/**
 * Hosted backend: a WebSocket link to the authoritative server in `server/`.
 *
 * Implements `Transport` exactly as specified in `transport.ts`. Read that file
 * first — this one is the mechanics, that one is the contract.
 *
 * WHAT THIS CLIENT DOES NOT DO
 * ----------------------------
 * It does not know the rules of Otrio. It never decides whose turn it is,
 * whether a placement is legal, or who won. It sends intents and renders the
 * snapshots that come back. The entire game logic on this side of the wire is
 * "apply the state if its `seq` moved forward".
 *
 * That is not laziness — it is what makes the two backends interchangeable. Any
 * rules knowledge that leaked into here would have to be duplicated, exactly,
 * in `rtcTransport.ts`, and the two copies would drift.
 *
 * BEHAVIOUR THIS IMPLEMENTATION CHOOSES
 * -------------------------------------
 * The contract permits either queueing or rejecting commands issued while the
 * link is down. This implementation **rejects** them with `CONNECTION_LOST`,
 * immediately. A queued move that lands four seconds later, after two other
 * players have moved, is worse than an honest failure — and clearing the ghost
 * piece at once tells the player what actually happened.
 *
 * The exceptions are `connect`, `createRoom` and `joinRoom`, which wait for the
 * link because they are how a session begins.
 */

import {
  PROTOCOL_VERSION,
  TIMING,
  isPlausibleRoomCode,
  normalizeRoomCode,
  randomId,
  sanitizeName,
} from './protocol';
import type {
  AckResult,
  Capabilities,
  ClientMessage,
  CreateRoomOptions,
  EventMsg,
  Move,
  RoomCode,
  RoomState,
  ServerMessage,
} from './protocol';

import {
  Emitter,
  TransportError,
  deriveLocalView,
  gradeQuality,
  initialQuality,
  reconnectDelay,
  saveIdentityName,
  smoothRtt,
} from './transport';
import type {
  ConnectionQuality,
  ConnectionStatus,
  JoinRoomOptions,
  Transport,
  TransportConfig,
  TransportEventMap,
  TransportEventType,
  TransportSnapshot,
  Unsubscribe,
} from './transport';

/** Give up and report `failed` after this many consecutive failed attempts. */
const MAX_RECONNECT_ATTEMPTS = 12;

export interface WsTransportConfig extends TransportConfig {
  /**
   * Server URL, `ws://` or `wss://`. An `http(s)://` URL is converted.
   *
   * When omitted, resolved from `VITE_OTRIO_SERVER_URL`, then from the page's
   * own origin. See `resolveServerUrl`.
   */
  url?: string;
}

/** Vite's `import.meta.env`, read without requiring `vite/client` types. */
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

/**
 * Work out where the server is.
 *
 * Order of preference:
 *  1. an explicit `url` in the config;
 *  2. `VITE_OTRIO_SERVER_URL` — how a deployed build is pointed at its server,
 *     since the front end and the server live on different hosts (the front end
 *     can sit on Vercel; the WebSocket server cannot);
 *  3. the page's own origin, which is right when both are behind one reverse
 *     proxy;
 *  4. in dev, `localhost:8787`, because the Vite dev server on :5173 does not
 *     speak this protocol and connecting to it fails confusingly.
 */
export function resolveServerUrl(explicit?: string): string {
  const fromEnv = explicit ?? viteEnv?.VITE_OTRIO_SERVER_URL;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/+$/, '');
  }

  const loc = globalThis.location;
  if (!loc) return 'ws://localhost:8787';

  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const devPorts = ['5173', '5174', '3000', '4173'];
  if (devPorts.includes(loc.port)) {
    const port = viteEnv?.VITE_OTRIO_SERVER_PORT ?? '8787';
    return `${scheme}//${loc.hostname}:${port}`;
  }
  return `${scheme}//${loc.host}`;
}

/** Mutable mirror of the read-only public snapshot. */
type MutableSnapshot = { -readonly [K in keyof TransportSnapshot]: TransportSnapshot[K] };

