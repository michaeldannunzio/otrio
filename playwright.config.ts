import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * ## Why software rendering, and what it does and does not prove
 *
 * There is a GPU in this machine and no display server, so headless Chromium
 * has nothing to talk to. The launch flags below force ANGLE onto SwiftShader,
 * Chromium's software Vulkan rasteriser. That gives a real WebGL 2 context, a
 * real three.js renderer and a real framebuffer — so every line of scene code
 * executes and a wrong matrix, a missing material or an environment map that
 * never baked all show up exactly as they would on a phone.
 *
 * What it does NOT prove is performance. SwiftShader is one to two orders of
 * magnitude slower than the RTX 3080 sitting in the same box, and it does not
 * exercise a single vendor driver path. Nothing in this suite should ever
 * assert a frame rate, and a green run here is not evidence that the game is
 * smooth on anything.
 *
 * `--enable-unsafe-swiftshader` is required from Chromium 120 onward: WebGL on
 * SwiftShader is otherwise refused with a console warning and a null context,
 * which presents as "this device can't draw the 3D board".
 *
 * ## Why one worker
 *
 * This machine powers off hard when CPU load ramps fast; the ceiling is load
 * ~6. A four-context multiplayer test is four Chromium renderers plus four
 * software rasterisers, and that is the real load in this suite — not the
 * browser download, not the dev server. Measured on this box: idle 0.4, a
 * four-client game peaked at 2.4. One worker keeps the headroom. If you raise
 * it, watch /proc/loadavg rather than the wall clock.
 */

const HOST = '127.0.0.1';
const WEB_PORT = 5173;
const GAME_PORT = 8787;

export const BASE_URL = `http://${HOST}:${WEB_PORT}`;
export const GAME_SERVER_URL = `http://${HOST}:${GAME_PORT}`;

/**
 * Where screenshots land. Deliberately not Playwright's `test-results/`, which
 * is wiped on every run: the render screenshots are the deliverable and someone
 * needs to be able to find them afterwards.
 */
export const SHOT_DIR = 'e2e/screenshots';

/** Chromium flags that turn a headless box into a working WebGL box. */
export const SWIFTSHADER_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

export default defineConfig({
  testDir: './e2e/specs',
  outputDir: './test-results',

  /* Multi-client tests drive four browsers through a nine-ply game on a
     software rasteriser. Two minutes is not generous, it is realistic. */
  timeout: 150_000,
  expect: { timeout: 20_000 },

  /* No parallelism and no retries. A flaky multiplayer test that passes on the
     second attempt is a bug report we would rather read than hide. */
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    launchOptions: { args: SWIFTSHADER_ARGS },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],

  /*
   * Both halves of the product, started together.
   *
   * The client does NOT go through Vite's `/ws` proxy — `resolveServerUrl()` in
   * src/net/wsTransport.ts special-cases dev ports and dials
   * ws://<hostname>:8787 directly — so the game server has to be up in its own
   * right, not merely proxyable. `/healthz` is the readiness signal;
   * `/api/health` does not exist (the Vite proxy config implies otherwise).
   *
   * `nice -n 19` on both: see the load note above.
   */
  webServer: [
    {
      command: 'nice -n 19 npm run server',
      url: `${GAME_SERVER_URL}/healthz`,
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'nice -n 19 npm run dev',
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
