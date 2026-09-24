/**
 * Otrio transport contract.
 * ============================================================================
 *
 * THE POINT OF THIS FILE
 * ----------------------
 * Otrio ships with three interchangeable networking backends:
 *
 *   - `wsTransport.ts`    — a WebSocket link to a deployed Node server that
 *                           acts as an impartial referee.
 *   - `rtcTransport.ts`   — WebRTC data channels between browsers, with no
 *                           server in the game path at all.
 *   - `localTransport.ts` — no link at all: two to four people passing one
 *                           device, with the referee running in this tab.
 *                           Its contract is the SINGLE-DEVICE BACKEND section
 *                           near the bottom of this file, and it is normative
 *                           in the same way everything else here is.
 *
 * The UI must be able to use any of them without knowing which it has. Every
 * screen, store and hook in `src/ui`, `src/hooks` and `src/scene` talks to a
 * `Transport` and never to a socket, a peer connection, or a room object. Swap
 * the factory, and the game plays the same.
 *
 * This file is therefore a *specification*, not just a set of types. The
 * implementations are written by people who cannot see each other's work, so
 * the guarantees below are normative: where the prose says MUST, an
 * implementation that does otherwise is broken even if it type-checks.
 *
 *
 * THE HARD PART: AUTHORITY
 * ------------------------
 * The hosted backend has a referee that no player controls. The peer-to-peer
 * backend does not — there is nobody in the room who is not also a player.
 * That is a real, irreducible difference in trust. What this interface
 * guarantees is that it is not a difference in *shape*.
 *
 * The trick is that the interface never exposes "ask the server" as an
 * operation. It exposes only:
 *
 *   1. **Intents.** `sendMove`, `startGame`, `setReady` are requests. They can
 *      be refused. They never mutate local state directly.
 *   2. **Authoritative snapshots.** `RoomState` arrives whole, stamped with a
 *      monotonic `seq`, and is rendered verbatim. Clients never compute game
 *      state; they receive it.
 *
 * Anything that satisfies (1) and (2) is a valid backend. A server satisfies it.
 * So does an elected peer.
 *
 * HOW A PEER-TO-PEER BACKEND IS EXPECTED TO FAKE AUTHORITY
 * --------------------------------------------------------
 * `rtcTransport.ts` should implement a **host-peer election**:
 *
 *   a. **Election.** Exactly one connected peer holds the referee role. The
 *      rule, which every peer evaluates independently from the same inputs (a
 *      vote would need a tie-break anyway):
 *
 *        **lowest connected `seat`, tie-broken by `PlayerId`, and never migrate
 *        away from a referee that is still reachable.**
 *
 *      That last clause is the important one. Determinism alone is not enough —
 *      the rule must also be *stable*. An earlier version of this doc specified
 *      "lexicographically smallest `PlayerId` among connected peers", which is
 *      perfectly deterministic and badly wrong: `PlayerId` is random, so a
 *      low-sorting player joining an established room would seize the referee
 *      role from the creator on arrival, and hand it back on every momentary
 *      blink. Seat order is assigned by join order, so the creator keeps the
 *      role for as long as they are present, which is what people expect.
 *      Re-elect only when the current referee is genuinely gone.
 *
 *   b. **Refereeing.** The host peer instantiates the *same* rules engine from
 *      `src/game/**` that the Node server uses, runs every submitted move
 *      through it, and broadcasts the resulting `RoomState` to all peers. Other
 *      peers MUST NOT run the engine to advance state. They may run it purely
 *      to grey out illegal cells in the UI, and MUST discard that result the
 *      moment an authoritative snapshot disagrees.
 *
 *   c. **Submission.** A non-host peer's `sendMove` sends the move to the host
 *      peer over its data channel and waits for the next snapshot, exactly as
 *      the WebSocket client waits for the server. The host peer's own
 *      `sendMove` short-circuits into its local referee — but MUST still go
 *      through the same validate → apply → snapshot → deliver path, so the host
 *      player's experience is not subtly different (e.g. instantaneous, with no
 *      `pendingMove` phase). Uniformity here is what keeps bugs from hiding on
 *      one side.
 *
 *   d. **Migration.** When the host peer disconnects, survivors re-run the
 *      election. The winner adopts the highest `seq` snapshot it has seen,
 *      rehydrates the rules engine from it, and resumes numbering at
 *      `seq + 1`. Because `seq` never goes backwards and snapshots are whole,
 *      clients need no rollback logic — they simply keep applying increasing
 *      snapshots from a different source. During migration the transport MUST
 *      report `status: 'reconnecting'` and set `RoomState.pause` with
 *      `reason: 'host-migrating'`, which the UI already renders for the hosted
 *      backend's disconnect pause. No new UI is needed.
 *
 *   e. **Honesty about it.** `Capabilities.impartialReferee` is `false` for
 *      peer-to-peer. A determined player can patch their own bundle and cheat
 *      while hosting. This interface does not pretend otherwise; it confines
 *      the difference to one boolean the UI may use for a "friendly game" badge
 *      and nothing else. Do not attempt cross-validation, commit-reveal, or
 *      consensus: for a four-player abstract with no stakes, the complexity is
 *      not worth it, and half-measures invite the false belief that P2P is
 *      cheat-proof.
 *
 * What MUST NOT leak into this interface: `RTCPeerConnection`, `WebSocket`,
 * ICE candidates, signalling URLs, peer ids distinct from `PlayerId`, "am I the
 * host peer" as anything other than `PlayerView.isHost`, or any method that
 * only one backend implements. If one backend needs a concept the other lacks,
 * it belongs in that backend's config object, not here.
 *
 *
 * WHAT THE UI IS ALLOWED TO ASSUME
 * --------------------------------
 * - State is replaced, never patched. Re-render from `getSnapshot()`.
 * - `RoomState.seq` only increases within a room's lifetime.
 * - Every command either resolves or rejects with a `TransportError`. None
 *   hang forever; all are bounded by `TIMING.requestTimeoutMs`.
 * - Reconnection is the transport's problem, not the UI's. The UI shows
 *   `status` and waits.
 * - Events are decoration. Dropping every one of them leaves the game correct.
 */

import type {
  Capabilities,
  ConnectionState,
  CreateRoomOptions,
  ErrorCode,
  GameEndReason,
  Move,
  PlayerId,
  PlayerView,
  RoomCode,
  RoomState,
  Seat,
  SessionSecret,
  WinningLine,
  WireError,
} from './protocol';

