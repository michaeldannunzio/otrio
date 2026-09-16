/// <reference types="node" />
import { defineConfig, type ServerOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const r = (p: string) => resolve(root, p);

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

export default defineConfig(({ command }) => ({
  root,
  /* Absolute base, not './'. The deployed hosts below all rewrite unknown
     paths to index.html, so the page can be served from a nested URL like
     /room/ABCD - and a relative base would resolve ./assets/* against /room/
     and 404. If you ever deploy under a sub-path instead, set this to that
     sub-path rather than switching to './'. */
  base: '/',
  resolve: { alias },

  plugins: [react()],

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
