import { defineConfig } from 'vitest/config';
import { alias } from './vite.config';

/* ------------------------------------------------------------------ *
 * Why this is a separate file from vite.config.ts
 *
 * Originally it had to be. vitest 2.1.x hard-depended on `vite: ^5` while the
 * app runs vite 6, so npm installed a second Vite nested under vitest and the
 * two `defineConfig` types were structurally incompatible - a `test` block
 * inside vite.config.ts made tsc reject the whole config.
 *
 * That is fixed: vitest is now ^3, which supports Vite 6, and there is exactly
 * one copy of Vite in the tree. Verified 2026-09-16 - `find node_modules
 * -path '*\/node_modules/vite'` returns nothing nested.
 *
 * The file stays separate now for a plainer reason: the test runner has no
 * business loading the React plugin, the dev-server proxy or the HTTPS
 * certificate logic, none of which it uses. Vitest prefers vitest.config.ts
 * over vite.config.ts automatically. Merging the two back together would work;
 * it would just make both harder to read.
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
