import { expect, test } from '@playwright/test';

import type { OtrioApp } from '../support/app';
import { capture } from '../support/pixels';
import { openTable, reportLoad } from '../support/table';

/**
 * The product is multi-client, so this is the file that decides whether it
 * works.
 *
 * Two, three and four real browser contexts, one room, one hosted server, no
 * mocks anywhere in the path: each client opens its own WebSocket to the Node
 * referee in `server/`, and every assertion below is one client observing a
 * consequence of another client's action. Nothing here can pass because two
 * copies of the engine happened to agree locally.
 *
 * One context per player, never one context with several tabs: the identity in
 * `otrio.identity.v1` is per-origin-per-context, and sharing it makes the second
 * tab reconnect as the first player instead of taking a second seat.
 */

/** Whichever client currently holds the turn. */
async function onTurn(apps: OtrioApp[]): Promise<OtrioApp> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    for (const app of apps) {
      if (await app.isMyTurn()) return app;
    }
    await apps[0].page.waitForTimeout(250);
  }
  throw new Error('no client claimed the turn within 20s');
}

/** Every client's view of the board, as one comparable string. */
async function boards(apps: OtrioApp[]): Promise<string[]> {
  const out: string[] = [];
  for (const app of apps) out.push(JSON.stringify(await app.board()));
  return out;
}

