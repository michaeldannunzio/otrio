import { expect, test } from '@playwright/test';

import { OtrioApp } from '../support/app';
import { captureAndAnalyse } from '../support/pixels';
import { readGl } from '../support/probe';
import { openTable, reportLoad } from '../support/table';

/**
 * Does it render at all.
 *
 * This file exists because the project reached 165 green unit tests and 82
 * server assertions without anyone, human or machine, ever having seen the
 * board. A green build proves the modules type-check and link. It says nothing
 * about whether a canvas appears, whether three.js issues a draw call, or
 * whether the environment map baked — and that last one is invisible to every
 * assertion in this file except the screenshot, which is why the screenshot is
 * the deliverable and the assertions are the supporting cast.
 */

test.describe('rendering', () => {
  test('the home screen paints', async ({ browser }) => {
    const app = await OtrioApp.open(await browser.newContext(), 'Ada');
    try {
      await expect(app.page.getByRole('heading', { name: 'Otrio', level: 1 })).toBeVisible();
      await expect(app.page.getByRole('button', { name: 'Start a new game' })).toBeEnabled();

      const { path, stats } = await captureAndAnalyse(app.page, '01-home');
      test.info().annotations.push({ type: 'screenshot', description: path });

      // Not a blank page repainted in the brand colour: there is type, there are
      // controls, there is more than one thing on screen.
      expect(stats.distinctColours).toBeGreaterThan(20);
      expect(stats.subjectRatio).toBeGreaterThan(0.01);
      expect(app.pageErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('the 3D board draws, in wood, with a live WebGL context', async ({ browser }) => {
    reportLoad('before 2-client render');
    const table = await openTable(browser, ['Ada', 'Grace'], { pinTextBoard: false });
    try {
      const { host } = table;
      await host.waitForBoard();
      // Shader compilation on SwiftShader is slow and the scene runs
      // frameloop="demand"; give it room to settle before reading the frame.
      await host.page.waitForTimeout(3_000);

      const gl = await readGl(host.page);
      test.info().annotations.push({ type: 'gl', description: JSON.stringify(gl) });

      expect(gl.webgl, 'a WebGL context could not be created at all').toBe(true);
      expect(gl.canvasCount, 'no <canvas> in the document').toBeGreaterThan(0);
      expect(gl.rendererCount, 'three.js never constructed a WebGLRenderer').toBeGreaterThan(0);
      expect(gl.contextLost).toBe(false);

      // The scene drew. Not "a canvas exists" — the renderer's own accounting of
      // the last frame it submitted.
      expect(gl.drawCalls, 'the renderer submitted no draw calls').toBeGreaterThan(0);
      expect(gl.triangles, 'the renderer drew no triangles').toBeGreaterThan(1_000);
      expect(gl.geometries).toBeGreaterThan(0);

      /*
       * The environment map. `useStudioEnvironment` bakes a PMREM once per
       * theme and there is no fallback: if it does not fire, every PBR material
       * in the scene loses its specular response and the board reads as grey
       * clay. Mapping 306 is three.js's CubeUVReflectionMapping — the output of
       * a real PMREMGenerator target, not a texture assigned by hand.
       */
      expect(gl.hasEnvironment, 'scene.environment is unset — the PMREM bake did not fire').toBe(
        true,
      );
      expect(gl.environmentMapping).toBe(306);

      const { path, stats } = await captureAndAnalyse(host.page, '02-board-desktop');
      test.info().annotations.push({ type: 'screenshot', description: path });
      test.info().annotations.push({ type: 'pixels', description: JSON.stringify(stats) });

      // Something big is on screen, and it is not the flat clear colour.
      expect(stats.subject, 'nothing but background in the frame').not.toBeNull();
      expect(stats.subjectRatio).toBeGreaterThan(0.15);
      expect(stats.distinctColours).toBeGreaterThan(200);

      /*
       * The clay check. A lit wooden board is warm (red well above blue) across
       * most of its pixels and has real luminance spread from the shading. An
       * unlit scene is neither. These thresholds are loose on purpose — they are
       * there to catch a total loss of material response, not to pin a look.
       */
      expect(stats.warmRatio, 'the board is not warm — shading or textures are missing').toBeGreaterThan(0.4);
      expect(stats.luminanceStdDev, 'the frame is flat — no shading').toBeGreaterThan(10);

      expect(host.pageErrors).toEqual([]);
      reportLoad('after 2-client render');
    } finally {
      await table.close();
    }
  });

  test('the lobby shows a joinable code and no colours', async ({ browser }) => {
    const table = await openTable(browser, ['Ada', 'Grace'], { lobbyOnly: true });
    try {
      const { host, code } = table;
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}$/);
      await expect(host.lobbySeats()).toHaveCount(2);

      /*
       * Colours are deliberately absent here. `PlayerView.colors` is empty
       * until the game starts, because how many colours a seat gets depends on
       * the final player count — one each at three or four players, two each in
       * the official two-player game. Asserting their absence is asserting the
       * contract.
       */
      const lobby = await host.page.locator('.o-seats').innerText();
      for (const colour of ['Purple', 'Red', 'Green', 'Blue']) {
        expect(lobby, `the lobby names ${colour} before seats are dealt`).not.toContain(colour);
      }

      const { path } = await captureAndAnalyse(host.page, '03-lobby');
      test.info().annotations.push({ type: 'screenshot', description: path });
    } finally {
      await table.close();
    }
  });
});