import {
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  newPlayerId,
  newSessionSecret,
  sanitizeName,
} from './protocol';

/* ========================================================================== *
 * Errors
 * ========================================================================== */

/**
 * The only error type any `Transport` method ever rejects with, and the only
 * one delivered to the `error` event.
 *
 * Implementations MUST NOT leak raw `DOMException`s, `Event`s, `ws` close
 * codes, or strings. Wrap everything. A UI that has to `instanceof` its way
 * through four error vocabularies is a UI that will get it wrong.
 */
export class TransportError extends Error {
  /** Machine-readable reason. Switch on this. */
  readonly code: ErrorCode;
  /** Whether repeating the identical call could plausibly succeed. */
  readonly retryable: boolean;
  /** The original failure, if there was one. For logging only. */
  readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.cause = options?.cause;
    // Keeps `instanceof` working when the class is down-levelled to ES5.
    Object.setPrototypeOf(this, TransportError.prototype);
  }

  /** Rebuild a `TransportError` from a `WireError` received over the link. */
  static fromWire(e: WireError, cause?: unknown): TransportError {
    return new TransportError(e.code, e.message, { retryable: e.retryable, cause });
  }
}

/* ========================================================================== *
 * Local identity
 * ========================================================================== */

/**
 * This client's identity. `playerId` is public and appears in `RoomState`;
 * `sessionSecret` is private and is presented only during a handshake to prove
 * the right to resume a held seat.
 *
 * Generated on the client rather than issued by a server, because the
 * peer-to-peer backend has no server to issue anything and both backends must
 * behave identically. See the note on `SessionSecret` in `protocol.ts` for why
 * this is adequate and what the upgrade path is.
 */
export interface Identity {
  playerId: PlayerId;
  sessionSecret: SessionSecret;
  /** Preferred display name. The referee may sanitise it. */
  name: string;
}

/** `localStorage` key holding the persisted identity. */
export const IDENTITY_STORAGE_KEY = 'otrio.identity.v1';

/**
 * Load the persisted identity, or mint and persist a new one.
 *
 * Both backends MUST use this rather than rolling their own, so that switching
 * backends — or switching between them mid-session while testing — keeps the
 * same `playerId`. Safe in private browsing and with storage disabled: it falls
 * back to an in-memory identity that simply will not survive a reload, which
 * degrades reconnection but breaks nothing.
 */
export function loadOrCreateIdentity(preferredName?: string): Identity {
  const fresh = (): Identity => ({
    playerId: newPlayerId(),
    sessionSecret: newSessionSecret(),
    name: sanitizeName(preferredName ?? '', 'Player'),
  });

  let storage: Storage | null = null;
  try {
    storage = globalThis.localStorage ?? null;
  } catch {
    storage = null; // Blocked by policy in some embedded contexts.
  }
  if (!storage) return fresh();

  try {
    const raw = storage.getItem(IDENTITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Identity>;
      if (
        typeof parsed.playerId === 'string' &&
        parsed.playerId.length > 0 &&
        typeof parsed.sessionSecret === 'string' &&
        parsed.sessionSecret.length > 0
      ) {
        const name = sanitizeName(preferredName ?? parsed.name ?? '', 'Player');
        const identity: Identity = {
          playerId: parsed.playerId,
          sessionSecret: parsed.sessionSecret,
          name,
        };
        if (name !== parsed.name) {
          storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
        }
        return identity;
      }
    }
  } catch {
    // Corrupt JSON — fall through and overwrite it.
  }

  const identity = fresh();
  try {
    storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Quota or private mode. In-memory identity is still usable.
  }
  return identity;
}

/** Persist a changed display name against the existing identity. */
export function saveIdentityName(name: string): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const raw = storage.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Identity;
    parsed.name = sanitizeName(name, parsed.name || 'Player').slice(0, MAX_NAME_LENGTH);
    storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    /* non-fatal */
  }
}

/* ========================================================================== *
 * Connection status and quality
 * ========================================================================== */

/**
 * The transport's link state. Distinct from `PlayerView.connection`, which
 * describes how the *referee* sees some participant — including this one.
 *
 * Legal transitions:
 *
 * ```
 *   idle ──connect()──▶ connecting ──▶ connected
 *                            │              │
 *                            │              ├──drop──▶ reconnecting ──▶ connected
 *                            │              │                │
 *                            ▼              ▼                ▼
 *                         failed ◀──── (gave up) ─────────────┘
 *
 *   any ──dispose()/leaveRoom()──▶ closed
 * ```
 *
 * `reconnecting` is NOT an error state. The UI should show a quiet indicator
 * and keep the board on screen — moves made by others will arrive once the link
 * is back, and the snapshot will simply jump forward. Only `failed` warrants an
 * error screen.
 */
export type ConnectionStatus =
  /** Constructed but `connect()` has not been called. */
  | 'idle'
  /** First connection attempt in flight. */
  | 'connecting'
  /** Link is up and the handshake completed. */
  | 'connected'
  /** Link dropped; automatic retry in progress. Seat may still be held. */
  | 'reconnecting'
  /** Deliberately shut down. Terminal — construct a new transport to retry. */
  | 'closed'
  /** Gave up. Terminal until `connect()` is called again explicitly. */
  | 'failed';

/** Coarse latency bucket, for rendering signal bars without magic numbers. */
export type QualityGrade = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

/**
 * Health of the local link. Refreshed roughly every `TIMING.pingIntervalMs`.
 *
 * Both backends MUST populate this. Measuring it differs — the hosted backend
 * times a round trip to the server, a peer-to-peer backend times a round trip
 * to the host peer (or reports the worst across peers when it is the host) —
 * but the *meaning* is the same: how stale is what I am looking at.
 */
export interface ConnectionQuality {
  /** Smoothed round-trip time in ms, or `null` before the first measurement. */
  rttMs: number | null;
  /** Mean deviation between consecutive RTT samples, or `null`. */
  jitterMs: number | null;
  /** Bucketed `rttMs`. See `gradeQuality`. */
  grade: QualityGrade;
  /**
   * Estimated offset to add to `Date.now()` to get referee time, in ms. Used
   * to render `turnDeadline` and `PauseState.resumesAt` correctly on a client
   * whose clock is wrong. `null` until measured.
   */
  clockOffsetMs: number | null;
  /** Epoch ms of the last message of any kind received. `null` if none yet. */
  lastMessageAt: number | null;
  /** Consecutive failed connection attempts. Resets to `0` on success. */
  reconnectAttempts: number;
}

