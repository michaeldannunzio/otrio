/**
 * localTransport.ts — pass-and-play on one device.
 * ============================================================================
 *
 * The third `Transport`. Two to four people share one phone, take turns, and
 * nothing leaves the tab: no socket, no peer connection, no signalling, no
 * server. The referee runs in this heap, one synthetic identity per seat, and
 * `RefereeSend` is wired straight back into this object's own inbox.
 *
 * Its contract is the SINGLE-DEVICE BACKEND section of `transport.ts` and is
 * normative. Read that, not this header — the doc comments there carry the
 * reasoning and are the version that stays true. This file records only what a
 * reader of that section could not already know.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO CONTAIN
 * ----------------------------------------
 * A rule, a colour, a seat arrangement, or an engine→wire projection. There is
 * exactly one of each, in `referee.ts` and `src/game`, and a local game gets
 * them by driving the same `PeerReferee` the other two backends drive — which
 * is the entire point of building this as a transport rather than as an
 * "offline mode". If you find yourself reaching for `src/game` from here, stop:
 * whatever you need, the referee already computed it and put it in `RoomState`.
 *
 * Consequently this file knows nothing about colours. The official 2-player
 * arrangement — two seats, four colours, strict alternation per RULES.md §4.6 —
 * arrives for free because `PeerReferee.startGame` builds the engine config
 * from the seat count. See THE OFFICIAL TWO-PLAYER RULE in `transport.ts`.
 *
 * WHY THERE IS NO REQUEST MAP
 * ---------------------------
 * `wsTransport.ts` and `rtcTransport.ts` each keep a `pending` Map of request id
 * to promise, because their acks come back over a link, later. This one does
 * not, and must not — a third copy of that bookkeeping is a third thing to get
 * wrong.
 *
 * `referee.ts` contains no `async`, no `Promise` and no `setTimeout`: every ack
 * and nack is sent synchronously from inside `handle()`, before it returns
 * (verified by reading the file, 2026-09-24). So a single-slot sink, armed for
 * the duration of one `handle()` call, captures the answer — and if it captures
 * nothing, that is a referee defect and this file throws `INTERNAL` rather than
 * hanging. Crash early: a command that silently never resolves is the failure
 * mode a timeout was invented to paper over, and there is no link here to time
 * out.
 */

import { PeerReferee } from './referee';

import {
  newLocalRoomCode,
  newPlayerId,
  newSessionSecret,
  type AckMsg,
  type ClientMessage,
  type CreateRoomOptions,
  type EventMsg,
  type Move,
  type PlayerId,
  type RequestId,
  type RoomCode,
  type RoomState,
  type ServerMessage,
} from './protocol';

import {
  Emitter,
  LOCAL_CAPABILITIES,
  LOCAL_TURN_TIMEOUT_MS,
  TransportError,
  deriveLocalView,
  initialQuality,
  type ConnectionQuality,
  type ConnectionStatus,
  type Identity,
  type JoinRoomOptions,
  type LocalSeatNames,
  type LocalTransportConfig,
  type Transport,
  type TransportEventMap,
  type TransportSnapshot,
  type Unsubscribe,
} from './transport';

/**
 * One synthetic identity per seat, in seat order.
 *
 * Seat 0 reuses the device's own `Identity` — `playerId` and `sessionSecret`
 * both — with its `name` replaced. That replacement is not cosmetic and not
 * optional: `PeerReferee.create` builds seat 0 from `host.name`, so passing the
 * identity through unchanged names seat 0 after the device's persisted *online*
 * display name while every other seat takes its configured one. It type-checks,
 * it runs, and it puts the wrong name on one player.
 *
 * Seats 1..n-1 are minted fresh and are **never persisted**. There is no
 * auto-save in this feature, and a hot-seat identity written to storage would
 * be indistinguishable next session from the device's real one.
 */
function buildSeats(identity: Identity, seatNames: LocalSeatNames): readonly Identity[] {
  return seatNames.map((name, i) =>
    i === 0
      ? { ...identity, name }
      : { playerId: newPlayerId(), sessionSecret: newSessionSecret(), name },
  );
}

