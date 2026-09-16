/**
 * Room lifecycle and authoritative refereeing.
 *
 * STATE LIVES IN MEMORY, AND ONLY IN MEMORY
 * -----------------------------------------
 * There is no database, no Redis, no disk. Rooms are a `Map` in this process.
 * The consequences, stated plainly because they are design decisions rather
 * than oversights:
 *
 *   - A deploy or a crash ends every game in progress. For a party game whose
 *     sessions last four minutes, that is an acceptable trade against operating
 *     a datastore, and it is why the reconnect grace period is measured in
 *     seconds rather than minutes.
 *   - Horizontal scaling requires all participants in a room to land on the
 *     same instance. Run one instance, or route by room code. Two instances
 *     behind a round-robin load balancer will silently split rooms in half.
 *   - Memory is bounded by `maxRooms` and by the sweeper, which collects empty
 *     rooms after `TIMING.emptyRoomTtlMs` and any room after
 *     `TIMING.roomMaxLifetimeMs`.
 *
 * AUTHORITY
 * ---------
 * This module is the referee. It holds the engine state; clients hold pictures
 * of it. Every mutation happens here, is validated here against server-side
 * state, and is published as a whole `RoomState` with an incremented `seq`.
 *
 * No client input is ever trusted beyond its shape:
 *   - `expectedSeq` on a move is logged, never believed.
 *   - The moving seat comes from the authenticated connection, never from the
 *     message.
 *   - Legality comes from the rules engine, never from the client.
 *   - Turn order comes from the engine, never from the client.
 */

import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  TIMING,
  sanitizeName,
  wireError,
} from '../../src/net/protocol.ts';
import type {
  ConnectionState,
  CreateRoomOptions,
  EventMsg,
  GameEndReason,
  GameSnapshot,
  Move,
  PauseState,
  PlayerColor,
  PlayerId,
  PlayerView,
  RoomCode,
  RoomState,
  Seat,
  ServerMessage,
  SessionSecret,
  SpectatorView,
  WireError,
} from '../../src/net/protocol.ts';
import type { EngineGame, OtrioRules } from './rules.ts';
import { Cancelable, generateRoomCode } from './util.ts';
import type { Logger, ServerConfig } from './util.ts';

/** Most spectators one room will hold. Bounds broadcast fan-out. */
const MAX_SPECTATORS = 16;

/** Guard against an engine that never advances past a forfeited seat. */
const MAX_AUTOPLAY_STEPS = 32;

/**
 * Where a room sends messages. Deliberately not a `WebSocket`: rooms should be
 * testable without a network, and the socket's lifecycle is `session.ts`'s
 * problem.
 */
export interface ClientSink {
  readonly id: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export type RoomResult<T = void> = { ok: true; value: T } | { ok: false; error: WireError };

function fail<T>(error: WireError): RoomResult<T> {
  return { ok: false, error };
}

interface SeatRecord {
  playerId: PlayerId;
  sessionSecret: SessionSecret;
  name: string;
  seat: Seat;
  ready: boolean;
  forfeited: boolean;
  connection: ConnectionState;
  rttMs: number | null;
  joinedAt: number;
  sink: ClientSink | null;
  grace: Cancelable;
}

interface SpectatorRecord {
  playerId: PlayerId;
  sessionSecret: SessionSecret;
  name: string;
  joinedAt: number;
  sink: ClientSink | null;
}

/* ========================================================================== *
 * Room
 * ========================================================================== */

export class Room {
  readonly code: RoomCode;
  readonly createdAt = Date.now();

  seq = 0;
  phase: RoomState['phase'] = 'lobby';
  hostPlayerId: PlayerId = '';
  maxPlayers: number;
  allowSpectators: boolean;
  turnTimeoutMs: number;
  endReason: GameEndReason | null = null;

  private players: SeatRecord[] = [];
  private spectators = new Map<PlayerId, SpectatorRecord>();
  private game: EngineGame | null = null;
  private pause: PauseState | null = null;
  private rematchState: RoomState['rematch'] = null;

  private turnTimer = new Cancelable();
  private rematchTimer = new Cancelable();
  private turnDeadline: number | null = null;
  /** Games played in this room. Seeds the opening turn so a rematch differs. */
  private gameNumber = 0;

  private rules: OtrioRules;
  private log: Logger;
  private config: ServerConfig;

  /** Set by the manager when the room should be collected. */
  closed = false;