/** Bucket an RTT. Shared so both backends draw the same number of bars. */
export function gradeQuality(rttMs: number | null): QualityGrade {
  if (rttMs === null || !Number.isFinite(rttMs)) return 'unknown';
  if (rttMs < 80) return 'excellent';
  if (rttMs < 180) return 'good';
  if (rttMs < 350) return 'fair';
  return 'poor';
}

/** Initial quality, before anything has been measured. */
export function initialQuality(): ConnectionQuality {
  return {
    rttMs: null,
    jitterMs: null,
    grade: 'unknown',
    clockOffsetMs: null,
    lastMessageAt: null,
    reconnectAttempts: 0,
  };
}

/* ========================================================================== *
 * The observable snapshot
 * ========================================================================== */

/** This client's part in the room. */
export type LocalRole = 'none' | 'player' | 'spectator';

/**
 * Everything the UI renders, in one immutable object.
 *
 * **Immutability is a hard requirement, not a style preference.** This type is
 * designed to be consumed through React's `useSyncExternalStore`:
 *
 * ```ts
 * const snap = useSyncExternalStore(transport.subscribe, transport.getSnapshot);
 * ```
 *
 * which imposes two rules an implementation MUST honour:
 *
 *  1. `getSnapshot()` returns the **same object reference** every time it is
 *     called until something actually changes. Building a fresh object on each
 *     call — even a deep-equal one — makes React re-render forever.
 *  2. When something changes, produce a **new** object (and new nested objects
 *     for the parts that changed) and then notify subscribers. Never mutate a
 *     snapshot that has already been handed out.
 *
 * Nested `RoomState` is likewise replaced wholesale, which comes for free since
 * it arrives off the wire as fresh JSON.
 */
export interface TransportSnapshot {
  /** Link state. See `ConnectionStatus`. */
  readonly status: ConnectionStatus;

  /**
   * This client's public id and current display name. Never the secret.
   *
   * "This client" is a *person* on the hosted and peer-to-peer backends, where
   * it is fixed for the life of the transport. On the single-device backend it
   * is the **active seat**, and it changes every time the device is handed
   * over — see SINGLE-DEVICE BACKEND. Anything that treats this as a stable key
   * is right on two backends and wrong on the third: a memo dependency is fine,
   * a cache key that outlives a turn or a persisted value is not.
   */
  readonly playerId: PlayerId;
  readonly name: string;

  /**
   * Authoritative room state, or `null` when not in a room.
   *
   * Non-null does not imply `status === 'connected'`: during a reconnect the
   * last known room is deliberately retained so the board stays on screen
   * instead of flashing away. Check `status` to decide whether to grey it out.
   */
  readonly room: RoomState | null;

  /** Convenience projections of `room`, recomputed whenever `room` changes. */
  readonly role: LocalRole;
  /** This client's seat, or `null` when spectating or not in a room. */
  readonly seat: Seat | null;
  /** True when `role === 'player'`, the game is running, and it is this seat's turn. */
  readonly isMyTurn: boolean;
  /** True when this client holds the host role (may start the game). */
  readonly isHost: boolean;

  /**
   * A move submitted locally and not yet confirmed or rejected by the referee.
   *
   * Set synchronously inside `sendMove`, before anything is transmitted, and
   * cleared when an authoritative snapshot reflecting the move arrives or the
   * move is rejected. Exactly one may be outstanding: `sendMove` rejects
   * immediately with `NOT_YOUR_TURN` if one already is.
   *
   * This exists so the UI can render a translucent "ghost" ring the instant the
   * player clicks, without the UI having to own optimistic state or reconcile
   * it. The transport never applies the move to `room` itself — prediction is a
   * rendering hint, and the authoritative board always wins.
   */
  readonly pendingMove: Move | null;

  /** Link health. See `ConnectionQuality`. */
  readonly quality: ConnectionQuality;

  /**
   * The most recent error, retained for display. Cleared on the next successful
   * command or connection. `null` when there is nothing to report.
   */
  readonly lastError: TransportError | null;

  /** What this backend can do. Constant for the lifetime of the transport. */
  readonly capabilities: Capabilities;
}

/* ========================================================================== *
 * Events
 * ========================================================================== */

/**
 * Transient notifications, for effects that a state diff cannot express well:
 * sounds, toasts, the piece-drop animation, confetti.
 *
 * **Events are decoration and MUST NOT be load-bearing.** A UI that ignored
 * every one of them would still render a correct board, because every event is
 * accompanied by a snapshot that already reflects the change. Consequently
 * neither backend has to guarantee event delivery, ordering against snapshots,
 * or exactly-once semantics — which is precisely what makes them cheap enough
 * for a peer-to-peer implementation to get right.
 *
 * Handlers MUST NOT throw. Implementations MUST isolate them (try/catch each)
 * so one bad listener cannot break the transport.
 */
export interface TransportEventMap {
  /** A move was accepted and applied. `seq` matches the resulting snapshot. */
  moveApplied: { seat: Seat; move: Move; seq: number };
  /** A locally submitted move was refused. Also rejects the `sendMove` promise. */
  moveRejected: { move: Move; error: TransportError };
  playerJoined: { player: PlayerView };
  /** `permanent` is false while the seat is still being held for a reconnect. */
  playerLeft: { playerId: PlayerId; name: string; permanent: boolean };
  playerReconnected: { playerId: PlayerId; name: string };
  /** Some participant's connectivity changed, possibly this client's own seat. */
  connectionChanged: { playerId: PlayerId; connection: ConnectionState };
  gameStarted: { seq: number };
  gameEnded: { reason: GameEndReason; winner: Seat | null; line: WinningLine | null };
  /** The host role moved. On P2P this is also a referee migration. */
  hostChanged: { playerId: PlayerId; name: string };
  /** The room is gone. `room` becomes `null` immediately after. */
  roomClosed: { reason: string };
  /** Link state changed. Emitted for every transition in `ConnectionStatus`. */
  statusChanged: { status: ConnectionStatus; previous: ConnectionStatus };
  /** An error not tied to a specific in-flight command. */
  error: TransportError;
}

export type TransportEventType = keyof TransportEventMap;

