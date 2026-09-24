/**
 * Networking entry point — the one place the app names a backend.
 *
 * Otrio ships three interchangeable transports (see `transport.ts` for the
 * contract they all satisfy):
 *
 *   - `hosted` — a WebSocket link to the deployed Node server in `server/`,
 *     which acts as an impartial referee.
 *   - `p2p`    — WebRTC data channels between browsers, refereed by an elected
 *     host peer, with no server in the game path.
 *   - `local`  — no link at all: two to four people passing one device, with
 *     the referee running in this tab.
 *
 * Everything above this file talks to a `Transport` and never imports
 * `WsTransport`, `RtcTransport` or `LocalTransport` directly. Import from
 * `../../net`, call `createTransport()`, and the choice becomes a runtime
 * setting rather than a rebuild — which is the whole reason for building three.
 *
 * IMPORT THIS MODULE WITH A LITERAL SPECIFIER
 * -------------------------------------------
 * `import('../../net')`, never a variable specifier with `@vite-ignore`. A
 * variable specifier stops Vite emitting a chunk for the backend at all, the
 * dynamic import 404s at runtime, and a `catch` turns it into a null transport
 * and a fallback board — a failure that looks like a game bug rather than a
 * build one.
 */

import { createWsTransport } from './wsTransport';
import type { WsTransportConfig } from './wsTransport';
import { loadOrCreateIdentity, toLocalSeatNames, TransportError } from './transport';
import type {
  Identity,
  LocalSeatNames,
  Transport,
  TransportConfig,
  TransportKind,
} from './transport';

export type { Transport, TransportConfig, TransportKind, Identity } from './transport';
export { TransportError, loadOrCreateIdentity } from './transport';
// Re-exported because `seatNames` below is unusable without them: a UI holds a
// `string[]` and needs the narrowing function to produce the tuple union. The
// header says to import from this barrel and not from a backend, so both have
// to be reachable here.
export type { LocalSeatNames, LocalTransportConfig } from './transport';
export { toLocalSeatNames, LOCAL_CAPABILITIES, LOCAL_TURN_TIMEOUT_MS } from './transport';
export * from './protocol';

/** Vite's `import.meta.env`, read without requiring `vite/client` types. */
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

/** Options accepted by `createTransport`, over and above the shared contract. */
export interface CreateTransportOptions extends Partial<TransportConfig> {
  /**
   * Preferred display name, used only when minting a fresh identity. Ignored
   * once one is persisted — rename through `transport.setName()` instead.
   */
  name?: string;
  /** Server URL for the hosted backend. Defaults to `VITE_OTRIO_SERVER_URL`. */
  url?: string;
  /** Signalling URL for the peer-to-peer backend, if it needs one. */
  signalingUrl?: string;
  /** ICE servers for the peer-to-peer backend. */
  iceServers?: RTCIceServer[];

  /**
   * Who is playing, in seat order. **Read only when `kind` is `'local'`**,
   * where it is required; the hosted and peer-to-peer backends ignore it and
   * seat players as they join.
   *
   * Optional in the type because two of the three backends have no use for it,
   * which means `createTransport('local', {})` compiles. The `'local'` arm MUST
   * therefore reject a missing or malformed value rather than invent seats.
   *
   * Build it with `toLocalSeatNames(names)`, which narrows a `string[]` to the
   * two-to-four tuple union or returns `null`. See `LocalTransportConfig` and
   * `LocalSeatNames` in `transport.ts`.
   */
  seatNames?: LocalSeatNames;
}

/**
 * Which backend to use when nothing overrides it.
 *
 * Resolution order, first match wins:
 *
 *  1. `?net=p2p`, `?net=hosted` or `?net=local` in the URL — so they can be
 *     A/B tested by sending someone a link, with no rebuild and no settings
 *     screen.
 *  2. `localStorage['otrio.net']`, for a sticky preference across reloads.
 *  3. `VITE_OTRIO_TRANSPORT` at build time.
 *  4. `'hosted'`.
 */
export function defaultTransportKind(): TransportKind {
  const fromQuery = readKind(() => {
    const loc = globalThis.location;
    if (!loc) return null;
    return new URLSearchParams(loc.search).get('net');
  });
  if (fromQuery) return fromQuery;

  const fromStorage = readKind(() => {
    try {
      return globalThis.localStorage?.getItem(TRANSPORT_STORAGE_KEY) ?? null;
    } catch {
      return null; // Storage blocked; fall through.
    }
  });
  if (fromStorage) return fromStorage;

  return readKind(() => viteEnv?.VITE_OTRIO_TRANSPORT ?? null) ?? 'hosted';
}

/** `localStorage` key holding a sticky backend preference. */
export const TRANSPORT_STORAGE_KEY = 'otrio.net';

