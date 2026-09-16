import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { disableWebGL, installThreeProbe } from './probe';

/**
 * One player, one browser context, driven the way a person drives it.
 *
 * Everything here goes through roles, labels and the accessible names the app
 * already publishes. Nothing reaches into a store, and there are no test-only
 * hooks in the product — if a state is not legible from the DOM, a screen
 * reader user cannot see it either, and that is worth finding out.
 *
 * The three exceptions, all of them setup rather than assertion:
 *   - the three.js devtools hook (see probe.ts), which is how the renderer
 *     reports on itself;
 *   - seeding `localStorage` to pin the flat board open, so a scripted game
 *     does not spend nine turns re-revealing a panel;
 *   - a couple of class-name reads (`u-player-N`, `is-mine`). These carry the
 *     *colour*, which in the official two-player game is the only thing that
 *     distinguishes two pieces belonging to the same person, and no accessible
 *     name exposes it per cell. Named here so the coupling is visible.
 */

export const PIECE_SIZES = ['small', 'medium', 'large'] as const;
export type PieceSize = (typeof PIECE_SIZES)[number];

/** `PlayerColor` on the wire: 0 purple, 1 red, 2 green, 3 blue. */
export type Colour = 0 | 1 | 2 | 3;
export const COLOUR_NAMES: readonly string[] = ['Purple', 'Red', 'Green', 'Blue'];

/** What one of the nine spaces holds, by ring size. `null` means empty. */
export type Cell = Record<PieceSize, Colour | null>;

export interface OpenOptions {
  /** Appended to the URL. `net=p2p` picks the WebRTC backend. */
  query?: string;
  /** Pin the accessible flat board open instead of revealing it on focus. */
  pinTextBoard?: boolean;
  /** Refuse every WebGL context, the way an old phone does. */
  noWebGL?: boolean;
  viewport?: { width: number; height: number };
  /** Runs against the fresh page before it navigates, for extra init scripts. */
  beforeLoad?: (page: Page) => Promise<void>;
}

export class OtrioApp {
  readonly consoleLog: string[] = [];
  readonly pageErrors: string[] = [];

  private constructor(
    readonly page: Page,
    readonly context: BrowserContext,
    readonly playerName: string,
  ) {}

  static async open(
    context: BrowserContext,
    playerName: string,
    options: OpenOptions = {},
  ): Promise<OtrioApp> {
    const page = await context.newPage();
    const app = new OtrioApp(page, context, playerName);

    page.on('console', (m) => app.consoleLog.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => app.pageErrors.push(`${e.name}: ${e.message}`));

    await muteHmr(page);
    if (options.noWebGL) await disableWebGL(page);
    await installThreeProbe(page);
    if (options.pinTextBoard) await seedPrefs(page, { showTextBoard: true });
    if (options.viewport) await page.setViewportSize(options.viewport);
    if (options.beforeLoad) await options.beforeLoad(page);

    await page.goto(options.query ? `/?${options.query}` : '/', { waitUntil: 'load' });
    await expect(page.getByRole('heading', { name: 'Otrio', level: 1 })).toBeVisible();

    const field = page.getByLabel('Your name');
    await field.fill(playerName);
    await field.blur();
    return app;
  }

  /* ---------------------------------------------------------------- home -- */

  /** Open a room and return its code. `players` is the seat count, 2-4. */
  async createRoom(players: 2 | 3 | 4): Promise<string> {
    await this.page.getByRole('button', { name: 'Start a new game' }).click();
    // The radios are `u-visually-hidden` inside their label, so a direct click
    // on the input lands on the label and Playwright rejects it as intercepted.
    // Clicking the label is also what a person does.
    await this.page.locator(`label.o-seg__option:has(input[value="${players}"])`).click();
    await this.page.getByRole('button', { name: 'Create room' }).click();
    await this.expectLobby();
    return this.roomCode();
  }

  async joinRoom(code: string): Promise<void> {
    await this.page.getByRole('button', { name: 'Join with a code' }).click();
    await this.page.getByLabel('Room code').fill(code);
    await this.page.getByRole('button', { name: 'Join room' }).click();
    await this.expectLobby();
  }

  /* --------------------------------------------------------------- lobby -- */

  async expectLobby(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Waiting room' })).toBeVisible();
  }

