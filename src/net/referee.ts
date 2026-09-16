/**
 * referee.ts — the authoritative room, independent of how bytes get to it.
 * ============================================================================
 *
 * ONE implementation of seats, lobby, readiness, start, moves, rematch, pause,
 * forfeit and the engine↔wire projection. Both backends drive it:
 *
 *   - `src/net/rtcTransport.ts` constructs one on whichever peer is currently
 *     the referee, and pumps it from a WebRTC data channel.
 *   - `server/src/session.ts` constructs one per room and pumps it from a
 *     WebSocket.
 *
 * The seam is deliberately narrow and transport-agnostic:
 *
 *     handle(from: PlayerId, msg: ClientMessage) -> void
 *     send(to: PlayerId | '*', msg: ServerMessage) -> void      // injected
 *
 * That is the whole surface. It knows nothing about sockets, peers, ICE, or
 * who is hosting. Everything it emits is a `ServerMessage` from `protocol.ts`,
 * so the two backends cannot drift on rematch semantics or forfeit handling —
 * which is exactly what two independent implementations would have done.
 *
 * It has NO dependency on `transport.ts`, so the server can load it through
 * Node's type-stripping loader without dragging the client layer in. The one
 * client-shaped type it needs (`RefereeHost`) is declared locally and is
 * structurally satisfied by `Identity`.
 *
 *
 * IDENTITY MODEL
 * --------------
 * This file is careful about a distinction the wire format now makes explicit,
 * and which is the single easiest thing to get wrong:
 *
 *   - a **`Seat`** is a person;
 *   - a **`PlayerColor`** is a colour of rings.
 *
 * They coincide in 3- and 4-player games and *do not* in the official 2-player
 * game, where each person plays two colours on opposite arms of the board and
 * a win must be formed within one colour (RULES.md §4.6, §5.7). Board cells and
 * reserves are therefore keyed by **colour**; turns, forfeits and wins are
 * keyed by **seat**. `GameSnapshot.reserves` is always length 4, indexed by
 * colour, so `reserves[color]` is always a safe index.
 */

import {
  ALL_COLORS,
  ALL_SEATS,
  BOARD_CELLS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PIECE_SIZES,
  PROTOCOL_VERSION,
  TIMING,
  normalizeRoomCode,
  sanitizeName,
  toSeat,
  wireError,
  type AckMsg,
  type Capabilities,
  type CellState,
  type ClientMessage,
  type ConnectionState,
  type CreateRoomOptions,
  type ErrorCode,
  type EventMsg,
  type GameEndReason,
  type GameSnapshot,
  type Move,
  type PlayerColor,
  type PlayerId,
  type PlayerView,
  type Reserve,
  type RequestId,
  type RoomCode,
  type RoomState,
  type Seat,
  type ServerMessage,
  type SessionSecret,
  type SpectatorView,
  type WinningLine,
} from './protocol.ts';

import {
  applyMove as engineApplyMove,
  boardFromJSON,
  createConfig,
  initialState,
  legalMoves as engineLegalMoves,
  moveError as engineMoveError,
  remainingPieces,
  seatOf,
  withdrawSeat,
  type GameConfig as EngineConfig,
  type GameState as EngineState,
  type Move as EngineMove,
  type PlayerId as Color,
  type Size as EngineSize,
  type SpaceIndex,
  type TurnSlot,
  type WinningLine as EngineWinningLine,
} from '../game/index.ts';

/* ========================================================================== *
 * Construction
 * ========================================================================== */

/** Where a `ServerMessage` goes. `'*'` is every participant in the room. */
export type RefereeSend = (to: PlayerId | '*', msg: ServerMessage) => void;

/**
 * The host's identity at room creation. Structurally satisfied by `Identity`
 * from `transport.ts`; declared here so this file imports nothing from the
 * client layer.
 */
export interface RefereeHost {
  playerId: PlayerId;
  sessionSecret: SessionSecret;
  name: string;
}

export interface RefereeOptions {
  maxPlayers: number;
  allowSpectators: boolean;
  /** Per-turn clock in ms, or 0 for untimed. */
  turnTimeoutMs: number;
  /**
   * Reported in `WelcomeMsg`. Supplied by the caller rather than hardcoded,
   * because the same referee runs behind both backends and they differ on
   * `kind`, `hostMigration` and `impartialReferee`.
   */
  capabilities: Capabilities;
}

/* ========================================================================== *
 * PeerReferee
 * ========================================================================== */

export class PeerReferee {
  private state: RoomState;
  private game: EngineState | null = null;
  private secrets = new Map<PlayerId, SessionSecret>();
  private graceUntil = new Map<PlayerId, number>();
  private pendingNames = new Map<PlayerId, string>();
  private opts: RefereeOptions;
  private send: RefereeSend;

  private constructor(state: RoomState, opts: RefereeOptions, send: RefereeSend) {
    this.state = state;
    this.opts = opts;
    this.send = send;
  }

