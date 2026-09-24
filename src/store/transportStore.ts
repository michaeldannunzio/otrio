/**
 * The UI's handle on the network.
 *
 * `Transport` (src/net/transport.ts) is already shaped for React: a referentially
 * stable `getSnapshot()` plus a `subscribe(listener)`. So this module does not
 * copy anything into zustand -- it holds the instance, and exposes selector
 * hooks over `useSyncExternalStore`. One copy of server state, no reconciliation.
 *
 * What lives here:
 *   - the instance, and the "no backend wired yet" case
 *   - `useNet(selector)`, a selector hook with proper bail-out
 *   - `runCommand`, which turns a rejected transport promise into a `WireError`
 *     the UI can actually put a sentence next to
 */

import { useCallback, useDebugValue, useRef, useSyncExternalStore } from 'react';
import { create } from 'zustand';

import { TransportError, initialQuality } from '../net/transport';
import type { Transport, TransportSnapshot } from '../net/transport';
import { MAX_PLAYERS } from '../net/protocol';
import type { Capabilities, ErrorCode, WireError } from '../net/protocol';

/* -------------------------------------------------------------------------- *
 * The instance
 * -------------------------------------------------------------------------- */

interface TransportHolder {
  transport: Transport | null;
  /** True once a backend has been chosen and constructed, even if it then failed. */
  configured: boolean;
  /** Why no transport could be built, if that is what happened. */
  bootError: string | null;
  setTransport(transport: Transport | null): void;
  setBootError(message: string): void;
}

export const useTransportHolder = create<TransportHolder>()((setState) => ({
  transport: null,
  configured: false,
  bootError: null,
  setTransport: (transport) => setState({ transport, configured: transport !== null, bootError: null }),
  setBootError: (bootError) => setState({ bootError, configured: false, transport: null }),
}));

/**
 * Install the transport. Called once during app boot.
 *
 * Disposing a replaced instance is correct *here* -- installing a genuinely
 * different transport means the old one is unreachable and would leak its
 * socket and timers.
 *
 * What must NOT happen is reaching for this to recover from a failure.
 * `ConnectionStatus.failed` is recoverable: `connect`, `createRoom` and
 * `joinRoom` all move out of it on the same instance. Building a fresh
 * transport to "retry" would throw away the identity continuity that lets a
 * reconnect reclaim a held seat -- so pressing "try again" would silently cost
 * the player their seat, and the symptom would look exactly like
 * `reconnectGraceMs` misbehaving. See `retryConnection` below.
 */
export function setTransport(transport: Transport | null): void {
  const previous = useTransportHolder.getState().transport;
  if (previous && previous !== transport) previous.dispose();
  useTransportHolder.getState().setTransport(transport);
}

/**
 * Recover from a failed link, keeping the same identity.
 *
 * Reuses the existing instance on purpose. `dispose()` is idempotent and safe,
 * so replacing it would not throw -- it would just quietly lose the seat.
 */
export async function retryConnection(): Promise<CommandResult<void>> {
  return runCommand((t) => t.connect());
}

/** Record that no backend could be constructed, so the UI can say why. */
export function setTransportBootError(message: string): void {
  useTransportHolder.getState().setBootError(message);
}

/** Non-hook access, for effects and event plumbing. May be `null`. */
export function getTransport(): Transport | null {
  return useTransportHolder.getState().transport;
}

/* -------------------------------------------------------------------------- *
 * The "no transport" snapshot
 * -------------------------------------------------------------------------- */

/**
 * Capabilities reported while **no backend is installed at all** -- during boot,
 * and after `setBootError`.
 *
 * It was called `OFFLINE_CAPABILITIES`, which was merely vague until
 * `src/net/localTransport.ts` made "offline" the name of a real backend with
 * real capabilities (`LOCAL_CAPABILITIES` in `transport.ts`). Two objects a
 * reader would reasonably expect to be the same thing, and they are opposites:
 * that one describes a game that works with no network, this one describes no
 * game at all.
 *
 * Every flag is `false`/`0` because nothing is possible yet, not because any
 * backend says so. `kind` is the one field with no honest value -- `Capabilities
 * ['kind']` has no "none" member -- so it holds the default backend's name as an
 * inert placeholder. Safe only because `kind` is documented diagnostics-only and
 * nothing outside `src/net/` reads it (grepped 2026-09-24). Anything wanting to
 * know "is this a local game" uses `isLocalRoomCode(room.code)`; if a reader of
 * this field ever appears, this literal is a lie and the field needs widening.
 */
const NO_TRANSPORT_CAPABILITIES: Capabilities = {
  kind: 'hosted',
  spectators: false,
  reconnect: false,
  reconnectGraceMs: 0,
  hostMigration: false,
  // Imported, not retyped: the seat ceiling belongs to the protocol, and a `4`
  // here is a second definition of it that nothing would catch drifting.
  maxPlayers: MAX_PLAYERS,
  impartialReferee: false,
};

