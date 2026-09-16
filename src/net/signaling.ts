/**
 * signaling.ts — the signalling client for the peer-to-peer (WebRTC) backend.
 *
 * WebRTC cannot bootstrap itself. Before two phones can exchange a single byte
 * directly, they must first exchange SDP offers/answers and ICE candidates
 * through some channel they *both* already trust. That channel is signalling,
 * and it needs a server. There is no way around this; the only question is how
 * small that server can be.
 *
 * The answer: very small. The signalling service never sees a game move, never
 * knows the rules, and never parses an SDP. It is a room-scoped message relay:
 *
 *     "put me in room QUIET-FOX-12"  ->  "you are peer p_a1b2, here's who else is here"
 *     "relay this opaque blob to p_c3d4"  ->  p_c3d4 receives it
 *
 * That is the whole contract. See docs/WEBRTC.md for a reference implementation
 * (about 90 lines of Node + `ws`) and deployment notes.
 *
 * IMPORTANT: the signalling connection must stay open for the whole session,
 * not just during the initial handshake. It is needed again for:
 *   - late joiners (player 3 and 4 arriving after the game starts)
 *   - ICE restarts after a Wi-Fi -> cellular handover
 *   - host migration, which must be coordinated when the host's data channels
 *     are exactly the thing that just died
 * A signalling client that disconnects after `welcome` will appear to work
 * perfectly in testing and fail in every interesting real-world case.
 */

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export type PeerId = string;

/**
 * Peers generate their own ids so that the signalling server needs no identity
 * store, and so that a peer that briefly loses its WebSocket keeps the same
 * identity when it comes back (important on mobile, where the WS dies on every
 * network handover). The id is stashed in sessionStorage: it survives a reload
 * of the same tab, but a second tab is genuinely a second player, which is what
 * you want when testing four players on one laptop.
 */
export function localPeerId(storageKey = 'otrio.peerId'): PeerId {
  const fresh = (): PeerId => 'p_' + randomId(10);
  try {
    const existing = globalThis.sessionStorage?.getItem(storageKey);
    if (existing) return existing;
    const id = fresh();
    globalThis.sessionStorage?.setItem(storageKey, id);
    return id;
  } catch {
    // Private mode / storage disabled / non-browser. A per-instance id is fine;
    // we just lose identity continuity across a reload.
    return fresh();
  }
}

function randomId(len: number): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l/o/0/1
  const bytes = new Uint8Array(len);
  const c: Crypto | undefined = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Room codes people have to read aloud across a table. No ambiguous glyphs. */