  /** A brand-new room with `host` in seat 0. */
  static create(
    code: RoomCode,
    host: RefereeHost,
    options: CreateRoomOptions | undefined,
    capabilities: Capabilities,
    send: RefereeSend,
  ): PeerReferee {
    const maxPlayers = clamp(options?.maxPlayers ?? MAX_PLAYERS, MIN_PLAYERS, MAX_PLAYERS);
    const state: RoomState = {
      code,
      seq: 1,
      phase: 'lobby',
      hostPlayerId: host.playerId,
      players: [makePlayerView(host.playerId, 0, host.name, true)],
      spectators: [],
      maxPlayers,
      allowSpectators: options?.allowSpectators ?? true,
      game: null,
      turnDeadline: null,
      pause: null,
      rematch: null,
      endReason: null,
      updatedAt: Date.now(),
    };
    const ref = new PeerReferee(
      state,
      {
        maxPlayers,
        allowSpectators: state.allowSpectators,
        turnTimeoutMs: Math.max(0, options?.turnTimeoutMs ?? 0),
        capabilities,
      },
      send,
    );
    ref.secrets.set(host.playerId, host.sessionSecret);
    ref.pendingNames.set(host.playerId, state.players[0].name);
    return ref;
  }

  /**
   * Rebuild a referee from the last snapshot a survivor holds. This is host
   * migration, and it is why the protocol sends whole snapshots.
   *
   * See `rehydrateEngine` for what does and does not survive.
   */
  static adopt(
    snapshot: RoomState,
    turnTimeoutMs: number,
    capabilities: Capabilities,
    send: RefereeSend,
  ): PeerReferee {
    const ref = new PeerReferee(
      { ...snapshot },
      {
        maxPlayers: snapshot.maxPlayers,
        allowSpectators: snapshot.allowSpectators,
        turnTimeoutMs,
        capabilities,
      },
      send,
    );
    if (snapshot.game) ref.game = rehydrateEngine(snapshot);
    for (const p of snapshot.players) ref.pendingNames.set(p.playerId, p.name);
    return ref;
  }

  snapshot(): RoomState { return this.state; }
  get seq(): number { return this.state.seq; }

  /** Names arrive in `hello` but seats are taken in `joinRoom`; bridge the two. */
  noteName(id: PlayerId, name: string): void {
    this.pendingNames.set(id, sanitizeName(name, 'Player'));
  }

  /** Everything a referee must do on a timer. Call roughly every 2s. */
  tick(now: number): void {
    let dirty = false;

    // Players whose reconnect grace ran out.
    let forfeited = false;
    for (const [id, until] of [...this.graceUntil]) {
      if (now < until) continue;
      this.graceUntil.delete(id);
      const p = this.state.players.find((x) => x.playerId === id);
      if (!p || p.connection === 'online') continue;
      forfeited = this.forfeit(id) || forfeited;
    }
    // Lifting the pause is the whole point of the grace period expiring. Without
    // this the room stays 'paused' forever, waiting on a player who has just
    // been forfeited and is never coming back.
    if (forfeited) {
      this.recomputePause();
      dirty = true;
    }

    // Rematch offers lapse.
    if (this.state.rematch && now > this.state.rematch.expiresAt) {
      this.state = { ...this.state, rematch: null };
      dirty = true;
    }

    // Turn clock. Otrio has no legal pass (§4.5 skips only when you *cannot*
    // place), so the referee plays the first legal move for the absent player —
    // deterministically, per TURN_TIMEOUT_POLICY, so replaying the same game
    // reproduces it on either backend.
    if (
      this.state.phase === 'playing' &&
      this.state.turnDeadline !== null &&
      now > this.state.turnDeadline &&
      this.game
    ) {
      const options = engineLegalMoves(this.game);
      if (options.length > 0) {
        this.applyEngineMove(options[0]);
        return;
      }
    }

    if (dirty) this.bump();
  }

  /** A participant's link state changed. */
  setConnection(id: PlayerId, conn: ConnectionState): void {
    const idx = this.state.players.findIndex((p) => p.playerId === id);
    if (idx < 0) return;
    const prev = this.state.players[idx];
    if (prev.connection === conn) return;
    const players = [...this.state.players];
    players[idx] = { ...prev, connection: conn };
    this.state = { ...this.state, players };

    if (conn === 'online') {
      this.graceUntil.delete(id);
      this.emitEvent({ t: 'event', kind: 'playerReconnected', playerId: id, name: prev.name });
    } else if (conn === 'reconnecting') {
      this.graceUntil.set(id, Date.now() + TIMING.reconnectGraceMs);
      this.emitEvent({ t: 'event', kind: 'playerLeft', playerId: id, name: prev.name, permanent: false });
    }
    this.emitEvent({ t: 'event', kind: 'connectionChanged', playerId: id, connection: conn });
    this.recomputePause();
    this.bump();
  }