class LocalTransport implements Transport {
  readonly capabilities = LOCAL_CAPABILITIES;

  private readonly seats: readonly Identity[];
  private readonly emitter = new Emitter<TransportEventMap>();
  private readonly listeners = new Set<() => void>();
  private readonly debug: boolean;

  /**
   * Nothing measures a round trip that does not happen, so this keeps its
   * initial value — `rttMs: null`, `grade: 'unknown'` — for the life of the
   * transport.
   *
   * **Where the source material does not specify, I am inventing a rule:** the
   * contract says both backends MUST populate `quality` and does not say what
   * an in-process referee should report. `0` was the alternative and would read
   * as `grade: 'excellent'`, which is a measurement nobody took. `unknown` is
   * the honest answer to a question that was never asked.
   */
  private readonly quality: ConnectionQuality = initialQuality();

  private referee: PeerReferee | null = null;
  private room: RoomState | null = null;
  private status: ConnectionStatus = 'idle';
  private pendingMove: Move | null = null;
  private lastError: TransportError | null = null;

  private snap: TransportSnapshot;
  private dirty = false;
  /** Deferred side effects, drained after subscribers see the new snapshot. */
  private queued: Array<() => void> = [];
  /** Armed only for the duration of one `handle()` call. See the file header. */
  private ackSink: ((ack: AckMsg) => void) | null = null;
  private nextRid = 0;

  constructor(config: LocalTransportConfig) {
    this.seats = buildSeats(config.identity, config.seatNames);
    this.debug = config.debug ?? false;
    this.snap = {
      status: 'idle',
      playerId: this.seats[0].playerId,
      name: this.seats[0].name,
      room: null,
      role: 'none',
      seat: null,
      isMyTurn: false,
      isHost: false,
      pendingMove: null,
      quality: this.quality,
      lastError: null,
      capabilities: LOCAL_CAPABILITIES,
    };
  }

  /* ---------------------------------------------------------------- *
   * Observation
   * ---------------------------------------------------------------- */