/** Returned by `subscribe` and `on`. Idempotent — safe to call twice. */
export type Unsubscribe = () => void;

/* ========================================================================== *
 * The interface
 * ========================================================================== */

/** Options accepted when joining an existing room. */
export interface JoinRoomOptions {
  /** Watch instead of playing. Fails with `UNSUPPORTED` if the backend cannot. */
  asSpectator?: boolean;
}

/**
 * The networking contract. Implemented by `wsTransport.ts` and
 * `rtcTransport.ts`; consumed by everything else.
 *
 * GENERAL RULES FOR EVERY METHOD
 * ------------------------------
 * - **Never throws synchronously.** Async methods return a rejected promise;
 *   sync methods swallow and report through the `error` event.
 * - **Rejects only with `TransportError`.** No raw exceptions escape.
 * - **Bounded.** No command waits longer than `TIMING.requestTimeoutMs` without
 *   rejecting with `TIMEOUT`.
 * - **Safe while disconnected.** Commands issued during `reconnecting` are
 *   either queued until the link returns, or rejected with `CONNECTION_LOST` —
 *   an implementation MUST pick one and document it. Neither may hang.
 * - **Idempotent where it matters.** Calling `connect()` twice, `leaveRoom()`
 *   when not in a room, or `dispose()` repeatedly is harmless.
 */
export interface Transport {
  /**
   * Static description of this backend. Available before `connect()` so the
   * UI can lay itself out — hide the spectator button, show the "friendly game"
   * badge — without waiting for a network round trip.
   *
   * Some fields (`reconnectGraceMs`, `maxPlayers`) may be refined by the
   * referee during the handshake; read them from `getSnapshot().capabilities`
   * once connected.
   */
  readonly capabilities: Capabilities;

  /**
   * Current state. MUST return a referentially stable object between changes.
   * See `TransportSnapshot` for why.
   *
   * Bound to the instance, so `transport.getSnapshot` can be passed directly to
   * `useSyncExternalStore` without wrapping.
   */
  getSnapshot(): TransportSnapshot;

  /**
   * Register for change notifications. The listener takes no arguments — call
   * `getSnapshot()` to read the new state. Returns an unsubscribe function.
   *
   * Bound to the instance. MUST NOT invoke the listener synchronously from
   * within `subscribe` itself.
   */
  subscribe(listener: () => void): Unsubscribe;

  /** Register a typed event handler. See `TransportEventMap`. */
  on<K extends TransportEventType>(
    type: K,
    handler: (payload: TransportEventMap[K]) => void,
  ): Unsubscribe;

  /**
   * Establish the underlying link and complete the handshake.
   *
   * Idempotent: a second call while `connecting` returns the same promise, and
   * while `connected` resolves immediately. Calling it in state `failed` starts
   * a fresh attempt and resets `reconnectAttempts`.
   *
   * If the referee was holding a seat for this identity, the room is restored
   * as part of the handshake and `getSnapshot().room` is non-null when this
   * resolves — the caller MUST check for that before offering a lobby, or a
   * page refresh mid-game will bounce the player out of their own seat.
   *
   * Rejects with `CONNECT_FAILED`, `NETWORK_UNAVAILABLE`, `PROTOCOL_MISMATCH`
   * or `TIMEOUT`.
   */
  connect(): Promise<void>;

  /**
   * Open a new room and take seat `0` in it.
   *
   * Resolves with the room code to share. The room also appears in
   * `getSnapshot().room` before this resolves.
   *
   * Implies `connect()` if not already connected.
   *
   * Rejects with `CONNECT_FAILED`, `TIMEOUT`, or `INTERNAL`.
   */
  createRoom(options?: CreateRoomOptions): Promise<RoomCode>;

  /**
   * Join an existing room by code.
   *
   * The code is normalised with `normalizeRoomCode` before use, so raw user
   * input is fine. Implies `connect()`.
   *
   * Resolves with the normalised code. Rejects with `CODE_INVALID` (malformed,
   * detected locally without a round trip), `ROOM_NOT_FOUND`, `ROOM_FULL`,
   * `ALREADY_STARTED` (joining as a player once play began — retry with
   * `asSpectator: true`), `UNSUPPORTED` (spectating requested but unavailable),
   * or the usual link errors.
   *
   * The single-device backend rejects every call with `UNSUPPORTED`: a local
   * room exists only in the tab that created it, so there is nothing to join.
   * See SINGLE-DEVICE BACKEND below.
   */
  joinRoom(code: RoomCode, options?: JoinRoomOptions): Promise<RoomCode>;

  /**
   * Leave voluntarily, giving up any held seat immediately — no grace period,
   * because this is a deliberate exit rather than a dropped connection.
   *
   * Resolves to `null` room state. Harmless when not in a room. The link stays
   * open so the player can create or join another room without reconnecting.
   */
  leaveRoom(): Promise<void>;

  /**
   * Set lobby readiness. No-op once the game has started, and always a no-op on
   * the single-device backend — see SINGLE-DEVICE BACKEND below.
   */
  setReady(ready: boolean): Promise<void>;

  /**
   * Change display name. Takes effect immediately in the lobby and mid-game.
   * The referee sanitises it, so the value that lands in `RoomState` may
   * differ from what was passed. Also persisted locally.
   *
   * The single-device backend rejects this with `UNSUPPORTED` — none of the
   * above holds there, including the persistence. See SINGLE-DEVICE BACKEND.
   */
  setName(name: string): Promise<void>;

  /**
   * Start the game. Host only.
   *
   * Rejects with `NOT_HOST`, `NOT_ENOUGH_PLAYERS` (fewer than `MIN_PLAYERS`
   * seated, or someone is not ready), or `ALREADY_STARTED`.
   */
  startGame(): Promise<void>;

