/**
 * rtcTransport.ts — the peer-to-peer backend: WebRTC data channels, no server
 * in the game path.
 * ============================================================================
 *
 * Implements `Transport` from `./transport.ts`. Read that file first; this one
 * only explains the parts that are specific to having no server.
 *
 *
 * TOPOLOGY: HOST-PEER STAR, NOT A MESH
 * ------------------------------------
 * Every peer holds exactly one data channel, to the referee. The referee holds
 * up to three. Four players is 3 connections, not the 6 a full mesh needs.
 *
 * Three reasons, in order of how much they matter:
 *
 *   1. **Each connection is a chance to fail.** NAT traversal is per-pair, not
 *      per-room. A mesh gives four phones six independent opportunities for ICE
 *      to fail; a star gives three, and they all terminate at one peer. In a
 *      mesh a single bad pair partitions the game with no obvious culprit. In a
 *      star, a bad link is one player who cannot join, and the other three play
 *      on without noticing.
 *
 *   2. **The protocol already assumes a referee.** `protocol.ts` is built around
 *      whole `RoomState` snapshots with a monotonic `seq`, produced by one
 *      authority. A star has an obvious place to put that authority. A mesh does
 *      not, and making four phones agree on a total order without one means
 *      lockstep or consensus — vastly more code, and more ways to deadlock, than
 *      a game where you place one ring every thirty seconds deserves.
 *
 *   3. **It keeps the two backends the same shape.** The frames on the data
 *      channel below are literally `ClientMessage` and `ServerMessage` from
 *      `protocol.ts` — the same JSON the hosted backend puts on its WebSocket.
 *      `PeerReferee` is a server room that happens to run on a phone. That is
 *      what makes the backends swappable rather than merely similar.
 *
 * The cost is honest and worth stating: the referee's phone does all the work
 * and every message costs two hops (leaf → referee → leaf) instead of one. For
 * nine cells of board state, neither matters.
 *
 *
 * WHAT THIS DOES NOT GIVE YOU
 * ---------------------------
 * `Capabilities.impartialReferee` is `false` and it is not a formality. The
 * referee peer is one of the players, running code they could replace. There is
 * no cryptography here and no cross-validation, by deliberate choice — see the
 * note in `transport.ts`. Four friends around a table: fine. Strangers with
 * something at stake: use the hosted backend.
 */

import {
  type AckMsg,
  type Capabilities,
  type ClientMessage,
  type CreateRoomOptions,
  type EventMsg,
  isPlausibleRoomCode,
  MAX_PLAYERS,
  type Move,
  normalizeRoomCode,
  type PlayerId,
  PROTOCOL_VERSION,
  randomId,
  ROOM_CODE_ALPHABET,
  type RoomCode,
  type RoomState,
  sanitizeName,
  type Seat,
  type ServerMessage,
  TIMING,
  wireError,
} from './protocol';

import {
  type ConnectionQuality,
  type ConnectionStatus,
  deriveLocalView,
  Emitter,
  gradeQuality,
  type Identity,
  initialQuality,
  type JoinRoomOptions,
  type LocalRole,
  smoothRtt,
  type Transport,
  type TransportConfig,
  TransportError,
  type TransportEventMap,
  type TransportEventType,
  type TransportSnapshot,
  type Unsubscribe,
} from './transport';

import { PeerReferee } from './referee';

import {
  createSignaling,
  type PeerInfo,
  type Signaling,
  type SignalingOptions,
} from './signaling';

/* ========================================================================== *
 * Configuration
 * ========================================================================== */

export interface RtcTransportConfig extends TransportConfig {
  /**
   * Where the signalling rendezvous lives.
   *
   * WebRTC cannot bootstrap itself: two phones cannot exchange an SDP offer
   * over a connection that does not exist yet. This is the irreducible server
   * in a "serverless" design. It is tiny — see `docs/WEBRTC.md` for the full
   * contract and a reference implementation — but it is not optional.
   *
   * `broadcast:otrio` substitutes a BroadcastChannel between tabs of one
   * browser, which needs no server at all and is how you develop this without
   * deploying anything. It cannot reach another device.
   *
   * Omit it and `resolveSignalingUrl()` works it out, exactly as
   * `WsTransportConfig.url` does for the hosted backend.
   */
  signalingUrl?: string;

  /**
   * STUN and TURN servers.
   *
   * The default is Google's public STUN, which is free, widely used, and comes
   * with no availability promise whatsoever. STUN alone gets most networks
   * through. The rest need TURN, there is no free public TURN, and without it
   * those players simply cannot connect. `docs/WEBRTC.md` has the numbers and
   * the options.
   */
  iceServers?: RTCIceServer[];

  /** Force every connection through TURN. The only way to prove TURN works. */
  forceRelay?: boolean;

  /** Give up on a peer connection after this long. Default 20s. */
  peerConnectTimeoutMs?: number;

  /** Per-turn clock in ms, or 0 for untimed. Referee-enforced. */
  turnTimeoutMs?: number;

  /** Test seam: substitute the signalling implementation. */
  signalingFactory?: (o: SignalingOptions) => Signaling;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/** Vite's `import.meta.env`, read without requiring `vite/client` types. */
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

/** Path the signalling relay is mounted at. See docs/WEBRTC.md. */
export const SIGNALING_PATH = '/signal';

/**
 * Work out where the signalling relay is, mirroring `resolveServerUrl` in
 * `wsTransport.ts` so the two backends are configured the same way.
 *
 * Order of preference:
 *  1. an explicit `signalingUrl` in the config;
 *  2. `VITE_OTRIO_SIGNALING_URL`, for a standalone signalling deployment;
 *  3. `VITE_OTRIO_SERVER_URL` + `/signal` — the common case, because the
 *     hosted backend's server is already a Node + `ws` process and mounting
 *     the relay beside it costs nothing;
 *  4. the page's own origin, when both sit behind one reverse proxy;
 *  5. in dev, `localhost:8787`, since the Vite dev server does not speak this.
 *
 * A `broadcast:` URL is passed through untouched — it is not a network address.
 */
export function resolveSignalingUrl(explicit?: string): string {
  const toWs = (u: string): string =>
    u.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/+$/, '');

  const direct = explicit ?? viteEnv?.VITE_OTRIO_SIGNALING_URL;
  if (direct && direct.length > 0) {
    return direct.startsWith('broadcast:') ? direct : toWs(direct);
  }

  const shared = viteEnv?.VITE_OTRIO_SERVER_URL;
  if (shared && shared.length > 0) return toWs(shared) + SIGNALING_PATH;

  const loc = globalThis.location;
  if (!loc) return `ws://localhost:8787${SIGNALING_PATH}`;

  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const devPorts = ['5173', '5174', '3000', '4173'];
  if (devPorts.includes(loc.port)) {
    const port = viteEnv?.VITE_OTRIO_SERVER_PORT ?? '8787';
    return `${scheme}//${loc.hostname}:${port}${SIGNALING_PATH}`;
  }
  return `${scheme}//${loc.host}${SIGNALING_PATH}`;
}

export const P2P_CAPABILITIES: Capabilities = {
  kind: 'p2p',
  spectators: true,
  reconnect: true,
  reconnectGraceMs: TIMING.reconnectGraceMs,
  hostMigration: true,
  // The referee is a player. This is the one place the difference is admitted,
  // and the UI is expected to show it as a badge and change nothing else.
  impartialReferee: false,
  maxPlayers: MAX_PLAYERS,
};

/* -- Timings specific to peers. Everything else comes from TIMING. --------- */

/** Referee heartbeat. Also carries the referee's identity and epoch. */
const HEARTBEAT_MS = 2_000;
/** Silence this long means the peer is gone. Four missed beats. */
const PEER_SILENT_MS = 8_000;
/** ICE reports 'disconnected' constantly on mobile and usually self-heals. */
const ICE_DISCONNECT_GRACE_MS = 4_000;
const DEFAULT_PEER_CONNECT_TIMEOUT_MS = 20_000;
/** Backgrounded longer than this and every link is suspect. */
const WAKE_SUSPECT_MS = 1_500;
/** Per-seat stagger when electing a replacement referee. */
const ELECTION_STAGGER_MS = 250;
/** Room codes long enough to be unguessable, short enough to read aloud. */
const P2P_ROOM_CODE_LENGTH = 6;