  getSnapshot = (): TransportSnapshot => this.snap;

  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  };

  on<K extends keyof TransportEventMap>(
    type: K,
    handler: (payload: TransportEventMap[K]) => void,
  ): Unsubscribe {
    return this.emitter.on(type, handler);
  }

  /* ---------------------------------------------------------------- *
   * The seam: everything the referee emits lands here
   * ---------------------------------------------------------------- */

  /**
   * `RefereeSend`, pointed back at this object.
   *
   * `to` is ignored, and that is correct rather than lazy: `'*'` and any
   * `PlayerId` both mean "this device", because every seat is on it. A local
   * transport that filtered by recipient would be filtering its own players out
   * of their own game.
   */
  private readonly receive = (_to: PlayerId | '*', msg: ServerMessage): void => {
    switch (msg.t) {
      case 'state':
        this.room = msg.state;
        this.dirty = true;
        return;
      case 'event': {
        const event = msg;
        this.queued.push(() => this.dispatch(event));
        return;
      }
      case 'ack':
        this.ackSink?.(msg);
        return;
      case 'error': {
        const error = TransportError.fromWire(msg.error);
        this.lastError = error;
        this.dirty = true;
        this.queued.push(() => this.emitter.emit('error', error));
        return;
      }
      // Neither can occur: this backend performs no handshake and sends no
      // ping, so the referee has nothing to answer. Ignored rather than thrown
      // so a future referee change cannot break a running game over a message
      // the UI does not read.
      case 'welcome':
      case 'pong':
        return;
    }
  };

  private dispatch(msg: EventMsg): void {
    switch (msg.kind) {
      case 'moveApplied':
        return this.emitter.emit('moveApplied', { seat: msg.seat, move: msg.move, seq: msg.seq });
      case 'moveRejected':
        return this.emitter.emit('moveRejected', {
          move: msg.move,
          error: TransportError.fromWire(msg.error),
        });
      case 'playerJoined':
        return this.emitter.emit('playerJoined', { player: msg.player });
      case 'playerLeft':
        return this.emitter.emit('playerLeft', {
          playerId: msg.playerId,
          name: msg.name,
          permanent: msg.permanent,
        });
      case 'playerReconnected':
        return this.emitter.emit('playerReconnected', { playerId: msg.playerId, name: msg.name });
      case 'connectionChanged':
        return this.emitter.emit('connectionChanged', {
          playerId: msg.playerId,
          connection: msg.connection,
        });
      case 'gameStarted':
        return this.emitter.emit('gameStarted', { seq: msg.seq });
      case 'gameEnded':
        return this.emitter.emit('gameEnded', {
          reason: msg.reason,
          winner: msg.winner,
          line: msg.line,
        });
      case 'hostChanged':
        return this.emitter.emit('hostChanged', { playerId: msg.playerId, name: msg.name });
      case 'roomClosed':
        return this.emitter.emit('roomClosed', { reason: msg.reason });
    }
  }

  /* ---------------------------------------------------------------- *
   * The hot seat
   * ---------------------------------------------------------------- */

  /**
   * Whoever is holding the device.
   *
   * Seat 0 between `createRoom` and `startGame`, because seat 0 holds the host
   * role and `startGame` has to be made by a seat entitled to make it. Seat 0
   * again once the game is finished, because `GameSnapshot.turn` is documented
   * as meaningless then and seat 0 owns `requestRematch`. The seat on turn
   * otherwise.
   */
  private activeSeat(): Identity {
    const game = this.room?.game ?? null;
    if (game === null || game.phase === 'finished') return this.seats[0];
    return this.seats[game.turn] ?? this.seats[0];
  }

  /* ---------------------------------------------------------------- *
   * Snapshot maintenance
   * ---------------------------------------------------------------- */

  private rebuild(): void {
    const me = this.activeSeat();
    const view = deriveLocalView(this.room, me.playerId);
    // The referee sanitises names, so the room's copy is the authoritative one;
    // the configured name is only a fallback for before the room exists.
    const seated = this.room?.players.find((p) => p.playerId === me.playerId);
    this.snap = {
      status: this.status,
      playerId: me.playerId,
      name: seated?.name ?? me.name,
      room: this.room,
      role: view.role,
      seat: view.seat,
      isMyTurn: view.isMyTurn,
      isHost: view.isHost,
      pendingMove: this.pendingMove,
      quality: this.quality,
      lastError: this.lastError,
      capabilities: LOCAL_CAPABILITIES,
    };
  }

  /**
   * Publish at most one new snapshot, notify once, then run deferred effects.
   *
   * Called at the end of each public method rather than after each referee
   * message, so a `createRoom` that seats four players and readies three of
   * them is one notification and not eight. Events are dispatched *after* the
   * notification so a handler that reads `getSnapshot()` sees the state the
   * event is describing, never the one before it.
   */
  private flush(): void {
    if (this.dirty) {
      this.dirty = false;
      this.rebuild();
      for (const listener of Array.from(this.listeners)) {
        try {
          listener();
        } catch (err) {
          console.error('[otrio] local transport subscriber threw', err);
        }
      }
    }
    if (this.queued.length === 0) return;
    const effects = this.queued;
    this.queued = [];
    for (const run of effects) run();
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    const previous = this.status;
    this.status = next;
    this.dirty = true;
    this.queued.push(() => this.emitter.emit('statusChanged', { status: next, previous }));
  }

  private note(error: TransportError): TransportError {
    this.lastError = error;
    this.dirty = true;
    if (this.debug) console.warn('[otrio] local transport', error.code, error.message);
    return error;
  }

  /** Clear the retained error on a successful command, as the contract requires. */
  private clearError(): void {
    if (this.lastError === null) return;
    this.lastError = null;
    this.dirty = true;
  }

  /* ---------------------------------------------------------------- *
   * Driving the referee
   * ---------------------------------------------------------------- */

  /**
   * Hand one `ClientMessage` to the referee and return the ack it produced.
   *
   * The single-slot sink replaces the `pending` Map the other two backends
   * need. It is armed immediately before `handle()` and disarmed immediately
   * after, so exactly one request can be outstanding — which is not a
   * restriction here, because `handle()` cannot yield.
   */
  private submit(referee: PeerReferee, from: PlayerId, msg: ClientMessage & { rid: RequestId }): AckMsg {
    // A box rather than a bare `let`: the value is written from inside a
    // closure, which TypeScript's control-flow analysis cannot follow.
    const box: { ack: AckMsg | null } = { ack: null };
    const previous = this.ackSink;
    this.ackSink = (ack) => {
      if (ack.rid === msg.rid) box.ack = ack;
    };
    try {
      referee.handle(from, msg);
    } finally {
      this.ackSink = previous;
    }
    if (box.ack === null) {
      throw this.note(
        new TransportError(
          'INTERNAL',
          `the referee answered no ack for "${msg.t}" — referee.ts is expected to ack synchronously inside handle()`,
        ),
      );
    }
    return box.ack;
  }

  /** `submit`, but a nack becomes a thrown `TransportError`. */
  private demand(referee: PeerReferee, from: PlayerId, msg: ClientMessage & { rid: RequestId }): AckMsg {
    const ack = this.submit(referee, from, msg);
    if (!ack.ok) {
      throw this.note(
        ack.error
          ? TransportError.fromWire(ack.error)
          : new TransportError('INTERNAL', `the referee refused "${msg.t}" without saying why`),
      );
    }
    return ack;
  }

  private rid(): RequestId {
    this.nextRid += 1;
    return `local-${this.nextRid}`;
  }

  private requireReferee(): PeerReferee {
    if (this.referee === null || this.room === null) {
      throw this.note(new TransportError('NOT_IN_ROOM', 'no local room; call createRoom() first'));
    }
    return this.referee;
  }

  private requireOpen(): void {
    if (this.status === 'closed') {
      throw this.note(new TransportError('CONNECTION_LOST', 'this transport has been disposed'));
    }
  }

  /* ---------------------------------------------------------------- *
   * Transport
   * ---------------------------------------------------------------- */

  connect(): Promise<void> {
    try {
      this.requireOpen();
    } catch (err) {
      this.flush();
      return Promise.reject(err);
    }
    if (this.status !== 'connected') {
      // There is no link to establish, so the two transitions are back to back.
      // They are both published because the UI's status machine is shared with
      // the other backends and a missing 'connecting' would be a gap in it.
      this.setStatus('connecting');
      this.setStatus('connected');
    }
    this.clearError();
    this.flush();
    return Promise.resolve();
  }

  /**
   * Open the one room this transport will ever have, fully seated and ready.
   *
   * `options` is **ignored**, and deliberately: the contract fixes all three
   * values this backend may pass. `maxPlayers` is `seatNames.length`, because
   * that is where the player count lives and a second source for it is a
   * divergence with a delay fuse; `allowSpectators` is false, because
   * `joinRoom` rejects and a spectator therefore cannot be constructed;
   * `turnTimeoutMs` is `LOCAL_TURN_TIMEOUT_MS`, because `tick()` does not
   * expire a turn, it plays `legalMoves[0]` for the player — out from under
   * somebody who is holding the phone and thinking.
   *
   * Calling this again **replaces** the room, discarding any game in it. That
   * is not a judgement call: the contract lists `CONNECT_FAILED`, `TIMEOUT` and
   * `INTERNAL` as this method's only rejections, so there is no code with which
   * to refuse a second call, and neither of the other two backends refuses one.
   * A fresh code is minted each time, which is what makes consecutive local
   * games open on different seats.
   */
  createRoom(_options?: CreateRoomOptions): Promise<RoomCode> {
    try {
      this.requireOpen();
      if (this.status !== 'connected') {
        this.setStatus('connecting');
        this.setStatus('connected');
      }

      const code = newLocalRoomCode();
      const referee = PeerReferee.create(
        code,
        { ...this.seats[0], name: this.seats[0].name },
        {
          maxPlayers: this.seats.length,
          allowSpectators: false,
          turnTimeoutMs: LOCAL_TURN_TIMEOUT_MS,
        },
        LOCAL_CAPABILITIES,
        this.receive,
      );
      this.referee = referee;
      this.room = referee.snapshot();
      this.dirty = true;

      // Seat 1..n-1. `noteName` first and always: `onJoin` reads the name from
      // `pendingNames` and falls back to the literal 'Player', so a seat that
      // joins before its name is noted is called Player for the whole game.
      for (let i = 1; i < this.seats.length; i += 1) {
        const seat = this.seats[i];
        referee.noteName(seat.playerId, seat.name);
        this.demand(referee, seat.playerId, { t: 'joinRoom', rid: this.rid(), code });
        // Every non-host seat must be ready or `onStartGame` NACKs
        // NOT_ENOUGH_PLAYERS. Seat 0 is exempt there and needs no marking.
        this.demand(referee, seat.playerId, { t: 'setReady', rid: this.rid(), ready: true });
      }

      this.clearError();
      this.flush();
      return Promise.resolve(code);
    } catch (err) {
      this.flush();
      return Promise.reject(err);
    }
  }

  /**
   * Always fails.
   *
   * `UNSUPPORTED` rather than `ROOM_NOT_FOUND`, and before the code is looked
   * at: there is no registry to miss in, and a retryable-looking rejection
   * invites a UI retry loop that can never succeed. Holds even for a code this
   * same transport just returned from `createRoom`.
   */
  joinRoom(_code: RoomCode, _options?: JoinRoomOptions): Promise<RoomCode> {
    const error = this.note(
      new TransportError(
        'UNSUPPORTED',
        'a local room exists only in the tab that created it; use createRoom()',
      ),
    );
    this.flush();
    return Promise.reject(error);
  }

  /**
   * End the local game.
   *
   * **Where the source material does not specify, I am inventing a rule:** the
   * base contract says leaving releases the seat and keeps the link open for
   * another room. There is no link and no other room here, and every seat is on
   * this device, so "release my seat" can only mean "this game is over". The
   * room becomes `null` and `roomClosed` fires. `status` stays `connected`, so
   * a caller may `createRoom()` again — which is also how the UI starts a
   * second local game with different names.
   */
  leaveRoom(): Promise<void> {
    if (this.referee === null) return Promise.resolve();
    this.referee = null;
    this.room = null;
    this.pendingMove = null;
    this.dirty = true;
    this.queued.push(() => this.emitter.emit('roomClosed', { reason: 'the local game was ended' }));
    this.clearError();
    this.flush();
    return Promise.resolve();
  }

  /**
   * No-op.
   *
   * `createRoom` readies every seat before it returns and there is no lobby in
   * which to become un-ready, so this call has no effect available to it. It
   * resolves rather than rejecting because a shared lobby component calling it
   * should cost nothing — the asymmetry with `setName`, which would have the
   * *wrong* effect, is deliberate.
   */
  setReady(_ready: boolean): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Always fails.
   *
   * This method names no seat. Against an identity that changes every handoff
   * it would rename whoever happens to be holding the device, and it would have
   * to skip `saveIdentityName` as well — every documented part of its behaviour
   * replaced. Seat names come from `LocalTransportConfig.seatNames`; to change
   * one, build a new local game.
   */
  setName(_name: string): Promise<void> {
    const error = this.note(
      new TransportError(
        'UNSUPPORTED',
        'seat names are fixed by LocalTransportConfig.seatNames; start a new local game to change one',
      ),
    );
    this.flush();
    return Promise.reject(error);
  }

  startGame(): Promise<void> {
    try {
      this.requireOpen();
      const referee = this.requireReferee();
      this.demand(referee, this.seats[0].playerId, { t: 'startGame', rid: this.rid() });
      this.clearError();
      this.flush();
      return Promise.resolve();
    } catch (err) {
      this.flush();
      return Promise.reject(err);
    }
  }

  /**
   * Submit the active seat's move.
   *
   * `pendingMove` is set before anything is submitted, as the contract
   * requires, and cleared when the authoritative snapshot arrives — which here
   * is inside the same synchronous block, because the referee is in this heap.
   * Subscribers are therefore never notified of the ghost state. That is
   * correct rather than a shortcut: the ghost exists to cover link latency, and
   * a UI that rendered one here would flicker a translucent piece for zero
   * frames on its way to the real one.
   */
  sendMove(move: Move): Promise<void> {
    try {
      this.requireOpen();
      const referee = this.requireReferee();

      // Checked in the order the contract fixes. Only the "already pending"
      // case is ours; the referee independently re-checks all of them, and its
      // answer is the one that reaches the board.
      if (this.pendingMove !== null) {
        throw this.note(new TransportError('NOT_YOUR_TURN', 'a move is already pending'));
      }

      const me = this.activeSeat();
      this.pendingMove = move;
      try {
        this.demand(referee, me.playerId, { t: 'move', rid: this.rid(), move });
      } finally {
        this.pendingMove = null;
        this.dirty = true;
      }

      this.clearError();
      this.flush();
      return Promise.resolve();
    } catch (err) {
      this.flush();
      return Promise.reject(err);
    }
  }

  /**
   * Answer for everybody.
   *
   * An acceptance is submitted on behalf of every seat, because the referee
   * completes a rematch only once every eligible player has accepted and there
   * is nobody else here to answer. A decline needs one voice — `onRematch`
   * clears the offer outright — so it is submitted by the active seat, which is
   * seat 0 while the game is finished.
   */
  requestRematch(accept: boolean): Promise<void> {
    try {
      this.requireOpen();
      const referee = this.requireReferee();

      if (!accept) {
        this.demand(referee, this.activeSeat().playerId, {
          t: 'rematch',
          rid: this.rid(),
          accept: false,
        });
      } else {
        for (let i = 0; i < this.seats.length; i += 1) {
          // The first acceptance is submitted unconditionally, so the referee
          // and not this transport decides whether a rematch is available at
          // all — that is what produces GAME_NOT_ACTIVE on a running game.
          // Only the seats after it are skipped once the room has left
          // 'finished', which is precisely what the final acceptance does: it
          // restarts the game, and a further call would then come back
          // GAME_NOT_ACTIVE and fail a rematch that had in fact succeeded.
          //
          // Guarding the first call too was the bug this comment exists for:
          // it made requestRematch(true) resolve silently on a running game.
          if (i > 0 && this.room?.phase !== 'finished') break;
          this.demand(referee, this.seats[i].playerId, {
            t: 'rematch',
            rid: this.rid(),
            accept: true,
          });
        }
      }

      this.clearError();
      this.flush();
      return Promise.resolve();
    } catch (err) {
      this.flush();
      return Promise.reject(err);
    }
  }

  /**
   * No-op.
   *
   * `resync` exists to recover from a lost or reordered link. This transport
   * holds the referee's own `RoomState` object, so there is nothing staler than
   * the truth to discard and nothing to ask for.
   */
  resync(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    if (this.status === 'closed') return;
    this.referee = null;
    this.room = null;
    this.pendingMove = null;
    this.dirty = true;
    this.setStatus('closed');
    this.flush();
    this.emitter.clear();
    this.listeners.clear();
  }
}

/**
 * Build the single-device backend.
 *
 * Named to match `createWsTransport` and `createRtcTransport`, and returning
 * `Transport` rather than the class, so `src/net/index.ts` can hold all three
 * behind one factory and the UI never learns which it has.
 */
export function createLocalTransport(config: LocalTransportConfig): Transport {
  return new LocalTransport(config);
}
