/**
 * Room registry — ownership, routing and timers for the shared referee.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * It is not a referee. An earlier version of this file implemented the whole
 * room lifecycle — seats, lobby, readiness, start, moves, rematch, pause,
 * forfeit — server-side, while `rtcTransport.ts` implemented the same thing
 * again for peer-to-peer. Two independent implementations of "when does a
 * rematch begin" and "what happens to an abandoned seat" drift, and the drift
 * shows up as the two backends playing subtly different games.
 *
 * So the rules of the room now live in exactly one place, `src/net/referee.ts`,
 * and both backends drive it through the same narrow seam:
 *
 *     handle(from: PlayerId, msg: ClientMessage) -> void
 *     send(to: PlayerId | '*', msg: ServerMessage) -> void
 *
 * What is left here is everything that *is* the server's business and which a
 * browser peer has no equivalent of: which rooms exist, which socket belongs to
 * which participant, calling `tick()` on a timer, and reclaiming memory.
 *
 * STATE LIVES IN MEMORY, AND ONLY IN MEMORY
 * -----------------------------------------
 * No database, no Redis, no disk. Rooms are a `Map` in this process:
 *
 *   - A deploy or a crash ends every game in progress. For a party game whose
 *     sessions last four minutes, that beats operating a datastore.
 *   - Horizontal scaling needs every participant in a room on the same
 *     instance. Run one instance, or route by room code. Two instances behind a
 *     round-robin load balancer will silently split rooms in half.
 *   - Memory is bounded by `maxRooms` and by the sweeper.
 */

import { TIMING, wireError } from '../../src/net/protocol.ts';
import { PeerReferee } from '../../src/net/referee.ts';
import type { RefereeHost } from '../../src/net/referee.ts';
import type {
  Capabilities,
  CreateRoomOptions,
  PlayerId,
  RoomCode,
  ServerMessage,
  WireError,
} from '../../src/net/protocol.ts';
import { generateRoomCode } from './util.ts';
import type { Logger, ServerConfig } from './util.ts';

/** How often every live referee gets a `tick()`. */
const TICK_INTERVAL_MS = 2_000;

/**
 * Where a room sends messages. Deliberately not a `WebSocket`: the registry
 * should be testable without a network, and a socket's lifecycle is
 * `session.ts`'s problem.
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

/** One live room: the referee, plus the sockets currently attached to it. */
export interface RoomEntry {
  readonly code: RoomCode;
  readonly referee: PeerReferee;
  /** Attached sockets by participant. A held seat has no entry here. */
  readonly sinks: Map<PlayerId, ClientSink>;
  readonly createdAt: number;
  /** Last time anyone was attached. Drives the empty-room sweep. */
  lastActive: number;
}

export class RoomRegistry {
  private rooms = new Map<RoomCode, RoomEntry>();
  /**
   * participant -> room code, so a reconnecting client is restored without
   * having to tell us where it was. Survives the socket, which is the point.
   */
  private locator = new Map<PlayerId, RoomCode>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private log: Logger;
  private config: ServerConfig;
  private capabilities: Capabilities;

  constructor(log: Logger, config: ServerConfig, capabilities: Capabilities) {
    this.log = log;
    this.config = config;
    this.capabilities = capabilities;
  }

  get size(): number {
    return this.rooms.size;
  }

  /* ---------------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------------- */

  create(host: RefereeHost, options: CreateRoomOptions | undefined): RoomResult<RoomEntry> {
    if (this.rooms.size >= this.config.maxRooms) {
      return fail(wireError('INTERNAL', 'the server is at capacity; try again shortly', true));
    }

    let code = generateRoomCode();
    for (let i = 0; i < 12 && this.rooms.has(code); i++) code = generateRoomCode();
    if (this.rooms.has(code)) {
      return fail(wireError('INTERNAL', 'could not allocate a room code', true));
    }

    // The send closure captures `sinks`, so the map has to exist before the
    // referee does — the referee may emit during construction.
    const sinks = new Map<PlayerId, ClientSink>();
    const referee = PeerReferee.create(code, host, options, this.capabilities, (to, msg) => {
      if (to === '*') {
        for (const sink of sinks.values()) sink.send(msg);
      } else {
        sinks.get(to)?.send(msg);
      }
    });

    const entry: RoomEntry = {
      code,
      referee,
      sinks,
      createdAt: Date.now(),
      lastActive: Date.now(),
    };
    this.rooms.set(code, entry);
    this.log.info('room: created', { code, rooms: this.rooms.size });
    return { ok: true, value: entry };
  }

