/// <reference types="node" />
import { defineConfig, type ServerOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* The web manifest needs the same background colour the page paints. Imported
   rather than retyped: `#e8ecf3` is already written in index.html, tokens.css,
   tokens.ts and src/styles/README.md, and a manifest that quietly disagrees
   with the app shows the wrong splash screen with nothing to catch it.
   tokens.ts is a pure data module with no imports - if that ever stops being
   true this config fails at build time, which is the failure we want. */
import { COLORS } from './src/styles/tokens';

const root = fileURLToPath(new URL('.', import.meta.url));
const r = (p: string) => resolve(root, p);

/* Absolute base, not './'. The deployed hosts below all rewrite unknown
   paths to index.html, so the page can be served from a nested URL like
   /room/ABCD - and a relative base would resolve ./assets/* against /room/
   and 404. If you ever deploy under a sub-path instead, set this to that
   sub-path rather than switching to './'.

   Hoisted to a const because the web manifest's `start_url` / `scope` / `id`
   must track it. A manifest whose start_url is '/' under a '/otrio/' base
   installs an app that opens on a 404. */
const BASE = '/';

/* ------------------------------------------------------------------ *
 * Path aliases
 *
 * Kept in one place so the bundler, the type-checker and vitest cannot
 * drift apart. If you add an entry here, mirror it in the "paths" block
 * of tsconfig.base.json - TypeScript cannot read this file.
 * ------------------------------------------------------------------ */
export const alias = {
  '@': r('src'),
  '@game': r('src/game'),
  '@net': r('src/net'),
  '@scene': r('src/scene'),
  '@ui': r('src/ui'),
  '@hooks': r('src/hooks'),
  '@styles': r('src/styles'),
  '@store': r('src/store'),
  '@assets': r('src/assets'),
  '@shared': r('src/game'),
};

/* ------------------------------------------------------------------ *
 * Dev-server TLS (optional)
 *
 * WebRTC, and several other APIs this game wants on phones, are gated
 * behind a "secure context". http://localhost counts as secure;
 * http://192.168.1.x does NOT. So the moment you open the dev server on
 * a phone over the LAN, RTCPeerConnection stops existing.
 *
 * Drop a cert pair in ./certs and it is picked up automatically:
 *
 *   mkcert -key-file certs/dev-key.pem -cert-file certs/dev-cert.pem \
 *          localhost 127.0.0.1 ::1 192.168.1.42
 *
 * See README - "Running the dev server over HTTPS" - for the full story,
 * including why mkcert beats a bare self-signed cert on iOS.
 * ------------------------------------------------------------------ */
const CERT = r('certs/dev-cert.pem');
const KEY = r('certs/dev-key.pem');

function devHttps(): ServerOptions['https'] {
  if (process.env.VITE_DEV_HTTPS === '0') return undefined;
  if (!existsSync(CERT) || !existsSync(KEY)) {
    if (process.env.VITE_DEV_HTTPS === '1') {
      throw new Error(
        `VITE_DEV_HTTPS=1 but no certificate found.\n` +
          `  expected: ${CERT}\n` +
          `            ${KEY}\n` +
          `  generate them with mkcert - see README, "Running the dev server over HTTPS".`,
      );
    }
    return undefined;
  }
  return { cert: readFileSync(CERT), key: readFileSync(KEY) };
}

/* The Node WebSocket host (server/). Proxied rather than contacted
   directly so the browser only ever talks to one origin - which means
   one TLS certificate to trust on each phone instead of two, and no
   CORS or mixed-content surprises when the dev server is on https. */
const WS_TARGET = process.env.OTRIO_SERVER_URL ?? 'http://127.0.0.1:8787';

/* Ceiling on a single precached file.
 *
 * Workbox drops anything larger than this from the precache with a console
 * warning and a zero exit code. That failure is the bad kind: a build that
 * reports success, installs on a phone, goes offline, and has no 3D engine.
 * The default is 2 MiB and the `three` chunk - 688,700 bytes / 0.657 MiB on
 * 2026-09-24 - is the only file within an order of magnitude of it.
 *
 * Set high on purpose, at ~6.4x the largest chunk today. Tightening it would
 * convert growth into a silent drop, which is the thing being prevented. The
 * guard against bloat is the precache report in .github/workflows/ci.yml,
 * which prints the total and FAILS if the three chunk is not in the manifest.
 * A number here catches nothing; a failing build does.
 */
const PRECACHE_MAX_FILE_BYTES = 4 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Installable / offline shell (PWA)
 *
 * What this buys: a phone that has opened the site once can open it
 * again with no network and reach the home screen with every asset it
 * needs already on the device. It does NOT by itself make the *game*
 * playable offline - that is `src/net/localTransport.ts`, a separate
 * lane. This layer only guarantees the code and assets are present.
 *
 * Nothing here requires a line in index.html or src/. `injectRegister:
 * 'auto'` resolves to 'script' when no source file imports the plugin's
 * virtual module (verified in the installed plugin, dist/index.js:253),
 * and the build-time transformIndexHtml then injects both the
 * <link rel="manifest"> and <script src="/registerSW.js"> before
 * </head>. index.html stays owned by the UI lane and untouched.
 * ------------------------------------------------------------------ */
function pwa() {
  return VitePWA({
    /* autoUpdate: a deploy replaces the cached shell on the next visit with
       no "new version available" prompt to build, design and localise. With
       injectRegister 'auto' the plugin also turns on skipWaiting +
       clientsClaim (dist/index.js:874).

       The cost, recorded because it is easy to rediscover as a mystery bug:
       the new worker takes over a tab that is already open, and this app
       code-splits Scene / wsTransport / rtcTransport. A tab that was loaded
       before a deploy and lazy-loads a chunk after it asks for a hash that
       the new precache no longer has and the host no longer serves. The
       window is one deploy wide and a reload fixes it. The alternative
       (prompt-on-update) trades that for a UI nobody has designed. */
    registerType: 'autoUpdate',
    injectRegister: 'auto',

    manifest: {
      name: 'Otrio',
      short_name: 'Otrio',
      description: 'Otrio in 3D for two to four players, on one device or four.',
      /* All three track BASE - see the const. `id` is pinned so that changing
         start_url later updates the installed app instead of installing a
         second one beside it. */
      id: BASE,
      start_url: BASE,
      scope: BASE,
      display: 'standalone',
      /* Deliberately no `orientation`: the board is laid out for portrait and
         landscape at every breakpoint, so locking it would remove a mode that
         works. */

      /* A manifest colour cannot be theme-aware - there is no media query
         here - so this follows the choice index.html already made for its
         single static <meta name="theme-color">: the light background. A dark
         mode user therefore gets a light splash frame before first paint.
         That is a real, visible cost with no fix at this layer; it is flagged
         for UX rather than hidden. */
      theme_color: COLORS.light.bg,
      background_color: COLORS.light.bg,

      /* NO `icons`, and that is a deliberate gap, not an oversight.
         Checked public/ on 2026-09-24: it holds textures and nothing else.
         There is no logo, no favicon (index.html's /favicon.svg has never
         existed in this repo) and no brand source anywhere outside
         node_modules. Chrome will not offer to install a PWA without a
         >=192px icon, so THIS MANIFEST IS NOT YET INSTALLABLE ON ANDROID -
         iOS "Add to Home Screen" still works, with a screenshot for an icon.
         Inventing a logo is a brand decision, not a build one. The moment an
         icon source lands in public/, add 192 / 512 / maskable here. */
    },

    workbox: {
      /* Workbox's default is `**\/*.{js,wasm,css,html}`, which would ship an
         app that loads offline and then renders an untextured board: every
         texture under public/textures is .webp and its index is .json.
         Extensions present in dist/, checked 2026-09-24: js, css, html, webp,
         json, and .map. `svg` is listed for the favicon index.html already
         asks for; `webmanifest` for the manifest itself.

         .map is excluded on purpose - 3.9 MB of source maps, fetched only
         when devtools are open, which never happens with no network. */
      globPatterns: ['**/*.{js,css,html,webp,json,svg,webmanifest}'],

      /* See the const for why this is stated rather than inherited. */
      maximumFileSizeToCacheInBytes: PRECACHE_MAX_FILE_BYTES,

      /* Serve the SPA shell for unknown paths so /room/ABCD works offline,
         but not for the paths the Node host owns. In the one-container /
         one-origin deployment shape (Dockerfile, fly.toml, render.yaml,
         railway.toml) and under `vite preview`, the app and the server share
         an origin, so these are same-origin URLs sitting inside the worker's
         scope.

         Honest scope of the risk, since it is smaller than it looks: workbox
         only applies this fallback to requests with mode 'navigate', and a
         WebSocket handshake is not a fetch and never reaches a service worker
         at all - so /ws and /signal could not have been swallowed mid-game
         either way. What the denylist actually prevents is those URLs
         becoming unreachable from the address bar, and any future non-WS GET
         under /api, once the worker is installed. Cheap, and the failure it
         prevents is silent. */
      navigateFallback: 'index.html',
      navigateFallbackDenylist: [
        /^\/ws(?:\/|$)/, // game socket - server/src/index.ts
        /^\/signal(?:\/|$)/, // WebRTC signalling relay - server/src/signal.ts
        /^\/api(?:\/|$)/, // proxied to WS_TARGET in dev and preview
        /^\/healthz?$/, // platform health checks: /healthz and /health
      ],

      /* No `runtimeCaching`. Everything the shell needs is precached above,
         and the two transports are sockets, which a worker cannot cache. An
         entry here would only add a stale-data path nobody asked for. */
    },
  });
}

export default defineConfig(({ command }) => ({
  root,
  /* See BASE above for why this is absolute rather than './'. */
  base: BASE,
  resolve: { alias },

  plugins: [react(), pwa()],

  /* Formats Vite does not recognise out of the box but that a 3D game
     payload is full of. Without this they are treated as modules and the
     build fails with "Unknown file extension". */
  assetsInclude: [
    '**/*.glb',
    '**/*.gltf',
    '**/*.bin',
    '**/*.hdr',
    '**/*.exr',
    '**/*.ktx2',
    '**/*.basis',
    '**/*.dds',
  ],

  server: {
    /* host: true binds 0.0.0.0 so the four phones on the sofa can reach it.
       Vite prints the LAN URL on startup - that is the one to type in. */
    host: true,
    port: 5173,
    /* Fail loudly rather than silently moving to 5174: the QR code / URL you
       just read out to four people needs to stay correct. */
    strictPort: true,
    https: devHttps(),
    proxy: {
      '/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
      '/api': { target: WS_TARGET, changeOrigin: true },
    },
    /* Vite 6 blocks unknown Host headers (DNS-rebinding protection). Bare IPs
       and localhost are always fine, but tunnels are not - without these,
       cloudflared/ngrok return "Blocked request" instead of the game. */
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io', '.loca.lt'],
  },

  /* `vite preview` serves the real production build. This is the honest way
     to test on phones: the dev server's unbundled ESM is thousands of requests
     and behaves nothing like the deployed artifact over mobile Wi-Fi. */
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
    https: devHttps(),
    proxy: {
      '/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
      '/api': { target: WS_TARGET, changeOrigin: true },
    },
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io', '.loca.lt'],
  },

  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    /* Phones are hard to attach a debugger to. Source maps are only fetched
       when devtools are actually open, so this costs nothing at runtime. */
    sourcemap: true,
    /* esbuild, not terser: comparable output, a fraction of the CPU. */
    minify: 'esbuild',
    /* We know the three.js chunk is ~600kB. Warn at a level that still
       catches a genuine regression. */
    chunkSizeWarningLimit: 1200,

    /* Never inline a texture or a model. Base64 in a JS chunk costs ~33%
       extra bytes, blocks the parser, and defeats HTTP caching - all three
       matter more here than saving a request. Small UI icons still inline. */
    assetsInlineLimit: (filePath: string, content: Buffer) => {
      if (/\.(png|jpe?g|webp|avif|ktx2|basis|dds|hdr|exr|glb|gltf|bin)$/i.test(filePath)) {
        return false;
      }
      return content.byteLength <= 4096;
    },

    rollupOptions: {
      output: {
        /* Chunking. three.js is ~600kB on its own and changes only when the
           dependency is bumped, so it gets its own long-lived chunk; the game
           code can then be rebuilt and re-downloaded without dragging the
           engine along with it.
           The split is acyclic on purpose: three imports nothing from r3f,
           r3f imports three. Splitting the other way round produces chunks
           that deadlock on initialisation. */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;

          if (/[\\/]node_modules[\\/]three[\\/]/.test(id)) return 'three';

          /* React and everything React-internal must be decided FIRST.
             `scheduler` and `react-reconciler` look like r3f dependencies -
             r3f does pull them in - but react-dom depends on `scheduler` too.
             Grouping them with r3f makes the react chunk import the r3f chunk
             while the r3f chunk imports the react chunk, and Rollup reports
             "Circular chunk: r3f -> react -> r3f". The resulting bundle can
             deadlock at module-init time depending on which chunk the browser
             evaluates first. Keep this branch above the r3f branch. */
          if (
            /[\\/]node_modules[\\/](react|react-dom|react-reconciler|scheduler|use-sync-external-store)[\\/]/.test(
              id,
            )
          ) {
            return 'react';
          }

          if (
            /[\\/]node_modules[\\/](@react-three|three-stdlib|three-mesh-bvh|camera-controls|meshline|maath|troika-[^\\/]+|@mediapipe|potpack|detect-gpu|suspend-react|its-fine|zustand)[\\/]/.test(
              id,
            )
          ) {
            return 'r3f';
          }

          return 'vendor';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },

  /* Pre-bundle the heavy 3D dependencies once at dev-server start instead of
     discovering them mid-session. Without this, the first time a phone loads
     the scene Vite stops to re-optimise and the page reloads under you. */
  optimizeDeps: {
    include: ['three', '@react-three/fiber', '@react-three/drei', 'react', 'react-dom'],
  },

  /* Strip licence banners from the production bundle only - they are useful
     noise in dev and dead weight over mobile data. Attribution for the
     dependencies lives in README / docs, not in every chunk. */
  esbuild: command === 'build' ? { legalComments: 'none' } : {},
}));