  constructor(
    code: RoomCode,
    options: CreateRoomOptions,
    rules: OtrioRules,
    log: Logger,
    config: ServerConfig,
  ) {
    this.code = code;
    this.rules = rules;
    this.log = log;
    this.config = config;
    this.maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
    this.allowSpectators = options.allowSpectators !== false;
    this.turnTimeoutMs = options.turnTimeoutMs ?? config.turnTimeoutMs;
  }

  /* ---------------------------------------------------------------------- *
   * Projection
   * ---------------------------------------------------------------------- */

  /**
   * Build the wire snapshot.
   *
   * Note what never appears here: `sessionSecret`, `sink`, engine internals.
   * This object is broadcast to everyone in the room including spectators, so
   * anything secret would be secret no longer.
   */
  toState(): RoomState {
    return {
      code: this.code,
      seq: this.seq,
      phase: this.phase,
      hostPlayerId: this.hostPlayerId,
      players: this.players.map((p) => this.viewOf(p)),
      spectators: Array.from(this.spectators.values()).map(
        (s): SpectatorView => ({ playerId: s.playerId, name: s.name, joinedAt: s.joinedAt }),
      ),
      maxPlayers: this.maxPlayers,
      allowSpectators: this.allowSpectators,
      game: this.snapshot(),
      turnDeadline: this.turnDeadline,
      pause: this.pause,
      rematch: this.rematchState,
      endReason: this.endReason,
      updatedAt: Date.now(),
    };
  }

  /**
   * Project a seat for broadcast.
   *
   * `colors` comes from the engine once a game exists, because the seat-to-
   * colour mapping is the engine's to decide — in the official 2-player game a
   * seat holds two colours on opposite arms, which no amount of arithmetic on
   * the seat index will tell you. Before the game starts there is no mapping
   * yet, so the lobby shows the provisional `seat n -> colour n`; it may change
   * when play begins, and the UI should read it from here rather than caching.
   */
  private viewOf(p: SeatRecord): PlayerView {
    const colors =
      this.game !== null ? this.rules.colorsForSeat(this.game, p.seat) : [p.seat as PlayerColor];
    return {
      playerId: p.playerId,
      seat: p.seat,
      name: p.name,
      colors,
      connection: p.connection,
      ready: p.ready,
      isHost: p.playerId === this.hostPlayerId,
      forfeited: p.forfeited,
      rttMs: p.rttMs,
      joinedAt: p.joinedAt,
    };
  }

  private snapshot(): GameSnapshot | null {
    if (this.game === null) return null;
    let snap: GameSnapshot;
    try {
      snap = this.rules.snapshot(this.game);
    } catch (err) {
      this.log.error('room: rules.snapshot threw', { code: this.code, err: String(err) });
      return null;
    }
    // `reserves`, `lastMove` and the colour mapping all come from the engine
    // now — it is the only thing that knows which colours a seat holds.
    //
    // The one field the server still owns is `forfeitedSeats`: a player can be
    // marked forfeited here a moment before (or without) the engine's
    // `withdraw` succeeding, so take the union rather than trusting either
    // alone. Copied rather than mutated in place, because the engine is written
    // in a frozen-immutable style and assigning into its result would throw.
    const forfeited = new Set<number>(snap.forfeitedSeats);
    for (const p of this.players) if (p.forfeited) forfeited.add(p.seat);

    return { ...snap, forfeitedSeats: Array.from(forfeited).sort((a, b) => a - b) };
  }

  /* ---------------------------------------------------------------------- *
   * Publishing
   * ---------------------------------------------------------------------- */

  /**
   * Increment `seq` and broadcast the new state, followed by any events.
   *
   * State first, events second, always. The transport contract promises that
   * when an event handler runs, the snapshot already reflects the change —
   * which is only true if the state message is on the wire first.
   */
  publish(...events: EventMsg[]): void {
    if (this.closed) return;
    this.seq += 1;
    const state = this.toState();
    this.broadcast({ t: 'state', state });
    for (const ev of events) this.broadcast(ev);
  }

  /** Send to every attached socket, players and spectators alike. */
  broadcast(msg: ServerMessage): void {
    for (const p of this.players) p.sink?.send(msg);
    for (const s of this.spectators.values()) s.sink?.send(msg);
  }

  /* ---------------------------------------------------------------------- *
   * Membership
   * ---------------------------------------------------------------------- */

  get playerCount(): number {
    return this.players.length;
  }