  /** Main entry point: one `ClientMessage` from one participant. */
  handle(from: PlayerId, msg: ClientMessage): void {
    switch (msg.t) {
      case 'hello': return this.onHello(from, msg);
      case 'createRoom':
        // The room already exists; whoever asked is confused. Not fatal.
        return this.nack(from, msg.rid, 'UNSUPPORTED', 'this referee already hosts a room');
      case 'joinRoom': return this.onJoin(from, msg.rid, msg.code, msg.asSpectator === true);
      case 'leaveRoom':
        this.removeParticipant(from, true);
        return this.ack(from, msg.rid, { kind: 'ok' });
      case 'setReady': return this.onSetReady(from, msg.rid, msg.ready);
      case 'setName': return this.onSetName(from, msg.rid, msg.name);
      case 'startGame': return this.onStartGame(from, msg.rid);
      case 'move': return this.onMove(from, msg.rid, msg.move);
      case 'rematch': return this.onRematch(from, msg.rid, msg.accept);
      case 'resync':
        this.send(from, { t: 'state', state: this.state });
        return this.ack(from, msg.rid, { kind: 'ok' });
      case 'ping':
        if (typeof msg.rttMs === 'number') this.publishRtt(from, msg.rttMs);
        return this.send(from, { t: 'pong', id: msg.id, t0: msg.t0, serverTime: Date.now() });
    }
  }

  /* -------------------- handlers -------------------- */

