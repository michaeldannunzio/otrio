import { expect, test } from '@playwright/test';

import { COLOUR_NAMES, type Colour, type OtrioApp, type PieceSize } from '../support/app';
import { capture } from '../support/pixels';
import { openTable } from '../support/table';

/**
 * The official two-player game, end to end through the interface.
 *
 * This is the configuration where `Seat` and `PlayerColor` come apart: two
 * people, four colours, each person holding an opposite pair and obliged to
 * switch between them every turn (docs/RULES.md §4.6). Both are plain `number`
 * on the wire, so a seat used where a colour belongs type-checks perfectly and
 * returns the wrong player's ring tray — which is exactly the bug that survived
 * 165 unit tests and a clean `tsc`.
 *
 * The consequence that matters most is arithmetic: under strict alternation a
 * colour only comes round on every second turn of its own seat, so the fastest
 * same-size row takes **nine plies, not five**. Homer proved that against the
 * server. This proves it through the board a person actually touches.
 */

interface Ply {
  cell: number;
  size: PieceSize;
}

/*
 * Nine plies to a same-size row, scripted so that nothing wins early.
 *
 * A is whoever moves first and B is the other seat; A takes the odd plies. A's
 * first colour X therefore lands on plies 1, 5 and 9, which is the whole point:
 * three same-size rings of ONE colour cannot be placed faster than that.
 *
 * Every colour here is given exactly one ring size, which makes the other two
 * win conditions — an ascending small/medium/large line, and all three sizes
 * nested in one space — structurally unreachable, so a mis-scripted move cannot
 * end the game early by accident.
 *
 *   X (A's first)  large  @ 0, 1, 2   -> the top row, and the win on ply 9
 *   Y (A's second) small  @ 6, 8      -> two of three, never a line
 *   P (B's first)  large  @ 3, 4      -> two of three, never a line
 *   Q (B's second) small  @ 7, 5      -> not collinear
 */
const NINE_PLY_ROW: Ply[] = [
  { cell: 0, size: 'large' }, // 1  A/X
  { cell: 3, size: 'large' }, // 2  B/P
  { cell: 6, size: 'small' }, // 3  A/Y
  { cell: 7, size: 'small' }, // 4  B/Q
  { cell: 1, size: 'large' }, // 5  A/X
  { cell: 4, size: 'large' }, // 6  B/P
  { cell: 8, size: 'small' }, // 7  A/Y
  { cell: 5, size: 'small' }, // 8  B/Q
  { cell: 2, size: 'large' }, // 9  A/X  -> three large in the top row
];

/** Whichever of the two apps currently holds the turn. */
async function onTurn(apps: OtrioApp[]): Promise<OtrioApp> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    for (const app of apps) {
      if (await app.isMyTurn()) return app;
    }
    await apps[0].page.waitForTimeout(250);
  }
  throw new Error('no client claimed the turn within 15s');
}