  get isEmpty(): boolean {
    return (
      this.players.every((p) => p.sink === null) &&
      Array.from(this.spectators.values()).every((s) => s.sink === null)
    );
  }

  get isDeserted(): boolean {
    return this.players.length === 0 && this.spectators.size === 0;
  }

  findPlayer(playerId: PlayerId): SeatRecord | undefined {
    return this.players.find((p) => p.playerId === playerId);
  }

  hasMember(playerId: PlayerId): boolean {
    return this.findPlayer(playerId) !== undefined || this.spectators.has(playerId);
  }

  /**
   * Seat a new player, or reattach one who is already seated.
   *
   * Reattachment requires the matching `sessionSecret`. Without that check, any
   * spectator could read a `playerId` out of the broadcast state and claim that
   * seat — the seat is the thing worth stealing, so it is the thing that needs
   * a credential.
   */
  join(
    playerId: PlayerId,
    secret: SessionSecret,
    name: string,
    sink: ClientSink,
    asSpectator: boolean,
  ): RoomResult<{ resumed: boolean }> {
    if (this.closed) return fail(wireError('ROOM_CLOSED', 'room has closed'));

    const existingSeat = this.findPlayer(playerId);
    if (existingSeat) {
      if (existingSeat.sessionSecret !== secret) {
        return fail(wireError('SEAT_TAKEN', 'that seat belongs to another session'));
      }
      this.attach(existingSeat, sink, name);
      return { ok: true, value: { resumed: true } };
    }

    const existingSpectator = this.spectators.get(playerId);
    if (existingSpectator) {
      if (existingSpectator.sessionSecret !== secret) {
        return fail(wireError('SEAT_TAKEN', 'that identity is in use'));
      }
      existingSpectator.sink?.close(4000, 'replaced by a newer connection');
      existingSpectator.sink = sink;
      existingSpectator.name = sanitizeName(name, existingSpectator.name);
      this.publish();
      return { ok: true, value: { resumed: true } };
    }

    if (asSpectator) {
      if (!this.allowSpectators) {
        return fail(wireError('UNSUPPORTED', 'this room does not allow spectators'));
      }
      if (this.spectators.size >= MAX_SPECTATORS) {
        return fail(wireError('ROOM_FULL', 'spectator limit reached'));
      }
      this.spectators.set(playerId, {
        playerId,
        sessionSecret: secret,
        name: sanitizeName(name),
        joinedAt: Date.now(),
        sink,
      });
      this.publish();
      return { ok: true, value: { resumed: false } };
    }

    if (this.phase !== 'lobby') {
      return fail(wireError('ALREADY_STARTED', 'the game has already started'));
    }
    if (this.players.length >= this.maxPlayers) {
      return fail(wireError('ROOM_FULL', 'every seat is taken'));
    }

    const record: SeatRecord = {
      playerId,
      sessionSecret: secret,
      name: sanitizeName(name),
      seat: this.players.length,
      ready: false,
      forfeited: false,
      connection: 'online',
      rttMs: null,
      joinedAt: Date.now(),
      sink,
      grace: new Cancelable(),
    };
    this.players.push(record);
    if (this.hostPlayerId === '') this.hostPlayerId = playerId;

    this.publish({ t: 'event', kind: 'playerJoined', player: this.viewOf(record) });
    return { ok: true, value: { resumed: false } };
  }

  /** Reattach a socket to a seat that was being held. */
  private attach(record: SeatRecord, sink: ClientSink, name: string): void {
    const wasAway = record.connection !== 'online';
    if (record.sink && record.sink !== sink) {
      // A second tab, or a socket whose close has not landed yet. The newest
      // connection wins: the player is plainly at the keyboard of that one.
      record.sink.close(4000, 'replaced by a newer connection');
    }
    record.grace.cancel();
    record.sink = sink;
    record.connection = 'online';
    record.name = sanitizeName(name, record.name);

    if (wasAway) {
      this.clearPauseFor(record.playerId);
      this.publish(
        { t: 'event', kind: 'playerReconnected', playerId: record.playerId, name: record.name },
        { t: 'event', kind: 'connectionChanged', playerId: record.playerId, connection: 'online' },
      );
    } else {
      this.publish();
    }
  }

