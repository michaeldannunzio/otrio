import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Tokens, reset, base, shell and utilities. Must come before any component
// stylesheet -- `src/ui/ui.css` consumes the custom properties it defines.
import './styles/index.css';

import { App } from './App';
import { applyTheme, setTransport, setTransportBootError, usePrefs } from './store';
import { loadOrCreateIdentity } from './net/transport';
import type { Transport, TransportConfig, TransportKind } from './net/transport';

/**
 * Entry point. Three jobs, in order: get the theme right before the first
 * paint, build a transport, mount the app.
 */

/* -------------------------------------------------------------------------- *
 * Theme
 * -------------------------------------------------------------------------- */

// `index.html` already set `data-theme` from localStorage before this bundle
// even parsed, so there is no flash. This re-applies it once zustand has
// rehydrated, which is when a first-run default or a migrated value lands.
applyTheme(usePrefs.getState().theme);

/* -------------------------------------------------------------------------- *
 * Networking
 * -------------------------------------------------------------------------- */

/**
 * Which backend to build.
 *
 * `?net=p2p` or `?net=hosted` overrides, which is what `TransportKind` is for:
 * the two implementations are meant to be A/B-comparable without a rebuild.
 */
function chosenKind(): TransportKind {
  const param = new URLSearchParams(window.location.search).get('net');
  return param === 'p2p' ? 'p2p' : 'hosted';
}

/**
 * Build the transport.
 *
 * Both specifiers are **literal**, so Vite follows them: each backend becomes a
 * real chunk, three.js and the WebRTC stack are actually bundled, and the paths
 * are rewritten for production. They were briefly variable specifiers marked
 * `@vite-ignore` while the concrete backends did not exist -- which keeps the
 * build green while emitting no chunk at all, so the request 404s at runtime
 * and the catch below silently downgrades the whole app. Never again: a static
 * import that fails loudly is recoverable, one the bundler never saw is not.
 *
 * ┌── INTEGRATION SEAM ────────────────────────────────────────────────────┐
 * │ `transport.ts` says the intended shape is a single                      │
 * │ `createTransport(kind, config)`. The net layer is putting that in       │
 * │ `src/net/index.ts`. Until it lands we call the two concrete factories   │
 * │ directly, which exist today and both return a `Transport`. When it      │
 * │ arrives this whole function collapses to:                               │
 * │                                                                         │
 * │     import { createTransport } from './net';                            │
 * │     …                                                                   │
 * │     return createTransport(kind, config);                               │
 * │                                                                         │
 * │ Keep it dynamic rather than a top-level import so the backend stays a   │
 * │ separate chunk and a failure to load it is catchable.                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
async function buildTransport(): Promise<Transport> {
  const identity = loadOrCreateIdentity(usePrefs.getState().name || undefined);
  const config: TransportConfig = { identity, debug: import.meta.env.DEV };

  if (chosenKind() === 'p2p') {
    const { createRtcTransport } = await import('./net/rtcTransport');
    return createRtcTransport(config);
  }
  const { createWsTransport } = await import('./net/wsTransport');
  return createWsTransport(config);
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
