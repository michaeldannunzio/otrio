/**
 * One connected socket: the pump between a WebSocket and the shared referee.
 *
 * Responsibilities, in order of importance:
 *
 *  1. Nothing reaches a referee until it has been validated and attributed to
 *     an authenticated identity. The `from` a message is handled under comes
 *     from *this* object, never from the message — that is the whole trust
 *     boundary in one sentence.
 *  2. Every request carrying a `rid` gets exactly one `ack`. A client that
 *     never receives one hangs until its own timeout, which looks like a
 *     network fault and is miserable to debug. The referee acks everything it
 *     handles; this file acks only what it answers itself.
 *  3. Socket lifecycle stays out of `referee.ts`, which has to run unchanged in
 *     a browser.
 *
 * WHAT THIS FILE DECIDES, AND WHAT THE REFEREE DECIDES
 * ---------------------------------------------------
 * Here: protocol version, message well-formedness, rate limiting, which room a
 * connection is pointed at, and room *allocation* (a peer-to-peer referee is
 * handed its room; a server has to mint one).
 *
 * There: everything about the game and the room — seats, readiness, turn order,
 * legality, rematch, forfeits, pauses. If a rule is being decided in this file,
 * it is in the wrong file.
 */

import {
  PROTOCOL_VERSION,
  isPlausibleRoomCode,
  sanitizeName,
  wireError,
} from '../../src/net/protocol.ts';
import type {
  Capabilities,
  ClientMessage,
  CreateRoomOptions,
  PlayerId,
  ServerMessage,
  SessionSecret,
  WireError,
} from '../../src/net/protocol.ts';
import type { ClientSink, RoomEntry, RoomRegistry } from './rooms.ts';
import { TokenBucket } from './util.ts';
import type { Logger, ServerConfig } from './util.ts';
import { parseClientMessage } from './validate.ts';

/** Minimal view of a socket, so sessions can be tested without `ws`. */
export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  readonly open: boolean;
}

/** Close codes in the application-defined 4000–4999 range. */
export const CLOSE = {
  PROTOCOL: 4001,
  RATE_LIMIT: 4002,
  BAD_MESSAGE: 4003,
  SHUTDOWN: 4004,
} as const;

export class Session implements ClientSink {
  readonly id: string;
  private socket: Socket;
  private registry: RoomRegistry;
  private log: Logger;
  private config: ServerConfig;
  private capabilities: Capabilities;

  playerId: PlayerId = '';
  private secret: SessionSecret = '';
  private name = 'Player';
  private room: RoomEntry | null = null;

  /** True once a `welcome` has gone out. Gates every other message type. */
  private ready = false;
  /**
   * Outbound messages produced before `welcome` was sent.
   *
   * Registering with a referee publishes state to everyone *including this
   * socket*, which would otherwise arrive before the handshake reply and force
   * every client to cope with out-of-order startup. Buffering keeps that
   * complexity in one place, on the side that created it.
   */
  private pendingOut: ServerMessage[] = [];
  /**
   * Suppress this many `welcome` messages.
   *
   * Registering an identity with a referee is only possible by handing it a
   * `hello`, and the referee answers every `hello` with a `welcome`. When this
   * connection has already been welcomed and is merely registering with a
   * *second* room (created or joined after the handshake), that extra welcome
   * would tell the client to re-run its connect logic — and a `welcome` with
   * `resumed: null` makes `wsTransport` think its room vanished and try to
   * rejoin. So it is swallowed.
   */
  private swallowWelcome = 0;

  private bucket = new TokenBucket(40, 20);
  private strikes = 0;
  /** Cleared by a socket-level pong; checked by the heartbeat sweep. */
  alive = true;
  private closed = false;

  constructor(
    id: string,
    socket: Socket,
    registry: RoomRegistry,
    log: Logger,
    config: ServerConfig,
    capabilities: Capabilities,
  ) {
    this.id = id;
    this.socket = socket;
    this.registry = registry;
    this.log = log;
    this.config = config;
    this.capabilities = capabilities;
  }

  /* ---------------------------------------------------------------------- *
   * ClientSink
   * ---------------------------------------------------------------------- */

  send(msg: ServerMessage): void {
    if (this.closed) return;

    if (msg.t === 'welcome') {
      if (this.swallowWelcome > 0) {
        this.swallowWelcome -= 1;
        return;
      }
      this.write(msg);
      this.ready = true;
      this.flush();
      return;
    }

    if (!this.ready && msg.t !== 'error') {
      this.pendingOut.push(msg);
      return;
    }
    this.write(msg);
  }

