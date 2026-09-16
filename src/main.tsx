import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Tokens, reset, base, shell and utilities. Must come before any component
// stylesheet -- `src/ui/ui.css` consumes the custom properties it defines.
import './styles/index.css';

import { App } from './App';
import { setTransport, setTransportBootError, usePrefs } from './store';
import type { Transport } from './net/transport';

/**
 * Entry point. Two jobs: build a transport, and mount the app. The theme is
 * already correct by the time this runs -- see the pre-paint script in
 * index.html and `src/hooks/useTheme.ts`.
 */

/* -------------------------------------------------------------------------- *
 * Theme
 * -------------------------------------------------------------------------- */

// Nothing to do here. `index.html` set `data-theme` from localStorage before
// this bundle parsed, and `src/hooks/useTheme.ts` owns it from then on --
// `watchTheme()` in App.tsx subscribes the prefs mirror to it.

/* -------------------------------------------------------------------------- *
 * Networking
 * -------------------------------------------------------------------------- */

/**
 * Build the transport.
 *
 * `src/net/index.ts` owns backend selection now, so this is a single call. Its
 * `defaultTransportKind()` resolves `?net=` (with the `rtc`/`webrtc`/`ws`/
 * `server` aliases), then a sticky `localStorage['otrio.net']`, then
 * `VITE_OTRIO_TRANSPORT`, then `hosted`. The hand-rolled version that used to
 * live here understood only the literal `p2p` in the query string, so the
 * sticky preference and the build-time env var were unreachable — duplicated
 * selection logic that had already drifted.
 *
 * A literal specifier, dynamic rather than top-level: the backend stays its own
 * chunk (the peer-to-peer one loads only when chosen), and a chunk that fails
 * to load is catchable. Never a variable specifier with `@vite-ignore` — that
 * emits no chunk at all, 404s at runtime, and turns a broken build into a
 * silent fallback.
 */
async function buildTransport(): Promise<Transport> {
  const { createTransport } = await import('./net');
  return createTransport(undefined, {
    // Used only when minting a fresh identity; a persisted one wins.
    name: usePrefs.getState().name || undefined,
    debug: import.meta.env.DEV,
  });
}

void (async () => {
  try {
    setTransport(await buildTransport());
  } catch (error) {
    // Reaching here now means something real: the chunk failed to download, or
    // the backend threw while constructing (no WebRTC, for instance). Both are
    // worth saying out loud rather than absorbing into a fallback.
    console.error('[otrio] could not start networking', error);
    setTransportBootError('Networking failed to start. Reloading the page usually fixes it.');
  }
})();

/* -------------------------------------------------------------------------- *
 * Mount
 * -------------------------------------------------------------------------- */

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

// The boot placeholder in index.html is replaced, not merged.
container.innerHTML = '';

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