  /**
   * Submit a move.
   *
   * Sets `pendingMove` synchronously — before the returned promise is even
   * constructed — so the UI can render an immediate ghost piece. Resolves once
   * an authoritative snapshot containing the move has been applied. Rejects,
   * and clears `pendingMove`, if the referee refuses it.
   *
   * The referee validates independently and completely. A client that submits
   * an illegal move gets `ILLEGAL_MOVE`; it does not get a corrupted board.
   * Implementations MUST NOT pre-apply the move to `room`.
   *
   * Rejection codes, in the order they MUST be checked — both by a transport
   * short-circuiting locally and by the referee. Order matters because several
   * can be true at once, and the UI shows a message based on the first:
   *
   *   1. `NOT_IN_ROOM`         — no room joined.
   *   2. `SPECTATOR_FORBIDDEN` — watching, not playing.
   *   3. `GAME_NOT_ACTIVE`     — still in the lobby, paused, or finished.
   *   4. `NOT_YOUR_TURN`       — including when a move is already pending.
   *   5. `ILLEGAL_MOVE`        — the referee's rules engine refused it.
   *
   * Checking turn before game state is the tempting mistake: it reports
   * "it's not your turn" for a game that has already ended, which is true and
   * useless. Plus `CONNECTION_LOST` and `TIMEOUT` from the link at any point.
   */
  sendMove(move: Move): Promise<void>;

  /**
   * Offer a rematch, or answer a pending offer.
   *
   * Call with `true` to propose or to accept; `false` declines and withdraws
   * any offer of your own. When every connected player has accepted, the
   * referee resets the board — keeping seats, `RoomCode` and the running `seq`
   * — and the room returns to `phase: 'playing'`.
   *
   * Rejects with `GAME_NOT_ACTIVE` if the game has not finished.
   */
  requestRematch(accept: boolean): Promise<void>;

  /**
   * Discard local state and ask the referee for a fresh snapshot.
   *
   * The transport calls this internally after every reconnect, so the UI rarely
   * needs it. Exposed for a manual "something looks wrong" escape hatch.
   */
  resync(): Promise<void>;

  /**
   * Shut everything down: close the link, drop every listener, release timers.
   *
   * Terminal — `status` becomes `closed` and stays there. Construct a new
   * transport to play again. Safe to call repeatedly, and safe to call from a
   * React effect cleanup.
   *
   * Any in-flight command promises reject with `CONNECTION_LOST`.
   */
  dispose(): void;
}

/* ========================================================================== *
 * Construction
 * ========================================================================== */

/**
 * Configuration common to every backend.
 *
 * Backend-specific settings (server URL, ICE servers, signalling endpoint) go
 * in that backend's own options type, which extends this. Nothing
 * backend-specific belongs in `Transport` itself.
 *
 * `LocalTransportConfig` is the one exception to *where* those types live: it
 * is declared below rather than in `localTransport.ts`, because it is the spec
 * that file is written against and it had to exist before that file did.
 */
export interface TransportConfig {
  /** From `loadOrCreateIdentity()`. */
  identity: Identity;
  /** Emit verbose console logging. Default `false`. */
  debug?: boolean;
}

/**
 * Which backend to build. The one place in the app where the choice is named.
 *
 * Intended use: a single `createTransport(kind, config)` in app setup, with
 * `kind` coming from a URL parameter or a settings toggle, so backends can be
 * compared without a rebuild.
 *
 * **Derived, not declared.** This used to be a second hand-written copy of
 * `Capabilities['kind']`, which is a set of backend names with two owners and
 * therefore two ways to disagree — and adding `'local'` would have needed
 * editing both. There is now one definition, in `protocol.ts`, and this is a
 * view of it.
 */
export type TransportKind = Capabilities['kind'];

/** Signature every backend's factory must match. */
export type TransportFactory<C extends TransportConfig = TransportConfig> = (config: C) => Transport;

/* ========================================================================== *
 * The single-device backend
 * ========================================================================== */

/**
 * Display names for a single-device game, one per seat, in seat order.
 *
 * A union of tuples rather than `string[]`, so "two to four players" is a fact
 * the compiler enforces instead of a comment somebody has to remember to obey.
 * The precedent is `GameSnapshot.turnColors`, a union of non-empty tuples for
 * the same reason. The alternative is a runtime clamp, and a clamp turns a
 * caller's mistake into a game that quietly has the wrong number of seats.
 *
 * `seatNames[i]` belongs to seat `i`, and `seatNames.length` — `2 | 3 | 4` — is
 * the player count. There is deliberately no second field carrying that number:
 * two definitions of one value is a divergence with a delay fuse.
 *
 * The bounds duplicate `MIN_PLAYERS` and `MAX_PLAYERS` because a literal tuple
 * type cannot be built from a `const`. They come from the physical game (four
 * colours of nine pieces) and do not move; if they ever do, this union moves
 * with them.
 */
export type LocalSeatNames =
  | readonly [string, string]
  | readonly [string, string, string]
  | readonly [string, string, string, string];

/**
 * Narrow a dynamic list of names to `LocalSeatNames`, or `null` when it is not
 * between `MIN_PLAYERS` and `MAX_PLAYERS` long.
 *
 * Same idiom and same reason as `toSeat` in `protocol.ts`. A UI builds its seat
 * list by pushing and splicing, so it holds a `string[]`, and the narrowing has
 * to happen somewhere; returning `null` rather than asserting makes the caller
 * say at the call site why the length is right, which is cheaper to check later
 * than a bare `as`.
 *
 * Does **not** sanitise. Names are sanitised by the referee, exactly as they
 * are online, so a hot-seat name and a networked name get identical treatment.
 * See `sanitizeName` — there is one owner for that rule and it is not here.
 */
export function toLocalSeatNames(names: readonly string[]): LocalSeatNames | null {
  if (names.length < MIN_PLAYERS || names.length > MAX_PLAYERS) return null;
  switch (names.length) {
    case 2:
      return [names[0], names[1]];
    case 3:
      return [names[0], names[1], names[2]];
    case 4:
      return [names[0], names[1], names[2], names[3]];
    default:
      return null;
  }
}

/**
 * Configuration for the single-device backend.
 *
 * Shaped like `WsTransportConfig` and `RtcTransportConfig`: it extends
 * `TransportConfig` and adds only what this backend cannot do without. What it
 * does *not* carry is the point — no URL, no signalling endpoint, no ICE
 * servers, no room code, no per-seat secret. A local game has no other end.
 */
export interface LocalTransportConfig extends TransportConfig {
  /** Who is playing, in seat order. Its length is the player count. */
  seatNames: LocalSeatNames;
}

