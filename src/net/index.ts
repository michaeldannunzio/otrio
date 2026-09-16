/**
 * Networking entry point — the one place the app names a backend.
 *
 * Otrio ships two interchangeable transports (see `transport.ts` for the
 * contract they both satisfy):
 *
 *   - `hosted` — a WebSocket link to the deployed Node server in `server/`,
 *     which acts as an impartial referee.
 *   - `p2p`    — WebRTC data channels between browsers, refereed by an elected
 *     host peer, with no server in the game path.
 *
 * Everything above this file talks to a `Transport` and never imports
 * `WsTransport` or `RtcTransport` directly. Import from `../../net`, call
 * `createTransport()`, and the choice becomes a runtime setting rather than a
 * rebuild — which is the whole reason for building two.
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
import { loadOrCreateIdentity } from './transport';
import type { Identity, Transport, TransportConfig, TransportKind } from './transport';

export type { Transport, TransportConfig, TransportKind, Identity } from './transport';
export { TransportError, loadOrCreateIdentity } from './transport';
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
}

/**
 * Which backend to use when nothing overrides it.
 *
 * Resolution order, first match wins:
 *
 *  1. `?net=p2p` or `?net=hosted` in the URL — so the two can be A/B tested by
 *     sending someone a link, with no rebuild and no settings screen.
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

function readKind(source: () => string | null): TransportKind | null {
  const raw = source()?.trim().toLowerCase();
  if (raw === 'p2p' || raw === 'rtc' || raw === 'webrtc') return 'p2p';
  if (raw === 'hosted' || raw === 'ws' || raw === 'server') return 'hosted';
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
 */
export async function createTransport(
  kind: TransportKind = defaultTransportKind(),
  options: CreateTransportOptions = {},
): Promise<Transport> {
  const identity: Identity = options.identity ?? loadOrCreateIdentity(options.name);
  const base: TransportConfig = { identity, debug: options.debug };

  if (kind === 'p2p') {
    const { createRtcTransport } = await import('./rtcTransport');
    return createRtcTransport({
      ...base,
      signalingUrl: options.signalingUrl,
      iceServers: options.iceServers,
    });
  }

  const config: WsTransportConfig = { ...base, url: options.url };
  return createWsTransport(config);
}

/** Synchronous factory for the hosted backend, when the choice is not dynamic. */
export function createHostedTransport(options: CreateTransportOptions = {}): Transport {
  const identity: Identity = options.identity ?? loadOrCreateIdentity(options.name);
  return createWsTransport({ identity, debug: options.debug, url: options.url });
}