export function randomRoomCode(): string {
  return randomId(6).toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Wire protocol (client <-> signalling server)
 * ------------------------------------------------------------------ */

export interface PeerInfo {
  id: PeerId;
  /** Display name, if the player set one. Untrusted; for UI only. */
  name?: string;
  /**
   * Server-assigned monotonic join order within the room, starting at 0.
   *
   * This is the single most load-bearing field in the whole protocol. It is the
   * tiebreak for host election, and it has to come from the server because it
   * is the only value all peers are guaranteed to agree on. Do not replace it
   * with a client clock (phones disagree) or with a sorted peer id (correct but
   * elects a random player, which confuses people — the person who made the
   * room should be the host).
   *
   * The server MUST preserve a peer's `order` if that peer id rejoins the same
   * room, so that a host whose WebSocket blipped does not lose seniority.
   */
  order: number;
}

export type SignalClientMsg =
  | { t: 'join'; room: string; peer: PeerId; name?: string }
  | { t: 'signal'; to: PeerId; data: unknown }
  | { t: 'leave' }
  | { t: 'ping'; ts: number };

export type SignalServerMsg =
  | { t: 'welcome'; room: string; you: PeerId; order: number; peers: PeerInfo[] }
  | { t: 'peer-join'; peer: PeerInfo }
  | { t: 'peer-leave'; peer: PeerId; reason?: string }
  | { t: 'signal'; from: PeerId; data: unknown }
  | { t: 'error'; code: SignalErrorCode; message: string }
  | { t: 'pong'; ts: number };

export type SignalErrorCode =
  | 'room-full'
  | 'bad-room'
  | 'duplicate-peer'
  | 'rate-limited'
  | 'server-error';

export type SignalingState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

/* A type alias, not an interface, on purpose: the private `Emitter<E>` below
   constrains E to `Record<string, (...args: never[]) => void>`, and an
   interface does not get an implicit index signature, so it cannot satisfy
   that constraint. A type alias can. Changing this back to `interface` breaks
   both `new Emitter<SignalingEvents>()` call sites. */
export type SignalingEvents = {
  /** Fired on first join AND on every successful reconnect. Idempotent handlers only. */
  welcome(info: { room: string; you: PeerId; order: number; peers: PeerInfo[]; resumed: boolean }): void;
  peerJoin(peer: PeerInfo): void;
  peerLeave(peer: PeerId, reason?: string): void;
  signal(from: PeerId, data: unknown): void;
  state(state: SignalingState): void;
  error(err: { code: SignalErrorCode | 'transport'; message: string; fatal: boolean }): void;
}

export interface Signaling {
  readonly selfId: PeerId;
  readonly room: string;
  readonly state: SignalingState;
  /** Everyone currently in the room according to the server, including us. */
  readonly peers: ReadonlyMap<PeerId, PeerInfo>;
  connect(): Promise<void>;
  /** Relay an opaque blob to one peer. Fire-and-forget; queued while reconnecting. */
  send(to: PeerId, data: unknown): void;
  on<K extends keyof SignalingEvents>(event: K, fn: SignalingEvents[K]): () => void;
  close(): void;
}

export interface SignalingOptions {
  /**
   * `wss://…` or `ws://…` for a real server, or `broadcast:<name>` to use a
   * BroadcastChannel between tabs of the same browser (dev only — see
   * createSignaling).
   */
  url: string;
  room: string;
  peerId?: PeerId;
  name?: string;
  /** Interval for application-level keepalive pings. Defaults to 25s. */
  pingIntervalMs?: number;
  /** Cap on reconnect backoff. Defaults to 15s. */
  maxBackoffMs?: number;
  /** Injectable for tests. */
  now?: () => number;
}

/* ------------------------------------------------------------------ *
 * Tiny typed emitter
 * ------------------------------------------------------------------ */

class Emitter<E extends Record<string, (...args: never[]) => void>> {
  private map = new Map<keyof E, Set<unknown>>();
  on<K extends keyof E>(event: K, fn: E[K]): () => void {
    let set = this.map.get(event);
    if (!set) this.map.set(event, (set = new Set()));
    set.add(fn);
    return () => { set!.delete(fn); };
  }
  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (...a: Parameters<E[K]>) => void)(...args);
      } catch (err) {
        // A throwing listener must never take down the signalling loop.
        console.error('[signaling] listener threw for', String(event), err);
      }
    }
  }
  clear(): void { this.map.clear(); }
}

/* ------------------------------------------------------------------ *
 * WebSocket implementation
 * ------------------------------------------------------------------ */

export class WebSocketSignaling implements Signaling {
  readonly selfId: PeerId;
  readonly room: string;

  private ws: WebSocket | null = null;
  private _state: SignalingState = 'idle';
  private _peers = new Map<PeerId, PeerInfo>();
  private emitter = new Emitter<SignalingEvents>();

  private outbox: SignalClientMsg[] = [];
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private everWelcomed = false;
  private closedByUs = false;
  private readyWaiters: Array<{ resolve(): void; reject(e: Error): void }> = [];

  private readonly url: string;
  private readonly name?: string;
  private readonly pingIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;

  constructor(opts: SignalingOptions) {
    this.url = opts.url;
    this.room = normalizeRoom(opts.room);
    this.selfId = opts.peerId ?? localPeerId();
    this.name = opts.name;
    this.pingIntervalMs = opts.pingIntervalMs ?? 25_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 15_000;
    this.now = opts.now ?? (() => Date.now());
  }