/**
 * The turn clock is pinned off for single-device play, and is deliberately
 * **not** a config field.
 *
 * `PeerReferee.tick()` does not merely expire a turn when the deadline passes:
 * it plays `legalMoves[0]` for that seat, per `TURN_TIMEOUT_POLICY` (verified
 * in `referee.ts`, 2026-09-24). That is right online, where the alternative is
 * three people waiting on someone who has walked away. It is wrong here, where
 * the "absent" player is a person holding the device and thinking, with nobody
 * waiting at the other end of anything — a timed hot-seat game would place a
 * piece out from under them.
 *
 * So the local transport MUST pass this and MUST NOT offer a way to change it.
 * Timed pass-and-play would need a referee that can expire a turn *without*
 * moving for the player: a different decision, and not one to make by widening
 * a config.
 */
export const LOCAL_TURN_TIMEOUT_MS = 0;

/**
 * What the single-device backend can do.
 *
 * The local transport MUST expose this object rather than build its own, so
 * these seven values have one definition — the same reason `P2P_CAPABILITIES`
 * is exported from `rtcTransport.ts` instead of being restated by its callers.
 *
 * Each flag, and why:
 *
 * - `spectators: false` — a consequence, not a policy. The only route into
 *   `RoomState.spectators` is `joinRoom({ asSpectator: true })`, and this
 *   backend rejects `joinRoom` outright, so a spectator cannot be constructed.
 *   People watching over a shoulder are not participants and need no seat.
 * - `reconnect: false`, `reconnectGraceMs: 0` — there is no link to drop. The
 *   referee lives in the same heap as the UI: if it is gone, the page is gone,
 *   and there is nobody left to hold a seat for. `0` is what the field's own
 *   doc requires when `reconnect` is false, and it is also what stops the
 *   referee arming grace timers against players who cannot disconnect.
 * - `hostMigration: false` — there is one process and seat `0` holds the host
 *   role for the life of the room. Nothing to migrate to.
 * - `impartialReferee: false` — see below.
 * - `maxPlayers: MAX_PLAYERS` — the *backend ceiling*, not this game's seat
 *   count. The configured count lives in `RoomState.maxPlayers`, which the
 *   referee sets from `CreateRoomOptions.maxPlayers`. The transport MUST NOT
 *   refine this field per instance: one number, one owner, and the owner is the
 *   room.
 *
 * WHY `impartialReferee` IS FALSE
 * -------------------------------
 * **Where the source material does not specify, I am inventing a rule** — the
 * flag is documented as "whether an impartial referee validates moves", with
 * peer-to-peer reporting `false` because the referee runs on one player's
 * machine, and nothing settles the case where every player shares one machine.
 *
 * A single-device game is arguably *more* symmetric than peer-to-peer: the
 * referee sits on the one device every seat shares, so it favours no seat over
 * another, and `true` was the tempting answer. It is the wrong one, because the
 * two possible errors are not the same size. `true` claims an authority that is
 * not there — the rules run inside the players' own bundle, and a reader who
 * checks this flag and finds `true` would believe a move was validated by
 * something outside any player's control. `false` merely over-warns, in a game
 * where everyone is looking at the same screen and there is nobody to deceive.
 * Over-warning is cosmetic; over-claiming is a correctness bug in slow motion.
 *
 * One consequence somebody downstream owns: `src/ui/screens/SettingsSheet.tsx`
 * renders "Friendly game — one of the phones is running the rules rather than a
 * server" whenever this is `false`. That copy is written for peer-to-peer and
 * reads oddly with one phone. It is true rather than misleading, so it is not
 * blocking, but it is UI copy and it is not mine. Select a local variant with
 * `isLocalRoomCode(room.code)`, never with `capabilities.kind`.
 */
export const LOCAL_CAPABILITIES: Capabilities = {
  kind: 'local',
  spectators: false,
  reconnect: false,
  reconnectGraceMs: 0,
  hostMigration: false,
  impartialReferee: false,
  maxPlayers: MAX_PLAYERS,
};

