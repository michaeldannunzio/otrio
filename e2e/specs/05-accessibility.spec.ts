import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { COLOUR_NAMES, OtrioApp, type Colour } from '../support/app';
import { capture, captureAndAnalyse } from '../support/pixels';
import { openTable } from '../support/table';

/**
 * The keyboard and screen-reader route, driven the way it is meant to be.
 *
 * `TextBoard` is a parallel 3x3 of real buttons that reads the same
 * authoritative state and calls the same `placePiece` action as the canvas. It
 * is also the fallback when WebGL is unavailable. Both claims are tested here,
 * and the first one is tested by playing a complete game without ever touching
 * the mouse.
 *
 * What this cannot tell you: how any of it actually sounds. There is no screen
 * reader in this environment, so these tests check names, roles, focus order
 * and live regions — the raw material VoiceOver and NVDA read from. Whether the
 * result is pleasant to listen to needs a person with a screen reader on.
 */

/** Tab until focus lands inside the flat board, and say how far it was. */
async function tabToBoard(page: Page, limit = 25): Promise<number> {
  for (let presses = 1; presses <= limit; presses += 1) {
    await page.keyboard.press('Tab');
    const inGrid = await page.evaluate(
      () => document.activeElement?.hasAttribute('data-cell') ?? false,
    );
    if (inGrid) return presses;
  }
  throw new Error(`the flat board was not reachable within ${limit} tab presses`);
}

async function focusedCell(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const value = document.activeElement?.getAttribute('data-cell');
    return value === null || value === undefined ? null : Number(value);
  });
}

const SIZE_FOR_KEY = { '1': 'small', '2': 'medium', '3': 'large' } as const;

/** Walk to a space using Home + ArrowRight only, then place with Enter. */
async function keyboardPlace(app: OtrioApp, cell: number, sizeKey: '1' | '2' | '3'): Promise<void> {
  await app.page.keyboard.press('Home');
  expect(await focusedCell(app.page)).toBe(0);
  for (let i = 0; i < cell; i += 1) await app.page.keyboard.press('ArrowRight');
  expect(await focusedCell(app.page)).toBe(cell);

  await app.page.keyboard.press(sizeKey);
  /* The hint line says which ring Enter will place. Waiting for it is both an
     assertion that 1/2/3 armed what it claims and the synchronisation point
     before Enter — pressing Enter into a stale render would place the previous
     size and the test would be lying about which ring went down. */
  await expect(app.page.locator('#textboard-hint')).toContainText(
    `Enter places the ${SIZE_FOR_KEY[sizeKey]} ring`,
  );

  await app.page.keyboard.press('Enter');
}

