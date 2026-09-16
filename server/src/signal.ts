/**
 * WebRTC signalling relay — `/signal`.
 *
 * WHAT THIS IS
 * ------------
 * Two phones cannot exchange an SDP offer over a connection that does not exist
 * yet. Something both can already reach has to introduce them. That is all this
 * does: it is a **room-scoped message relay**, and it is the irreducible server
 * in the "serverless" backend.
 *
 * It never sees a game move, never parses an SDP, and does not know the rules of
 * Otrio. `data` on a `signal` frame is opaque and is forwarded byte for byte. If
 * anyone ever finds themselves reading SDP in this file, something has gone
 * wrong.
 *
 * It shares a process with the authoritative game server purely because that
 * process already exists — see `docs/WEBRTC.md`, "Where to put it". The two are
 * otherwise unrelated: different path, different protocol, different payload
 * limits, no shared state. A peer-to-peer game routed through here puts no game
 * state on this box at all.
 *
 * ERRORS USE THE GAME PROTOCOL'S SHAPE
 * ------------------------------------
 * Everything else here is its own protocol, but the error frame is deliberately
 * `protocol.ts`'s `ErrorMsg`:
 *
 *     { t: 'error', error: WireError, fatal: boolean }
 *
 * `docs/WEBRTC.md` originally specified a flat `{t:'error', code, message}`, and
 * the mismatch between that and what a mis-routed game socket actually sent is
 * what made peer-to-peer fail silently: `/signal` was accepted as a *game*
 * socket, so a `join` frame came back as `INTERNAL: unknown message type "join"`
 * in a shape the client read as `undefined`, which its fatality test then
 * evaluated false — so it never gave up and `createRoom` hung forever.
 *
 * Agreed with Goku (`signaling.ts`) to converge on the nested shape rather than
 * the flat one, for a reason beyond tidiness: **the flat form made the client
 * infer fatality from a hardcoded list of codes, so the server had no way to say
 * "stop retrying".** `fatal` here is set by the side that actually knows. That
 * is a real defect fixed, not a preference.
 *
 * The remaining message shapes are mirrored from `SignalClientMsg` /
 * `SignalServerMsg` in `src/net/signaling.ts` rather than imported, because that
 * file is written bundler-style for the browser and pulling it into the server's
 * `nodenext` project risks dragging client resolution rules along with it. **The
 * two must stay in step.**
 */

import type { WebSocket } from 'ws';
import { normalizeRoomCode, wireError } from '../../src/net/protocol.ts';
import type { ErrorCode, WireError } from '../../src/net/protocol.ts';
import { TokenBucket } from './util.ts';
import type { Logger } from './util.ts';

/* ========================================================================== *
 * Wire types — mirror of src/net/signaling.ts
 * ========================================================================== */

/** A peer id. Client-generated, and equal to the game's `PlayerId`. */
type PeerId = string;

interface PeerInfo {
  id: PeerId;
  /** Display name if set. Untrusted, for UI only. */
  name?: string;
  /** Server-assigned monotonic join order within the room, from 0. */
  order: number;
}

type SignalClientMsg =
  | { t: 'join'; room: string; peer: PeerId; name?: string }
  | { t: 'signal'; to: PeerId; data: unknown }
  | { t: 'leave' }
  | { t: 'ping'; ts: number };

type SignalServerMsg =
  | { t: 'welcome'; room: string; you: PeerId; order: number; peers: PeerInfo[] }
  | { t: 'peer-join'; peer: PeerInfo }
  | { t: 'peer-leave'; peer: PeerId; reason?: string }
  | { t: 'signal'; from: PeerId; data: unknown }
  | { t: 'error'; error: WireError; fatal: boolean }
  | { t: 'pong'; ts: number };

/* ========================================================================== *
 * Limits
 * ========================================================================== */

/**
 * Largest signalling frame.
 *
 * Far larger than the game socket's 4 KB, and deliberately so: an SDP offer with
 * a full candidate list runs to several kilobytes, and a cap sized for game
 * moves would truncate the one message the handshake cannot proceed without.
 * This is why the two paths get separate `WebSocketServer` instances rather
 * than sharing one — `maxPayload` is per-server, and the game socket must keep
 * its tight cap.
 */
export const MAX_SIGNAL_BYTES = 64 * 1024;

/** Four players, four peers. */
const MAX_PEERS = 4;