  /**
   * A socket went away. The seat is held for the grace period rather than
   * released, because the overwhelming majority of drops are a phone locking,
   * a tab refreshing, or a train entering a tunnel.
   */
  detach(playerId: PlayerId, sink: ClientSink): void {
    const spectator = this.spectators.get(playerId);
    if (spectator) {
      if (spectator.sink !== sink) return;
      this.spectators.delete(playerId);
      this.publish();
      return;
    }

    const record = this.findPlayer(playerId);
    if (!record || record.sink !== sink) return; // Superseded by a newer socket.

    record.sink = null;
    record.connection = 'reconnecting';

    // Also while already paused: a second player dropping must be added to
    // `waitingFor`, or the first one reconnecting would resume a game that is
    // still a player short.
    if (this.phase === 'playing' || this.phase === 'paused') {
      this.pauseFor(record.playerId);
    }

    record.grace.set(() => this.onGraceExpired(playerId), this.config.reconnectGraceMs);

    this.publish(
      { t: 'event', kind: 'connectionChanged', playerId, connection: 'reconnecting' },
      { t: 'event', kind: 'playerLeft', playerId, name: record.name, permanent: false },
    );
  }

  /** Deliberate exit. No grace: they chose to go. */
  leave(playerId: PlayerId): void {
    const spectator = this.spectators.get(playerId);
    if (spectator) {
      this.spectators.delete(playerId);
      this.publish();
      return;
    }
    const record = this.findPlayer(playerId);
    if (!record) return;
    record.grace.cancel();
    record.sink = null;
    this.removeOrForfeit(record, 'left');
  }

  private onGraceExpired(playerId: PlayerId): void {
    const record = this.findPlayer(playerId);
    if (!record || record.connection === 'online') return;
    this.log.info('room: reconnect grace expired', { code: this.code, playerId });
    this.removeOrForfeit(record, 'timed out');
  }

  /**
   * Resolve a player who is gone for good.
   *
   * In the lobby the seat is simply removed and the remaining seats compact, so
   * colours stay contiguous. Once a game is underway seats cannot be renumbered
   * — the engine and every client index by seat — so the player is marked
   * forfeited instead and their pieces stay on the board as blockers.
   */
  private removeOrForfeit(record: SeatRecord, why: string): void {
    const events: EventMsg[] = [
      { t: 'event', kind: 'playerLeft', playerId: record.playerId, name: record.name, permanent: true },
    ];

    if (this.phase === 'lobby') {
      this.players = this.players.filter((p) => p.playerId !== record.playerId);
      this.players.forEach((p, i) => {
        p.seat = i;
      });
      const hostEvent = this.ensureHost();
      if (hostEvent) events.push(hostEvent);
      this.publish(...events);
      return;
    }

    record.forfeited = true;
    record.connection = 'offline';
    record.ready = false;
    this.clearPauseFor(record.playerId);

    const hostEvent = this.ensureHost();
    if (hostEvent) events.push(hostEvent);

    if (this.phase === 'finished') {
      this.publish(...events);
      return;
    }

    const active = this.players.filter((p) => !p.forfeited);
    if (active.length < MIN_PLAYERS) {
      // Nobody left to play against. The last player standing takes it.
      const winner = active.length === 1 ? active[0].seat : null;
      this.finish('opponents-left', winner, events);
      return;
    }

    // Try to remove the seat from the rotation properly. If the engine cannot,
    // fall through to auto-playing their turns, which keeps the remaining
    // players' game finishable without inventing rules the engine does not have.
    // Remove the seat from the turn rotation so play continues without it.
    // Throws only when asked to remove the last seat, which the guard above
    // already prevents; if it ever does, fall through to auto-playing their
    // turns rather than wedging the room.
    try {
      this.game = this.rules.withdraw(this.game, record.seat);
    } catch (err) {
      this.log.warn('room: withdraw refused; falling back to auto-play', {
        code: this.code,
        err: String(err),
      });
    }

    this.log.info('room: player forfeited', { code: this.code, playerId: record.playerId, why });
    this.afterGameMutation(events);
  }

  /** Promote a connected player to host when the current one is gone. */
  private ensureHost(): EventMsg | null {
    const host = this.findPlayer(this.hostPlayerId);
    if (host && !host.forfeited && host.connection !== 'offline') return null;

    const candidate =
      this.players.find((p) => !p.forfeited && p.connection === 'online') ??
      this.players.find((p) => !p.forfeited);

    if (!candidate) {
      this.hostPlayerId = '';
      return null;
    }
    this.hostPlayerId = candidate.playerId;
    return { t: 'event', kind: 'hostChanged', playerId: candidate.playerId, name: candidate.name };
  }