interface PendingRequest {
  resolve: (result: AckResult) => void;
  reject: (err: TransportError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CAPABILITIES: Capabilities = {
  kind: 'hosted',
  spectators: true,
  reconnect: true,
  reconnectGraceMs: TIMING.reconnectGraceMs,
  hostMigration: false,
  impartialReferee: true,
  maxPlayers: 4,
};

export class WsTransport implements Transport {
  readonly capabilities: Capabilities = DEFAULT_CAPABILITIES;

  private url: string;
  private config: WsTransportConfig;
  private debug: boolean;

  private socket: WebSocket | null = null;
  private snap: TransportSnapshot;
  private listeners = new Set<() => void>();
  private events = new Emitter<TransportEventMap>();

  private pending = new Map<string, PendingRequest>();
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: TransportError) => void) | null = null;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyQueued = false;

  /** Highest `seq` applied. Guards against stale and duplicate snapshots. */
  private lastSeq = -1;
  /** Room to rejoin after a reconnect that did not restore a seat. */
  private roomCode: RoomCode | null = null;
  private disposed = false;

  constructor(config: WsTransportConfig) {
    this.config = config;
    this.debug = config.debug === true;
    this.url = resolveServerUrl(config.url);

    this.snap = Object.freeze({
      status: 'idle',
      playerId: config.identity.playerId,
      name: config.identity.name,
      room: null,
      role: 'none',
      seat: null,
      isMyTurn: false,
      isHost: false,
      pendingMove: null,
      quality: initialQuality(),
      lastError: null,
      capabilities: this.capabilities,
    });

    // Bound so they can be passed straight to `useSyncExternalStore`.
    this.getSnapshot = this.getSnapshot.bind(this);
    this.subscribe = this.subscribe.bind(this);
  }

  /* ---------------------------------------------------------------------- *
   * Observation
   * ---------------------------------------------------------------------- */