  private write(msg: ServerMessage): void {
    if (!this.socket.open) return;
    try {
      this.socket.send(JSON.stringify(msg));
    } catch (err) {
      this.log.warn('session: send failed', { id: this.id, err: String(err) });
    }
  }

  private flush(): void {
    const queued = this.pendingOut;
    this.pendingOut = [];
    for (const msg of queued) this.write(msg);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  /* ---------------------------------------------------------------------- *
   * Inbound
   * ---------------------------------------------------------------------- */

  handleRaw(raw: string): void {
    if (this.closed) return;

    if (!this.bucket.take()) {
      this.strikes += 1;
      this.fatal(wireError('RATE_LIMITED', 'slow down'), CLOSE.RATE_LIMIT, this.strikes >= 3);
      return;
    }

    const parsed = parseClientMessage(raw, this.config.turnTimeoutMs);
    if (!parsed.ok) {
      this.strikes += 1;
      this.log.debug('session: rejected message', { id: this.id, reason: parsed.reason });
      this.fatal(wireError('INTERNAL', parsed.reason), CLOSE.BAD_MESSAGE, this.strikes >= 5);
      return;
    }

    const msg = parsed.msg;

    if (msg.t === 'hello') {
      this.onHello(msg);
      return;
    }

    if (!this.ready) {
      this.fatal(wireError('PROTOCOL_MISMATCH', 'hello must be sent first'), CLOSE.PROTOCOL, true);
      return;
    }

    try {
      this.dispatch(msg);
    } catch (err) {
      // A defect in the referee must not take down every other room on the
      // instance. Fail this one request loudly and keep serving.
      this.log.error('session: handler threw', { id: this.id, t: msg.t, err: String(err) });
      if ('rid' in msg) this.ackErr(msg.rid, wireError('INTERNAL', 'server error'));
    }
  }

  private dispatch(msg: Exclude<ClientMessage, { t: 'hello' }>): void {
    // Room allocation is the server's job; a peer-to-peer referee is handed its
    // room at construction and has nothing to allocate.
    if (msg.t === 'createRoom') return this.onCreateRoom(msg.rid, msg.options);
    if (msg.t === 'joinRoom') return this.onJoinRoom(msg.rid, msg.code, msg.asSpectator === true);

    // `setName` has to be remembered even with no room attached, so the name is
    // right when one is created or joined later.
    if (msg.t === 'setName') this.name = sanitizeName(msg.name, this.name);

    // `ping` must work before joining anything, or the client's latency
    // indicator sits at "unknown" on the lobby screen.
    if (msg.t === 'ping' && !this.room) {
      this.write({ t: 'pong', id: msg.id, t0: msg.t0, serverTime: Date.now() });
      return;
    }

    const room = this.room;
    if (!room) {
      if ('rid' in msg) this.ackErr(msg.rid, wireError('NOT_IN_ROOM', 'not in a room'));
      return;
    }

    const wasLeaving = msg.t === 'leaveRoom';
    room.referee.handle(this.playerId, msg);

    if (wasLeaving) {
      this.room = null;
      this.registry.detach(room, this.playerId, this, true);
    }
  }

  /* ---------------------------------------------------------------------- *
   * Handshake
   * ---------------------------------------------------------------------- */

  private onHello(msg: Extract<ClientMessage, { t: 'hello' }>): void {
    if (this.ready) return; // Duplicate hello; harmless, ignore.

    // Checked here rather than in the referee so a version mismatch is refused
    // before it can touch room state at all.
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.fatal(
        wireError(
          'PROTOCOL_MISMATCH',
          `server speaks protocol ${PROTOCOL_VERSION}, client sent ${msg.protocolVersion}; reload the page`,
        ),
        CLOSE.PROTOCOL,
        true,
      );
      return;
    }

    this.playerId = msg.playerId;
    this.secret = msg.sessionSecret;
    this.name = sanitizeName(msg.name, 'Player');

    // Restore a held seat if there is one. The referee owns that decision —
    // including checking the session secret — and answers with the `welcome`
    // carrying `resumed`.
    const previous = this.registry.locate(this.playerId);
    if (previous) {
      this.registry.attach(previous, this.playerId, this);
      this.room = previous;
      previous.referee.handle(this.playerId, msg);
      if (!this.ready) {
        // The referee refused the resume (a secret mismatch sends a fatal
        // error instead of a welcome). Drop the association and let the client
        // start over rather than leaving it half-attached.
        this.registry.detach(previous, this.playerId, this, true);
        this.room = null;
      } else {
        this.log.info('session: resumed seat', {
          id: this.id,
          playerId: this.playerId,
          code: previous.code,
        });
      }
      return;
    }

    // Nothing to resume: answer the handshake ourselves so the client can get
    // on with creating or joining a room.
    this.send({
      t: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: Date.now(),
      playerId: this.playerId,
      name: this.name,
      capabilities: this.capabilities,
      resumed: null,
    });
  }