  private onHello(from: PlayerId, msg: Extract<ClientMessage, { t: 'hello' }>): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.send(from, {
        t: 'error',
        error: wireError(
          'PROTOCOL_MISMATCH',
          `referee speaks v${PROTOCOL_VERSION}, client speaks v${msg.protocolVersion}`,
        ),
        fatal: true,
      });
      return;
    }
    const name = sanitizeName(msg.name, 'Player');
    const known = this.secrets.get(from);
    const seated = this.state.players.find((p) => p.playerId === from);

    // Resuming a held seat needs the private half of the identity. Without
    // this, anyone who read a PlayerId out of a broadcast RoomState could claim
    // that seat.
    if (seated && known !== undefined && known !== msg.sessionSecret) {
      this.send(from, {
        t: 'error',
        error: wireError('SEAT_TAKEN', 'that seat belongs to another session'),
        fatal: true,
      });
      return;
    }
    this.secrets.set(from, msg.sessionSecret);
    this.noteName(from, name);

    let resumed: RoomState | null = null;
    if (seated) {
      this.setConnection(from, 'online');
      resumed = this.state;
    }
    this.send(from, {
      t: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: Date.now(),
      playerId: from,
      name: seated?.name ?? name,
      capabilities: { ...this.opts.capabilities, maxPlayers: this.state.maxPlayers },
      resumed,
    });
  }

  private onJoin(from: PlayerId, rid: RequestId, code: RoomCode, asSpectator: boolean): void {
    if (normalizeRoomCode(code) !== this.state.code) {
      return this.nack(from, rid, 'ROOM_NOT_FOUND', `this referee hosts ${this.state.code}`);
    }
    if (this.state.players.some((p) => p.playerId === from)) {
      this.setConnection(from, 'online');
      return this.ack(from, rid, { kind: 'room', code: this.state.code, state: this.state });
    }
    if (this.state.spectators.some((s) => s.playerId === from)) {
      return this.ack(from, rid, { kind: 'room', code: this.state.code, state: this.state });
    }

    const wantsSeat = !asSpectator;
    const started = this.state.phase !== 'lobby';
    if (wantsSeat && started) {
      return this.nack(from, rid, 'ALREADY_STARTED', 'the game is underway; join as a spectator');
    }
    if (wantsSeat && this.state.players.length >= this.state.maxPlayers) {
      return this.nack(from, rid, 'ROOM_FULL', 'every seat is taken');
    }
    if (asSpectator && !this.state.allowSpectators) {
      return this.nack(from, rid, 'UNSUPPORTED', 'spectators are disabled in this room');
    }

    const name = this.pendingNames.get(from) ?? 'Player';
    if (wantsSeat) {
      const seat = this.lowestFreeSeat();
      // Belt and braces with the length guard above: that one counts players,
      // this one looks at which seats are actually occupied. They should never
      // disagree, and if they ever do, the honest answer is still "full".
      if (seat === null) return this.nack(from, rid, 'ROOM_FULL', 'every seat is taken');
      const view = makePlayerView(from, seat, name, false);
      this.state = {
        ...this.state,
        players: [...this.state.players, view].sort((a, b) => a.seat - b.seat),
      };
      this.emitEvent({ t: 'event', kind: 'playerJoined', player: view });
    } else {
      const view: SpectatorView = { playerId: from, name, joinedAt: Date.now() };
      this.state = { ...this.state, spectators: [...this.state.spectators, view] };
    }
    this.bump();
    this.ack(from, rid, { kind: 'room', code: this.state.code, state: this.state });
  }

  private onSetReady(from: PlayerId, rid: RequestId, ready: boolean): void {
    if (this.state.phase !== 'lobby') return this.ack(from, rid, { kind: 'ok' });
    const idx = this.state.players.findIndex((p) => p.playerId === from);
    if (idx < 0) return this.nack(from, rid, 'NOT_IN_ROOM', 'not seated');
    const players = [...this.state.players];
    players[idx] = { ...players[idx], ready };
    this.state = { ...this.state, players };
    this.bump();
    this.ack(from, rid, { kind: 'ok' });
  }

  private onSetName(from: PlayerId, rid: RequestId, raw: string): void {
    const name = sanitizeName(raw, 'Player');
    this.pendingNames.set(from, name);
    const pIdx = this.state.players.findIndex((p) => p.playerId === from);
    if (pIdx >= 0) {
      const players = [...this.state.players];
      players[pIdx] = { ...players[pIdx], name };
      this.state = { ...this.state, players };
      this.bump();
    } else {
      const sIdx = this.state.spectators.findIndex((s) => s.playerId === from);
      if (sIdx >= 0) {
        const spectators = [...this.state.spectators];
        spectators[sIdx] = { ...spectators[sIdx], name };
        this.state = { ...this.state, spectators };
        this.bump();
      }
    }
    this.ack(from, rid, { kind: 'ok' });
  }

  private onStartGame(from: PlayerId, rid: RequestId): void {
    if (from !== this.state.hostPlayerId) return this.nack(from, rid, 'NOT_HOST', 'only the host may start');
    if (this.state.phase !== 'lobby') return this.nack(from, rid, 'ALREADY_STARTED', 'already running');
    const seated = this.state.players;
    if (seated.length < MIN_PLAYERS) {
      return this.nack(from, rid, 'NOT_ENOUGH_PLAYERS', `need at least ${MIN_PLAYERS}`);
    }
    if (!seated.every((p) => p.ready || p.playerId === this.state.hostPlayerId)) {
      return this.nack(from, rid, 'NOT_ENOUGH_PLAYERS', 'not everyone is ready');
    }
    this.startGame(seated, hashSeed(this.state.code, this.state.seq));
    this.emitEvent({ t: 'event', kind: 'gameStarted', seq: this.state.seq });
    this.ack(from, rid, { kind: 'ok' });
  }

  /**
   * Build the engine game and publish it.
   *
   * `twoPlayerMode` is left at the engine default, `'official'` — two seats,
   * four colours, strict alternation. That is the printed rule, and the wire
   * format now carries it: `reserves` is per colour, `PlayerView.colors` holds
   * both of a seat's colours, and `turnColors` says which one is due.
   */
  private startGame(seated: PlayerView[], seed: number): void {
    const count = seated.length as 2 | 3 | 4;
    const config = createConfig({
      players: count,
      seed,
      names: seated.map((p) => p.name),
    });
    this.game = initialState(config);
    this.state = {
      ...this.state,
      phase: 'playing',
      players: seated.map((p) => ({
        ...p,
        ready: true,
        // A seat's colours are only known once the player count fixes the
        // arrangement, so they are empty in the lobby and filled in here.
        colors: colorsForSeat(config, p.seat),
      })),
      game: toGameSnapshot(this.game),
      turnDeadline: this.nextDeadline(),
      endReason: null,
      rematch: null,
    };
    this.bump();
  }

  private onMove(from: PlayerId, rid: RequestId, move: Move): void {
    const player = this.state.players.find((p) => p.playerId === from);
    if (!player) {
      const spectating = this.state.spectators.some((s) => s.playerId === from);
      return this.nack(from, rid, spectating ? 'SPECTATOR_FORBIDDEN' : 'NOT_IN_ROOM', 'no seat');
    }
    if (this.state.phase !== 'playing' || !this.game) {
      return this.nack(from, rid, 'GAME_NOT_ACTIVE', 'the game is not running');
    }
    if (player.forfeited) return this.nack(from, rid, 'SPECTATOR_FORBIDDEN', 'you have forfeited');
    if (!isStructurallyValidMove(move)) return this.nack(from, rid, 'ILLEGAL_MOVE', 'malformed move');

    // Whose turn it is comes from the authenticated sender's seat, never from
    // anything in the message.
    if (this.game.currentSeat !== player.seat) {
      return this.nack(from, rid, 'NOT_YOUR_TURN', `seat ${this.game.currentSeat} is to move`);
    }

    const resolved = this.resolveColor(move);
    if (typeof resolved === 'string') {
      const err = wireError('ILLEGAL_MOVE', resolved);
      this.emitEventTo(from, { t: 'event', kind: 'moveRejected', move, error: err });
      return this.nack(from, rid, 'ILLEGAL_MOVE', resolved);
    }

    const engineMove: EngineMove = {
      player: resolved,
      space: move.cell as SpaceIndex,
      size: move.size as EngineSize,
    };
    const reason = engineMoveError(this.game, engineMove);
    if (reason !== null) {
      const code: ErrorCode = reason === 'not-your-turn' ? 'NOT_YOUR_TURN' : 'ILLEGAL_MOVE';
      this.emitEventTo(from, { t: 'event', kind: 'moveRejected', move, error: wireError(code, reason) });
      return this.nack(from, rid, code, reason);
    }
    this.applyEngineMove(engineMove);
    this.ack(from, rid, { kind: 'ok' });
  }

  /**
   * Work out which colour a move places.
   *
   * `Move.color` is optional and normally absent, because the seat to move has
   * exactly one playable colour on every 3-/4-player turn and on every turn of
   * the official 2-player game (strict alternation fixes it). It is required
   * only in the opt-out `'free-colors'` mode, which this referee never builds.
   *
   * Returns the colour, or a rejection reason.
   */
  private resolveColor(move: Move): Color | string {
    const due = this.game?.playableColors ?? [];
    if (move.color !== undefined) {
      if (!due.includes(move.color as Color)) {
        return `colour ${move.color} is not playable this turn (due: ${due.join(', ')})`;
      }
      return move.color as Color;
    }
    if (due.length === 1) return due[0];
    if (due.length === 0) return 'no colour is playable this turn';
    return `ambiguous: this seat may play ${due.join(' or ')} — specify move.color`;
  }

  private applyEngineMove(engineMove: EngineMove): void {
    if (!this.game) return;
    const seat = seatOf(this.game.config, engineMove.player);
    this.game = engineApplyMove(this.game, engineMove);
    const snap = toGameSnapshot(this.game);
    const finished = snap.phase === 'finished';
    this.state = {
      ...this.state,
      phase: finished ? 'finished' : 'playing',
      game: snap,
      turnDeadline: finished ? null : this.nextDeadline(),
      endReason: finished ? (snap.isDraw ? 'draw' : 'win') : null,
    };
    this.bump();
    this.emitEvent({
      t: 'event',
      kind: 'moveApplied',
      seat,
      move: { cell: engineMove.space, size: engineMove.size, color: engineMove.player },
      seq: this.state.seq,
    });
    if (finished) {
      this.emitEvent({
        t: 'event',
        kind: 'gameEnded',
        reason: snap.isDraw ? 'draw' : 'win',
        winner: snap.winner,
        line: snap.winningLine,
      });
    }
  }

  private onRematch(from: PlayerId, rid: RequestId, accept: boolean): void {
    if (this.state.phase !== 'finished') {
      return this.nack(from, rid, 'GAME_NOT_ACTIVE', 'the game has not finished');
    }
    if (!this.state.players.some((p) => p.playerId === from)) {
      return this.nack(from, rid, 'NOT_IN_ROOM', 'no seat');
    }

    if (!accept) {
      this.state = { ...this.state, rematch: null };
      this.bump();
      return this.ack(from, rid, { kind: 'ok' });
    }
    const current = this.state.rematch;
    const accepted = current ? Array.from(new Set([...current.accepted, from])) : [from];
    const rematch = current
      ? { ...current, accepted }
      : { requestedBy: from, accepted, expiresAt: Date.now() + TIMING.rematchTtlMs };

    const eligible = this.state.players.filter((p) => !p.forfeited && p.connection !== 'offline');
    if (eligible.length >= MIN_PLAYERS && eligible.every((p) => accepted.includes(p.playerId))) {
      // Reseat contiguously from 0: the engine indexes seats densely, so a
      // rematch after someone forfeited seat 1 must not leave a hole.
      // `eligible` is at most MAX_PLAYERS long, so `toSeat` never fails here;
      // keeping the player's existing seat rather than inventing one is the
      // honest fallback if that ever stops being true.
      const reseated = eligible.map((p, i) => ({
        ...p,
        seat: toSeat(i) ?? p.seat,
        forfeited: false,
        ready: true,
      }));
      this.state = { ...this.state, players: reseated, rematch: null };
      // `seq` deliberately keeps counting across a rematch — clients discard
      // anything that does not move it forward, so a reset would freeze them.
      this.startGame(reseated, hashSeed(this.state.code, this.state.seq));
      this.emitEvent({ t: 'event', kind: 'gameStarted', seq: this.state.seq });
    } else {
      this.state = { ...this.state, rematch };
      this.bump();
    }
    this.ack(from, rid, { kind: 'ok' });
  }

  /* -------------------- room bookkeeping -------------------- */

  removeParticipant(id: PlayerId, permanent: boolean): void {
    const player = this.state.players.find((p) => p.playerId === id);
    if (player) {
      if (this.state.phase === 'lobby') {
        // In the lobby a seat is simply released, and the remaining players
        // close up so seats stay dense.
        const rest = this.state.players
          .filter((p) => p.playerId !== id)
          .map((p, i) => ({ ...p, seat: toSeat(i) ?? p.seat }));
        this.state = { ...this.state, players: rest };
        this.emitEvent({ t: 'event', kind: 'playerLeft', playerId: id, name: player.name, permanent: true });
        if (id === this.state.hostPlayerId) this.reassignHostFlag();
      } else if (permanent || player.forfeited) {
        this.forfeit(id); // emits playerLeft itself
        if (id === this.state.hostPlayerId) this.reassignHostFlag();
      }
      this.recomputePause();
      this.bump();
      return;
    }
    if (this.state.spectators.some((s) => s.playerId === id)) {
      this.state = { ...this.state, spectators: this.state.spectators.filter((s) => s.playerId !== id) };
      this.bump();
    }
  }

  /**
   * Take a seat out of the game.
   *
   * Mid-game the seat is *withdrawn from the turn cycle* rather than deleted:
   * its pieces stay on the board as blockers, exactly as they would if someone
   * walked away from a physical table. The engine models this directly, so
   * there is no need to fabricate moves on the absent player's behalf.
   */
  private forfeit(id: PlayerId): boolean {
    const idx = this.state.players.findIndex((p) => p.playerId === id);
    if (idx < 0 || this.state.players[idx].forfeited) return false;
    const players = [...this.state.players];
    players[idx] = { ...players[idx], forfeited: true, connection: 'offline', ready: false };
    this.state = { ...this.state, players };
    this.emitEvent({ t: 'event', kind: 'playerLeft', playerId: id, name: players[idx].name, permanent: true });

    const active = players.filter((p) => !p.forfeited);
    if (this.state.phase === 'playing' || this.state.phase === 'paused') {
      if (active.length < MIN_PLAYERS) {
        this.endGame('opponents-left');
        return true;
      }
      if (this.game) {
        this.game = withdrawSeat(this.game, players[idx].seat);
        const snap = toGameSnapshot(this.game);
        const finished = snap.phase === 'finished';
        this.state = {
          ...this.state,
          phase: finished ? 'finished' : this.state.phase,
          game: snap,
          turnDeadline: finished ? null : this.nextDeadline(),
          endReason: finished ? (snap.isDraw ? 'draw' : 'win') : this.state.endReason,
        };
      }
    }
    return true;
  }

  private endGame(reason: GameEndReason): void {
    this.state = { ...this.state, phase: 'finished', turnDeadline: null, endReason: reason, pause: null };
    this.emitEvent({
      t: 'event',
      kind: 'gameEnded',
      reason,
      winner: this.state.game?.winner ?? null,
      line: this.state.game?.winningLine ?? null,
    });
  }

  /** The host *flag* in RoomState. Referee election is the transport's job. */
  private reassignHostFlag(): void {
    const candidate =
      this.state.players.find((p) => !p.forfeited && p.connection !== 'offline') ?? this.state.players[0];
    if (!candidate) return;
    this.state = {
      ...this.state,
      hostPlayerId: candidate.playerId,
      players: this.state.players.map((p) => ({ ...p, isHost: p.playerId === candidate.playerId })),
    };
    this.emitEvent({ t: 'event', kind: 'hostChanged', playerId: candidate.playerId, name: candidate.name });
  }

  /** Called by the transport when it takes over as referee after a migration. */
  assumeHost(id: PlayerId): void {
    const me = this.state.players.find((p) => p.playerId === id);
    if (!me) return;
    this.state = {
      ...this.state,
      hostPlayerId: id,
      players: this.state.players.map((p) => ({ ...p, isHost: p.playerId === id })),
      pause: null,
    };
    this.emitEvent({ t: 'event', kind: 'hostChanged', playerId: id, name: me.name });
    this.bump();
  }

  /** Suspend play while someone the game is waiting on is missing. */
  private recomputePause(): void {
    if (this.state.phase === 'finished' || this.state.phase === 'lobby') return;
    const missing = this.state.players.filter((p) => !p.forfeited && p.connection === 'reconnecting');
    if (missing.length === 0) {
      if (this.state.pause) this.state = { ...this.state, phase: 'playing', pause: null };
      return;
    }
    this.state = {
      ...this.state,
      phase: 'paused',
      pause: {
        reason: 'player-disconnected',
        waitingFor: missing.map((p) => p.playerId),
        resumesAt: Math.min(
          ...missing.map((p) => this.graceUntil.get(p.playerId) ?? Date.now() + TIMING.reconnectGraceMs),
        ),
      },
    };
  }

  /** Publish one player's measured RTT so everyone can see their bars. */
  private publishRtt(id: PlayerId, rttMs: number): void {
    const idx = this.state.players.findIndex((p) => p.playerId === id);
    if (idx < 0) return;
    const players = [...this.state.players];
    players[idx] = { ...players[idx], rttMs: Math.round(rttMs) };
    this.state = { ...this.state, players };
    // Deliberately no bump(): RTT churns every few seconds, and a new snapshot
    // per sample would re-render the board for a number in the corner. It rides
    // along with the next real change.
  }

  /**
   * The lowest unoccupied seat, or `null` when there isn't one.
   *
   * `null` rather than a fallback seat, for the same reason `toSeat` returns
   * `null` rather than asserting: there is no correct seat to invent here. The
   * previous fallback returned `players.length` — which, in the only state that
   * could reach it, is `4`, and 4 is not a seat. Narrowing `Seat` from `number`
   * is what made that visible.
   *
   * Returning `0` instead would be worse than the bug it replaced: seat 0 is
   * occupied in every state that reaches this line, so it would seat two people
   * on one seat and hand the engine a board whose pieces have ambiguous owners
   * — silent corruption, in the one component that is the sole authority for
   * everyone at the table. Throwing would be loud but lands in a data-channel
   * message handler with no supervisor above it on a P2P host, taking the room
   * down for everyone over a condition the caller can handle cleanly.
   *
   * So neither: the caller turns `null` into `ROOM_FULL`, which is a normal,
   * already-tested protocol reply. That also makes "the room is full" true in
   * exactly one place instead of two that can drift apart.
   */
  private lowestFreeSeat(): Seat | null {
    const taken = new Set<number>(this.state.players.map((p) => p.seat));
    for (const seat of ALL_SEATS) {
      if (seat < this.state.maxPlayers && !taken.has(seat)) return seat;
    }
    return null;
  }

  private nextDeadline(): number | null {
    return this.opts.turnTimeoutMs > 0 ? Date.now() + this.opts.turnTimeoutMs : null;
  }

  /** Publish a new snapshot. The only place `seq` moves. */
  private bump(): void {
    this.state = { ...this.state, seq: this.state.seq + 1, updatedAt: Date.now() };
    this.send('*', { t: 'state', state: this.state });
  }

  private emitEvent(e: EventMsg): void { this.send('*', e); }
  private emitEventTo(to: PlayerId, e: EventMsg): void { this.send(to, e); }

  private ack(to: PlayerId, rid: RequestId, result: AckMsg['result']): void {
    this.send(to, { t: 'ack', rid, ok: true, result });
  }

  private nack(to: PlayerId, rid: RequestId, code: ErrorCode, message: string): void {
    this.send(to, { t: 'ack', rid, ok: false, error: wireError(code, message) });
  }
}