/**
 * A single frozen snapshot used when no backend is installed.
 *
 * It must be the *same object every time*: `useSyncExternalStore` compares
 * snapshots by identity and a fresh object per call is an infinite render loop.
 */
const NO_TRANSPORT_SNAPSHOT: TransportSnapshot = Object.freeze({
  status: 'idle',
  playerId: '',
  name: '',
  room: null,
  role: 'none',
  seat: null,
  isMyTurn: false,
  isHost: false,
  pendingMove: null,
  quality: Object.freeze(initialQuality()),
  lastError: null,
  capabilities: NO_TRANSPORT_CAPABILITIES,
}) as TransportSnapshot;

const NO_OP_UNSUBSCRIBE = () => {};

/* -------------------------------------------------------------------------- *
 * Hooks
 * -------------------------------------------------------------------------- */

/**
 * Read a slice of the transport snapshot.
 *
 * Why a selector rather than `useSyncExternalStore(subscribe, getSnapshot)`
 * directly: the snapshot gets a new identity on every ping (roughly every three
 * seconds, to refresh `quality`). Subscribing to the whole object would
 * re-render every component in the tree on that timer, which is exactly the
 * kind of avoidable React work that competes with the r3f render loop. With a
 * selector, a component that only cares about `isMyTurn` re-renders when
 * `isMyTurn` changes and at no other time.
 *
 * `isEqual` defaults to `Object.is`. Pass a shallow comparison when selecting a
 * freshly built object; the result is cached between snapshots either way, so a
 * selector that allocates will not loop.
 */
export function useNet<T>(
  selector: (snapshot: TransportSnapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const transport = useTransportHolder((s) => s.transport);

  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;

  // Cache the last (snapshot -> selection) pair so getSnapshot is stable when
  // nothing relevant changed, which is what lets React bail out of the render.
  const cache = useRef<{ snapshot: TransportSnapshot; value: T } | null>(null);

  const read = useCallback((): T => {
    const snapshot = transport ? transport.getSnapshot() : NO_TRANSPORT_SNAPSHOT;
    const previous = cache.current;
    if (previous && previous.snapshot === snapshot) return previous.value;
    const next = selectorRef.current(snapshot);
    if (previous && isEqualRef.current(previous.value, next)) {
      cache.current = { snapshot, value: previous.value };
      return previous.value;
    }
    cache.current = { snapshot, value: next };
    return next;
  }, [transport]);

  const subscribe = useCallback(
    (onChange: () => void) => (transport ? transport.subscribe(onChange) : NO_OP_UNSUBSCRIBE),
    [transport],
  );

  const value = useSyncExternalStore(subscribe, read, read);
  useDebugValue(value);
  return value;
}

/** Shallow equality for selectors that build a small object or array. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** The whole snapshot. Use sparingly -- prefer a narrow `useNet` selector. */
export function useNetSnapshot(): TransportSnapshot {
  return useNet((s) => s);
}

/* -------------------------------------------------------------------------- *
 * Commands
 * -------------------------------------------------------------------------- */

export type CommandResult<T> = { ok: true; value: T } | { ok: false; error: WireError };

/**
 * Normalise anything thrown into a `WireError`.
 *
 * Exported for `startLocalGame` in `actions.ts`, which is the one command whose
 * failure can happen *before* a transport exists — `createTransport` itself
 * rejects — so it cannot go through `runCommand` and would otherwise need its
 * own copy of this mapping.
 */
export function toWireError(err: unknown): WireError {
  if (err instanceof TransportError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof Error) {
    return { code: 'INTERNAL' as ErrorCode, message: err.message, retryable: false };
  }
  return { code: 'INTERNAL' as ErrorCode, message: String(err), retryable: false };
}

/**
 * Run a transport command and normalise its failure.
 *
 * Every one of these can fail during ordinary play -- a room code typo, a host
 * who started the game while you were tapping Ready, a phone that just went
 * through a tunnel. Returning the error instead of throwing keeps each call
 * site a plain `if`, which matters because each failure needs a *different*
 * sentence on screen and a generic catch-all would flatten them all into
 * "something went wrong".
 */
export async function runCommand<T>(
  run: (transport: Transport) => Promise<T>,
): Promise<CommandResult<T>> {
  const transport = getTransport();
  if (!transport) {
    return {
      ok: false,
      error: {
        code: 'NETWORK_UNAVAILABLE',
        message: 'No networking backend is installed in this build.',
        retryable: false,
      },
    };
  }
  try {
    return { ok: true, value: await run(transport) };
  } catch (err) {
    return { ok: false, error: toWireError(err) };
  }
}