/** Ceiling on concurrent signalling rooms, to bound memory. */
const MAX_ROOMS = 1000;

/**
 * How long an emptied room is kept before deletion.
 *
 * Not tidiness — seniority. See `orders` below: if the room vanished the moment
 * its last socket dropped, two peers whose shared Wi-Fi blipped would both
 * rejoin a fresh room and could swap `order`, which swaps who referees. A minute
 * of patience makes that case behave like the single-peer blip it actually is.
 */
const EMPTY_ROOM_TTL_MS = 60_000;

/** Hard ceiling on a room's lifetime. */
const ROOM_MAX_LIFETIME_MS = 6 * 60 * 60 * 1_000;

/** Protocol-level keepalive. Intermediaries drop idle WebSockets. */
const HEARTBEAT_MS = 30_000;

/** Generous: ICE candidates arrive in bursts of a few dozen. */
const RATE_CAPACITY = 120;
const RATE_PER_SECOND = 60;

/* ========================================================================== *
 * State
 * ========================================================================== */

interface Peer {
  ws: WebSocket;
  name?: string;
  order: number;
}

interface SignalRoom {
  code: string;
  peers: Map<PeerId, Peer>;
  /**
   * Join order ever assigned in this room, by peer id.
   *
   * **Kept after a peer disconnects**, for the room's whole life, which is the
   * point. `docs/WEBRTC.md` requires `order` to survive a rejoin so that a host
   * whose WebSocket blipped does not lose seniority — but the reference
   * implementation there deletes the peer on `close`, so a genuine disconnect
   * (as opposed to a socket being replaced while still open) hands out a fresh,
   * higher `order` on the way back and quietly demotes the host. Tracking order
   * separately from presence is what actually satisfies the requirement.
   */
  orders: Map<PeerId, number>;
  next: number;
  createdAt: number;
  /** When the room last became empty, or `null` while occupied. */
  emptySince: number | null;
}

/** Per-connection state. */
interface SignalSession {
  ws: WebSocket;
  id: PeerId | null;
  room: string | null;
  alive: boolean;
  bucket: TokenBucket;
  strikes: number;
}

/** Narrow a parsed JSON value to something with string-keyed properties. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ========================================================================== *
 * Relay
 * ========================================================================== */

export class SignalingRelay {
  private rooms = new Map<string, SignalRoom>();
  private sessions = new Set<SignalSession>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get peerCount(): number {
    return this.sessions.size;
  }

  /** Take ownership of a freshly upgraded `/signal` socket. */
  attach(ws: WebSocket): void {
    const session: SignalSession = {
      ws,
      id: null,
      room: null,
      alive: true,
      bucket: new TokenBucket(RATE_CAPACITY, RATE_PER_SECOND),
      strikes: 0,
    };
    this.sessions.add(session);

    ws.on('message', (raw: unknown, isBinary: boolean) => {
      if (isBinary) return; // JSON text only; a binary frame is a bug or a probe.
      this.onMessage(session, String(raw));
    });
    ws.on('pong', () => {
      session.alive = true;
    });
    ws.on('error', () => {
      /* `close` follows; nothing useful here. */
    });
    ws.on('close', () => {
      this.sessions.delete(session);
      this.onClose(session);
    });
  }

  /* ---------------------------------------------------------------------- *
   * Inbound
   * ---------------------------------------------------------------------- */

  private onMessage(session: SignalSession, raw: string): void {
    if (raw.length > MAX_SIGNAL_BYTES) {
      return this.fail(session, 'INTERNAL', 'message too large', false);
    }
    if (!session.bucket.take()) {
      session.strikes += 1;
      this.fail(session, 'RATE_LIMITED', 'slow down', false);
      if (session.strikes >= 3) this.closeSocket(session.ws, 4002, 'rate-limited');
      return;
    }

    // Parsed as `unknown`, NOT asserted into `SignalClientMsg`.
    //
    // Casting untrusted wire bytes straight into the union is both false and
    // self-defeating: it lets the compiler exhaust the union across the four
    // cases below and conclude the `default` branch is `never` — unreachable —
    // when `default` is precisely the branch that catches everything a real
    // client sends by mistake. The type was wrong, not the code.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.fail(session, 'INTERNAL', 'malformed JSON', false);
    }
    if (!isRecord(parsed) || typeof parsed.t !== 'string') {
      return this.fail(session, 'INTERNAL', 'malformed message', false);
    }