/* ========================================================================== *
 * Engine <-> wire projection
 *
 * The engine speaks colours; the wire speaks both, and is explicit about which
 * is which. Getting this mapping wrong is the one way the official 2-player
 * game silently breaks, so each field says which it is.
 * ========================================================================== */

const EMPTY_RESERVE: Reserve = { small: 0, medium: 0, large: 0 };

export function toGameSnapshot(g: EngineState): GameSnapshot {
  const board: CellState[] = [];
  for (let i = 0; i < BOARD_CELLS; i++) {
    const c = g.board[i];
    // Slots hold a COLOUR. In the official 2-player game two of these belong to
    // the same person, and collapsing them to a seat here would make a
    // two-purple-one-green line look like a win. It is not.
    board.push({ small: c.small, medium: c.medium, large: c.large });
  }

  // Length 4, indexed by colour, so `reserves[color]` is always safe. Colours
  // not in play read {0,0,0} rather than a full tray nobody owns.
  const inPlay = new Set<Color>(g.config.colorsInPlay);
  const reserves: Reserve[] = ALL_COLORS.map((c) =>
    inPlay.has(c as Color) ? toReserve(remainingPieces(g.board, c as Color)) : { ...EMPTY_RESERVE },
  );

  const winnerColor = g.result ? g.result.player : null;
  const winner = g.result ? g.result.seat : null;

  return {
    board,
    reserves,
    colorsInPlay: [...g.config.colorsInPlay] as PlayerColor[],
    turn: g.currentSeat,
    turnColors: toTurnColors(g.playableColors),
    phase: g.status === 'playing' ? 'playing' : 'finished',
    winner,
    winnerColor,
    isDraw: g.status === 'draw',
    winningLine:
      g.result && winner !== null ? toWinningLine(g.result.lines[0], winner) : null,
    moveCount: g.moveNumber,
    lastMove: g.lastMove
      ? {
          seat: seatOf(g.config, g.lastMove.player),
          color: g.lastMove.player,
          move: { cell: g.lastMove.space, size: g.lastMove.size, color: g.lastMove.player },
        }
      : null,
    forfeitedSeats: [...g.config.withdrawnSeats],
    skipped: g.skipped.map((s: TurnSlot) => ({ seat: s.seat, colors: [...s.colors] as PlayerColor[] })),
  };
}