test.describe('the accessible board', () => {
  test('is reachable by Tab, navigable by arrows, and reveals itself on focus', async ({
    browser,
  }) => {
    const table = await openTable(browser, ['Ada', 'Grace']);
    try {
      const app = table.apps[0];
      await app.waitForBoard();

      // Collapsed to 1px until something inside takes focus — the skip-link
      // pattern, so a sighted keyboard user can see where their focus went.
      const hiddenBox = await app.page.locator('.o-textboard').boundingBox();
      expect(hiddenBox?.height ?? 0).toBeLessThan(8);

      const presses = await tabToBoard(app.page);
      test.info().annotations.push({ type: 'tab-distance', description: String(presses) });

      const shownBox = await app.page.locator('.o-textboard').boundingBox();
      expect(shownBox?.height ?? 0, 'the flat board stayed hidden after focus').toBeGreaterThan(80);

      // Exactly one tab stop for the whole grid: Tab leaves it rather than
      // walking through nine buttons.
      await expect(app.page.locator('[data-cell][tabindex="0"]')).toHaveCount(1);
      await expect(app.page.locator('[data-cell]')).toHaveCount(9);

      // Arrows, with the documented wrapping.
      await app.page.keyboard.press('Home');
      expect(await focusedCell(app.page)).toBe(0);
      await app.page.keyboard.press('End');
      expect(await focusedCell(app.page)).toBe(8);
      await app.page.keyboard.press('ArrowRight');
      expect(await focusedCell(app.page), 'ArrowRight should wrap past the last space').toBe(0);
      await app.page.keyboard.press('ArrowDown');
      expect(await focusedCell(app.page)).toBe(3);
      await app.page.keyboard.press('ArrowUp');
      expect(await focusedCell(app.page)).toBe(0);
      await app.page.keyboard.press('ArrowLeft');
      expect(await focusedCell(app.page), 'ArrowLeft should wrap before the first space').toBe(8);

      // Every space says what is on it and what pressing Enter would do.
      const label = await app.cellLabel(4);
      expect(label).toMatch(/^centre\./i);
      expect(label).toMatch(/small free, medium free, large free/i);
      expect(label).toMatch(/place your|cannot place/i);

      const shot = await capture(app.page, '11-textboard-focused');
      test.info().annotations.push({ type: 'screenshot', description: shot });
    } finally {
      await table.close();
    }
  });

  test('plays a complete nine-ply game with the keyboard only', async ({ browser }) => {
    const table = await openTable(browser, ['Ada', 'Grace'], { pinTextBoard: true });
    try {
      const apps = table.apps;
      await apps[0].waitForBoard();

      // The same nine plies as the two-player rule test, entered entirely from
      // the keyboard: Home and arrows to the space, 1/2/3 to arm a size, Enter
      // to place. No pointer is used anywhere in this test.
      const script: Array<[number, '1' | '2' | '3']> = [
        [0, '3'],
        [3, '3'],
        [6, '1'],
        [7, '1'],
        [1, '3'],
        [4, '3'],
        [8, '1'],
        [5, '1'],
        [2, '3'],
      ];

      const colours: Array<{ player: string; colour: Colour | null }> = [];
      for (let i = 0; i < script.length; i += 1) {
        const mover = (await apps[0].isMyTurn()) ? apps[0] : apps[1];
        await mover.waitForMyTurn();
        colours.push({ player: mover.playerName, colour: await mover.dueColour() });

        await tabToBoard(mover.page);
        const [cell, key] = script[i];
        await keyboardPlace(mover, cell, key);

        for (const app of apps) {
          await expect
            .poll(() => app.pieceCount(), { message: `ply ${i + 1} never landed` })
            .toBe(i + 1);
        }
        // Leave the grid so the next Tab walk starts from a known place.
        await mover.page.keyboard.press('Shift+Tab');
      }

      // Nine plies, and the win is announced to the live region rather than only
      // drawn: the overlay is a picture, the announcer is the sentence.
      await expect(apps[0].page.locator('.o-result')).toBeVisible({ timeout: 20_000 });
      const spoken = await apps[0].announcements();
      expect(spoken.toLowerCase()).toMatch(/win|wins/);

      const first = colours[0].player;
      const firstColours = colours.filter((c) => c.player === first).map((c) => c.colour);
      expect(firstColours).toHaveLength(5);
      expect(firstColours[0]).not.toBe(firstColours[1]);
      expect(firstColours[4]).toBe(firstColours[0]);

      test.info().annotations.push({
        type: 'plies',
        description: colours
          .map((c, i) => `${i + 1}. ${c.player}/${COLOUR_NAMES[c.colour ?? 0]}`)
          .join('  '),
      });

      const shot = await capture(apps[0].page, '12-keyboard-game-won');
      test.info().annotations.push({ type: 'screenshot', description: shot });
    } finally {
      await table.close();
    }
  });

  test('without WebGL the game falls back to the flat board and stays playable', async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();

    /* The probe in BoardStage calls `canvas.getContext('webgl2')` and
       `('webgl')`. Refusing both, before any app script runs, is exactly the
       condition an old phone, a blocklisted driver, or "use hardware
       acceleration when available" switched off presents to the app. */
    const noGl = await OtrioApp.open(hostCtx, 'Ada', { noWebGL: true });
    /* The other player keeps WebGL. Their flat board is not promoted for them,
       so it is pinned here — otherwise it stays collapsed to 1px and a pointer
       cannot reach it, which is the intended behaviour and not what this test
       is about. */
    const guest = await OtrioApp.open(guestCtx, 'Grace', { pinTextBoard: true });
    const patched = noGl.page;

    try {
      const code = await noGl.createRoom(2);
      await guest.joinRoom(code);
      await noGl.markReady();
      await guest.markReady();
      await noGl.startGame();
      await noGl.expectInGame();

      // No canvas, an explanation that is not an error, and the flat board
      // promoted without anyone having to find it.
      await expect(patched.locator('.app-canvas canvas')).toHaveCount(0);
      await expect(patched.getByText(/can.t draw the 3D board/i)).toBeVisible();
      await expect(patched.getByText(/flat board below shows the same position/i)).toBeVisible();
      const box = await patched.locator('.o-textboard').boundingBox();
      expect(box?.height ?? 0, 'the flat board was not promoted').toBeGreaterThan(80);

      const { path } = await captureAndAnalyse(patched, '13-no-webgl-fallback');
      test.info().annotations.push({ type: 'screenshot', description: path });

      // And it is a game, not a consolation screen: a move still works, both
      // ways, against the same server.
      const mover = (await noGl.isMyTurn()) ? noGl : guest;
      await mover.place(4, 'large');
      await expect.poll(() => noGl.pieceCount()).toBe(1);
      await expect.poll(() => guest.pieceCount()).toBe(1);

      const second = mover === noGl ? guest : noGl;
      await second.place(0, 'large');
      await expect.poll(() => noGl.pieceCount()).toBe(2);
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });
});