    // `parsed.t` is a plain `string`, so `default` stays reachable. Each case
    // narrows to its own shape, and every handler re-checks the fields it
    // actually reads — the cast buys convenience, never trust.
    switch (parsed.t) {
      case 'join':
        return this.onJoin(session, parsed as Extract<SignalClientMsg, { t: 'join' }>);
      case 'signal':
        return this.onSignal(session, parsed as Extract<SignalClientMsg, { t: 'signal' }>);
      case 'ping':
        return this.send(session.ws, {
          t: 'pong',
          ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
        });
      case 'leave':
        this.closeSocket(session.ws, 1000, 'left');
        return;
      default:
        // Well-formed but unknown: answer, so the client fails loudly rather
        // than waiting forever for a reply that is never coming.
        return this.fail(
          session,
          'INTERNAL',
          `unknown message type "${parsed.t.slice(0, 32)}"`,
          false,
        );
    }
  }

  private onJoin(session: SignalSession, msg: Extract<SignalClientMsg, { t: 'join' }>): void {
    // The SAME normalisation the game socket applies, not a lookalike of it.
    // `normalizeRoomCode` folds the four confusable characters (I/L to 1, O to
    // 0, U to V) on top of upper-casing and stripping punctuation. Clients are
    // expected to normalise before they get here and currently do, so this is
    // defence in depth — but the failure it prevents is a nasty one: two peers
    // that disagree by a single character land in two private rooms, each
    // waiting for the other, which looks exactly like NAT traversal failing and
    // is debugged nothing like it. Two sockets on one server must not disagree
    // about what "the same room" means.
    const code = normalizeRoomCode(String(msg.room ?? '')).slice(0, 24);
    if (code.length < 4) {
      return this.fail(session, 'CODE_INVALID', 'bad room code', true);
    }
    if (typeof msg.peer !== 'string' || msg.peer.length === 0 || msg.peer.length > 64) {
      return this.fail(session, 'CODE_INVALID', 'bad peer id', true);
    }
    const name = typeof msg.name === 'string' ? msg.name.slice(0, 32) : undefined;

    // Moving between rooms on one socket: leave the old one properly first.
    if (session.room !== null && session.room !== code) this.onClose(session);

    let room = this.rooms.get(code);
    if (!room) {
      if (this.rooms.size >= MAX_ROOMS) {
        return this.fail(session, 'INTERNAL', 'too many rooms; try again shortly', false);
      }
      room = {
        code,
        peers: new Map(),
        orders: new Map(),
        next: 0,
        createdAt: Date.now(),
        emptySince: null,
      };
      this.rooms.set(code, room);
    }

    const existing = room.peers.get(msg.peer);
    // A peer that has been here before keeps its seniority, whether or not its
    // old socket is still open. That is the whole point of `orders`.
    const knownOrder = room.orders.get(msg.peer);
    const returning = existing !== undefined || knownOrder !== undefined;

    if (!returning && room.peers.size >= MAX_PEERS) {
      return this.fail(session, 'ROOM_FULL', 'room is full', true);
    }

    const order = knownOrder ?? room.next++;
    room.orders.set(msg.peer, order);

    // A repeat join from a known id is a RESUME: replace the socket, keep the
    // order, and stay quiet so the other peers do not tear down a working
    // connection over what was a blip.
    if (existing && existing.ws !== session.ws) {
      this.closeSocket(existing.ws, 4001, 'replaced by a newer connection');
    }

    room.peers.set(msg.peer, { ws: session.ws, name, order });
    room.emptySince = null;
    session.room = code;
    session.id = msg.peer;

    const peers: PeerInfo[] = [];
    for (const [pid, p] of room.peers) {
      if (pid !== msg.peer) peers.push({ id: pid, name: p.name, order: p.order });
    }
    peers.sort((a, b) => a.order - b.order);

    this.send(session.ws, { t: 'welcome', room: code, you: msg.peer, order, peers });

    // Only announce a genuinely new arrival. A resume must be invisible.
    if (!existing) {
      this.broadcast(room, msg.peer, { t: 'peer-join', peer: { id: msg.peer, name, order } });
    }

    this.log.info('signal: join', {
      room: code,
      peer: msg.peer,
      order,
      resume: returning,
      peers: room.peers.size,
    });
  }

  private onSignal(session: SignalSession, msg: Extract<SignalClientMsg, { t: 'signal' }>): void {
    if (session.room === null || session.id === null) {
      return this.fail(session, 'PROTOCOL_MISMATCH', 'send join before signal', true);
    }
    const room = this.rooms.get(session.room);
    if (!room) return this.fail(session, 'PROTOCOL_MISMATCH', 'room is gone; rejoin', true);
    if (typeof msg.to !== 'string') return this.fail(session, 'INTERNAL', 'bad signal target', false);

    const target = room.peers.get(msg.to);
    // Silently dropping a signal for a peer that has gone is right: the sender
    // finds out from `peer-leave`, and erroring here would race every normal
    // departure.
    if (!target) return;

    // `data` is opaque and forwarded untouched.
    this.send(target.ws, { t: 'signal', from: session.id, data: msg.data });
  }

  /* ---------------------------------------------------------------------- *
   * Departure
   * ---------------------------------------------------------------------- */

  private onClose(session: SignalSession): void {
    const code = session.room;
    const id = session.id;
    session.room = null;
    session.id = null;
    if (code === null || id === null) return;

    const room = this.rooms.get(code);
    if (!room) return;

    // Only forget this peer if the socket closing is still the current one.
    // Otherwise a resume would delete the peer it just replaced.
    if (room.peers.get(id)?.ws !== session.ws) return;

    room.peers.delete(id);
    // `room.orders` deliberately keeps the entry, so a reconnect gets its
    // seniority back.
    this.broadcast(room, id, { t: 'peer-leave', peer: id, reason: 'disconnected' });

    if (room.peers.size === 0) room.emptySince = Date.now();
    this.log.info('signal: leave', { room: code, peer: id, peers: room.peers.size });
  }

  /* ---------------------------------------------------------------------- *
   * Timers
   * ---------------------------------------------------------------------- */

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), HEARTBEAT_MS);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    for (const session of Array.from(this.sessions)) {
      if (!session.alive) {
        this.closeSocket(session.ws, 4000, 'heartbeat timeout', true);
        continue;
      }
      session.alive = false;
      try {
        session.ws.ping();
      } catch {
        this.closeSocket(session.ws, 4000, 'ping failed', true);
      }
    }

    const now = Date.now();
    for (const [code, room] of Array.from(this.rooms)) {
      const expired =
        (room.emptySince !== null && now - room.emptySince > EMPTY_ROOM_TTL_MS) ||
        now - room.createdAt > ROOM_MAX_LIFETIME_MS;
      if (expired) {
        for (const peer of room.peers.values()) this.closeSocket(peer.ws, 1000, 'room expired');
        this.rooms.delete(code);
        this.log.info('signal: room expired', { room: code, rooms: this.rooms.size });
      }
    }
  }

  closeAll(reason: string): void {
    for (const session of Array.from(this.sessions)) {
      this.closeSocket(session.ws, 1001, reason);
    }
    this.rooms.clear();
    this.sessions.clear();
  }

  /* ---------------------------------------------------------------------- *
   * Plumbing
   * ---------------------------------------------------------------------- */

  private send(ws: WebSocket, msg: SignalServerMsg): void {
    try {
      if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log.warn('signal: send failed', { err: String(err) });
    }
  }

  private broadcast(room: SignalRoom, exceptId: PeerId, msg: SignalServerMsg): void {
    for (const [pid, peer] of room.peers) {
      if (pid !== exceptId) this.send(peer.ws, msg);
    }
  }

  /**
   * Report an error, and close the socket when it is fatal.
   *
   * `fatal` is the server's call, not the client's guess. `true` means "this
   * will never work, stop retrying and tell the player" — a room that is full, a
   * code that is malformed, a client talking out of order. `false` means "try
   * again": rate limiting, or a frame we could not make sense of.
   *
   * Closing on fatal is the other half of the contract. Leaving the socket open
   * after telling someone their room is full invites exactly the spin that made
   * this bug so hard to see.
   */
  private fail(session: SignalSession, code: ErrorCode, message: string, fatal: boolean): void {
    this.send(session.ws, { t: 'error', error: wireError(code, message, !fatal), fatal });
    if (fatal) this.closeSocket(session.ws, 4003, code);
  }

  private closeSocket(ws: WebSocket, code: number, reason: string, terminate = false): void {
    try {
      if (terminate) ws.terminate();
      else ws.close(code, reason);
    } catch {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
  }
}