function toReserve(r: Record<EngineSize, number>): Reserve {
  return { small: r.small, medium: r.medium, large: r.large };
}

/**
 * Narrow the engine's `playableColors` to the wire's non-empty tuple.
 *
 * Safe by construction: `playableColors` originates as a `TurnSlot`'s `colors`,
 * which is never empty (a slot with no colour could not be in the rotation),
 * and `applyMove` carries it forward unchanged into both `'won'` and `'draw'`.
 * So index 0 always exists, and the engine never produces more than two.
 */
function toTurnColors(due: readonly Color[]): GameSnapshot['turnColors'] {
  return (
    due.length > 1
      ? [due[0] as PlayerColor, due[1] as PlayerColor]
      : [due[0] as PlayerColor]
  );
}

export function toWinningLine(l: EngineWinningLine, seat: Seat): WinningLine {
  return {
    kind: l.condition === 'same-size' ? 'same-size' : l.condition === 'sequence' ? 'ascending' : 'concentric',
    cells: l.pieces.map((p) => p.space),
    sizes: l.pieces.map((p) => p.size),
    color: l.player,
    seat,
  };
}

/** The colours a seat controls, for `PlayerView.colors`. */
function colorsForSeat(config: EngineConfig, seat: Seat): PlayerColor[] {
  const found = config.seats.find((s) => s.id === seat);
  return [...(found?.controls ?? [])] as PlayerColor[];
}