/* ========================================================================== *
 * Data channel framing
 *
 * The payload is the protocol's own message types, unchanged. `e` is the
 * referee epoch — a fencing token that increments on every migration, so a
 * deposed referee whose phone just woke up cannot inject stale snapshots.
 * ========================================================================== */

type Frame =
  | { k: 'c'; e: number; m: ClientMessage }
  | { k: 's'; e: number; m: ServerMessage }
  | { k: 'hb'; e: number; referee: PlayerId; seq: number; ts: number }
  | { k: 'hbr'; ts: number }
  | { k: 'bye'; reason?: string };

/** Signalling payloads: negotiation and election. Never game data. */
type Sig =
  | { k: 'offer'; e: number; sdp: RTCSessionDescriptionInit }
  | { k: 'answer'; e: number; sdp: RTCSessionDescriptionInit }
  | { k: 'ice'; cand: RTCIceCandidateInit }
  | { k: 'want-offer'; e: number }
  | { k: 'need-restart' }
  | { k: 'claim'; e: number; rank: number; seq: number }
  | { k: 'claim-ack'; e: number; seq: number; state?: RoomState }
  | { k: 'claim-deny'; e: number; rank: number };


/* ========================================================================== *
 * PeerLink — exactly one RTCPeerConnection, fully owned.
 * ========================================================================== */

interface LinkCallbacks {
  onFrame(peer: PlayerId, f: Frame): void;
  onState(peer: PlayerId, s: LinkState): void;
  signal(peer: PlayerId, s: Sig): void;
  log(line: string): void;
}

type LinkState = 'new' | 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed';

class PeerLink {
  readonly peer: PlayerId;
  state: LinkState = 'new';
  rttMs: number | null = null;
  relayed: boolean | undefined;
  lastRecvAt = 0;
  readonly diagnostics: string[] = [];

  private pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  private pendingIce: RTCIceCandidateInit[] = [];
  private haveRemote = false;
  private connectDeadline: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    peer: PlayerId,
    readonly isOfferer: boolean,
    config: RTCConfiguration,
    private readonly connectTimeoutMs: number,
    private cb: LinkCallbacks,
  ) {
    this.peer = peer;
    this.pc = new RTCPeerConnection(config);

    // A *negotiated* channel: both sides create it with the same id, so there
    // is no in-band handshake and no `ondatachannel` to race. Safari has been
    // loose about that event's timing; this removes the question entirely, and
    // the channel object exists before ICE even starts.
    this.dc = this.pc.createDataChannel('otrio', { ordered: true, negotiated: true, id: 1 });
    // Safari does not support binaryType 'blob' on data channels.
    this.dc.binaryType = 'arraybuffer';

    this.dc.onopen = () => {
      this.clearConnectDeadline();
      this.setState('open');
      void this.probeCandidatePair();
    };
    this.dc.onclose = () => { if (!this.closed) this.setState('reconnecting'); };
    this.dc.onerror = () => this.note('data channel error');
    this.dc.onmessage = (ev: MessageEvent) => {
      this.lastRecvAt = Date.now();
      let f: Frame;
      try {
        f = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      } catch { return; }
      this.cb.onFrame(this.peer, f);
    };

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.cb.signal(this.peer, { k: 'ice', cand: ev.candidate.toJSON() });
    };
    // Bad TURN credentials surface here as a 401 and absolutely nowhere else.
    // Without this you get a silent failure twenty seconds later.
    this.pc.onicecandidateerror = (ev: Event) => {
      const e = ev as RTCPeerConnectionIceErrorEvent;
      this.note(`ICE server error ${e.errorCode} from ${e.url}: ${e.errorText}`);
    };
    this.pc.oniceconnectionstatechange = () => this.note(`ice=${this.pc.iceConnectionState}`);
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.note(`pc=${s}`);
      if (s === 'connected') {
        this.clearDisconnectTimer();
        this.clearConnectDeadline();
        if (this.dc.readyState === 'open') this.setState('open');
        void this.probeCandidatePair();
      } else if (s === 'disconnected') {
        // Routine on mobile, and usually self-healing. Give it a moment before
        // spending a renegotiation on it.
        this.setState('reconnecting');
        this.clearDisconnectTimer();
        this.disconnectTimer = setTimeout(() => {
          if (this.pc.connectionState === 'disconnected') this.setState('reconnecting');
        }, ICE_DISCONNECT_GRACE_MS);
      } else if (s === 'failed') {
        this.clearDisconnectTimer();
        this.setState('reconnecting');
      } else if (s === 'closed') {
        this.setState('closed');
      }
    };

    this.armConnectDeadline();
  }

  get connectionState(): RTCPeerConnectionState { return this.pc.connectionState; }
  get isHealthy(): boolean { return this.state === 'open' && this.dc.readyState === 'open'; }

  send(f: Frame): boolean {
    if (this.dc.readyState !== 'open') return false;
    try { this.dc.send(JSON.stringify(f)); return true; } catch { return false; }
  }

  async createOffer(epoch: number, iceRestart = false): Promise<void> {
    // Negotiation is driven explicitly rather than from `negotiationneeded`,
    // whose timing differs between browsers. With a negotiated data channel and
    // no media we know exactly when an offer is needed: now.
    const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : {});
    await this.pc.setLocalDescription(offer);
    this.armConnectDeadline();
    this.cb.signal(this.peer, { k: 'offer', e: epoch, sdp: this.pc.localDescription ?? offer });
  }

  async acceptOffer(sdp: RTCSessionDescriptionInit, epoch: number): Promise<void> {
    await this.pc.setRemoteDescription(sdp);
    this.haveRemote = true;
    await this.flushIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.armConnectDeadline();
    this.cb.signal(this.peer, { k: 'answer', e: epoch, sdp: this.pc.localDescription ?? answer });
  }

  async acceptAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    // An answer in the wrong state is glare or a duplicate. Dropping it is
    // safer than tearing down a connection that may be about to work.
    if (this.pc.signalingState !== 'have-local-offer') {
      this.note(`dropped answer in state ${this.pc.signalingState}`);
      return;
    }
    await this.pc.setRemoteDescription(sdp);
    this.haveRemote = true;
    await this.flushIce();
  }

  async addIce(cand: RTCIceCandidateInit): Promise<void> {
    // Trickle ICE: candidates routinely arrive before the description.
    if (!this.haveRemote) { this.pendingIce.push(cand); return; }
    try { await this.pc.addIceCandidate(cand); } catch { /* stale candidate */ }
  }

  /** Re-gather candidates in place. The fix for a Wi-Fi to cellular handover. */
  async restartIce(epoch: number): Promise<void> {
    if (this.closed) return;
    this.setState('reconnecting');
    this.note('ice restart');
    if (this.isOfferer) {
      // Safari only gained restartIce() in 16.x; the createOffer flag is the
      // portable fallback.
      const pcAny = this.pc as RTCPeerConnection & { restartIce?: () => void };
      if (typeof pcAny.restartIce === 'function') {
        pcAny.restartIce();
        await this.createOffer(epoch);
      } else {
        await this.createOffer(epoch, true);
      }
    } else {
      // Only the offerer restarts, so glare is structurally impossible. Ask
      // over signalling — the data channel is the thing that is broken.
      this.cb.signal(this.peer, { k: 'need-restart' });
    }
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearConnectDeadline();
    this.clearDisconnectTimer();
    if (reason && this.dc.readyState === 'open') {
      try { this.dc.send(JSON.stringify({ k: 'bye', reason } satisfies Frame)); } catch { /* best effort */ }
    }
    this.dc.onopen = this.dc.onclose = this.dc.onerror = this.dc.onmessage = null;
    try { this.dc.close(); } catch { /* ignore */ }
    this.pc.onicecandidate = null;
    this.pc.onicecandidateerror = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    try { this.pc.close(); } catch { /* ignore */ }
    this.setState('closed');
  }

  private async flushIce(): Promise<void> {
    const q = this.pendingIce; this.pendingIce = [];
    for (const c of q) { try { await this.pc.addIceCandidate(c); } catch { /* stale */ } }
  }

  private armConnectDeadline(): void {
    this.clearConnectDeadline();
    if (this.state !== 'open') this.setState('connecting');
    // Without a hard deadline, a peer behind a symmetric NAT with no TURN sits
    // on an infinite spinner: ICE does eventually reach 'failed' on its own,
    // but not reliably and not promptly. This is what turns a hang into a
    // sentence the player can act on.
    this.connectDeadline = setTimeout(() => {
      if (this.isHealthy) return;
      this.note(`connect timeout after ${this.connectTimeoutMs}ms`);
      this.setState('failed');
    }, this.connectTimeoutMs);
  }

  private clearConnectDeadline(): void {
    if (this.connectDeadline) { clearTimeout(this.connectDeadline); this.connectDeadline = null; }
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
  }

  private setState(s: LinkState): void {
    if (this.state === s || (this.closed && s !== 'closed')) return;
    this.state = s;
    this.cb.onState(this.peer, s);
  }

  /** Tells us whether this is a real P2P path or a TURN relay we are paying for. */
  private async probeCandidatePair(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((r: Record<string, unknown>) => {
        if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string') {
          pairId = r.selectedCandidatePairId;
        }
      });
      let local: string | undefined;
      let remote: string | undefined;
      stats.forEach((r: Record<string, unknown>) => {
        const isPair = r.type === 'candidate-pair' &&
          (r.id === pairId || (!pairId && r.nominated === true && r.state === 'succeeded'));
        if (!isPair) return;
        local = (stats.get(r.localCandidateId as string) as { candidateType?: string } | undefined)?.candidateType;
        remote = (stats.get(r.remoteCandidateId as string) as { candidateType?: string } | undefined)?.candidateType;
      });
      if (local || remote) {
        this.relayed = local === 'relay' || remote === 'relay';
        this.note(`path ${local ?? '?'} <-> ${remote ?? '?'}${this.relayed ? ' (TURN RELAY)' : ''}`);
      }
    } catch { /* getStats shape varies; diagnostics are best-effort */ }
  }

  private note(line: string): void {
    const entry = `${new Date().toISOString().slice(11, 23)} [${this.peer.slice(0, 6)}] ${line}`;
    this.diagnostics.push(entry);
    if (this.diagnostics.length > 60) this.diagnostics.shift();
    this.cb.log(entry);
  }
}