/* ========================================================================== *
 * SINGLE-DEVICE BACKEND — normative behaviour
 * ========================================================================== *
 *
 * Everything in the `Transport` interface applies unchanged unless it is
 * contradicted here. This section is the spec `localTransport.ts` is written
 * against, and it exists because that file is written by someone who cannot see
 * this one being written.
 *
 * IDENTITIES
 * ----------
 * One synthetic `PlayerId` per seat.
 *
 *   - Seat `0` MUST reuse `config.identity`'s `playerId` and `sessionSecret`.
 *     `Identity` already satisfies `RefereeHost` structurally (see the note on
 *     that type in `referee.ts`), so no adapter and no new identity concept.
 *
 *     **Its `name` MUST be replaced with `seatNames[0]`.** `PeerReferee.create`
 *     builds seat 0 from `host.name` (via `makePlayerView`, verified
 *     2026-09-24) — so passing `config.identity` unchanged names seat 0 after
 *     the device's persisted *online* display name while seats 1..n take their
 *     configured names. That type-checks, runs, and puts the wrong name on one
 *     player. Pass `{ ...config.identity, name: seatNames[0] }`.
 *   - Seats `1..n-1` get `newPlayerId()` and `newSessionSecret()` from
 *     `protocol.ts`.
 *   - Those synthetic identities MUST NOT be persisted. This feature has no
 *     auto-save, and a persisted hot-seat identity would be indistinguishable
 *     next session from the device's own online one.
 *
 * THE ROOM HAS NO LOBBY
 * ---------------------
 * `createRoom()` seats every entry of `seatNames`, marks every non-host seat
 * ready, leaves seat `0` holding the host role, and returns
 * `newLocalRoomCode()`. The room is left in `phase: 'lobby'`, and the caller
 * invokes `startGame()` immediately after. There is no ready-up screen, because
 * there is nobody to wait for.
 *
 * That shape is forced by the referee rather than chosen (verified in
 * `referee.ts`, 2026-09-24):
 *
 *   - `onStartGame` NACKs `NOT_HOST` unless the sender is `hostPlayerId`, so
 *     the call has to be made as seat 0.
 *   - It then NACKs `NOT_ENOUGH_PLAYERS` unless every non-host seat has
 *     `ready`, so every synthetic seat has to be ready before it. Seat 0 is
 *     exempt in `onStartGame` itself and does not need marking — `create`
 *     leaves it `ready: false` and that is fine.
 *   - `onJoin` takes a seat's name from `pendingNames` alone, falling back to
 *     the literal `'Player'`. `noteName(id, name)` MUST therefore be called for
 *     each seat *before* that seat joins, or the game is played by four people
 *     called Player.
 *
 * `PeerReferee.create(code, host, options, capabilities, send)` takes a
 * mandatory `RoomCode` and a `CreateRoomOptions` — not a `RefereeOptions`,
 * which it builds internally. The local transport passes exactly:
 *
 *     code:         newLocalRoomCode()
 *     host:         { ...config.identity, name: config.seatNames[0] }
 *     options:      { maxPlayers:      config.seatNames.length,
 *                     allowSpectators: false,
 *                     turnTimeoutMs:   LOCAL_TURN_TIMEOUT_MS }
 *     capabilities: LOCAL_CAPABILITIES
 *
 * `options.maxPlayers` is how the seat count reaches `RoomState.maxPlayers`,
 * which is the one place that number lives.
 *
 * THE HOT SEAT
 * ------------
 * The **active seat** is:
 *
 *   - seat `0` while `room.game === null` — the moment between `createRoom` and
 *     `startGame`. Seat 0 holds the host role, so `startGame` lands on a seat
 *     entitled to make it.
 *   - `room.game.turn` once `room.game !== null`.
 *
 * With one exception, written down because leaving it implicit is how it
 * breaks: once `room.game.phase === 'finished'`, `GameSnapshot.turn` is
 * documented as meaningless, so the active seat falls back to seat `0` — the
 * seat that owns `requestRematch`. `isMyTurn` is false either way; what differs
 * is which name the UI puts on the end screen.
 *
 * `TransportSnapshot.playerId` and `.name` MUST be the active seat's. They
 * therefore change on every handoff. That is the one place this backend's
 * snapshot behaves differently from the other two, and it is deliberate: "who
 * am I" in pass-and-play is "whoever is holding the phone". A UI MUST NOT cache
 * `playerId` across a turn — it is the thing that moves.
 *
 * `role`, `seat`, `isMyTurn` and `isHost` MUST come from
 * `deriveLocalView(room, activeSeatPlayerId)`, unchanged and unwrapped. Feeding
 * it the active seat's id makes `isMyTurn` true exactly while the game is
 * running, which is the right answer for a hot seat: the board accepts the
 * current player's touch and nobody else's, and there is nobody else.
 *
 * METHOD DELTAS
 * -------------
 *   - `connect()` resolves once the in-process referee exists. `status` goes
 *     `idle → connecting → connected` with no I/O, and never reaches
 *     `reconnecting` or `failed`.
 *   - `createRoom()` is the only way into a room. See THE ROOM HAS NO LOBBY
 *     above for exactly what it does and why it has no choice.
 *   - `joinRoom()` MUST reject with `TransportError('UNSUPPORTED', …)` for
 *     every input, before looking at the code at all. Not `ROOM_NOT_FOUND`:
 *     there is no registry to miss in, and a retryable-looking code invites a
 *     UI retry loop. `UNSUPPORTED` is not in `RETRYABLE_CODES`.
 *   - `setReady()` resolves as a no-op. Every seat is already ready before
 *     `createRoom` returns and there is no lobby in which to become un-ready,
 *     so the call has no effect available to it. A no-op rather than a
 *     rejection because the base contract already defines `setReady` as a no-op
 *     in a state where readiness does not apply, and a shared lobby component
 *     calling it should cost nothing.
 *   - `setName(name)` MUST reject with `UNSUPPORTED`. Seat names are owned by
 *     `LocalTransportConfig.seatNames` and set once; this method names no seat,
 *     so against a rotating identity it would rename whoever happens to be
 *     holding the device — a behaviour nobody could have asked for. It would
 *     also have to skip `saveIdentityName`, so every documented part of its
 *     behaviour would be replaced. To rename a seat, construct a new local
 *     game: no lobby and no network means that costs a click.
 *
 *     The asymmetry with `setReady` is deliberate. `setReady` has no effect
 *     either way; `setName` would have the *wrong* effect. A call with nothing
 *     to do resolves, a call that would do the wrong thing fails.
 *   - `requestRematch(true)` MUST be submitted on behalf of every seat, so the
 *     offer completes immediately. Routing it through the active seat alone
 *     leaves the rematch waiting on players who have no way to answer.
 *   - `resync()` is a no-op that resolves; the snapshot is already the truth.
 *   - `leaveRoom()` and `dispose()` behave as specified for every backend.
 *
 * Snapshot discipline, event isolation and the `Object.is` stability rule are
 * NOT relaxed. They are what `useSyncExternalStore` needs, and it does not care
 * that there is no network.
 *
 * THE OFFICIAL TWO-PLAYER RULE
 * ----------------------------
 * Nothing above assumes one colour per seat, and a local transport does not
 * have to think about colours at all.
 *
 * `deriveLocalView` compares seats only (`room.game.turn === me.seat`). Colour
 * assignment happens entirely inside the referee's `startGame`, via
 * `colorsForSeat`, which reads `EngineConfig.seats[].controls` and depends only
 * on the player count. So a two-player local game gets the official
 * two-colours-per-seat arrangement with strict alternation for free.
 *
 * The seat to move still alternates every turn — the engine's two-player
 * rotation is four slots long, `[seat 0, seat 1, seat 0, seat 1]`, carrying one
 * colour each. What alternates *within* a seat is which of its two colours is
 * due, and that is `GameSnapshot.turnColors`, which the UI already renders.
 * Verified by reading `referee.ts` (`startGame`, `colorsForSeat`) and
 * `engine.ts` (rotation construction) on 2026-09-24.
 */

/* ========================================================================== *
 * Helpers shared by implementations
 * ========================================================================== */

/**
 * Derive the convenience projections in `TransportSnapshot` from a `RoomState`.
 *
 * Every backend MUST use this rather than computing `isMyTurn` itself — the
 * edge cases (spectators, forfeited seats, paused games, games that have
 * finished but whose `turn` still points somewhere) are exactly where
 * independent implementations drift apart, and a wrong `isMyTurn` means a board
 * that accepts clicks it should not.
 *
 * The single-device backend uses it unchanged by passing the **active seat's**
 * synthetic `playerId` — see SINGLE-DEVICE BACKEND above. That is why this
 * helper takes a `playerId` rather than reading one off a transport: "who am I"
 * is a question with a moving answer in pass-and-play, and every other
 * projection follows from it. Nothing here needs to know that.
 */