  /* ---------------------------------------------------------------------- *
   * Pause
   * ---------------------------------------------------------------------- */

  private pauseFor(playerId: PlayerId): void {
    this.turnTimer.cancel();
    const waitingFor = this.pause ? Array.from(new Set([...this.pause.waitingFor, playerId])) : [playerId];
    this.pause = {
      reason: 'player-disconnected',
      waitingFor,
      resumesAt: Date.now() + this.config.reconnectGraceMs,
    };
    this.phase = 'paused';
  }

  private clearPauseFor(playerId: PlayerId): void {
    if (!this.pause) return;
    const waitingFor = this.pause.waitingFor.filter((id) => id !== playerId);
    if (waitingFor.length > 0) {
      this.pause = { ...this.pause, waitingFor };
      return;
    }
    this.pause = null;
    if (this.phase === 'paused') {
      this.phase = this.game !== null && !this.safeIsFinished() ? 'playing' : 'finished';
      if (this.phase === 'playing') this.armTurnTimer();
    }
  }

  /* ---------------------------------------------------------------------- *
   * Lobby actions
   * ---------------------------------------------------------------------- */

  setReady(playerId: PlayerId, ready: boolean): RoomResult {
    const record = this.findPlayer(playerId);
    if (!record) return fail(wireError('SPECTATOR_FORBIDDEN', 'spectators cannot ready up'));
    if (this.phase !== 'lobby') return { ok: true, value: undefined };
    record.ready = ready;
    this.publish();
    return { ok: true, value: undefined };
  }

  setName(playerId: PlayerId, name: string): RoomResult {
    const clean = sanitizeName(name);
    const record = this.findPlayer(playerId);
    if (record) {
      record.name = clean;
    } else {
      const spectator = this.spectators.get(playerId);
      if (!spectator) return fail(wireError('NOT_IN_ROOM', 'not in this room'));
      spectator.name = clean;
    }
    this.publish();
    return { ok: true, value: undefined };
  }

  /**
   * Begin play. Host only.
   *
   * Requires every *other* seated player to be ready; the host's intent is
   * expressed by pressing the button.
   */
  start(playerId: PlayerId): RoomResult {
    if (playerId !== this.hostPlayerId) {
      return fail(wireError('NOT_HOST', 'only the host can start the game'));
    }
    if (this.phase !== 'lobby') {
      return fail(wireError('ALREADY_STARTED', 'the game has already started'));
    }
    if (this.players.length < MIN_PLAYERS) {
      return fail(wireError('NOT_ENOUGH_PLAYERS', `need at least ${MIN_PLAYERS} players`));
    }
    const notReady = this.players.filter((p) => p.playerId !== this.hostPlayerId && !p.ready);
    if (notReady.length > 0) {
      return fail(
        wireError('NOT_ENOUGH_PLAYERS', `waiting for ${notReady.map((p) => p.name).join(', ')}`),
      );
    }

    try {
      this.game = this.rules.createGame(
        this.players.length,
        this.rules.seedForRoom(this.code, this.gameNumber),
      );
      this.gameNumber += 1;
    } catch (err) {
      this.log.error('room: createGame threw', { code: this.code, err: String(err) });
      return fail(wireError('INTERNAL', 'could not start the game'));
    }

    this.phase = 'playing';
    this.endReason = null;
    this.rematchState = null;
    this.rematchTimer.cancel();
    for (const p of this.players) p.ready = true;
    this.armTurnTimer();

    this.publish({ t: 'event', kind: 'gameStarted', seq: this.seq + 1 });
    return { ok: true, value: undefined };
  }

  /* ---------------------------------------------------------------------- *
   * Play
   * ---------------------------------------------------------------------- */