/* ========================================================================== *
 * RtcTransport
 * ========================================================================== */

interface Pending {
  resolve(result: AckMsg['result']): void;
  reject(err: TransportError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Remembers the room across a reload so `connect()` can resume a held seat. */
const RESUME_KEY = 'otrio.p2p.room';

export class RtcTransport implements Transport {
  readonly capabilities: Capabilities = P2P_CAPABILITIES;

  private identity: Identity;
  private cfg: RtcTransportConfig;
  private rtcConfig: RTCConfiguration;
  private events = new Emitter<TransportEventMap>();
  private listeners = new Set<() => void>();

  private sig: Signaling | null = null;
  private links = new Map<PlayerId, PeerLink>();
  private roster = new Map<PlayerId, PeerInfo>();

  private referee: PeerReferee | null = null;
  private refereeId: PlayerId | null = null;
  /** Fencing token. Increments on every migration; stale frames are dropped. */
  private epoch = 0;

  private status: ConnectionStatus = 'idle';
  private room: RoomState | null = null;
  private appliedSeq = 0;
  private pendingMove: Move | null = null;
  private quality: ConnectionQuality = initialQuality();
  private lastError: TransportError | null = null;
  private name: string;
  private snap: TransportSnapshot;

  private pending = new Map<string, Pending>();
  private connectPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private claimAcks = new Map<PlayerId, { seq: number; state?: RoomState }>();
  private claimEpoch = 0;
  private hiddenAt = 0;
  private lastRefereeMsgAt = 0;
  private outbox: ClientMessage[] = [];
  private unbind: Array<() => void> = [];
  private disposed = false;
  readonly diagnostics: string[] = [];
  /** Resolved once at construction. See `resolveSignalingUrl`. */
  private readonly signalingUrl: string;

  constructor(config: RtcTransportConfig) {
    this.cfg = config;
    this.identity = config.identity;
    this.name = config.identity.name;
    this.signalingUrl = resolveSignalingUrl(config.signalingUrl);
    this.rtcConfig = {
      // Falling back to the env vars means TURN can be configured entirely from
      // `.env.local`, with no code change and no credentials in the repo.
      iceServers: config.iceServers ?? iceServersFromEnv(viteEnv ?? {}),
      iceTransportPolicy: config.forceRelay ? 'relay' : 'all',
      // The referee opens up to three connections in quick succession; a warm
      // candidate saves a round trip on each.
      iceCandidatePoolSize: 1,
    };
    this.snap = this.buildSnapshot();
    this.getSnapshot = this.getSnapshot.bind(this);
    this.subscribe = this.subscribe.bind(this);
  }

  /* ---------------------- Transport surface ---------------------- */

  getSnapshot(): TransportSnapshot { return this.snap; }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    let active = true;
    return () => { if (active) { active = false; this.listeners.delete(listener); } };
  }

  on<K extends TransportEventType>(type: K, handler: (payload: TransportEventMap[K]) => void): Unsubscribe {
    return this.events.on(type, handler);
  }

  /**
   * For peer-to-peer there is nothing to connect *to* until a room code is
   * known — the signalling rendezvous is per-room. So `connect()` checks that
   * WebRTC works, resumes a remembered room if there is one, and otherwise just
   * reports `connected`, meaning "ready to create or join".
   *
   * That is a slightly different meaning of `connected` from the hosted
   * backend's "socket is up", but it is the same meaning to the UI: the lobby
   * buttons are live. Documented rather than papered over.
   */
  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new TransportError('CONNECTION_LOST', 'transport disposed'));
    if (this.status === 'connected') return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      if (!supportsWebRTC()) {
        throw this.fail(new TransportError('UNSUPPORTED', 'RTCPeerConnection is unavailable', { retryable: false }));
      }
      this.setStatus('connecting');
      this.quality = { ...this.quality, reconnectAttempts: 0 };
      this.bindLifecycle();