test.describe('the official 2-player rule', () => {
  test('each seat holds two opposite colours and must alternate', async ({ browser }) => {
    const table = await openTable(browser, ['Ada', 'Grace'], { pinTextBoard: true });
    try {
      const [ada, grace] = table.apps;
      await ada.waitForBoard();

      // Two colour chips on the banner — the colour due and the colour next —
      // is the visible signature of a seat that alternates. A three- or
      // four-player seat renders none.
      await expect(ada.page.locator('.o-turn__colourChip.is-due')).toHaveCount(1);
      await expect(ada.page.locator('.o-turn__colourChip.is-next')).toHaveCount(1);

      // Both people hold two colours, and between them they hold all four.
      const labels = await ada.railLabels();
      const held = new Set<string>();
      for (const [name, label] of Object.entries(labels)) {
        const mine = COLOUR_NAMES.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(label));
        expect(mine, `${name} should hold exactly two colours`).toHaveLength(2);
        for (const c of mine) held.add(c);
      }
      expect([...held].sort()).toEqual([...COLOUR_NAMES].sort());

      /*
       * With strict alternation on — the default — the referee leaves no choice
       * of colour, so `SizePicker` must not offer one. A colour picker here
       * would mean `turnColors` came back with more than one entry, i.e. the
       * variant is silently off.
       */
      await expect(ada.page.locator('[role="radiogroup"][aria-label*="olour"]')).toHaveCount(0);
      await expect(grace.page.locator('[role="radiogroup"][aria-label*="olour"]')).toHaveCount(0);
    } finally {
      await table.close();
    }
  });

  test('a same-size row takes nine plies, not five', async ({ browser }) => {
    const table = await openTable(browser, ['Ada', 'Grace'], { pinTextBoard: true });
    try {
      const apps = table.apps;
      await apps[0].waitForBoard();

      const first = await onTurn(apps);
      const second = apps.find((a) => a !== first);
      if (!second) throw new Error('expected two clients');

      const played: Array<{ player: string; colour: Colour | null; ply: Ply }> = [];

      for (let i = 0; i < NINE_PLY_ROW.length; i += 1) {
        const mover = await onTurn(apps);
        const expected = i % 2 === 0 ? first : second;
        expect(mover.playerName, `ply ${i + 1} should belong to ${expected.playerName}`).toBe(
          expected.playerName,
        );

        const colour = await mover.dueColour();
        const ply = NINE_PLY_ROW[i];

        /*
         * The reserve read on this turn belongs to the COLOUR due, not to the
         * seat. Indexing by seat compiles and quietly returns the partner
         * colour's tray; on ply 3 that shows two large rings left instead of
         * three, which is the exact shape of the bug this game hides best.
         */
        const tray = await mover.railReserve(mover.playerName, COLOUR_NAMES[colour ?? 0]);
        const placedBefore = played.filter((p) => p.colour === colour).length;
        expect(tray, `no reserve published for ${mover.playerName}`).not.toBeNull();
        if (tray) {
          const used = played.filter((p) => p.colour === colour && p.ply.size === ply.size).length;
          expect(
            tray[ply.size],
            `ply ${i + 1}: ${COLOUR_NAMES[colour ?? 0]} should have ${3 - used} ${ply.size} left`,
          ).toBe(3 - used);
          expect(placedBefore).toBeLessThanOrEqual(3);
        }

        await mover.place(ply.cell, ply.size);
        played.push({ player: mover.playerName, colour, ply });

        if (i < NINE_PLY_ROW.length - 1) {
          await expect
            .poll(() => mover.pieceCount(), { message: `ply ${i + 1} never landed` })
            .toBe(i + 1);
        }
      }

      /* ---- alternation, as actually observed, not as assumed ---- */

      const firstColours = played.filter((p) => p.player === first.playerName).map((p) => p.colour);
      const secondColours = played
        .filter((p) => p.player === second.playerName)
        .map((p) => p.colour);

      expect(firstColours).toHaveLength(5);
      expect(secondColours).toHaveLength(4);

      // X Y X Y X, and P Q P Q: every seat switched colour on every one of its
      // turns, and never played the same colour twice running.
      expect(firstColours[0]).not.toBe(firstColours[1]);
      expect(firstColours).toEqual([
        firstColours[0],
        firstColours[1],
        firstColours[0],
        firstColours[1],
        firstColours[0],
      ]);
      expect(secondColours[0]).not.toBe(secondColours[1]);
      expect(secondColours).toEqual([
        secondColours[0],
        secondColours[1],
        secondColours[0],
        secondColours[1],
      ]);

      // The two seats' colour pairs are disjoint and cover all four.
      const pairA = new Set(firstColours);
      const pairB = new Set(secondColours);
      expect([...pairA].sort()).toHaveLength(2);
      expect([...pairB].sort()).toHaveLength(2);
      expect([...pairA].filter((c) => pairB.has(c))).toEqual([]);

      /* ---- the win, on the ninth ply and not before ---- */

      await expect(first.page.locator('.o-result')).toBeVisible({ timeout: 20_000 });
      expect(await first.pieceCount()).toBe(9);

      const shot = await capture(first.page, '04-two-player-win');
      test.info().annotations.push({ type: 'screenshot', description: shot });

      /*
       * The result says *which colour* won, and says so unprompted. That is the
       * two-player rule stated where it is least deniable: a line is always
       * within one colour, and the winner holds two.
       */
      const won = await first.page.locator('.o-result').innerText();
      expect(won).toMatch(/you win/i);
      expect(won).toMatch(/three large (purple|red|green|blue) rings in a line/i);
      expect(won).toMatch(/colours never combine/i);

      const lost = await second.page.locator('.o-result').innerText();
      expect(lost, "the loser's overlay should name the winner").toContain(first.playerName);
      test.info().annotations.push({
        type: 'plies',
        description: played
          .map((p, i) => `${i + 1}. ${p.player}/${COLOUR_NAMES[p.colour ?? 0]} ${p.ply.size}@${p.ply.cell}`)
          .join('  '),
      });

      // Both clients agree on the finished position — this is the referee's
      // state arriving over the wire, not two local simulations coinciding.
      expect(await second.pieceCount()).toBe(9);
      await expect(second.page.locator('.o-result')).toBeVisible();
    } finally {
      await table.close();
    }
  });

  test('a three-player seat holds one colour: seat 1 is red, not red and blue', async ({
    browser,
  }) => {
    const table = await openTable(browser, ['Ada', 'Grace', 'Alan'], { pinTextBoard: true });
    try {
      const [ada, grace] = table.apps;
      await ada.waitForBoard();

      // No alternation, so no due/next chips at all.
      await expect(ada.page.locator('.o-turn__colourChip')).toHaveCount(0);

      const labels = await ada.railLabels();
      for (const [name, label] of Object.entries(labels)) {
        const mine = COLOUR_NAMES.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(label));
        expect(mine, `${name} should hold exactly one colour`).toHaveLength(1);
      }

      // Seats are dealt in join order, and colours follow seats when they do not
      // diverge: Ada 0 purple, Grace 1 red, Alan 2 green.
      expect(labels['Ada']).toMatch(/purple/i);
      expect(labels['Grace']).toMatch(/\bred\b/i);
      expect(labels['Grace']).not.toMatch(/\bblue\b/i);
      expect(labels['Alan']).toMatch(/green/i);
      expect(await grace.railReserve('Grace', 'Red')).toEqual({
        small: 3,
        medium: 3,
        large: 3,
      });
    } finally {
      await table.close();
    }
  });
});