  /**
   * Validate and apply a move. The single most security-relevant method here.
   *
   * `seat` comes from the authenticated connection's seat record, never from
   * the message. `expectedSeq` is accepted from the client purely so a race can
   * be logged; it is not consulted when deciding whether the move is allowed.
   */
  submitMove(playerId: PlayerId, move: Move, expectedSeq?: number): RoomResult {
    const record = this.findPlayer(playerId);
    if (!record) return fail(wireError('SPECTATOR_FORBIDDEN', 'spectators cannot move'));
    if (this.phase === 'paused') {
      return fail(wireError('GAME_NOT_ACTIVE', 'the game is paused'));
    }
    if (this.phase !== 'playing' || this.game === null) {
      return fail(wireError('GAME_NOT_ACTIVE', 'no game in progress'));
    }
    if (record.forfeited) {
      return fail(wireError('SPECTATOR_FORBIDDEN', 'you are no longer in this game'));
    }

    const turn = this.safeCurrentSeat();
    if (turn !== record.seat) {
      if (expectedSeq !== undefined && expectedSeq !== this.seq) {
        this.log.debug('room: move raced a state update', {
          code: this.code,
          playerId,
          expectedSeq,
          actualSeq: this.seq,
        });
      }
      return fail(wireError('NOT_YOUR_TURN', 'it is not your turn'));
    }

    const result = this.applyToEngine(record.seat, move);
    if (!result.ok) {
      return fail(wireError('ILLEGAL_MOVE', result.reason));
    }

    this.afterGameMutation([
      { t: 'event', kind: 'moveApplied', seat: record.seat, move, seq: this.seq + 1 },
    ]);
    return { ok: true, value: undefined };
  }

  private applyToEngine(seat: Seat, move: Move): { ok: true } | { ok: false; reason: string } {
    try {
      const result = this.rules.applyMove(this.game, seat, move);
      if (!result.ok) return { ok: false, reason: result.reason };
      this.game = result.game;
      return { ok: true };
    } catch (err) {
      // An engine that throws where it should reject is a bug, but it must not
      // take the server down or corrupt the room — treat it as a rejection.
      this.log.warn('room: rules.applyMove threw', { code: this.code, err: String(err) });
      return { ok: false, reason: 'rejected by rules engine' };
    }
  }

  /**
   * Shared tail of every state-advancing action: resolve auto-play for absent
   * seats, check for an ending, re-arm the clock, publish once.
   *
   * Everything funnels through here so there is exactly one place where "the
   * game moved forward" is handled, rather than three subtly different ones.
   */
  private afterGameMutation(events: EventMsg[]): void {
    this.autoPlayAbsentSeats(events);

    // `autoPlayAbsentSeats` can end the game, and `finish` publishes. Bail out
    // rather than publishing the same events a second time.
    if (this.phase === 'finished') return;

    if (this.safeIsFinished()) {
      const snap = this.snapshot();
      const winner = snap?.winner ?? null;
      this.finish(winner !== null ? 'win' : 'draw', winner, events);
      return;
    }

    if (this.phase === 'playing') this.armTurnTimer();
    this.publish(...events);
  }

  /**
   * Play on behalf of seats nobody is sitting in.
   *
   * Only reached when the engine has no `withdraw`. The move chosen is the
   * first structurally legal one in ascending cell, then ascending size order —
   * deterministic rather than random, so the same move log always reproduces
   * the same game, which is what makes a desync debuggable.
   */
  private autoPlayAbsentSeats(events: EventMsg[]): void {
    for (let i = 0; i < MAX_AUTOPLAY_STEPS; i++) {
      if (this.game === null || this.safeIsFinished()) return;
      const turn = this.safeCurrentSeat();
      const record = this.players.find((p) => p.seat === turn);
      if (!record || !record.forfeited) return;

      if (!this.playForcedMove(turn, events)) return;
    }
    this.log.warn('room: auto-play guard tripped', { code: this.code });
  }

  /**
   * Place the first legal move for `seat`. Candidates are enumerated
   * structurally but each is still submitted to the engine, so the engine
   * remains the authority on legality.
   */
  private playForcedMove(seat: Seat, events: EventMsg[]): boolean {
    let candidates: Move[];
    try {
      candidates = this.rules.legalMoves(this.game, seat);
    } catch (err) {
      this.log.warn('room: legalMoves threw', { code: this.code, err: String(err) });
      return false;
    }

    for (const move of candidates) {
      const result = this.applyToEngine(seat, move);
      if (result.ok) {
        events.push({ t: 'event', kind: 'moveApplied', seat, move, seq: this.seq + 1 });
        return true;
      }
    }

    // No legal move: the seat's reserve is exhausted but the engine still
    // believes it is their turn. Nothing sensible remains — end the game.
    this.log.warn('room: no legal move for seat, ending game', { code: this.code, seat });
    this.finish('opponents-left', null, events);
    return false;
  }

  private finish(reason: GameEndReason, winner: Seat | null, events: EventMsg[]): void {
    if (this.phase === 'finished') {
      this.publish(...events);
      return;
    }
    this.turnTimer.cancel();
    this.turnDeadline = null;
    this.phase = 'finished';
    this.endReason = reason;
    this.pause = null;
    const snap = this.snapshot();
    events.push({
      t: 'event',
      kind: 'gameEnded',
      reason,
      winner: winner ?? snap?.winner ?? null,
      line: snap?.winningLine ?? null,
    });
    this.publish(...events);
  }

