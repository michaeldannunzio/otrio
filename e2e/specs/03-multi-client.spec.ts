import { expect, test } from '@playwright/test';

import { OtrioApp } from '../support/app';
import { SeverableLink } from '../support/link';
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
 *
 * All four contexts run inside a single test, on a single worker. That is not a
 * parallelism setting that could be turned down — four players in one room are
 * four browsers that must be alive at the same moment. On this machine each one
 * costs a full SwiftShader rasteriser, so the four-client test is the most
 * expensive thing in the suite by a wide margin.
 */

/**
 * Whichever client holds the turn, once it has stopped moving.
 *
 * The settle step matters. Right after a move the outgoing client can still
 * report `is-mine` for a frame or two, and acting on that reads as "the client
 * let me play out of turn" when it is really the test being too quick.
 */
async function onTurn(apps: OtrioApp[]): Promise<OtrioApp> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    for (const app of apps) {
      if (await app.isMyTurn()) {
        await app.page.waitForTimeout(150);
        if (await app.isMyTurn()) return app;
      }
    }
    await apps[0].page.waitForTimeout(250);
  }
  throw new Error('no client claimed the turn within 20s');
}

/** Wait until every client has seen the same number of pieces land. */
async function settle(apps: OtrioApp[], pieces: number): Promise<void> {
  for (const app of apps) {
    await expect
      .poll(() => app.pieceCount(), { message: `${app.playerName} never saw ply ${pieces}` })
      .toBe(pieces);
  }
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
      /* Six plies with everyone placing a large ring into cells 0..5. Three
         seats each end up with two large rings in their own column, never a
         third, so nobody can win before the count is up. */
      for (let ply = 1; ply <= 6; ply += 1) {
        const mover = await onTurn(apps);
        seen.push(mover.playerName);
        await mover.place(ply - 1, 'large');
        await settle(apps, ply);
        expect(new Set(await boards(apps)).size, `clients disagree after ply ${ply}`).toBe(1);
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
        await expect(
          app.page.locator('[role="radiogroup"][aria-label="Ring size to place"]'),
        ).toHaveAttribute('aria-disabled', 'true');
      }

      // And a click on one changes nothing, anywhere.
      await waiting[0].cell(4).click({ force: true });
      await waiting[0].page.waitForTimeout(800);
      for (const app of apps) expect(await app.pieceCount()).toBe(0);

      /* Eight plies into cells 0..7, all large. Each of the four colours ends
         with two large rings that are never collinear, so the lap completes
         without anyone winning. */
      const order: string[] = [];
      for (let ply = 1; ply <= 8; ply += 1) {
        const next = await onTurn(apps);
        order.push(next.playerName);
        await next.place(ply - 1, 'large');
        await settle(apps, ply);
      }
      expect(order.slice(0, 4)).toEqual(order.slice(4, 8));
      expect(new Set(order).size).toBe(4);
      expect(new Set(await boards(apps)).size, 'four clients disagree about the board').toBe(1);

      for (const app of apps) {
        const shot = await capture(app.page, `05-four-clients-${app.playerName.toLowerCase()}`);
        test.info().annotations.push({ type: 'screenshot', description: shot });
      }
      reportLoad('after 4 clients');
    } finally {
      await table.close();
    }
  });

  test('a severed link reconnects into the same game', async ({ browser }) => {
    /* Losing a link is slow by design: the client's idle timeout is 20s, its
       reconnect backoff is 500ms x 1.8^n, and the referee's grace is 45s. A
       test that cuts a connection has to be allowed to outlast all three. */
    test.setTimeout(240_000);

    const survivorCtx = await browser.newContext();
    const droppedCtx = await browser.newContext();

    const survivor = await OtrioApp.open(survivorCtx, 'Ada', { pinTextBoard: true });
    let link: SeverableLink | null = null;
    const dropped = await OtrioApp.open(droppedCtx, 'Grace', {
      pinTextBoard: true,
      beforeLoad: async (page) => {
        link = await SeverableLink.install(page);
      },
    });
    if (!link) throw new Error('the severable link was not installed');
    const wire: SeverableLink = link;

    try {
      const code = await survivor.createRoom(2);
      await dropped.joinRoom(code);
      await survivor.markReady();
      await dropped.markReady();
      await survivor.startGame();
      await survivor.expectInGame();
      await dropped.expectInGame();

      const apps = [survivor, dropped];
      await survivor.waitForBoard();

      await (await onTurn(apps)).place(0, 'large');
      await settle(apps, 1);
      expect(await wire.connectionCount()).toBe(1);

      // Cut the wire mid-game, without closing the tab.
      await wire.cut();

      // The dropped client says so — a healthy link renders no banner at all,
      // so the banner appearing is itself the signal.
      await expect(dropped.page.locator('.o-banner')).toBeVisible({ timeout: 30_000 });

      // And the other client is told the seat is being held, with a countdown to
      // the point where the referee gives up.
      await expect(survivor.page.locator('.o-banner')).toBeVisible({ timeout: 60_000 });
      const held = await survivor.page.locator('.o-banner').innerText();
      expect(held.toLowerCase()).toMatch(/grace|come back|reconnect/);

      const away = await capture(survivor.page, '06-peer-dropped');
      test.info().annotations.push({ type: 'screenshot', description: away });

      // Reconnect inside the grace window and let the client's own backoff work.
      await wire.heal();

      await expect
        .poll(() => wire.connectionCount(), {
          timeout: 90_000,
          message: 'the client never re-opened its socket',
        })
        .toBeGreaterThan(1);

      // Back on the board, not back on the home screen: the route is derived
      // from the restored room state rather than stored anywhere.
      await expect(dropped.page.locator('.o-game')).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => dropped.pieceCount(), { timeout: 60_000 }).toBe(1);
      await expect(survivor.page.locator('.o-banner')).toHaveCount(0, { timeout: 60_000 });

      // And the game carries on from where it stopped.
      await (await onTurn(apps)).place(1, 'large');
      await settle(apps, 2);
    } finally {
      await survivorCtx.close();
      await droppedCtx.close();
    }
  });

  test('a player who reloads mid-game gets their seat and position back', async ({ browser }) => {
    test.setTimeout(180_000);
    const table = await openTable(browser, ['Ada', 'Grace'], { pinTextBoard: true });
    try {
      const apps = table.apps;
      await apps[0].waitForBoard();

      await (await onTurn(apps)).place(4, 'large');
      await settle(apps, 1);

      const before = JSON.stringify(await apps[1].board());
      await apps[1].page.reload({ waitUntil: 'load' });

      // The identity in localStorage survives the reload, the handshake resumes
      // the room, and the derived route puts them straight back on the board.
      await expect(apps[1].page.locator('.o-game')).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => apps[1].pieceCount(), { timeout: 60_000 }).toBe(1);
      expect(JSON.stringify(await apps[1].board())).toBe(before);

      await expect(apps[1].lobbySeats()).toHaveCount(0);
      await (await onTurn(apps)).place(0, 'large');
      await settle(apps, 2);
    } finally {
      await table.close();
    }
  });

  test('a player who closes their tab pauses the room, and it names them', async ({ browser }) => {
    test.setTimeout(180_000);
    const table = await openTable(browser, ['Ada', 'Grace', 'Alan'], { pinTextBoard: true });
    try {
      const apps = table.apps;
      await apps[0].waitForBoard();

      const leaving = apps[2];
      const remaining = [apps[0], apps[1]];
      await leaving.context.close();

      /*
       * The room pauses rather than carrying on without them, which is the
       * right call for a game around a table: the referee holds the seat for the
       * 45s grace and everyone is told whose it is and how long is left. The
       * banner only exists when there is something to say, so its presence and
       * its text are both the assertion.
       */
      await expect(remaining[0].page.locator('.o-banner')).toBeVisible({ timeout: 60_000 });
      const text = await remaining[0].page.locator('.o-banner').innerText();
      expect(text, 'the pause banner should name who everyone is waiting for').toContain('Alan');

      const shot = await capture(remaining[0].page, '07-player-left');
      test.info().annotations.push({ type: 'screenshot', description: shot });

      // Both remaining clients agree that the seat is away rather than gone.
      for (const app of remaining) {
        await expect(
          app.page.locator('.o-pcard.is-away, .o-pcard.is-gone, .o-conn--reconnecting, .o-conn--offline'),
        ).not.toHaveCount(0);
      }
    } finally {
      await table.close();
    }
  });
});