      const remembered = readResume();
      if (remembered && remembered.playerId === this.identity.playerId) {
        try {
          await this.joinRoom(remembered.code, { asSpectator: remembered.spectator });
          return;
        } catch {
          // The room is gone, or nobody is left in it. Tear down whatever the
          // half-finished join left behind before falling through to a clean
          // lobby — otherwise we report `connected` while holding an open
          // signalling socket pointed at a room we are not in.
          this.teardownRoom();
          clearResume();
        }
      }
      this.setStatus('connected');
    })();

    this.connectPromise = this.connectPromise.finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async createRoom(options?: CreateRoomOptions): Promise<RoomCode> {
    if (!supportsWebRTC()) throw this.fail(new TransportError('UNSUPPORTED', 'WebRTC is unavailable'));
    this.bindLifecycle();
    const code = mintRoomCode();
    this.setStatus('connecting');
    await this.openSignaling(code);

    // We are alone, so we are trivially the referee. Epoch 1 so that any later
    // migration strictly increases it.
    this.epoch = 1;
    this.refereeId = this.identity.playerId;
    this.referee = PeerReferee.create(
      code,
      { ...this.identity, name: this.name },
      options,
      this.capabilities,
      (to, msg) => this.refereeOut(to, msg),
    );
    this.referee.noteName(this.identity.playerId, this.name);
    this.applyRoom(this.referee.snapshot());
    this.setStatus('connected');
    this.startTimers();
    writeResume(code, this.identity.playerId, false);
    return code;
  }

  async joinRoom(code: RoomCode, options?: JoinRoomOptions): Promise<RoomCode> {
    if (!supportsWebRTC()) throw this.fail(new TransportError('UNSUPPORTED', 'WebRTC is unavailable'));
    const normalized = normalizeRoomCode(code);
    // Checked locally so an obviously bad code costs nothing.
    if (!isPlausibleRoomCode(normalized)) {
      throw this.fail(new TransportError('CODE_INVALID', `"${code}" is not a room code`));
    }
    this.bindLifecycle();
    this.setStatus('connecting');
    await this.openSignaling(normalized);

    // Bootstrap: the peer with the lowest signalling join order is the room's
    // creator and therefore its referee. This uses signalling ordering ONLY to
    // find someone to talk to; once a RoomState arrives, `electReferee` takes
    // over and works purely from data every peer already shares.
    const others = [...this.roster.values()]
      .filter((p) => p.id !== this.identity.playerId)
      .sort((a, b) => a.order - b.order);
    if (others.length === 0) {
      this.sig?.close();
      this.sig = null;
      throw this.fail(new TransportError('ROOM_NOT_FOUND', `nobody is in room ${normalized}`));
    }

    this.refereeId = others[0].id;
    await this.dial(this.refereeId);
    await this.waitForLink(this.refereeId);

    void this.request({ t: 'hello', protocolVersion: PROTOCOL_VERSION, playerId: this.identity.playerId, sessionSecret: this.identity.sessionSecret, name: this.name }, false);
    const result = await this.request({ t: 'joinRoom', rid: newRid(), code: normalized, asSpectator: options?.asSpectator }, true);
    if (result && result.kind === 'room') this.applyRoom(result.state);
    this.setStatus('connected');
    this.startTimers();
    writeResume(normalized, this.identity.playerId, options?.asSpectator === true);
    return normalized;
  }

  async leaveRoom(): Promise<void> {
    if (!this.room) return;
    clearResume();
    try { await this.request({ t: 'leaveRoom', rid: newRid() }, true); }
    catch { /* leaving is best-effort; we tear down regardless */ }
    this.teardownRoom();
  }

  async setReady(ready: boolean): Promise<void> {
    await this.request({ t: 'setReady', rid: newRid(), ready }, true);
  }

  async setName(name: string): Promise<void> {
    this.name = sanitizeName(name, this.name);
    if (!this.room) { this.publish(); return; }
    await this.request({ t: 'setName', rid: newRid(), name: this.name }, true);
  }

  async startGame(): Promise<void> {
    await this.request({ t: 'startGame', rid: newRid() }, true);
  }

  sendMove(move: Move): Promise<void> {
    // `pendingMove` is set before anything is transmitted, so the UI can draw a
    // ghost ring on the same frame as the tap. The authoritative board always
    // wins; this is a rendering hint and is never applied to `room`.
    if (this.pendingMove) {
      return Promise.reject(new TransportError('NOT_YOUR_TURN', 'a move is already pending'));
    }
    if (!this.room) return Promise.reject(new TransportError('NOT_IN_ROOM', 'not in a room'));
    const view = deriveLocalView(this.room, this.identity.playerId);
    if (view.role === 'spectator') return Promise.reject(new TransportError('SPECTATOR_FORBIDDEN', 'spectators cannot move'));
    if (view.role === 'none') return Promise.reject(new TransportError('NOT_IN_ROOM', 'no seat'));

    this.pendingMove = move;
    this.publish();

    return this.request({ t: 'move', rid: newRid(), move, expectedSeq: this.appliedSeq }, true)
      .then(() => { this.clearPending(); })
      .catch((err: TransportError) => {
        this.clearPending();
        this.events.emit('moveRejected', { move, error: err });
        throw err;
      });
  }

  async requestRematch(accept: boolean): Promise<void> {
    await this.request({ t: 'rematch', rid: newRid(), accept }, true);
  }

  async resync(): Promise<void> {
    if (!this.room) return;
    if (this.isReferee && this.referee) { this.applyRoom(this.referee.snapshot()); return; }
    await this.request({ t: 'resync', rid: newRid() }, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimers();
    if (this.electionTimer) { clearTimeout(this.electionTimer); this.electionTimer = null; }
    for (const l of this.links.values()) l.close('closing');
    this.links.clear();
    for (const off of this.unbind) { try { off(); } catch { /* ignore */ } }
    this.unbind = [];
    try { this.sig?.close(); } catch { /* ignore */ }
    this.sig = null;
    this.referee = null;
    const err = new TransportError('CONNECTION_LOST', 'transport disposed');
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    this.setStatus('closed');
    this.events.clear();
    this.listeners.clear();
  }

  /** Full connection diagnostics. The first thing to ask a player for. */
  getDiagnostics(): string {
    const lines = [
      `self=${this.identity.playerId} name=${this.name}`,
      `status=${this.status} referee=${this.refereeId ?? 'none'} isReferee=${this.isReferee} epoch=${this.epoch}`,
      `room=${this.room?.code ?? 'none'} seq=${this.appliedSeq} phase=${this.room?.phase ?? '-'}`,
      `signalling=${this.sig?.state ?? 'none'} roster=${[...this.roster.keys()].map((k) => k.slice(0, 6)).join(',')}`,
      `rtt=${this.quality.rttMs ?? '?'}ms jitter=${this.quality.jitterMs ?? '?'}ms grade=${this.quality.grade}`,
      '--- transport ---',
      ...this.diagnostics,
    ];
    for (const l of this.links.values()) {
      lines.push(`--- link ${l.peer.slice(0, 6)} state=${l.state} pc=${l.connectionState} relayed=${l.relayed ?? '?'} ---`);
      lines.push(...l.diagnostics);
    }
    return lines.join('\n');
  }

  private get isReferee(): boolean { return this.refereeId === this.identity.playerId; }

  /* ---------------------- signalling ---------------------- */

  private async openSignaling(code: RoomCode): Promise<void> {
    if (this.sig) { try { this.sig.close(); } catch { /* ignore */ } }
    const factory = this.cfg.signalingFactory ?? createSignaling;
    const sig = factory({
      url: this.signalingUrl,
      room: code,
      // Peer ids ARE PlayerIds. The transport interface forbids a second
      // identity space, and there is no reason for one.
      peerId: this.identity.playerId,
      name: this.name,
    });
    this.sig = sig;

    this.unbind.push(
      sig.on('welcome', (info) => {
        this.roster.clear();
        for (const p of info.peers) this.roster.set(p.id, p);
        this.roster.set(info.you, { id: info.you, name: this.name, order: info.order });
        this.note(`signalling welcome order=${info.order} peers=${info.peers.length}`);
        // On a reconnect the referee may have changed underneath us.
        if (info.resumed && this.room) this.reconcileReferee();
      }),
      sig.on('peerJoin', (p) => {
        this.roster.set(p.id, p);
        this.note(`peer joined ${p.id.slice(0, 6)}`);
        if (this.isReferee) void this.dial(p.id);
      }),
      sig.on('peerLeave', (id) => {
        this.roster.delete(id);
        this.note(`peer left signalling ${id.slice(0, 6)}`);
        // Signalling presence is a weak signal: a phone that switched to
        // cellular drops its WebSocket while its data channel is still fine.
        // Only act when the data channel agrees.
        const link = this.links.get(id);
        if (link && link.isHealthy) return;
        this.onPeerGone(id);
      }),
      sig.on('signal', (from, data) => { void this.onSignal(from, data as Sig); }),
      sig.on('error', (e) => {
        this.note(`signalling error: ${e.message}`);
        if (e.fatal) this.fail(new TransportError(e.code === 'room-full' ? 'ROOM_FULL' : 'SIGNALING_FAILED', e.message, { retryable: true }));
      }),
    );

    try {
      await sig.connect();
    } catch (err) {
      throw this.fail(new TransportError('SIGNALING_FAILED', `cannot reach the signalling server at ${this.signalingUrl}`, { retryable: true, cause: err }));
    }
    // Give late `peer-join` notifications a beat to arrive before we decide the
    // room is empty. Cheap, and it removes a race that only shows up on a fast
    // local network.
    await delay(150);
  }

  private async onSignal(from: PlayerId, s: Sig): Promise<void> {
    if (!s || typeof s !== 'object') return;
    switch (s.k) {
      case 'offer': {
        // A stale epoch means a deposed referee that has not noticed yet.
        if (s.e < this.epoch) { this.note(`stale offer from ${from.slice(0, 6)}`); return; }
        if (s.e > this.epoch) { this.epoch = s.e; this.refereeId = from; }
        this.dropLink(from);
        const link = this.makeLink(from, false);
        try { await link.acceptOffer(s.sdp, this.epoch); }
        catch (err) { this.note(`acceptOffer failed: ${String(err)}`); }
        break;
      }
      case 'answer':
        await this.links.get(from)?.acceptAnswer(s.sdp).catch(() => undefined);
        break;
      case 'ice':
        await this.links.get(from)?.addIce(s.cand);
        break;
      case 'want-offer':
        if (this.isReferee) void this.dial(from);
        break;
      case 'need-restart':
        if (this.isReferee) {
          const l = this.links.get(from);
          if (l) await l.restartIce(this.epoch).catch(() => this.dial(from));
          else void this.dial(from);
        }
        break;
      case 'claim': return this.onClaim(from, s);
      case 'claim-ack':
        if (s.e === this.claimEpoch) {
          this.claimAcks.set(from, { seq: s.seq, state: s.state });
          this.maybeAssumeReferee(false);
        }
        break;
      case 'claim-deny':
        if (s.e === this.claimEpoch && s.rank < this.myRank()) {
          this.note(`yielding election to ${from.slice(0, 6)}`);
          this.claimEpoch = 0;
          this.claimAcks.clear();
        }
        break;
    }
  }

  /* ---------------------- links ---------------------- */

  private makeLink(peer: PlayerId, isOfferer: boolean): PeerLink {
    const link = new PeerLink(peer, isOfferer, this.rtcConfig, this.cfg.peerConnectTimeoutMs ?? DEFAULT_PEER_CONNECT_TIMEOUT_MS, {
      onFrame: (p, f) => this.onFrame(p, f),
      onState: (p, st) => this.onLinkState(p, st),
      signal: (p, s) => this.sig?.send(p, s),
      log: (line) => this.pushDiag(line),
    });
    this.links.set(peer, link);
    return link;
  }

  private async dial(peer: PlayerId): Promise<void> {
    if (peer === this.identity.playerId || this.disposed) return;
    const existing = this.links.get(peer);
    if (existing && existing.state !== 'failed' && existing.state !== 'closed') return;
    this.dropLink(peer);
    const link = this.makeLink(peer, true);
    try { await link.createOffer(this.epoch); }
    catch (err) { this.note(`createOffer to ${peer.slice(0, 6)} failed: ${String(err)}`); }
  }

  private dropLink(peer: PlayerId): void {
    const l = this.links.get(peer);
    if (l) { l.close(); this.links.delete(peer); }
  }

  /** Resolve when a link opens, or reject with the honest reason it did not. */
  private waitForLink(peer: PlayerId): Promise<void> {
    const link = this.links.get(peer);
    if (link?.isHealthy) return Promise.resolve();
    const budget = (this.cfg.peerConnectTimeoutMs ?? DEFAULT_PEER_CONNECT_TIMEOUT_MS) + 1_000;
    return new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const iv = setInterval(() => {
        const l = this.links.get(peer);
        if (l?.isHealthy) { clearInterval(iv); resolve(); return; }
        if (l?.state === 'failed' || Date.now() - started > budget) {
          clearInterval(iv);
          reject(this.fail(new TransportError(
            'PEER_UNREACHABLE',
            `could not open a direct connection to ${peer.slice(0, 6)}`,
            { retryable: true },
          )));
        }
      }, 120);
    });
  }

  private onLinkState(peer: PlayerId, st: LinkState): void {
    this.note(`link ${peer.slice(0, 6)} -> ${st}`);
    if (st === 'open') {
      if (this.isReferee) {
        this.referee?.setConnection(peer, 'online');
      } else if (peer === this.refereeId) {
        this.lastRefereeMsgAt = Date.now();
        this.quality = { ...this.quality, reconnectAttempts: 0 };
        this.setStatus('connected');
        // Re-announce, so a referee that migrated knows our identity, then
        // pull a fresh snapshot: we may have missed moves while the link was
        // down, and `seq` alone cannot tell us what they were.
        void this.request({ t: 'hello', protocolVersion: PROTOCOL_VERSION, playerId: this.identity.playerId, sessionSecret: this.identity.sessionSecret, name: this.name }, false);
        this.flushOutbox();
        void this.resync().catch(() => undefined);
      }
    } else if (st === 'reconnecting') {
      // The referee drives recovery for every link, so leaves only ever
      // restart toward the referee. Exactly one side renegotiates; glare
      // cannot happen.
      if (this.isReferee) {
        this.referee?.setConnection(peer, 'reconnecting');
        void this.links.get(peer)?.restartIce(this.epoch);
      } else if (peer === this.refereeId) {
        this.setStatus('reconnecting');
        this.quality = { ...this.quality, reconnectAttempts: this.quality.reconnectAttempts + 1 };
        void this.links.get(peer)?.restartIce(this.epoch);
      }
    } else if (st === 'failed') {
      if (peer === this.refereeId && !this.isReferee) {
        this.fail(new TransportError('PEER_UNREACHABLE', `lost the direct connection to the referee`, { retryable: true }));
        this.onPeerGone(peer);
      } else if (this.isReferee) {
        this.referee?.setConnection(peer, 'reconnecting');
      }
    }
    this.publish();
  }

  private onFrame(from: PlayerId, f: Frame): void {
    const link = this.links.get(from);
    if (link) link.lastRecvAt = Date.now();
    this.quality = { ...this.quality, lastMessageAt: Date.now() };

    switch (f.k) {
      case 'c':
        // Only the referee admits client messages. If we are not the referee
        // the sender is out of date; our heartbeat carries the truth and they
        // will re-point within two seconds.
        if (this.isReferee && this.referee) this.referee.handle(from, f.m);
        break;

      case 's':
        if (from !== this.refereeId) { this.note(`ignoring server frame from non-referee ${from.slice(0, 6)}`); return; }
        if (f.e < this.epoch) return; // deposed referee still talking
        this.lastRefereeMsgAt = Date.now();
        this.onServerMessage(f.m);
        break;

      case 'hb':
        if (f.e < this.epoch) return;
        if (f.e > this.epoch || this.refereeId !== f.referee) {
          this.note(`adopting referee ${f.referee.slice(0, 6)} at epoch ${f.e}`);
          this.epoch = f.e;
          this.refereeId = f.referee;
          this.publish();
        }
        this.lastRefereeMsgAt = Date.now();
        link?.send({ k: 'hbr', ts: f.ts });
        break;

      case 'hbr': {
        if (!link) break;
        const sample = Math.max(0, Date.now() - f.ts);
        link.rttMs = sample;
        if (this.isReferee) this.updateQualityFromWorstPeer();
        break;
      }

      case 'bye':
        this.note(`peer ${from.slice(0, 6)} said bye`);
        this.dropLink(from);
        this.onPeerGone(from);
        break;
    }
  }

  /** Handle a `ServerMessage`, identically to how the hosted client would. */
  private onServerMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.fail(new TransportError('PROTOCOL_MISMATCH', `referee speaks v${msg.protocolVersion}`));
          return;
        }
        this.name = msg.name;
        if (msg.resumed) this.applyRoom(msg.resumed);
        this.quality = { ...this.quality, clockOffsetMs: msg.serverTime - Date.now() };
        this.publish();
        break;

      case 'ack': {
        const p = this.pending.get(msg.rid);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.rid);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(TransportError.fromWire(msg.error ?? wireError('INTERNAL', 'ack without error')));
        break;
      }

      case 'state':
        this.applyRoom(msg.state);
        break;

      case 'event':
        this.relayEvent(msg);
        break;

      case 'pong': {
        const sample = Date.now() - msg.t0;
        const { rttMs, jitterMs } = smoothRtt(this.quality, sample);
        this.quality = {
          ...this.quality,
          rttMs, jitterMs,
          grade: gradeQuality(rttMs),
          // One-way delay assumed symmetric — the standard approximation, and
          // easily good enough to render a countdown.
          clockOffsetMs: msg.serverTime + sample / 2 - Date.now(),
        };
        this.publish();
        break;
      }

      case 'error':
        this.fail(TransportError.fromWire(msg.error));
        if (msg.fatal) this.teardownRoom();
        break;
    }
  }

  private relayEvent(e: EventMsg): void {
    switch (e.kind) {
      case 'moveApplied': this.events.emit('moveApplied', { seat: e.seat, move: e.move, seq: e.seq }); break;
      case 'moveRejected': this.events.emit('moveRejected', { move: e.move, error: TransportError.fromWire(e.error) }); break;
      case 'playerJoined': this.events.emit('playerJoined', { player: e.player }); break;
      case 'playerLeft': this.events.emit('playerLeft', { playerId: e.playerId, name: e.name, permanent: e.permanent }); break;
      case 'playerReconnected': this.events.emit('playerReconnected', { playerId: e.playerId, name: e.name }); break;
      case 'connectionChanged': this.events.emit('connectionChanged', { playerId: e.playerId, connection: e.connection }); break;
      case 'gameStarted': this.events.emit('gameStarted', { seq: e.seq }); break;
      case 'gameEnded': this.events.emit('gameEnded', { reason: e.reason, winner: e.winner, line: e.line }); break;
      case 'hostChanged': this.events.emit('hostChanged', { playerId: e.playerId, name: e.name }); break;
      case 'roomClosed': this.events.emit('roomClosed', { reason: e.reason }); this.teardownRoom(); break;
    }
  }

  /** The referee's outbound path: to a peer's data channel, or to ourselves. */
  private refereeOut(to: PlayerId | '*', msg: ServerMessage): void {
    if (to === '*') {
      const frame: Frame = { k: 's', e: this.epoch, m: msg };
      for (const l of this.links.values()) if (l.isHealthy) l.send(frame);
      this.onServerMessage(msg); // the referee is a player too
      return;
    }
    if (to === this.identity.playerId) { this.onServerMessage(msg); return; }
    this.links.get(to)?.send({ k: 's', e: this.epoch, m: msg });
  }

  /* ---------------------- requests ---------------------- */

  /**
   * Send a `ClientMessage` to the referee and, when it carries a `rid`, wait
   * for its `Ack`.
   *
   * While the link is down, commands are QUEUED rather than rejected (the
   * interface requires picking one and saying so). They still expire after
   * `TIMING.requestTimeoutMs`, so nothing hangs — a tap made during a two-second
   * cellular handover lands, and one made during a real outage fails cleanly.
   */
  private request(msg: ClientMessage, expectAck: boolean): Promise<AckMsg['result']> {
    if (this.disposed) return Promise.reject(new TransportError('CONNECTION_LOST', 'disposed'));

    const deliver = (): boolean => {
      if (this.isReferee && this.referee) {
        // The referee's own commands go through the identical validate →
        // apply → snapshot → deliver path, so the host player's experience is
        // not subtly different from everyone else's. This uniformity is a hard
        // requirement in transport.ts, and it is where bugs would otherwise
        // hide on exactly one side.
        queueMicrotask(() => this.referee?.handle(this.identity.playerId, msg));
        return true;
      }
      const link = this.refereeId ? this.links.get(this.refereeId) : undefined;
      if (link?.isHealthy) return link.send({ k: 'c', e: this.epoch, m: msg });
      return false;
    };

    if (!expectAck) {
      if (!deliver() && this.outbox.length < 32) this.outbox.push(msg);
      return Promise.resolve(undefined);
    }

    const rid = (msg as { rid?: string }).rid ?? newRid();
    return new Promise<AckMsg['result']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(this.fail(new TransportError('TIMEOUT', `no reply to ${msg.t} in ${TIMING.requestTimeoutMs}ms`, { retryable: true })));
      }, TIMING.requestTimeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      if (!deliver()) {
        if (this.outbox.length < 32) this.outbox.push(msg);
        else {
          clearTimeout(timer);
          this.pending.delete(rid);
          reject(new TransportError('CONNECTION_LOST', 'too many queued commands'));
        }
      }
    });
  }

  private flushOutbox(): void {
    if (!this.outbox.length) return;
    const q = this.outbox; this.outbox = [];
    const link = this.refereeId ? this.links.get(this.refereeId) : undefined;
    for (const m of q) {
      if (this.isReferee && this.referee) this.referee.handle(this.identity.playerId, m);
      else link?.send({ k: 'c', e: this.epoch, m });
    }
  }

  /* ---------------------- referee election ---------------------- */

  /**
   * Who should be refereeing, computed from data every peer already has.
   *
   * DEVIATION FROM transport.ts, DELIBERATE: the interface specifies "the
   * lexicographically smallest PlayerId among those currently connected". That
   * rule is deterministic but not *stable* — `PlayerId` is random, so a player
   * whose id happens to sort low seizes the referee role the moment they join,
   * taking it from the person who made the room, and hands it back every time
   * they blink. The interface's own justification ("room creator holds it
   * initially by construction") only holds while nobody else has arrived.
   *
   * Using the lowest connected `seat` keeps every property the interface
   * actually wanted — every peer computes the same answer from the same shared
   * inputs, with no vote and no tie-break — while making the creator the
   * referee for real, because seats are assigned in join order. Migration then
   * walks down the table in a predictable order. `PlayerId` remains the
   * tie-break. Flagged in the report.
   */
  private electReferee(): PlayerId | null {
    if (!this.room) return this.refereeId;
    // A reachable referee KEEPS the role. Migration is a response to failure,
    // not a standing seniority contest: re-electing every time a low-seat
    // player rejoins would churn the role and resynchronise the whole table
    // for no benefit. This is the stability property the interface's
    // "smallest PlayerId" rule lacks.
    if (this.refereeId && this.isPeerReachable(this.refereeId)) return this.refereeId;
    const eligible = this.room.players
      .filter((p) => !p.forfeited && this.isPeerReachable(p.playerId))
      .sort((a, b) => (a.seat - b.seat) || (a.playerId < b.playerId ? -1 : 1));
    return eligible[0]?.playerId ?? null;
  }

  private myRank(): number {
    const me = this.room?.players.find((p) => p.playerId === this.identity.playerId);
    return me ? me.seat : Number.MAX_SAFE_INTEGER;
  }

  private isPeerReachable(id: PlayerId): boolean {
    if (id === this.identity.playerId) return true;
    const link = this.links.get(id);
    if (link) return link.isHealthy;
    // No link of our own. In a star we only ever connect to the referee, so
    // its absence is decisive; for other leaves, signalling presence is the
    // best evidence available.
    if (id === this.refereeId) return false;
    return this.roster.has(id);
  }

  private reconcileReferee(): void {
    const who = this.electReferee();
    if (who === this.identity.playerId && who !== this.refereeId) this.beginElection();
  }

  private onPeerGone(id: PlayerId): void {
    this.dropLink(id);
    if (this.isReferee) {
      this.referee?.setConnection(id, 'reconnecting');
      this.publish();
      return;
    }
    if (id !== this.refereeId) return;

    // The referee went away. This is the case that actually happens: the phone
    // rang, Safari froze the tab, the battery died, or they walked out of range.
    this.note('referee lost');
    this.setStatus('reconnecting');
    if (this.room && this.room.phase !== 'lobby' && this.room.phase !== 'finished') {
      // Show the same pause UI the hosted backend uses for a disconnect, as
      // transport.ts requires. No new UI is needed.
      this.applyRoom({
        ...this.room,
        seq: this.room.seq, // not an authoritative bump; purely local presentation
        phase: 'paused',
        pause: { reason: 'host-migrating', waitingFor: [this.refereeId], resumesAt: Date.now() + TIMING.requestTimeoutMs },
      }, true);
    }
    this.beginElection();
  }

  private beginElection(): void {
    if (this.electionTimer || this.disposed) return;
    // Stagger by seat so the senior survivor claims first and the others
    // usually never claim at all. Jitter on top: four phones that lost the same
    // referee all wake at the same instant.
    const delayMs = ELECTION_STAGGER_MS * (this.myRank() + 1) + Math.random() * 200;
    this.electionTimer = setTimeout(() => { this.electionTimer = null; this.claimReferee(); }, delayMs);
  }

  private claimReferee(): void {
    if (this.disposed || this.isReferee) return;
    const who = this.electReferee();
    if (who !== this.identity.playerId) { this.note(`deferring to ${who?.slice(0, 6) ?? 'nobody'}`); return; }

    this.claimEpoch = this.epoch + 1;
    this.claimAcks.clear();
    this.claimAcks.set(this.identity.playerId, { seq: this.appliedSeq, state: this.room ?? undefined });
    this.note(`claiming referee at epoch ${this.claimEpoch} seq ${this.appliedSeq}`);
    const claim: Sig = { k: 'claim', e: this.claimEpoch, rank: this.myRank(), seq: this.appliedSeq };
    for (const p of this.roster.values()) if (p.id !== this.identity.playerId) this.sig?.send(p.id, claim);
    setTimeout(() => this.maybeAssumeReferee(true), 1_500);
  }

  private onClaim(from: PlayerId, s: Extract<Sig, { k: 'claim' }>): void {
    if (s.e <= this.epoch) {
      this.sig?.send(from, { k: 'claim-deny', e: s.e, rank: this.myRank() } satisfies Sig);
      return;
    }
    // A more senior survivor outranks this claimant. Deny, and claim ourselves.
    if (this.myRank() < s.rank && !this.isReferee) {
      this.sig?.send(from, { k: 'claim-deny', e: s.e, rank: this.myRank() } satisfies Sig);
      this.beginElection();
      return;
    }
    // Accept, and hand over our snapshot if it is ahead of theirs. This is how
    // a move the old referee applied but only half-broadcast is recovered.
    this.note(`acking claim from ${from.slice(0, 6)} (our seq ${this.appliedSeq}, theirs ${s.seq})`);
    this.sig?.send(from, {
      k: 'claim-ack', e: s.e, seq: this.appliedSeq,
      state: this.appliedSeq > s.seq ? this.room ?? undefined : undefined,
    } satisfies Sig);
    if (this.electionTimer) { clearTimeout(this.electionTimer); this.electionTimer = null; }
  }

  private maybeAssumeReferee(deadlineReached: boolean): void {
    if (!this.claimEpoch || this.disposed) return;
    const roomSize = this.room?.players.filter((p) => !p.forfeited).length ?? this.roster.size;
    // Majority of the room we last saw. This is the split-brain guard: two
    // halves of a partitioned table cannot both reach a majority, so they
    // cannot both elect a referee and fork the game.
    //
    // Stated honestly: this is a quorum rule, not a consensus protocol. It
    // prevents the common failure, not every failure. With two players it means
    // migration is impossible — which is correct, because a two-player game
    // with one player left is over regardless.
    const quorum = Math.floor(roomSize / 2) + 1;
    if (this.claimAcks.size < quorum && !deadlineReached) return;

    if (this.claimAcks.size < quorum) {
      this.note(`election failed: ${this.claimAcks.size}/${quorum}`);
      this.claimEpoch = 0;
      this.fail(new TransportError('REFEREE_LOST', `only ${this.claimAcks.size} of ${quorum} players answered`, { retryable: false }));
      this.setStatus('failed');
      return;
    }

    // Adopt the furthest-ahead snapshot anyone acked with. `seq` never goes
    // backwards, so no client rewinds.
    let best = this.room;
    let bestSeq = this.appliedSeq;
    for (const ack of this.claimAcks.values()) {
      if (ack.state && ack.seq > bestSeq) { best = ack.state; bestSeq = ack.seq; }
    }
    if (!best) { this.claimEpoch = 0; return; }

    this.epoch = this.claimEpoch;
    this.claimEpoch = 0;
    this.claimAcks.clear();
    this.refereeId = this.identity.playerId;
    this.note(`assuming referee at epoch ${this.epoch}, seq ${bestSeq}`);

    this.referee = PeerReferee.adopt(
      best,
      this.cfg.turnTimeoutMs ?? 0,
      this.capabilities,
      (to, msg) => this.refereeOut(to, msg),
    );
    this.appliedSeq = Math.max(this.appliedSeq, best.seq);
    this.applyRoom(best, true);
    this.referee.assumeHost(this.identity.playerId);

    // Rebuild the star: every survivor gets a fresh offer stamped with the new
    // epoch, and a snapshot as soon as the channel opens.
    for (const p of best.players) {
      if (p.playerId === this.identity.playerId || p.forfeited) continue;
      this.dropLink(p.playerId);
      void this.dial(p.playerId);
    }
    this.setStatus('connected');
    this.startTimers();
  }

  /* ---------------------- timers ---------------------- */

  private startTimers(): void {
    this.stopTimers();
    this.lastRefereeMsgAt = Date.now();
    this.timer = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.pingTimer = setInterval(() => this.ping(), TIMING.pingIntervalMs);
  }

  private stopTimers(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private tick(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (this.isReferee && this.referee) {
      this.referee.tick(now);
      const frame: Frame = { k: 'hb', e: this.epoch, referee: this.identity.playerId, seq: this.appliedSeq, ts: now };
      for (const [id, l] of this.links) {
        if (l.isHealthy) l.send(frame);
        else if (l.state === 'failed' && this.roster.has(id)) void this.dial(id);
        if (l.lastRecvAt && now - l.lastRecvAt > PEER_SILENT_MS) {
          this.note(`peer ${id.slice(0, 6)} silent ${now - l.lastRecvAt}ms`);
          l.lastRecvAt = now; // do not restart every tick
          void l.restartIce(this.epoch);
        }
      }
      for (const p of this.room?.players ?? []) {
        if (p.playerId !== this.identity.playerId && !p.forfeited && !this.links.has(p.playerId) && this.roster.has(p.playerId)) {
          void this.dial(p.playerId);
        }
      }
    } else if (this.refereeId && this.room) {
      if (now - this.lastRefereeMsgAt > PEER_SILENT_MS) this.onPeerGone(this.refereeId);
    }
    this.publish();
  }

  private ping(): void {
    if (this.disposed || !this.room) return;
    if (this.isReferee) { this.updateQualityFromWorstPeer(); return; }
    void this.request({ t: 'ping', id: newRid(), t0: Date.now(), rttMs: this.quality.rttMs ?? undefined }, false);
  }

  /**
   * The referee has no upstream to time, so its own quality is the *worst* of
   * its peers — the number that actually predicts how stale someone's view is.
   */
  private updateQualityFromWorstPeer(): void {
    let worst: number | null = null;
    for (const l of this.links.values()) {
      if (l.rttMs === null) continue;
      worst = worst === null ? l.rttMs : Math.max(worst, l.rttMs);
    }
    if (worst === null) return;
    const { rttMs, jitterMs } = smoothRtt(this.quality, worst);
    this.quality = { ...this.quality, rttMs, jitterMs, grade: gradeQuality(rttMs), clockOffsetMs: 0 };
    this.publish();
  }

  /* ---------------------- mobile lifecycle ---------------------- */

  /**
   * The four-phones-on-a-table failure modes, handled explicitly.
   *
   * iOS Safari throttles timers in a backgrounded tab and freezes the page
   * entirely after a while. WebRTC sometimes survives a short background and
   * usually does not survive a long one. Waiting for ICE to notice costs about
   * thirty seconds of consent-freshness timeouts, during which the player
   * stares at a frozen board. Probing the instant we return cuts that to about
   * a second.
   */
  private bindLifecycle(): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    if (this.unbind.some((f) => (f as { lifecycle?: boolean }).lifecycle)) return;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { this.hiddenAt = Date.now(); return; }
      const away = Date.now() - this.hiddenAt;
      this.note(`foregrounded after ${away}ms`);
      if (away > WAKE_SUSPECT_MS) this.wake(false);
    };
    const onOnline = () => { this.note('network online'); this.wake(false); };
    // Restored from the back/forward cache: every socket is dead although the
    // objects still look alive.
    const onPageShow = (ev: PageTransitionEvent) => { if (ev.persisted) this.wake(true); };
    // Best effort only: iOS gives no reliable async window here. If it does not
    // land, the others fall back to the heartbeat timeout.
    const onPageHide = () => { for (const l of this.links.values()) l.send({ k: 'bye', reason: 'page hidden' }); };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onPageShow as EventListener);
    window.addEventListener('pagehide', onPageHide);
    const off = Object.assign(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pageshow', onPageShow as EventListener);
      window.removeEventListener('pagehide', onPageHide);
    }, { lifecycle: true });
    this.unbind.push(off);
  }

  private wake(force: boolean): void {
    if (this.disposed) return;
    // Do not declare the referee dead because our own timers were frozen.
    this.lastRefereeMsgAt = Date.now();
    for (const [id, l] of this.links) {
      const suspect = force || !l.isHealthy || l.connectionState !== 'connected';
      if (!suspect) continue;
      this.note(`waking link ${id.slice(0, 6)} (${l.state}/${l.connectionState})`);
      if (this.isReferee || id === this.refereeId) void l.restartIce(this.epoch);
    }
    if (this.refereeId && !this.isReferee && !this.links.has(this.refereeId)) {
      this.sig?.send(this.refereeId, { k: 'want-offer', e: this.epoch } satisfies Sig);
    }
    void this.resync().catch(() => undefined);
    this.publish();
  }

  /* ---------------------- snapshot plumbing ---------------------- */

  /**
   * Adopt an authoritative snapshot.
   *
   * `local` marks a presentation-only change (the migration pause) that did not
   * come from a referee and must not move `appliedSeq`.
   */
  private applyRoom(state: RoomState, local = false): void {
    if (!local && state.seq <= this.appliedSeq) return; // stale or duplicate
    if (!local) this.appliedSeq = state.seq;
    this.room = state;
    if (this.pendingMove && state.game?.lastMove) {
      const lm = state.game.lastMove;
      const me = state.players.find((p) => p.playerId === this.identity.playerId);
      if (me && lm.seat === me.seat && lm.move.cell === this.pendingMove.cell && lm.move.size === this.pendingMove.size) {
        this.pendingMove = null;
      }
    }
    // Any change to who is connected can make us the new referee.
    if (!this.isReferee) this.reconcileReferee();
    this.publish();
  }

  private clearPending(): void {
    if (this.pendingMove) { this.pendingMove = null; this.publish(); }
  }

  private teardownRoom(): void {
    clearResume();
    this.stopTimers();
    for (const l of this.links.values()) l.close('leaving');
    this.links.clear();
    this.roster.clear();
    try { this.sig?.close(); } catch { /* ignore */ }
    this.sig = null;
    this.referee = null;
    this.refereeId = null;
    this.room = null;
    this.appliedSeq = 0;
    this.pendingMove = null;
    this.publish();
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next || this.status === 'closed') return;
    const previous = this.status;
    this.status = next;
    this.publish();
    this.events.emit('statusChanged', { status: next, previous });
  }

  private fail(err: TransportError): TransportError {
    this.lastError = err;
    this.note(`error[${err.code}] ${err.message}`);
    this.publish();
    this.events.emit('error', err);
    return err;
  }

  private buildSnapshot(): TransportSnapshot {
    const view: { role: LocalRole; seat: Seat | null; isMyTurn: boolean; isHost: boolean } =
      deriveLocalView(this.room, this.identity.playerId);
    return {
      status: this.status,
      playerId: this.identity.playerId,
      name: this.name,
      room: this.room,
      role: view.role,
      seat: view.seat,
      isMyTurn: view.isMyTurn,
      isHost: view.isHost,
      pendingMove: this.pendingMove,
      quality: this.quality,
      lastError: this.lastError,
      capabilities: this.capabilities,
    };
  }

  /**
   * Rebuild the snapshot and notify.
   *
   * `useSyncExternalStore` demands a referentially stable snapshot between real
   * changes: returning a fresh deep-equal object on every call re-renders
   * forever. So this compares the cheap fields and keeps the old reference when
   * nothing moved. `room` is compared by identity, which is exact — it is only
   * ever replaced wholesale, never mutated.
   */
  private publish(): void {
    const next = this.buildSnapshot();
    const prev = this.snap;
    const same =
      prev.status === next.status &&
      prev.room === next.room &&
      prev.name === next.name &&
      prev.pendingMove === next.pendingMove &&
      prev.lastError === next.lastError &&
      prev.quality === next.quality;
    if (same) return;
    this.snap = next;
    for (const l of [...this.listeners]) {
      try { l(); } catch (e) { console.error('[rtc] subscriber threw', e); }
    }
  }

  private note(line: string): void {
    const entry = `${new Date().toISOString().slice(11, 23)} ${line}`;
    this.pushDiag(entry);
    if (this.cfg.debug) console.debug('[rtc]', line);
  }

  private pushDiag(line: string): void {
    this.diagnostics.push(line);
    if (this.diagnostics.length > 200) this.diagnostics.shift();
  }
}

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