  /* ---------------------------------------------------------------------- *
   * Turn clock
   * ---------------------------------------------------------------------- */

  private armTurnTimer(): void {
    this.turnTimer.cancel();
    if (this.turnTimeoutMs <= 0 || this.phase !== 'playing') {
      this.turnDeadline = null;
      return;
    }
    this.turnDeadline = Date.now() + this.turnTimeoutMs;
    this.turnTimer.set(() => this.onTurnTimeout(), this.turnTimeoutMs);
  }

  /**
   * The clock ran out. Otrio has no legal pass — a player always has a move
   * available until their reserve is empty — so the referee plays the
   * deterministic first legal move for them, per `TURN_TIMEOUT_POLICY`.
   */
  private onTurnTimeout(): void {
    if (this.phase !== 'playing' || this.game === null) return;
    const seat = this.safeCurrentSeat();
    this.log.info('room: turn timed out', { code: this.code, seat });
    const events: EventMsg[] = [];
    if (this.playForcedMove(seat, events)) {
      this.afterGameMutation(events);
    }
  }

  /* ---------------------------------------------------------------------- *
   * Rematch
   * ---------------------------------------------------------------------- */

  /**
   * Offer or accept a rematch. Once every remaining player agrees, the board
   * resets while seats, room code and `seq` carry on — `seq` never restarts,
   * because clients discard snapshots that do not move it forward.
   */
  rematch(playerId: PlayerId, accept: boolean): RoomResult {
    const record = this.findPlayer(playerId);
    if (!record) return fail(wireError('SPECTATOR_FORBIDDEN', 'spectators cannot request a rematch'));
    if (this.phase !== 'finished') {
      return fail(wireError('GAME_NOT_ACTIVE', 'the game has not finished'));
    }

    if (!accept) {
      this.rematchState = null;
      this.rematchTimer.cancel();
      this.publish();
      return { ok: true, value: undefined };
    }

    if (!this.rematchState) {
      this.rematchState = {
        requestedBy: playerId,
        accepted: [playerId],
        expiresAt: Date.now() + TIMING.rematchTtlMs,
      };
      this.rematchTimer.set(() => {
        this.rematchState = null;
        this.publish();
      }, TIMING.rematchTtlMs);
    } else if (!this.rematchState.accepted.includes(playerId)) {
      this.rematchState = {
        ...this.rematchState,
        accepted: [...this.rematchState.accepted, playerId],
      };
    }

    const eligible = this.players.filter((p) => !p.forfeited && p.connection !== 'offline');
    const everyone = eligible.every((p) => this.rematchState!.accepted.includes(p.playerId));

    if (everyone && eligible.length >= MIN_PLAYERS) {
      return this.resetForRematch();
    }

    this.publish();
    return { ok: true, value: undefined };
  }

  private resetForRematch(): RoomResult {
    // Players who abandoned the last game do not come back for the next one.
    this.players = this.players.filter((p) => !p.forfeited && p.connection !== 'offline');
    this.players.forEach((p, i) => {
      p.seat = i;
      p.ready = true;
      p.forfeited = false;
    });

    if (this.players.length < MIN_PLAYERS) {
      this.rematchState = null;
      this.phase = 'lobby';
      this.publish();
      return fail(wireError('NOT_ENOUGH_PLAYERS', 'not enough players for a rematch'));
    }

    try {
      this.game = this.rules.createGame(
        this.players.length,
        this.rules.seedForRoom(this.code, this.gameNumber),
      );
      this.gameNumber += 1;
    } catch (err) {
      this.log.error('room: createGame threw on rematch', { code: this.code, err: String(err) });
      return fail(wireError('INTERNAL', 'could not start the rematch'));
    }

    this.rematchTimer.cancel();
    this.rematchState = null;
    this.endReason = null;
    this.pause = null;
    this.phase = 'playing';
    this.ensureHost();
    this.armTurnTimer();

    this.publish({ t: 'event', kind: 'gameStarted', seq: this.seq + 1 });
    return { ok: true, value: undefined };
  }

  /* ---------------------------------------------------------------------- *
   * Misc
   * ---------------------------------------------------------------------- */