/** Remember a backend choice across reloads. Pass `null` to clear it. */
export function rememberTransportKind(kind: TransportKind | null): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    if (kind === null) storage.removeItem(TRANSPORT_STORAGE_KEY);
    else storage.setItem(TRANSPORT_STORAGE_KEY, kind);
  } catch {
    /* non-fatal */
  }
}

/**
 * Parse a stored or query-string backend name.
 *
 * `'local'` is **accepted**, not rejected, and the distinction matters:
 * `rememberTransportKind('local')` writes that string to `localStorage`, and a
 * parser that could not read it back would fall through to `'hosted'` on the
 * next load. The player would be silently dropped onto a different backend by a
 * preference the app itself had saved — a loud problem turned into a quiet one.
 *
 * `'offline'` is accepted alongside it because that is what this feature is
 * called everywhere except in the type, so `?net=offline` is what somebody will
 * type. Same reason `'rtc'` and `'webrtc'` reach `'p2p'`.
 */
function readKind(source: () => string | null): TransportKind | null {
  const raw = source()?.trim().toLowerCase();
  if (raw === 'p2p' || raw === 'rtc' || raw === 'webrtc') return 'p2p';
  if (raw === 'hosted' || raw === 'ws' || raw === 'server') return 'hosted';
  if (raw === 'local' || raw === 'offline') return 'local';
  return null;
}

/**
 * Build a transport.
 *
 * `kind` defaults to `defaultTransportKind()`. Identity defaults to the
 * persisted one, so the same player keeps their `playerId` across a backend
 * switch — which matters when comparing the two, since a reconnect has to find
 * the same seat.
 *
 * The peer-to-peer backend is loaded lazily so that a hosted-only session never
 * pays for the WebRTC code, and so a browser without `RTCPeerConnection` can
 * still play. That makes this function async; callers `await` it once at
 * startup.
 *
 * WHY THIS IS A SWITCH AND NOT AN `if`
 * ------------------------------------
 * It used to test `kind === 'p2p'` and fall through to the hosted backend for
 * everything else. That was fine while there were two backends and became a
 * defect the moment `TransportKind` gained `'local'`: `createTransport('local')`
 * would have compiled, returned a `WsTransport`, and dialled a WebSocket server
 * — an offline mode that opens a socket, failing at runtime instead of at the
 * call. The `never` default means the compiler, not a player on a plane, finds
 * the next one.
 */
export async function createTransport(
  kind: TransportKind = defaultTransportKind(),
  options: CreateTransportOptions = {},
): Promise<Transport> {
  const identity: Identity = options.identity ?? loadOrCreateIdentity(options.name);
  const base: TransportConfig = { identity, debug: options.debug };

  switch (kind) {
    case 'p2p': {
      const { createRtcTransport } = await import('./rtcTransport');
      return createRtcTransport({
        ...base,
        signalingUrl: options.signalingUrl,
        iceServers: options.iceServers,
      });
    }

    case 'hosted': {
      const config: WsTransportConfig = { ...base, url: options.url };
      return createWsTransport(config);
    }

    case 'local': {
      // Lazily imported for the same reason as `p2p`: a hosted-only session
      // should not pay for the referee and the rules engine it will never run.
      const { createLocalTransport } = await import('./localTransport');

      // `seatNames` is optional in `CreateTransportOptions` because two of the
      // three backends ignore it, so a missing value type-checks at this call
      // and nowhere else. Re-narrowing through `toLocalSeatNames` rather than
      // trusting the declared tuple also catches a caller who arrived through a
      // cast, and leaves the 2-to-4 bound owned by `transport.ts` instead of
      // restated here as a pair of literals.
      const seatNames = options.seatNames ? toLocalSeatNames(options.seatNames) : null;
      if (seatNames === null) {
        // Where the source material does not specify, I am inventing a rule: no
        // `ErrorCode` names "this backend was configured wrongly".
        // `NOT_ENOUGH_PLAYERS` is the nearest honest one — it is what the
        // referee itself returns when a room cannot start for want of players.
        throw new TransportError(
          'NOT_ENOUGH_PLAYERS',
          'the single-device backend needs 2 to 4 names in options.seatNames; build them with toLocalSeatNames()',
        );
      }
      return createLocalTransport({ ...base, seatNames });
    }

    default: {
      const unreachable: never = kind;
      throw new TransportError('UNSUPPORTED', `Unknown transport kind: ${String(unreachable)}`);
    }
  }
}

/** Synchronous factory for the hosted backend, when the choice is not dynamic. */
export function createHostedTransport(options: CreateTransportOptions = {}): Transport {
  const identity: Identity = options.identity ?? loadOrCreateIdentity(options.name);
  return createWsTransport({ identity, debug: options.debug, url: options.url });
}