  /* ---------------------------------------------------------------------- *
   * Rooms
   * ---------------------------------------------------------------------- */

  private onCreateRoom(rid: string, options?: CreateRoomOptions): void {
    this.leaveCurrentRoom();

    const created = this.registry.create(
      { playerId: this.playerId, sessionSecret: this.secret, name: this.name },
      options,
    );
    if (!created.ok) return this.ackErr(rid, created.error);

    const entry = created.value;
    this.registry.attach(entry, this.playerId, this);
    this.room = entry;
    this.ackOk(rid, { kind: 'room', code: entry.code, state: entry.referee.snapshot() });
  }

  private onJoinRoom(rid: string, code: string, asSpectator: boolean): void {
    // Checked locally so an obvious typo costs nothing and reports precisely.
    if (!isPlausibleRoomCode(code)) {
      return this.ackErr(rid, wireError('CODE_INVALID', 'that is not a valid room code'));
    }

    const entry = this.registry.get(code);
    if (!entry) {
      return this.ackErr(rid, wireError('ROOM_NOT_FOUND', 'no room with that code'));
    }

    if (this.room && this.room !== entry) this.leaveCurrentRoom();

    this.registry.attach(entry, this.playerId, this);
    this.room = entry;

    // Register identity with *this* referee before asking for a seat: it needs
    // the display name, and it needs the session secret on file or a later
    // reconnect could not prove ownership of the seat. Handing it a `hello` is
    // the only way in, and the resulting `welcome` is redundant here.
    this.registerWithReferee(entry);

    entry.referee.handle(this.playerId, {
      t: 'joinRoom',
      rid,
      code,
      asSpectator,
    });
  }

  /** Give a referee this connection's identity, swallowing its `welcome`. */
  private registerWithReferee(entry: RoomEntry): void {
    this.swallowWelcome += 1;
    entry.referee.handle(this.playerId, {
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      playerId: this.playerId,
      sessionSecret: this.secret,
      name: this.name,
    });
    // If the referee answered with something other than a welcome (it refuses a
    // secret mismatch), the counter would leak into the next handshake.
    this.swallowWelcome = 0;
  }

  private leaveCurrentRoom(): void {
    const room = this.room;
    if (!room) return;
    this.room = null;
    room.referee.removeParticipant(this.playerId, true);
    this.registry.detach(room, this.playerId, this, true);
  }

  /** Called when the underlying socket closes for any reason. */
  onSocketClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const room = this.room;
    this.room = null;
    // Not deliberate: hold the seat and let the grace period decide.
    if (room) this.registry.detach(room, this.playerId, this, false);
  }

  /* ---------------------------------------------------------------------- *
   * Replies
   * ---------------------------------------------------------------------- */

  private ackOk(rid: string, result: Extract<ServerMessage, { t: 'ack' }>['result'] = { kind: 'ok' }): void {
    this.send({ t: 'ack', rid, ok: true, result });
  }

  private ackErr(rid: string, error: WireError): void {
    this.send({ t: 'ack', rid, ok: false, error });
  }

  private fatal(error: WireError, code: number, terminate: boolean): void {
    this.write({ t: 'error', error, fatal: terminate });
    if (terminate) {
      this.log.info('session: closing', { id: this.id, code, reason: error.code });
      this.close(code, error.code);
    }
  }
}

/** Advertised to every client during the handshake. */
export function buildCapabilities(config: ServerConfig): Capabilities {
  return {
    kind: 'hosted',
    spectators: true,
    reconnect: true,
    reconnectGraceMs: config.reconnectGraceMs,
    // The server does not vanish, so the referee role never moves. A
    // peer-to-peer backend reports `true` here; the UI reads the flag rather
    // than asking which backend it is talking to.
    hostMigration: false,
    impartialReferee: true,
    maxPlayers: 4,
  };
}

/** Socket-level heartbeat interval. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