  /** The code as shown to the player, with the grouping spaces removed. */
  async roomCode(): Promise<string> {
    const shown = await this.page.locator('.o-code__value span[aria-hidden="true"]').innerText();
    return shown.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  }

  async markReady(): Promise<void> {
    await this.page.getByRole('button', { name: /I'm ready/ }).click();
    await expect(this.page.getByRole('button', { name: /tap to undo/ })).toBeVisible();
  }

  async startGame(): Promise<void> {
    await this.page.getByRole('button', { name: 'Start the game' }).click();
  }

  /** Names of everyone listed in the lobby, in seat order. */
  lobbySeats(): Locator {
    return this.page.locator('.o-seats .o-seat');
  }

  /* ---------------------------------------------------------------- game -- */

  async expectInGame(): Promise<void> {
    await expect(this.page.locator('.o-game')).toBeVisible();
    await expect(this.page.locator('.o-turn')).toBeVisible();
  }

  /** Wait for the 3D canvas to exist and for three.js to have drawn a frame. */
  async waitForBoard(): Promise<void> {
    await this.page.waitForSelector('.app-canvas canvas', { timeout: 60_000 });
    await expect
      .poll(
        async () =>
          this.page.evaluate(() => {
            interface R { info?: { render?: { calls?: number } } }
            const r = window.__otrioProbe?.renderers[0] as R | undefined;
            return r?.info?.render?.calls ?? 0;
          }),
        { timeout: 60_000, message: 'three.js never reported a draw call' },
      )
      .toBeGreaterThan(0);
  }

  async isMyTurn(): Promise<boolean> {
    return (await this.page.locator('.o-turn.is-mine').count()) > 0;
  }

  /** The colour due this turn, read off the turn banner. */
  async dueColour(): Promise<Colour | null> {
    const chip = this.page.locator('.o-turn__colourChip.is-due');
    if ((await chip.count()) === 0) return colourFromClass(await this.page.locator('.o-turn').getAttribute('class'));
    return colourFromClass(await chip.getAttribute('class'));
  }

  /** "Your turn" / "Ada's turn" / "Game over". */
  async turnLabel(): Promise<string> {
    return (await this.page.locator('.o-turn__label').first().innerText()).trim();
  }

  async waitForMyTurn(): Promise<void> {
    await expect(this.page.locator('.o-turn.is-mine')).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Arm a ring size through the size picker, exactly as a thumb would.
   *
   * Skips the click when the size is already armed. `autoArmSize()` re-arms the
   * largest ring held at the start of every turn, so most of the time it is,
   * and clicking an already-selected radio is a no-op for a person too. It is
   * not a no-op for the test: the button carries a selection transition, and
   * Playwright waits for an animating element to be stable before clicking,
   * which is long enough for the turn to move on underneath it.
   */
  async armSize(size: PieceSize): Promise<void> {
    const label = size[0].toUpperCase() + size.slice(1);
    const option = this.page.getByRole('radio', { name: new RegExp(`^${label},`) });
    if ((await option.getAttribute('aria-checked')) === 'true') return;
    await option.click();
    await expect(option).toHaveAttribute('aria-checked', 'true');
  }

  /**
   * Place a ring through the accessible board: the same `placePiece` action the
   * 3D canvas calls, reached through a real button.
   */
  async place(cell: number, size: PieceSize): Promise<void> {
    await this.waitForMyTurn();
    await this.armSize(size);
    const button = this.cell(cell);
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await button.click();
  }

  cell(index: number): Locator {
    return this.page.locator(`[data-cell="${index}"]`);
  }

  /** The whole board, read out of the flat board's own markup. */
  async board(): Promise<Cell[]> {
    return this.page.evaluate(() => {
      const sizes = ['small', 'medium', 'large'] as const;
      return Array.from({ length: 9 }, (_, i) => {
        const button = document.querySelector(`[data-cell="${i}"]`);
        const rings = button ? Array.from(button.querySelectorAll('.o-tcell__ring')) : [];
        const cell: Record<string, number | null> = {};
        sizes.forEach((size, slot) => {
          const ring = rings[slot];
          if (!ring || ring.getAttribute('data-empty') !== 'false') {
            cell[size] = null;
            return;
          }
          const m = /\bu-player-([1-4])\b/.exec(ring.className);
          cell[size] = m ? Number(m[1]) - 1 : null;
        });
        return cell;
      });
    }) as Promise<Cell[]>;
  }

  /** How many pieces are on the board. The ply counter, read from the DOM. */
  async pieceCount(): Promise<number> {
    const board = await this.board();
    return board.reduce(
      (n, cell) => n + PIECE_SIZES.filter((s) => cell[s] !== null).length,
      0,
    );
  }

  /** Rings left for the colour currently armed, by size, from the size picker. */
  async reserve(): Promise<Record<PieceSize, number>> {
    const out = {} as Record<PieceSize, number>;
    for (const size of PIECE_SIZES) {
      const label = size[0].toUpperCase() + size.slice(1);
      const name = await this.page
        .getByRole('radio', { name: new RegExp(`^${label},`) })
        .getAttribute('aria-label');
      const m = name ? /(\d+) left/.exec(name) : null;
      out[size] = m ? Number(m[1]) : -1;
    }
    return out;
  }

  /** The accessible name of a space — what a screen reader actually says. */
  async cellLabel(index: number): Promise<string> {
    return (await this.cell(index).getAttribute('aria-label')) ?? '';
  }

  /**
   * The player rail's accessible names, keyed by player name.
   *
   * `PlayerRail` composes the whole card into one sentence, and it is the only
   * place in the DOM that publishes per-colour reserves:
   *
   *   "Grace, red and blue. Blue due now. you. to move now.
   *    18 rings left: Red 3 small, 3 medium, 3 large; Blue 3 small, ..."
   *
   * Which makes it the natural place to check that a tray belongs to a colour
   * and not to a seat.
   */
  async railLabels(): Promise<Record<string, string>> {
    return this.page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const card of Array.from(document.querySelectorAll('.o-pcard'))) {
        const name = card.querySelector('.o-pcard__name')?.textContent?.trim();
        const label = card.getAttribute('aria-label');
        if (name && label) out[name] = label;
      }
      return out;
    });
  }