test.describe('multi-client, hosted WebSocket', () => {
  test('three clients converge on the same board after every move', async ({ browser }) => {
    reportLoad('before 3 clients');
    const table = await openTable(browser, ['Ada', 'Grace', 'Alan'], { pinTextBoard: true });
    try {
      const apps = table.apps;
      await apps[0].waitForBoard();

      const seen: string[] = [];
      for (let ply = 1; ply <= 6; ply += 1) {
        const mover = await onTurn(apps);
        seen.push(mover.playerName);
        await mover.place(ply - 1, 'large');
        for (const app of apps) {
          await expect
            .poll(() => app.pieceCount(), { message: `${app.playerName} missed ply ${ply}` })
            .toBe(ply);
        }
        const views = await boards(apps);
        expect(new Set(views).size, `clients disagree after ply ${ply}`).toBe(1);
      }

      // Six plies, three seats, strict round robin: the order repeats exactly.
      expect(seen.slice(0, 3)).toEqual(seen.slice(3, 6));
      expect(new Set(seen).size).toBe(3);
      reportLoad('after 3 clients');
    } finally {
      await table.close();
    }
  });

  test('four clients play one game and the turn cannot be jumped', async ({ browser }) => {
    reportLoad('before 4 clients');
    const table = await openTable(browser, ['Ada', 'Grace', 'Alan', 'Edsger'], {
      pinTextBoard: true,
    });
    try {
      const apps = table.apps;
      await apps[0].waitForBoard();
      reportLoad('4 clients, board drawn');

      const mover = await onTurn(apps);
      const waiting = apps.filter((a) => a !== mover);

      /*
       * Turn enforcement, seen from the three clients who do not have it. Every
       * space is `aria-disabled` rather than `disabled`, on purpose: an
       * unplayable space still has to be readable and reachable by a screen
       * reader, it just cannot be activated.
       */
      for (const app of waiting) {
        for (let cell = 0; cell < 9; cell += 1) {
          await expect(app.cell(cell)).toHaveAttribute('aria-disabled', 'true');
        }
        await expect(app.page.locator('[role="radiogroup"][aria-label="Ring size to place"]')).toHaveAttribute(
          'aria-disabled',
          'true',
        );
      }

      // And a click on one changes nothing, anywhere.
      await waiting[0].cell(4).click({ force: true });
      await waiting[0].page.waitForTimeout(800);
      for (const app of apps) expect(await app.pieceCount()).toBe(0);

      // Now play a full lap and check the seats come round in a fixed order.
      const order: string[] = [];
      for (let ply = 1; ply <= 8; ply += 1) {
        const next = await onTurn(apps);
        order.push(next.playerName);
        await next.place(ply - 1, 'large');
        await expect.poll(() => apps[3].pieceCount()).toBe(ply);
      }
      expect(order.slice(0, 4)).toEqual(order.slice(4, 8));
      expect(new Set(order).size).toBe(4);

      const views = await boards(apps);
      expect(new Set(views).size, 'four clients disagree about the board').toBe(1);

      const shot = await capture(apps[0].page, '05-four-clients');
      test.info().annotations.push({ type: 'screenshot', description: shot });
      reportLoad('after 4 clients');
    } finally {
      await table.close();
    }
  });

  test('a client that loses the network reconnects into the same game', async ({ browser }) => {
    /* Losing a link is slow by design: the client's idle timeout is 20s, the
       server's socket heartbeat is 10s, and the reconnect grace is 45s. A test
       that drops a connection has to be allowed to outlast all three. */
    test.setTimeout(240_000);
    const table = await openTable(browser, ['Ada', 'Grace'], { pinTextBoard: true });
    try {
      const apps = table.apps;
      await apps[0].waitForBoard();

      const first = await onTurn(apps);
      await first.place(0, 'large');
      await expect.poll(() => apps[1].pieceCount()).toBe(1);

      // Pull the plug on one client, mid-game, without closing the tab.
      const dropped = apps[1];
      const survivor = apps[0];
      await dropped.context.setOffline(true);

      // Both ends notice: the dropped client says so, and the other client sees
      // the seat go away rather than silently freezing.
      await expect(dropped.page.locator('.o-banner')).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(
          async () => survivor.page.locator('.o-pcard.is-away, .o-conn--reconnecting, .o-conn--offline').count(),
          { timeout: 60_000, message: 'the surviving client never noticed the drop' },
        )
        .toBeGreaterThan(0);

      const away = await capture(survivor.page, '06-peer-dropped');
      test.info().annotations.push({ type: 'screenshot', description: away });

      // Plug it back in, inside the 45s reconnect grace.
      await dropped.context.setOffline(false);

      await expect
        .poll(() => dropped.page.locator('.o-game').count(), {
          timeout: 60_000,
          message: 'the reconnected client did not land back on the board',
        })
        .toBe(1);
      await expect
        .poll(() => dropped.pieceCount(), { timeout: 60_000 })
        .toBe(1);

      // The route is derived from room state, not stored, so a restored seat
      // lands back on the board rather than the home screen. Check it can also
      // still play.
      await expect
        .poll(async () => (await survivor.page.locator('.o-pcard.is-away').count()) === 0, {
          timeout: 60_000,
          message: 'the seat never came back online for the other client',
        })
        .toBe(true);

      const mover = await onTurn(apps);
      await mover.place(1, 'large');
      await expect.poll(() => apps[0].pieceCount()).toBe(2);
      await expect.poll(() => apps[1].pieceCount()).toBe(2);
    } finally {
      await table.close();
    }
  });

  test('a client that closes its tab mid-game leaves the others playable', async ({ browser }) => {
    const table = await openTable(browser, ['Ada', 'Grace', 'Alan'], { pinTextBoard: true });
    try {
      const apps = table.apps;
      await apps[0].waitForBoard();

      // Take the seat that is NOT about to move, so the remaining two can carry
      // on without waiting out a turn timeout.
      const mover = await onTurn(apps);
      const leaving = apps.find((a) => a !== mover);
      if (!leaving) throw new Error('expected three clients');
      const remaining = apps.filter((a) => a !== leaving);

      await leaving.context.close();

      await expect
        .poll(
          async () =>
            remaining[0].page.locator('.o-pcard.is-away, .o-pcard.is-gone, .o-conn--offline, .o-conn--reconnecting').count(),
          { timeout: 60_000, message: 'nobody noticed a player close their tab' },
        )
        .toBeGreaterThan(0);

      // The game is not over, and whoever holds the turn can still take it.
      const next = await onTurn(remaining);
      await next.place(0, 'large');
      await expect.poll(() => remaining[0].pieceCount()).toBe(1);
      await expect.poll(() => remaining[1].pieceCount()).toBe(1);

      const shot = await capture(remaining[0].page, '07-player-left');
      test.info().annotations.push({ type: 'screenshot', description: shot });
    } finally {
      await table.close();
    }
  });
});