  get(code: RoomCode): RoomEntry | undefined {
    return this.rooms.get(code);
  }

  /** Where this participant was last seen, for reconnection. */
  locate(playerId: PlayerId): RoomEntry | undefined {
    const code = this.locator.get(playerId);
    if (!code) return undefined;
    const entry = this.rooms.get(code);
    if (!entry) {
      this.locator.delete(playerId);
      return undefined;
    }
    // Only a genuine participant can be restored; someone who left, or a stale
    // index, must not resurrect.
    const state = entry.referee.snapshot();
    const known =
      state.players.some((p) => p.playerId === playerId) ||
      state.spectators.some((s) => s.playerId === playerId);
    if (!known) {
      this.locator.delete(playerId);
      return undefined;
    }
    return entry;
  }

  attach(entry: RoomEntry, playerId: PlayerId, sink: ClientSink): void {
    const existing = entry.sinks.get(playerId);
    if (existing && existing !== sink) {
      // A second tab, or a socket whose close has not landed yet. Newest wins:
      // that is plainly the one the player is sitting in front of.
      existing.close(4000, 'replaced by a newer connection');
    }
    entry.sinks.set(playerId, sink);
    entry.lastActive = Date.now();
    this.locator.set(playerId, entry.code);
  }

  /**
   * A socket went away.
   *
   * `deliberate` distinguishes pressing "leave" — which the referee has already
   * handled by releasing the seat — from the socket dying, which starts the
   * reconnect grace period instead. Conflating the two either strands seats or
   * loses them on a train.
   */
  detach(entry: RoomEntry, playerId: PlayerId, sink: ClientSink, deliberate: boolean): void {
    if (entry.sinks.get(playerId) !== sink) return; // Superseded by a newer socket.
    entry.sinks.delete(playerId);
    entry.lastActive = Date.now();

    if (deliberate) {
      this.locator.delete(playerId);
    } else {
      // Hold the seat. `tick()` forfeits it when the grace period lapses.
      entry.referee.setConnection(playerId, 'reconnecting');
    }

    if (this.isCollectable(entry)) this.destroy(entry.code, 'last participant left');
  }

  forget(playerId: PlayerId): void {
    this.locator.delete(playerId);
  }

  destroy(code: RoomCode, reason: string): void {
    const entry = this.rooms.get(code);
    if (!entry) return;
    this.rooms.delete(code);

    for (const sink of entry.sinks.values()) {
      sink.send({ t: 'event', kind: 'roomClosed', reason });
      sink.close(1000, reason);
    }
    entry.sinks.clear();

    for (const [playerId, c] of Array.from(this.locator)) {
      if (c === code) this.locator.delete(playerId);
    }
    this.log.info('room: destroyed', { code, reason, rooms: this.rooms.size });
  }

  /* ---------------------------------------------------------------------- *
   * Timers
   * ---------------------------------------------------------------------- */

  /**
   * Drive every referee's clock, then reclaim dead rooms.
   *
   * The referee is deliberately passive — it owns no timers, because a browser
   * peer and a Node server schedule differently and a module that calls
   * `setInterval` is a module that leaks in one of them. Everything time-based
   * (reconnect grace expiring, a rematch offer lapsing, a turn clock running
   * out) is driven from here.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    for (const entry of Array.from(this.rooms.values())) {
      try {
        entry.referee.tick(now);
      } catch (err) {
        // A defect in one room must not stop every other room's clock.
        this.log.error('room: referee.tick threw', { code: entry.code, err: String(err) });
      }
    }
    this.sweep(now);
  }

  /**
   * Without this, every abandoned room leaks for the lifetime of the process —
   * which, on a host that does not restart for weeks, is a slow-burning memory
   * leak.
   */
  private sweep(now: number): void {
    for (const [code, entry] of Array.from(this.rooms)) {
      if (this.isCollectable(entry, now)) {
        this.destroy(code, 'empty');
      } else if (now - entry.createdAt > TIMING.roomMaxLifetimeMs) {
        this.destroy(code, 'expired');
      }
    }
  }

  private isCollectable(entry: RoomEntry, now = Date.now()): boolean {
    if (entry.sinks.size > 0) return false;
    const state = entry.referee.snapshot();
    // Nobody attached and nobody left to come back for: collect immediately.
    if (state.players.length === 0 && state.spectators.length === 0) return true;
    // Seats are still held. Outlive the reconnect grace so they get their
    // chance, then collect.
    return now - entry.lastActive > TIMING.emptyRoomTtlMs;
  }

  closeAll(reason: string): void {
    for (const code of Array.from(this.rooms.keys())) this.destroy(code, reason);
  }
}