  /** Rings left for one player and one colour, out of the rail's own sentence. */
  async railReserve(player: string, colour: string): Promise<Record<PieceSize, number> | null> {
    const label = (await this.railLabels())[player];
    if (!label) return null;
    const m = new RegExp(
      `${colour} (\\d+) small, (\\d+) medium, (\\d+) large`,
      'i',
    ).exec(label);
    return m
      ? { small: Number(m[1]), medium: Number(m[2]), large: Number(m[3]) }
      : null;
  }

  /** Text of the live region, i.e. the last thing announced. */
  async announcements(): Promise<string> {
    return this.page.locator('[aria-live]').allInnerTexts().then((t) => t.join(' | '));
  }

  async openMenu(): Promise<void> {
    await this.page.getByRole('button', { name: 'Game menu' }).click();
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

/** `u-player-1` .. `u-player-4` carry the colour. Returns 0-3. */
export function colourFromClass(className: string | null): Colour | null {
  const m = className ? /\bu-player-([1-4])\b/.exec(className) : null;
  return m ? ((Number(m[1]) - 1) as Colour) : null;
}

/**
 * Take Vite's hot-reload socket out of the loop.
 *
 * Ten agents share this tree, and a source file saved by any of them makes the
 * dev server push a full page reload. Mid-test that wipes the room, the seat and
 * the board, and the failure reads as a multiplayer bug — it took one confusing
 * run to learn that. Intercepting the HMR socket and never forwarding it leaves
 * the module graph exactly as it was served: the page runs, it just stops being
 * told about edits.
 *
 * Only the dev-server socket is matched. The game's own WebSocket goes to port
 * 8787 and must not be touched, or there is no product left to test.
 */
async function muteHmr(page: Page): Promise<void> {
  await page.routeWebSocket(
    (url) => url.port === '5173' || url.pathname.startsWith('/@vite'),
    () => {
      /* Accept and swallow: no `connectToServer`, so nothing reaches the page. */
    },
  );
}

/**
 * Seed the persisted preferences before the bundle parses.
 *
 * Mirrors `PREFS_STORAGE_KEY` and the zustand persist envelope in
 * src/store/prefsStore.ts. It has no `version` option, so version 0 is what
 * the store writes and what it expects back.
 */
async function seedPrefs(page: Page, prefs: Record<string, unknown>): Promise<void> {
  await page.addInitScript((seed) => {
    try {
      localStorage.setItem('otrio.prefs.v1', JSON.stringify({ state: seed, version: 0 }));
    } catch {
      /* private mode: the test still runs, the board is just not pinned */
    }
  }, prefs);
}