/**
 * Rebuild an engine state from a wire snapshot, for host migration.
 *
 * This works because legality depends only on the board, the config, the
 * status, and which colours are playable — and reserves are *derived* from the
 * board rather than tracked separately. So a snapshot carries everything the
 * referee needs to keep adjudicating.
 *
 * What does not survive: `history` (nothing in the protocol exposes it, so
 * nothing notices) and `result.lines` beyond the one already in the snapshot.
 * `bannedSlots` is empty because this referee never enables the centre-medium
 * handicap; if that ever becomes a room option it must be added to the wire
 * format too, or a migration would silently drop it.
 */
export function rehydrateEngine(room: RoomState): EngineState {
  const snap = room.game;
  if (!snap) throw new Error('rehydrateEngine called on a room with no game');

  const seatCount = clamp(room.players.length, MIN_PLAYERS, MAX_PLAYERS) as 2 | 3 | 4;
  const base = createConfig({
    players: seatCount,
    seed: hashSeed(room.code, 0),
    names: room.players.map((p) => p.name),
  });

  // Withdrawal removes slots from the rotation; it is not just a flag. Replay
  // that transform so the recovered turn index lands in the right cycle.
  const withdrawn = snap.forfeitedSeats;
  const config: EngineConfig = withdrawn.length
    ? Object.freeze({
        ...base,
        rotation: Object.freeze(base.rotation.filter((slot) => !withdrawn.includes(slot.seat))),
        withdrawnSeats: Object.freeze([...withdrawn]),
      })
    : base;

  // Recover the turn index by matching both seat and due colours — in the
  // official 2-player game a seat appears twice in the rotation, and only the
  // colours tell the two apart.
  const due = snap.turnColors;
  let turnIndex = config.rotation.findIndex(
    (s) => s.seat === snap.turn && s.colors.length === due.length && s.colors.every((c, i) => c === due[i]),
  );
  if (turnIndex < 0) turnIndex = config.rotation.findIndex((s) => s.seat === snap.turn);
  if (turnIndex < 0) turnIndex = 0;

  const slot = config.rotation[turnIndex];
  return Object.freeze({
    config,
    board: boardFromJSON(snap.board),
    turnIndex,
    currentSeat: slot?.seat ?? snap.turn,
    currentPlayer: (due[0] ?? slot?.colors[0] ?? 0) as Color,
    playableColors: Object.freeze((due.length ? [...due] : [...(slot?.colors ?? [])]) as Color[]),
    status: snap.phase === 'finished' ? (snap.isDraw ? 'draw' : 'won') : 'playing',
    // Cosmetic only — the winning line already crossed the wire in the snapshot.
    result: null,
    moveNumber: snap.moveCount,
    history: Object.freeze([]),
    lastMove: snap.lastMove
      ? Object.freeze({
          player: snap.lastMove.color as Color,
          space: snap.lastMove.move.cell as SpaceIndex,
          size: snap.lastMove.move.size as EngineSize,
        })
      : null,
    skipped: Object.freeze([]),
  });
}

/* ========================================================================== *
 * Small helpers
 * ========================================================================== */

export function makePlayerView(playerId: PlayerId, seat: Seat, name: string, isHost: boolean): PlayerView {
  return {
    playerId,
    seat,
    name: sanitizeName(name, `Player ${seat + 1}`),
    // Empty until the game starts: how many colours a seat controls depends on
    // the final player count, which the lobby does not know yet.
    colors: [],
    connection: 'online',
    ready: false,
    isHost,
    forfeited: false,
    rttMs: null,
    joinedAt: Date.now(),
  };
}

function isStructurallyValidMove(m: Move): boolean {
  if (typeof m !== 'object' || m === null) return false;
  if (!Number.isInteger(m.cell) || m.cell < 0 || m.cell >= BOARD_CELLS) return false;
  if (!(PIECE_SIZES as readonly string[]).includes(m.size)) return false;
  if (m.color !== undefined && !(ALL_COLORS as readonly number[]).includes(m.color)) return false;
  return true;
}

/** Deterministic seed, so replaying the same room reproduces the same game. */
export function hashSeed(code: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