export function supportsWebRTC(): boolean {
  return (
    typeof RTCPeerConnection !== 'undefined' &&
    typeof RTCPeerConnection.prototype.createDataChannel === 'function'
  );
}

/**
 * Room codes drawn from `ROOM_CODE_ALPHABET` so `normalizeRoomCode` and
 * `isPlausibleRoomCode` treat them exactly as they treat hosted codes. Six
 * characters of Crockford Base32 is about a billion rooms, which is plenty of
 * margin against someone guessing their way into a game.
 */
function mintRoomCode(): RoomCode {
  const bytes = new Uint8Array(P2P_ROOM_CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
  return out;
}

function newRid(): string { return randomId(8); }

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ResumeRecord { code: RoomCode; playerId: PlayerId; spectator: boolean }

function writeResume(code: RoomCode, playerId: PlayerId, spectator: boolean): void {
  try { globalThis.sessionStorage?.setItem(RESUME_KEY, JSON.stringify({ code, playerId, spectator })); }
  catch { /* private mode */ }
}

function readResume(): ResumeRecord | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(RESUME_KEY);
    return raw ? (JSON.parse(raw) as ResumeRecord) : null;
  } catch { return null; }
}

function clearResume(): void {
  try { globalThis.sessionStorage?.removeItem(RESUME_KEY); } catch { /* ignore */ }
}

/**
 * Build an ICE server list from Vite env vars, so TURN credentials never land
 * in the repo. See `docs/WEBRTC.md`.
 */
export function iceServersFromEnv(env: Record<string, string | undefined>): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  const stun = env.VITE_STUN_URLS;
  servers.push({ urls: stun ? stun.split(',').map((s) => s.trim()).filter(Boolean) : (DEFAULT_ICE_SERVERS[0].urls as string[]) });
  const turn = env.VITE_TURN_URLS;
  if (turn) {
    servers.push({
      urls: turn.split(',').map((s) => s.trim()).filter(Boolean),
      username: env.VITE_TURN_USERNAME,
      credential: env.VITE_TURN_CREDENTIAL,
    });
  }
  return servers;
}

/** `TransportFactory` for the peer-to-peer backend. */
export function createRtcTransport(config: RtcTransportConfig): Transport {
  return new RtcTransport(config);
}