export function deriveLocalView(
  room: RoomState | null,
  playerId: PlayerId,
): { role: LocalRole; seat: Seat | null; isMyTurn: boolean; isHost: boolean } {
  if (!room) return { role: 'none', seat: null, isMyTurn: false, isHost: false };

  const me = room.players.find((p) => p.playerId === playerId);
  if (me) {
    const isMyTurn =
      room.phase === 'playing' &&
      room.game !== null &&
      room.game.phase === 'playing' &&
      room.game.turn === me.seat &&
      !me.forfeited;
    return { role: 'player', seat: me.seat, isMyTurn, isHost: me.isHost };
  }

  const spectating = room.spectators.some((s) => s.playerId === playerId);
  return {
    role: spectating ? 'spectator' : 'none',
    seat: null,
    isMyTurn: false,
    isHost: room.hostPlayerId === playerId,
  };
}

/**
 * Exponential backoff with jitter, in ms, for reconnect attempt `attempt`
 * (`0`-based).
 *
 * Shared so both backends retry at the same cadence — otherwise "how long until
 * it comes back" becomes backend-dependent behaviour a user will notice while
 * comparing them. Jitter matters: without it, four players dropped by the same
 * server restart reconnect in lockstep and hammer it.
 */
export function reconnectDelay(
  attempt: number,
  timing: { reconnectBaseMs: number; reconnectFactor: number; reconnectMaxMs: number; reconnectJitter: number },
): number {
  const raw = timing.reconnectBaseMs * Math.pow(timing.reconnectFactor, Math.max(0, attempt));
  const capped = Math.min(raw, timing.reconnectMaxMs);
  const jitter = capped * timing.reconnectJitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/**
 * Smooth an RTT sample into a running estimate, TCP-style.
 *
 * Returns the updated `{ rttMs, jitterMs }`. A single spike should not drop the
 * signal bars to one, and a single good sample should not restore them —
 * `alpha = 0.2` gives a visible indicator that settles in about ten samples
 * (half a minute at `TIMING.pingIntervalMs`).
 */
export function smoothRtt(
  previous: { rttMs: number | null; jitterMs: number | null },
  sample: number,
  alpha = 0.2,
): { rttMs: number; jitterMs: number } {
  if (previous.rttMs === null) return { rttMs: sample, jitterMs: 0 };
  const rttMs = previous.rttMs * (1 - alpha) + sample * alpha;
  const deviation = Math.abs(sample - previous.rttMs);
  const jitterMs = (previous.jitterMs ?? 0) * (1 - alpha) + deviation * alpha;
  return { rttMs: Math.round(rttMs), jitterMs: Math.round(jitterMs) };
}

/**
 * A tiny typed event emitter, so both backends behave identically around the
 * awkward parts: a handler that throws, and a handler that unsubscribes itself
 * while the event is being dispatched.
 *
 * Neither backend should write its own. This one iterates a copy of the handler
 * set and isolates each call, which is exactly the behaviour `TransportEventMap`
 * promises.
 */
export class Emitter<M> {
  private handlers = new Map<keyof M, Set<(payload: never) => void>>();

  on<K extends keyof M>(type: K, handler: (payload: M[K]) => void): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const h = handler as (payload: never) => void;
    set.add(h);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set!.delete(h);
    };
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.handlers.get(type);
    if (!set || set.size === 0) return;
    for (const handler of Array.from(set)) {
      try {
        (handler as (p: M[K]) => void)(payload);
      } catch (err) {
        console.error(`[otrio] event handler for "${String(type)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

/* ========================================================================== *
 * Conformance checklist
 * ========================================================================== *
 *
 * A backend is done when all of these hold. Written out because the
 * implementations cannot be diffed against each other.
 *
 * Lifecycle
 *   [ ] `connect()` twice concurrently yields one connection attempt.
 *   [ ] `dispose()` during `connecting` leaves no timer and no open socket.
 *   [ ] `dispose()` rejects every in-flight promise; none are left dangling.
 *   [ ] `status` transitions follow the diagram on `ConnectionStatus`, and
 *       every transition emits `statusChanged`.
 *
 * Snapshot discipline
 *   [ ] `getSnapshot()` returns an identical reference across calls with no
 *       intervening change. (Test: call it twice, `Object.is` must be true.)
 *   [ ] Every mutation creates a new snapshot object, then notifies.
 *   [ ] Subscribers are notified exactly once per coalesced change, after the
 *       new snapshot is readable — never before.
 *
 * Rooms
 *   [ ] `createRoom` then `joinRoom` from a second client seats both players.
 *   [ ] Joining a full room rejects `ROOM_FULL`; a bad code rejects
 *       `ROOM_NOT_FOUND`; a malformed code rejects `CODE_INVALID` with no
 *       network traffic at all.
 *   [ ] `leaveRoom()` releases the seat immediately, with no grace period.
 *
 * Play
 *   [ ] `sendMove` sets `pendingMove` before returning, and clears it on both
 *       resolution paths.
 *   [ ] An illegal move rejects `ILLEGAL_MOVE` and leaves the board untouched.
 *   [ ] A move out of turn rejects `NOT_YOUR_TURN` and never reaches the board.
 *   [ ] `RoomState.seq` strictly increases; an out-of-order or duplicate
 *       snapshot is discarded, not applied.
 *
 * Interruption
 *   [ ] Killing the link mid-game moves `status` to `reconnecting` while
 *       `room` stays populated, and recovers to the correct board on return.
 *   [ ] A player gone longer than `reconnectGraceMs` is resolved per the pause
 *       policy, and the remaining players can finish or end the game.
 *   [ ] Two clients reconnecting simultaneously both recover their own seats.
 *   [ ] For P2P only: killing the host peer elects a new one, `seq` continues
 *       upward, and no client rewinds. `hostChanged` fires.
 *
 * Single device
 *   [ ] `joinRoom` rejects `UNSUPPORTED` for every input, including a code the
 *       same transport just returned from `createRoom`.
 *   [ ] `startGame` succeeds without any caller having touched `setReady`.
 *   [ ] `getSnapshot().playerId` changes when the turn does, and
 *       `getSnapshot().isMyTurn` is true on every turn of a running game.
 *   [ ] `requestRematch(true)` resolves and restarts without a second caller.
 *   [ ] Two games started the same way do not always open on the same seat.
 *       (This is the one that fails if the room code stops being random —
 *       see `newLocalRoomCode`.)
 *   [ ] `localStorage` holds no seat identity after a game: only the key
 *       `IDENTITY_STORAGE_KEY`, unchanged.
 */