  /** Record a latency sample reported by a client, for the others to see. */
  reportRtt(playerId: PlayerId, rttMs: number): void {
    const record = this.findPlayer(playerId);
    if (!record) return;
    // Not published immediately: a latency tick is not worth a broadcast and a
    // `seq` bump every three seconds per player. It rides along with the next
    // real change.
    record.rttMs = rttMs;
  }

  /** Send the current state to one socket, without bumping `seq`. */
  sendStateTo(sink: ClientSink): void {
    sink.send({ t: 'state', state: this.toState() });
  }

  /** Tear the room down and disconnect everyone still attached. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.turnTimer.cancel();
    this.rematchTimer.cancel();
    for (const p of this.players) p.grace.cancel();
    this.broadcast({ t: 'event', kind: 'roomClosed', reason });
    for (const p of this.players) p.sink?.close(1000, reason);
    for (const s of this.spectators.values()) s.sink?.close(1000, reason);
    this.players = [];
    this.spectators.clear();
  }

  private safeCurrentSeat(): Seat {
    try {
      return this.rules.currentSeat(this.game);
    } catch {
      return this.snapshot()?.turn ?? 0;
    }
  }

  private safeIsFinished(): boolean {
    try {
      return this.rules.isFinished(this.game);
    } catch {
      return this.snapshot()?.phase === 'finished';
    }
  }
}

/* ========================================================================== *
 * RoomManager
 * ========================================================================== */

/**
 * Owns every room in the process, plus the index from player to room that makes
 * reconnection work without the client having to say where it was.
 */
export class RoomManager {
  private rooms = new Map<RoomCode, Room>();
  /** playerId → room code. Lets a reconnecting client be restored from `hello`. */
  private locator = new Map<PlayerId, RoomCode>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  private rules: OtrioRules;
  private log: Logger;
  private config: ServerConfig;

  constructor(rules: OtrioRules, log: Logger, config: ServerConfig) {
    this.rules = rules;
    this.log = log;
    this.config = config;
  }

  get size(): number {
    return this.rooms.size;
  }

  create(options: CreateRoomOptions): RoomResult<Room> {
    if (this.rooms.size >= this.config.maxRooms) {
      return fail(wireError('INTERNAL', 'the server is at capacity; try again shortly', true));
    }
    let code = generateRoomCode();
    for (let i = 0; i < 12 && this.rooms.has(code); i++) code = generateRoomCode();
    if (this.rooms.has(code)) {
      return fail(wireError('INTERNAL', 'could not allocate a room code', true));
    }
    const room = new Room(code, options, this.rules, this.log, this.config);
    this.rooms.set(code, room);
    this.log.info('room: created', { code, rooms: this.rooms.size });
    return { ok: true, value: room };
  }

  get(code: RoomCode): Room | undefined {
    return this.rooms.get(code);
  }

  /** Where this player was last seen, for reconnection. */
  locate(playerId: PlayerId): Room | undefined {
    const code = this.locator.get(playerId);
    if (!code) return undefined;
    const room = this.rooms.get(code);
    if (!room || room.closed || !room.hasMember(playerId)) {
      this.locator.delete(playerId);
      return undefined;
    }
    return room;
  }

  remember(playerId: PlayerId, code: RoomCode): void {
    this.locator.set(playerId, code);
  }

  forget(playerId: PlayerId): void {
    this.locator.delete(playerId);
  }

  destroy(code: RoomCode, reason: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.close(reason);
    this.rooms.delete(code);
    for (const [playerId, c] of this.locator) {
      if (c === code) this.locator.delete(playerId);
    }
    this.log.info('room: destroyed', { code, reason, rooms: this.rooms.size });
  }

  /**
   * Periodic cleanup. Without this, every abandoned room leaks for the lifetime
   * of the process — which, on a host that does not restart for weeks, is a
   * memory leak with a long fuse.
   */
  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    if (typeof this.sweeper === 'object' && this.sweeper !== null && 'unref' in this.sweeper) {
      (this.sweeper as unknown as { unref: () => void }).unref();
    }
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.isDeserted || (room.isEmpty && now - room.createdAt > TIMING.emptyRoomTtlMs)) {
        this.destroy(code, 'empty');
      } else if (now - room.createdAt > TIMING.roomMaxLifetimeMs) {
        this.destroy(code, 'expired');
      }
    }
  }

  closeAll(reason: string): void {
    for (const code of Array.from(this.rooms.keys())) this.destroy(code, reason);
  }
}
