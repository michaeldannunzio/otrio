import { defineConfig } from 'vitest/config';
import { alias } from './vite.config';

/* ------------------------------------------------------------------ *
 * Why this is a separate file from vite.config.ts
 *
 * vitest 2.1.x declares `vite: ^5.0.0` as a hard dependency, but this app
 * runs on vite 6. npm therefore installed a SECOND copy of Vite nested at
 * node_modules/vitest/node_modules/vite (5.4.21).
 *
 * That makes `vite` and `vitest/config` two structurally different type
 * universes. Putting a `test` block inside vite.config.ts makes tsc reject
 * the whole config, because @vitejs/plugin-react returns a vite-6 Plugin
 * where vitest's defineConfig expects a vite-5 Plugin.
 *
 * Keeping the test config in its own file - with no Vite plugins in it -
 * means the two copies never have to agree. Vitest prefers vitest.config.ts
 * over vite.config.ts automatically, so `npm test` picks this up.
 *
 * The real fix is `vitest@^3`, which supports Vite 6. That is a package.json
 * change and package.json is not owned by this agent; see the README's
 * "Known rough edges" section.
 * ------------------------------------------------------------------ */

export default defineConfig({
  resolve: { alias },
  test: {
    /* environment stays "node": the game rules and the wire protocol are the
       parts worth testing, and neither needs a DOM. There is deliberately no
       jsdom/happy-dom dependency - it would not let you render r3f components
       in tests anyway, because there is no WebGL context to render into. */
    environment: 'node',
    /* globals: true so that both `import { describe } from 'vitest'` and bare
       describe/it/expect work. With nine authors, both styles exist. */
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'server/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    /* Vitest defaults to one worker per core. On a 24-core machine that is a
       near-instant load spike from idle, which is exactly what this machine
       must not do. Capped at 4. */
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
