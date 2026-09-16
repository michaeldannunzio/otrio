/**
 * One connected socket.
 *
 * Responsibilities, in order of importance:
 *
 *  1. Nothing reaches a `Room` until it has been validated and attributed to an
 *     authenticated identity. The seat a move applies to is taken from *this*
 *     object, never from the message — that is the whole trust boundary in one
 *     sentence.
 *  2. Every request carrying a `rid` gets exactly one `ack`, success or
 *     failure. A client that never receives an ack hangs until its own timeout,
 *     which looks like a network fault and is miserable to debug.
 *  3. The socket's lifecycle is kept out of `rooms.ts`, which should be
 *     testable without a network.
 */

import {
  PROTOCOL_VERSION,
  TIMING,
  isPlausibleRoomCode,
  sanitizeName,
  wireError,
} from '../../src/net/protocol.ts';
import type {
  AckResult,
  Capabilities,
  ClientMessage,
  CreateRoomOptions,
  PlayerId,
  ServerMessage,
  SessionSecret,
  WireError,
} from '../../src/net/protocol.ts';
import type { ClientSink, Room, RoomManager, RoomResult } from './rooms.ts';
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
  private manager: RoomManager;
  private log: Logger;
  private config: ServerConfig;
  private capabilities: Capabilities;

  playerId: PlayerId = '';
  private secret: SessionSecret = '';
  private name = 'Player';
  private room: Room | null = null;

  /** True once `hello` has been answered. Gates every other message type. */
  private ready = false;
  /**
   * Outbound messages produced before `welcome` was sent.
   *
   * Joining a room publishes state to everyone *including this socket*, which
   * would otherwise arrive before the handshake reply and force every client to
   * cope with out-of-order startup. Buffering here keeps that complexity in one
   * place, on the side that created it.
   */
  private pendingOut: ServerMessage[] = [];

  private bucket = new TokenBucket(40, 20);
  private strikes = 0;
  /** Cleared by a socket-level pong; checked by the heartbeat sweep. */
  alive = true;
  private closed = false;

  constructor(
    id: string,
    socket: Socket,
    manager: RoomManager,
    log: Logger,
    config: ServerConfig,
    capabilities: Capabilities,
  ) {
    this.id = id;
    this.socket = socket;
    this.manager = manager;
    this.log = log;
    this.config = config;
    this.capabilities = capabilities;
  }

  /* ---------------------------------------------------------------------- *
   * ClientSink
   * ---------------------------------------------------------------------- */

  send(msg: ServerMessage): void {
    if (this.closed) return;
    if (!this.ready && msg.t !== 'welcome' && msg.t !== 'error') {
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
    switch (msg.t) {
      case 'createRoom':
        return this.onCreateRoom(msg.rid, msg.options);
      case 'joinRoom':
        return this.onJoinRoom(msg.rid, msg.code, msg.asSpectator === true);
      case 'leaveRoom':
        this.detachFromRoom(true);
        return this.ackOk(msg.rid);
      case 'setReady':
        return this.relay(msg.rid, (room) => room.setReady(this.playerId, msg.ready));
      case 'setName':
        this.name = sanitizeName(msg.name, this.name);
        if (!this.room) return this.ackOk(msg.rid);
        return this.relay(msg.rid, (room) => room.setName(this.playerId, this.name));
      case 'startGame':
        return this.relay(msg.rid, (room) => room.start(this.playerId));
      case 'move':
        return this.relay(msg.rid, (room) =>
          room.submitMove(this.playerId, msg.move, msg.expectedSeq),
        );
      case 'rematch':
        return this.relay(msg.rid, (room) => room.rematch(this.playerId, msg.accept));
      case 'resync':
        if (!this.room) return this.ackErr(msg.rid, wireError('NOT_IN_ROOM', 'not in a room'));
        this.room.sendStateTo(this);
        return this.ackOk(msg.rid);
      case 'ping':
        if (msg.rttMs !== undefined) this.room?.reportRtt(this.playerId, msg.rttMs);
        this.write({ t: 'pong', id: msg.id, t0: msg.t0, serverTime: Date.now() });
        return;
    }
  }

  /* ---------------------------------------------------------------------- *
   * Handshake
   * ---------------------------------------------------------------------- */

  private onHello(msg: Extract<ClientMessage, { t: 'hello' }>): void {
    if (this.ready) return; // Duplicate hello; harmless, ignore.

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

    // Restore a held seat, if there is one. Done before `welcome` is written so
    // that `resumed` carries the state the player is about to see, and the
    // broadcast this triggers is buffered until after the handshake.
    let resumed = null;
    const previous = this.manager.locate(this.playerId);
    if (previous) {
      const result = previous.join(this.playerId, this.secret, this.name, this, false);
      if (result.ok && result.value.resumed) {
        this.room = previous;
        resumed = previous.toState();
        this.log.info('session: resumed seat', {
          id: this.id,
          playerId: this.playerId,
          code: previous.code,
        });
      }
    }

    this.ready = true;
    this.write({
      t: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: Date.now(),
      playerId: this.playerId,
      name: this.name,
      capabilities: this.capabilities,
      resumed,
    });
    this.flush();
  }

  /* ---------------------------------------------------------------------- *
   * Rooms
   * ---------------------------------------------------------------------- */

  private onCreateRoom(rid: string, options?: CreateRoomOptions): void {
    this.detachFromRoom(true);

    const created = this.manager.create(options ?? {});
    if (!created.ok) return this.ackErr(rid, created.error);

    const room = created.value;
    const joined = room.join(this.playerId, this.secret, this.name, this, false);
    if (!joined.ok) {
      this.manager.destroy(room.code, 'creation failed');
      return this.ackErr(rid, joined.error);
    }

    this.room = room;
    this.manager.remember(this.playerId, room.code);
    this.ackOk(rid, { kind: 'room', code: room.code, state: room.toState() });
  }

  private onJoinRoom(rid: string, code: string, asSpectator: boolean): void {
    if (!isPlausibleRoomCode(code)) {
      return this.ackErr(rid, wireError('CODE_INVALID', 'that is not a valid room code'));
    }

    const room = this.manager.get(code);
    if (!room || room.closed) {
      return this.ackErr(rid, wireError('ROOM_NOT_FOUND', 'no room with that code'));
    }

    if (this.room && this.room !== room) this.detachFromRoom(true);

    const joined = room.join(this.playerId, this.secret, this.name, this, asSpectator);
    if (!joined.ok) return this.ackErr(rid, joined.error);

    this.room = room;
    this.manager.remember(this.playerId, room.code);
    this.ackOk(rid, { kind: 'room', code: room.code, state: room.toState() });
  }

  /**
   * Leave the current room.
   *
   * `deliberate` distinguishes pressing "leave" — which releases the seat at
   * once — from the socket dying, which starts the reconnect grace period
   * instead. Conflating the two either strands seats or loses them on a train.
   */
  private detachFromRoom(deliberate: boolean): void {
    const room = this.room;
    if (!room) return;
    this.room = null;

    if (deliberate) {
      room.leave(this.playerId);
      this.manager.forget(this.playerId);
    } else {
      room.detach(this.playerId, this);
    }

    if (room.isDeserted) this.manager.destroy(room.code, 'last participant left');
  }

  /** Called when the underlying socket closes for any reason. */
  onSocketClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachFromRoom(false);
  }

  /* ---------------------------------------------------------------------- *
   * Replies
   * ---------------------------------------------------------------------- */

  private relay(rid: string, action: (room: Room) => RoomResult): void {
    if (!this.room) return this.ackErr(rid, wireError('NOT_IN_ROOM', 'not in a room'));
    const result = action(this.room);
    if (result.ok) this.ackOk(rid);
    else this.ackErr(rid, result.error);
  }

  private ackOk(rid: string, result: AckResult = { kind: 'ok' }): void {
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

/** Re-exported so `index.ts` does not need a second import of the timings. */
export const HEARTBEAT_INTERVAL_MS = Math.max(5_000, Math.floor(TIMING.idleTimeoutMs / 2));