  getSnapshot(): TransportSnapshot {
    return this.snap;
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  on<K extends TransportEventType>(
    type: K,
    handler: (payload: TransportEventMap[K]) => void,
  ): Unsubscribe {
    return this.events.on(type, handler);
  }

  /**
   * Replace the snapshot and schedule one notification.
   *
   * Notification is deferred to a microtask so that a `state` message followed
   * by three `event` messages in the same network tick produces one re-render
   * rather than four. The snapshot itself is updated synchronously, so a caller
   * reading `getSnapshot()` on the next line sees the new value — which
   * `sendMove` depends on for its ghost piece.
   */
  private patch(changes: Partial<MutableSnapshot>): void {
    this.snap = Object.freeze({ ...this.snap, ...changes });
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of Array.from(this.listeners)) {
        try {
          listener();
        } catch (err) {
          console.error('[otrio] transport subscriber threw', err);
        }
      }
    });
  }

  /** Apply a room state and recompute every derived field from it. */
  private setRoom(room: RoomState | null): void {
    const derived = deriveLocalView(room, this.snap.playerId);
    this.patch({ room, ...derived });
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.snap.status === status) return;
    const previous = this.snap.status;
    this.patch({ status });
    this.events.emit('statusChanged', { status, previous });
  }

  private setQuality(changes: Partial<ConnectionQuality>): void {
    this.patch({ quality: { ...this.snap.quality, ...changes } });
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.debug('[otrio:ws]', ...args);
  }

  /* ---------------------------------------------------------------------- *
   * Connection
   * ---------------------------------------------------------------------- */

  connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new TransportError('CONNECTION_LOST', 'transport has been disposed'));
    }
    if (this.snap.status === 'connected') return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.setStatus(this.snap.quality.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    this.openSocket();
    return this.connectPromise;
  }

  private openSocket(): void {
    if (this.disposed) return;

    if (typeof globalThis.navigator !== 'undefined' && globalThis.navigator.onLine === false) {
      this.failConnect(new TransportError('NETWORK_UNAVAILABLE', 'this device is offline', { retryable: true }));
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.failConnect(
        new TransportError('CONNECT_FAILED', `could not open ${this.url}`, { retryable: true, cause: err }),
      );
      return;
    }

    this.socket = socket;
    this.log('opening', this.url);

    socket.onopen = () => {
      this.log('open; sending hello');
      this.rawSend({
        t: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        playerId: this.config.identity.playerId,
        sessionSecret: this.config.identity.sessionSecret,
        name: this.snap.name,
      });
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        this.log('dropped malformed frame');
        return;
      }
      this.setQuality({ lastMessageAt: Date.now() });
      this.handleMessage(msg);
    };

    socket.onerror = () => {
      // The browser deliberately gives no detail here, to avoid leaking whether
      // a port is open. `onclose` follows and carries what little there is.
      this.log('socket error');
    };

    socket.onclose = (ev: CloseEvent) => {
      if (this.socket !== socket) return; // Superseded.
      this.socket = null;
      this.stopPing();
      this.log('closed', ev.code, ev.reason);
      this.onDisconnected(ev.code, ev.reason);
    };
  }

  private onDisconnected(code: number, reason: string): void {
    // Every in-flight request is now unanswerable.
    this.rejectAllPending(new TransportError('CONNECTION_LOST', 'connection lost', { retryable: true }));
    this.clearPendingMove();

    if (this.disposed || this.snap.status === 'closed') return;

    // 1000 with no room means a deliberate server-side close we should not
    // fight (a shutdown, or a fatal protocol error already reported).
    const fatal = code === 1008 || (code >= 4000 && code <= 4099 && code !== 4004);
    if (fatal) {
      const err = new TransportError('PROTOCOL_MISMATCH', reason || 'connection refused by server');
      this.failConnect(err, true);
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;

    const attempts = this.snap.quality.reconnectAttempts + 1;
    this.setQuality({ reconnectAttempts: attempts, rttMs: null, jitterMs: null, grade: 'unknown' });

    if (attempts > MAX_RECONNECT_ATTEMPTS) {
      this.failConnect(
        new TransportError('CONNECT_FAILED', `gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`, {
          retryable: true,
        }),
        true,
      );
      return;
    }

    this.setStatus('reconnecting');
    const delay = reconnectDelay(attempts - 1, TIMING);
    this.log(`reconnecting in ${delay}ms (attempt ${attempts})`);

    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.disposed) return;
      // Re-arm the connect promise if nothing is awaiting one.
      if (!this.connectPromise) {
        this.connectPromise = new Promise<void>((resolve, reject) => {
          this.resolveConnect = resolve;
          this.rejectConnect = reject;
        });
        // Nobody is necessarily awaiting this; swallow to avoid an unhandled
        // rejection warning for a retry the UI never asked about.
        this.connectPromise.catch(() => {});
      }
      this.openSocket();
    }, delay);
  }

  private failConnect(err: TransportError, terminal = false): void {
    this.patch({ lastError: err });
    this.events.emit('error', err);
    const reject = this.rejectConnect;
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
    if (terminal) {
      this.setStatus('failed');
    }
    reject?.(err);
    if (!terminal) this.scheduleReconnect();
  }

  /* ---------------------------------------------------------------------- *
   * Inbound messages
   * ---------------------------------------------------------------------- */

  private handleMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        return this.onWelcome(msg);

      case 'ack': {
        const pending = this.pending.get(msg.rid);
        if (!pending) return;
        this.pending.delete(msg.rid);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result ?? { kind: 'ok' });
        else pending.reject(TransportError.fromWire(msg.error ?? { code: 'INTERNAL', message: 'unknown error', retryable: false }));
        return;
      }

      case 'state':
        return this.applyState(msg.state);

      case 'pong': {
        const sample = Date.now() - msg.t0;
        const smoothed = smoothRtt(this.snap.quality, sample);
        this.setQuality({
          ...smoothed,
          grade: gradeQuality(smoothed.rttMs),
          // One-way delay is approximated as half the round trip. Crude, but it
          // only has to be good enough to render a countdown that does not
          // visibly disagree with everyone else's.
          clockOffsetMs: Math.round(msg.serverTime + sample / 2 - Date.now()),
        });
        return;
      }

      case 'error': {
        const err = TransportError.fromWire(msg.error);
        this.patch({ lastError: err });
        this.events.emit('error', err);
        return;
      }

      case 'event':
        return this.onServerEvent(msg);
    }
  }

  private onWelcome(msg: Extract<ServerMessage, { t: 'welcome' }>): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      const err = new TransportError(
        'PROTOCOL_MISMATCH',
        `server speaks protocol ${msg.protocolVersion}, this client speaks ${PROTOCOL_VERSION}; reload the page`,
      );
      this.failConnect(err, true);
      this.socket?.close(1000, 'protocol mismatch');
      return;
    }

    (this as { capabilities: Capabilities }).capabilities = msg.capabilities;
    this.patch({
      name: msg.name,
      capabilities: msg.capabilities,
      lastError: null,
    });
    this.setQuality({ reconnectAttempts: 0 });
    this.setStatus('connected');
    this.startPing();

    const resolve = this.resolveConnect;
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;

    if (msg.resumed) {
      this.log('seat resumed', msg.resumed.code);
      this.roomCode = msg.resumed.code;
      this.lastSeq = -1; // Adopt the server's numbering wholesale.
      this.applyState(msg.resumed);
      resolve?.();
      return;
    }

    resolve?.();

    // The server had nothing held for us, but we believed we were in a room —
    // it restarted, or the grace period lapsed. Try to get back in; if the room
    // is genuinely gone, say so rather than leaving a dead board on screen.
    if (this.roomCode && this.snap.room) {
      const code = this.roomCode;
      this.log('seat not resumed; attempting rejoin', code);
      this.rejoinAfterReconnect(code);
    }
  }

  private async rejoinAfterReconnect(code: RoomCode): Promise<void> {
    try {
      await this.joinRoom(code, { asSpectator: this.snap.role === 'spectator' });
    } catch (err) {
      const reason = err instanceof TransportError ? err.message : 'room is no longer available';
      this.roomCode = null;
      this.lastSeq = -1;
      this.setRoom(null);
      this.events.emit('roomClosed', { reason });
      if (err instanceof TransportError) {
        this.patch({ lastError: err });
        this.events.emit('error', err);
      }
    }
  }

  /**
   * Adopt an authoritative snapshot, or discard it.
   *
   * The `seq` guard is the whole of this client's correctness argument: stale
   * and duplicated snapshots are dropped, so the board can never move backwards
   * no matter what order messages arrive in.
   */
  private applyState(state: RoomState): void {
    if (this.snap.room && state.code === this.snap.room.code && state.seq <= this.lastSeq) {
      this.log('dropped stale state', state.seq, '<=', this.lastSeq);
      return;
    }
    if (!this.snap.room || state.code !== this.snap.room.code) {
      this.lastSeq = -1;
    }
    this.lastSeq = state.seq;
    this.roomCode = state.code;
    this.setRoom(state);
  }

  private onServerEvent(msg: EventMsg): void {
    switch (msg.kind) {
      case 'moveApplied':
        return this.events.emit('moveApplied', { seat: msg.seat, move: msg.move, seq: msg.seq });
      case 'playerJoined':
        return this.events.emit('playerJoined', { player: msg.player });
      case 'playerLeft':
        return this.events.emit('playerLeft', {
          playerId: msg.playerId,
          name: msg.name,
          permanent: msg.permanent,
        });
      case 'playerReconnected':
        return this.events.emit('playerReconnected', { playerId: msg.playerId, name: msg.name });
      case 'connectionChanged':
        return this.events.emit('connectionChanged', {
          playerId: msg.playerId,
          connection: msg.connection,
        });
      case 'gameStarted':
        return this.events.emit('gameStarted', { seq: msg.seq });
      case 'gameEnded':
        return this.events.emit('gameEnded', {
          reason: msg.reason,
          winner: msg.winner,
          line: msg.line,
        });
      case 'hostChanged':
        return this.events.emit('hostChanged', { playerId: msg.playerId, name: msg.name });
      case 'roomClosed': {
        this.roomCode = null;
        this.lastSeq = -1;
        this.setRoom(null);
        return this.events.emit('roomClosed', { reason: msg.reason });
      }
      case 'moveRejected':
        // Synthesised locally from the failing ack instead, so that the promise
        // rejection and the event carry the same `TransportError` instance.
        return;
    }
  }

  /* ---------------------------------------------------------------------- *
   * Requests
   * ---------------------------------------------------------------------- */

  private rawSend(msg: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.log('send failed', err);
      return false;
    }
  }

  /** Send a message that expects an `ack`, and await it. */
  private request(build: (rid: string) => ClientMessage): Promise<AckResult> {
    if (this.disposed) {
      return Promise.reject(new TransportError('CONNECTION_LOST', 'transport has been disposed'));
    }
    if (this.snap.status !== 'connected') {
      return Promise.reject(
        new TransportError('CONNECTION_LOST', 'not connected', { retryable: true }),
      );
    }

    const rid = randomId(8);
    const msg = build(rid);

    return new Promise<AckResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new TransportError('TIMEOUT', `no reply to "${msg.t}"`, { retryable: true }));
      }, TIMING.requestTimeoutMs);

      this.pending.set(rid, { resolve, reject, timer });

      if (!this.rawSend(msg)) {
        this.pending.delete(rid);
        clearTimeout(timer);
        reject(new TransportError('CONNECTION_LOST', 'not connected', { retryable: true }));
      }
    });
  }

  private rejectAllPending(err: TransportError): void {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  /* ---------------------------------------------------------------------- *
   * Heartbeat
   * ---------------------------------------------------------------------- */

  private startPing(): void {
    this.stopPing();
    const tick = () => {
      if (this.snap.status !== 'connected') return;

      // A socket can stay `OPEN` long after the peer has gone — a laptop lid,
      // a dropped mobile signal. If nothing has arrived in `idleTimeoutMs`,
      // stop believing the socket and force a reconnect.
      const last = this.snap.quality.lastMessageAt;
      if (last !== null && Date.now() - last > TIMING.idleTimeoutMs) {
        this.log('idle timeout; forcing reconnect');
        this.socket?.close(4100, 'idle');
        return;
      }

      this.rawSend({
        t: 'ping',
        id: randomId(4),
        t0: Date.now(),
        rttMs: this.snap.quality.rttMs ?? undefined,
      });
    };
    tick();
    this.pingTimer = setInterval(tick, TIMING.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /* ---------------------------------------------------------------------- *
   * Commands
   * ---------------------------------------------------------------------- */

  async createRoom(options?: CreateRoomOptions): Promise<RoomCode> {
    await this.connect();
    const result = await this.request((rid) => ({ t: 'createRoom', rid, options }));
    if (result.kind !== 'room') {
      throw new TransportError('INTERNAL', 'server did not return a room');
    }
    this.lastSeq = -1;
    this.roomCode = result.code;
    this.applyState(result.state);
    this.patch({ lastError: null });
    return result.code;
  }

  async joinRoom(code: RoomCode, options?: JoinRoomOptions): Promise<RoomCode> {
    const normalized = normalizeRoomCode(code);
    // Checked locally so an obvious typo costs nothing and reports precisely.
    if (!isPlausibleRoomCode(normalized)) {
      throw new TransportError('CODE_INVALID', 'that is not a valid room code');
    }

    await this.connect();
    const result = await this.request((rid) => ({
      t: 'joinRoom',
      rid,
      code: normalized,
      asSpectator: options?.asSpectator === true,
    }));
    if (result.kind !== 'room') {
      throw new TransportError('INTERNAL', 'server did not return a room');
    }
    this.lastSeq = -1;
    this.roomCode = result.code;
    this.applyState(result.state);
    this.patch({ lastError: null });
    return result.code;
  }

  async leaveRoom(): Promise<void> {
    if (!this.snap.room) return;
    try {
      await this.request((rid) => ({ t: 'leaveRoom', rid }));
    } catch (err) {
      // Leaving is best-effort: if the link is already down, the server will
      // release the seat when the grace period lapses. Do not block the UI.
      this.log('leaveRoom failed; dropping locally anyway', err);
    }
    this.roomCode = null;
    this.lastSeq = -1;
    this.clearPendingMove();
    this.setRoom(null);
  }

  async setReady(ready: boolean): Promise<void> {
    await this.request((rid) => ({ t: 'setReady', rid, ready }));
  }

  async setName(name: string): Promise<void> {
    const clean = sanitizeName(name, this.snap.name);
    this.patch({ name: clean });
    saveIdentityName(clean);
    this.config.identity.name = clean;
    if (this.snap.status === 'connected') {
      await this.request((rid) => ({ t: 'setName', rid, name: clean }));
    }
  }

  async startGame(): Promise<void> {
    await this.request((rid) => ({ t: 'startGame', rid }));
  }

  async sendMove(move: Move): Promise<void> {
    // These guards run in the same precedence order the referee uses, so that a
    // locally short-circuited rejection carries the same code the server would
    // have returned. Checking `isMyTurn` first would report NOT_YOUR_TURN for a
    // game that has finished or paused, which is true but useless to the UI.
    const room = this.snap.room;
    if (!room) throw new TransportError('NOT_IN_ROOM', 'not in a room');
    if (this.snap.role !== 'player') {
      throw new TransportError('SPECTATOR_FORBIDDEN', 'spectators cannot move');
    }
    if (room.phase === 'paused') {
      throw new TransportError('GAME_NOT_ACTIVE', 'the game is paused');
    }
    if (room.phase !== 'playing' || room.game === null || room.game.phase !== 'playing') {
      throw new TransportError('GAME_NOT_ACTIVE', 'no game in progress');
    }
    if (this.snap.pendingMove) {
      throw new TransportError('NOT_YOUR_TURN', 'a move is already pending');
    }
    if (!this.snap.isMyTurn) throw new TransportError('NOT_YOUR_TURN', 'it is not your turn');

    // Set before anything is transmitted, so the ghost piece appears on the
    // click rather than on the round trip.
    this.patch({ pendingMove: move });

    try {
      await this.request((rid) => ({ t: 'move', rid, move, expectedSeq: this.snap.room?.seq }));
      this.clearPendingMove();
    } catch (err) {
      this.clearPendingMove();
      const error =
        err instanceof TransportError
          ? err
          : new TransportError('INTERNAL', 'move failed', { cause: err });
      this.patch({ lastError: error });
      this.events.emit('moveRejected', { move, error });
      throw error;
    }
  }

  async requestRematch(accept: boolean): Promise<void> {
    await this.request((rid) => ({ t: 'rematch', rid, accept }));
  }

  async resync(): Promise<void> {
    this.lastSeq = -1;
    await this.request((rid) => ({ t: 'resync', rid }));
  }

  private clearPendingMove(): void {
    if (this.snap.pendingMove !== null) this.patch({ pendingMove: null });
  }

  /* ---------------------------------------------------------------------- *
   * Teardown
   * ---------------------------------------------------------------------- */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.stopPing();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;

    this.rejectAllPending(new TransportError('CONNECTION_LOST', 'transport disposed'));

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(1000, 'client disposed');
      } catch {
        /* already closing */
      }
    }

    this.rejectConnect?.(new TransportError('CONNECTION_LOST', 'transport disposed'));
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;

    this.setStatus('closed');
    this.events.clear();
    this.listeners.clear();
  }
}

/** Factory matching `TransportFactory`. */
export function createWsTransport(config: WsTransportConfig): Transport {
  return new WsTransport(config);
}