  get state(): SignalingState { return this._state; }
  get peers(): ReadonlyMap<PeerId, PeerInfo> { return this._peers; }

  on<K extends keyof SignalingEvents>(event: K, fn: SignalingEvents[K]): () => void {
    return this.emitter.on(event, fn);
  }

  connect(): Promise<void> {
    this.closedByUs = false;
    if (this._state === 'open') return Promise.resolve();
    const p = new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
    if (this._state === 'idle' || this._state === 'closed') this.open();
    return p;
  }

  send(to: PeerId, data: unknown): void {
    this.push({ t: 'signal', to, data });
  }

  close(): void {
    this.closedByUs = true;
    this.setState('closed');
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      try { this.ws.send(JSON.stringify({ t: 'leave' } satisfies SignalClientMsg)); } catch { /* best effort */ }
    }
    this.teardownSocket();
    this.clearTimers();
    this.outbox.length = 0;
    this._peers.clear();
    this.rejectWaiters(new Error('signalling closed'));
    this.emitter.clear();
  }

  /* -------------------- internals -------------------- */

  private open(): void {
    this.setState(this.everWelcomed ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.emitter.emit('error', {
        code: 'transport',
        message: `Could not open ${this.url}: ${String(err)}`,
        fatal: false,
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.attempt = 0;
      this.lastPongAt = this.now();
      // Re-join on every (re)connect. The server treats a repeat join from a
      // known peer id as a resume: same `order`, no peer-join storm for others.
      const join: SignalClientMsg = { t: 'join', room: this.room, peer: this.selfId, name: this.name };
      this.raw(join);
      const queued = this.outbox;
      this.outbox = [];
      for (const m of queued) this.raw(m);
      this.startPing();
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: SignalServerMsg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      } catch {
        return; // ignore garbage rather than dying
      }
      this.handle(msg);
    };

    ws.onerror = () => {
      // Browsers give us nothing useful here by design (it would be a
      // cross-origin information leak). onclose carries the actionable signal.
    };

    ws.onclose = (ev: CloseEvent) => {
      this.stopPing();
      if (this.closedByUs) return;
      this.emitter.emit('error', {
        code: 'transport',
        message: `Signalling socket closed (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`,
        fatal: false,
      });
      this.scheduleReconnect();
    };
  }

  private handle(msg: SignalServerMsg): void {
    switch (msg.t) {
      case 'welcome': {
        const resumed = this.everWelcomed;
        this.everWelcomed = true;
        this._peers.clear();
        for (const p of msg.peers) this._peers.set(p.id, p);
        this._peers.set(msg.you, { id: msg.you, name: this.name, order: msg.order });
        this.setState('open');
        // Emit BEFORE resolving, so that code awaiting connect() can rely on
        // the roster already being populated. Resolving first happens to work
        // (the continuation is only a microtask away) but makes correctness
        // depend on scheduling, which is not a thing to depend on.
        this.emitter.emit('welcome', {
          room: msg.room, you: msg.you, order: msg.order,
          peers: msg.peers, resumed,
        });
        this.resolveWaiters();
        break;
      }
      case 'peer-join':
        this._peers.set(msg.peer.id, msg.peer);
        this.emitter.emit('peerJoin', msg.peer);
        break;
      case 'peer-leave':
        this._peers.delete(msg.peer);
        this.emitter.emit('peerLeave', msg.peer, msg.reason);
        break;
      case 'signal':
        this.emitter.emit('signal', msg.from, msg.data);
        break;
      case 'pong':
        this.lastPongAt = this.now();
        break;
      case 'error': {
        const fatal = msg.code === 'room-full' || msg.code === 'bad-room';
        this.emitter.emit('error', { code: msg.code, message: msg.message, fatal });
        if (fatal) {
          this.closedByUs = true;
          this.rejectWaiters(new Error(msg.message));
          this.setState('closed');
          this.teardownSocket();
          this.clearTimers();
        }
        break;
      }
    }
  }

  private push(msg: SignalClientMsg): void {
    if (this.ws && this.ws.readyState === 1) this.raw(msg);
    else {
      // Bounded: a long outage should not accumulate a megabyte of stale ICE
      // candidates that are useless by the time they flush.
      if (this.outbox.length > 64) this.outbox.shift();
      this.outbox.push(msg);
      if (!this.reconnectTimer && this._state !== 'connecting') this.scheduleReconnect(0);
    }
  }

  private raw(msg: SignalClientMsg): void {
    try { this.ws?.send(JSON.stringify(msg)); } catch { this.outbox.push(msg); }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      // Intermediaries (nginx, Cloudflare, mobile carrier NATs) drop idle
      // WebSockets after 30-120s. An app-level ping is the only portable
      // keepalive; the browser gives us no access to WS ping frames.
      this.raw({ t: 'ping', ts: this.now() });
      // If several pings go unanswered the socket is a zombie: it looks OPEN
      // but nothing traverses. Force a reconnect rather than trusting it.
      if (this.now() - this.lastPongAt > this.pingIntervalMs * 2.5) {
        try { this.ws?.close(4000, 'stale'); } catch { /* ignore */ }
      }
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private scheduleReconnect(forceDelay?: number): void {
    if (this.closedByUs || this.reconnectTimer) return;
    this.teardownSocket();
    this.setState(this.everWelcomed ? 'reconnecting' : 'connecting');
    const base = Math.min(this.maxBackoffMs, 400 * Math.pow(1.8, this.attempt++));
    const delay = forceDelay ?? base * (0.6 + Math.random() * 0.6); // jitter: 4 phones must not retry in lockstep
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private teardownSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch { /* ignore */ }
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private setState(s: SignalingState): void {
    if (this._state === s) return;
    this._state = s;
    this.emitter.emit('state', s);
  }

  private resolveWaiters(): void {
    const w = this.readyWaiters; this.readyWaiters = [];
    for (const x of w) x.resolve();
  }

  private rejectWaiters(e: Error): void {
    const w = this.readyWaiters; this.readyWaiters = [];
    for (const x of w) x.reject(e);
  }
}

/* ------------------------------------------------------------------ *
 * BroadcastChannel implementation — DEV ONLY
 * ------------------------------------------------------------------ */

/**
 * Signalling between browser tabs of the same origin, with no server at all.
 *
 * This exists because the single most annoying thing about developing a WebRTC
 * app is that you cannot test it without deploying something. With this you can
 * open four tabs of `localhost:5173`, pick `broadcast:otrio` as the signalling
 * URL, and exercise the *entire* real WebRTC stack — real RTCPeerConnections,
 * real SCTP data channels, real host election, real migration — against loopback
 * ICE candidates.
 *
 * What it does NOT test: anything to do with NAT, STUN, TURN, cellular handover,
 * or iOS Safari. Those are exactly the things that break in the field. Treat a
 * green run here as "my state machine is correct", never as "this works".
 *
 * Election order is derived from a claim-stake in localStorage so that tabs
 * agree on join order the way a real server would.
 */
export class BroadcastChannelSignaling implements Signaling {
  readonly selfId: PeerId;
  readonly room: string;

  private chan: BroadcastChannel | null = null;
  private _state: SignalingState = 'idle';
  private _peers = new Map<PeerId, PeerInfo>();
  private emitter = new Emitter<SignalingEvents>();
  private order = 0;
  private readonly name?: string;
  private readonly channelName: string;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastSeen = new Map<PeerId, number>();

  constructor(opts: SignalingOptions) {
    this.room = normalizeRoom(opts.room);
    this.selfId = opts.peerId ?? localPeerId();
    this.name = opts.name;
    const base = opts.url.startsWith('broadcast:') ? opts.url.slice('broadcast:'.length) : 'otrio';
    this.channelName = `${base || 'otrio'}::${this.room}`;
  }

  get state(): SignalingState { return this._state; }
  get peers(): ReadonlyMap<PeerId, PeerInfo> { return this._peers; }

  on<K extends keyof SignalingEvents>(event: K, fn: SignalingEvents[K]): () => void {
    return this.emitter.on(event, fn);
  }

  async connect(): Promise<void> {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('BroadcastChannel is unavailable; use a real wss:// signalling URL');
    }
    this.order = this.claimOrder();
    this.chan = new BroadcastChannel(this.channelName);
    this.chan.onmessage = (ev: MessageEvent) => this.handle(ev.data);
    this._state = 'open';
    this.emitter.emit('state', 'open');
    this._peers.set(this.selfId, { id: this.selfId, name: this.name, order: this.order });

    // Announce, then give existing tabs a moment to announce back before we
    // report the roster — mirrors a server's atomic `welcome`.
    this.post({ k: 'hello', peer: { id: this.selfId, name: this.name, order: this.order } });
    await new Promise((r) => setTimeout(r, 120));
    this.emitter.emit('welcome', {
      room: this.room, you: this.selfId, order: this.order,
      peers: [...this._peers.values()].filter((p) => p.id !== this.selfId),
      resumed: false,
    });

    this.heartbeat = setInterval(() => {
      this.post({ k: 'hello', peer: { id: this.selfId, name: this.name, order: this.order } });
      const cutoff = Date.now() - 4000;
      for (const [id, at] of [...this.lastSeen]) {
        if (at < cutoff) {
          this.lastSeen.delete(id);
          if (this._peers.delete(id)) this.emitter.emit('peerLeave', id, 'timeout');
        }
      }
    }, 1500);
  }

  send(to: PeerId, data: unknown): void {
    this.post({ k: 'sig', to, from: this.selfId, data });
  }

  close(): void {
    this.post({ k: 'bye', peer: this.selfId });
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    try { this.chan?.close(); } catch { /* ignore */ }
    this.chan = null;
    this._state = 'closed';
    this.emitter.emit('state', 'closed');
    this.emitter.clear();
  }

  private post(m: unknown): void {
    try { this.chan?.postMessage(m); } catch { /* ignore */ }
  }

  private handle(m: { k: string; peer?: PeerInfo | PeerId; to?: PeerId; from?: PeerId; data?: unknown }): void {
    if (m.k === 'hello' && typeof m.peer === 'object' && m.peer) {
      const info = m.peer as PeerInfo;
      if (info.id === this.selfId) return;
      this.lastSeen.set(info.id, Date.now());
      if (!this._peers.has(info.id)) {
        this._peers.set(info.id, info);
        this.emitter.emit('peerJoin', info);
        // Reply so the newcomer learns about us immediately.
        this.post({ k: 'hello', peer: { id: this.selfId, name: this.name, order: this.order } });
      }
    } else if (m.k === 'bye' && typeof m.peer === 'string') {
      if (this._peers.delete(m.peer)) this.emitter.emit('peerLeave', m.peer, 'left');
    } else if (m.k === 'sig' && m.to === this.selfId && m.from) {
      this.emitter.emit('signal', m.from, m.data);
    }
  }

  /** Stand-in for the server's monotonic per-room counter. */
  private claimOrder(): number {
    const key = `otrio.order.${this.channelName}`;
    try {
      const raw = globalThis.localStorage?.getItem(key);
      const seen: Record<string, number> = raw ? JSON.parse(raw) : {};
      if (typeof seen[this.selfId] === 'number') return seen[this.selfId];
      const next = Object.keys(seen).length;
      seen[this.selfId] = next;
      globalThis.localStorage?.setItem(key, JSON.stringify(seen));
      return next;
    } catch {
      return Math.floor(Math.random() * 1_000_000);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

export function createSignaling(opts: SignalingOptions): Signaling {
  return opts.url.startsWith('broadcast:')
    ? new BroadcastChannelSignaling(opts)
    : new WebSocketSignaling(opts);
}

/** Room codes are case-insensitive and whitespace-tolerant; people type these. */
export function normalizeRoom(room: string): string {
  return room.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}
