import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { COLORS } from './tokens';

/**
 * The app icon is drawn from this palette, and nothing mechanical keeps it
 * that way.
 *
 * `public/favicon.svg` is the source for every icon the app ships — the PWA
 * manifest's 192/512/maskable PNGs, the 180px `apple-touch-icon`, and the
 * browser-tab favicon itself. An SVG cannot import a TypeScript module, so the
 * mark restates five values from `tokens.ts` as literals: the ground plus the
 * four player identity fills. The regeneration commands in the README rebuild
 * the PNGs *from* the SVG, which propagates whatever it already says rather
 * than checking it.
 *
 * That makes the icon a fifth definition of the player colours. This project
 * has already paid for that once — they were defined four times in four
 * disagreeing palettes, and the 3D board and the 2D UI rendered different
 * colours for the same player.
 *
 * The drift is silent in both directions and the icon is the worst place for
 * it. A retint of `tokens.ts` would do it, with no reason for whoever retints
 * to think about artwork, and the result is a launcher icon whose wedges no
 * longer match the board it launches: an identity failure in the one asset
 * whose entire job is identity.
 *
 * Hence an assertion rather than a comment in a doc. Fixing a failure here is
 * one command — re-export the icon, see README "The icon" — not an
 * investigation.
 */

/** Resolved from this module, not the cwd, so the runner's root cannot matter. */
const SVG_PATH = fileURLToPath(new URL('../../public/favicon.svg', import.meta.url));

/** Every `fill="#rrggbb"` in the mark, lowercased, in document order. */
function iconFills(): string[] {
  const svg = readFileSync(SVG_PATH, 'utf8');
  return [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase());
}

function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

const lower = (hex: string): string => hex.toLowerCase();

/**
 * The mark's geometry, as counts.
 *
 * Three nested pieces — large annulus, medium annulus, small solid peg — each
 * quartered by seat. So every player colour appears exactly three times, once
 * per piece, and the ground appears once as the backing rect.
 *
 * Asserting the counts and not just the set is what makes a dropped or
 * duplicated quadrant fail. A wrong colour is the obvious defect; a missing
 * wedge is the one that would otherwise pass.
 */
const USES_PER_PLAYER = 3;
const USES_OF_GROUND = 1;

describe('app icon palette', () => {
  /*
   * Checked first because it is what makes "which theme?" a non-question for
   * the four fills. An icon sits on a home screen, outside any theme, so it
   * can only be drawn from values that do not move between themes.
   *
   * It is also the only thing that identifies the right FIELD, which matters
   * because `playerN` and `playerNUi` collide on hex more often than not
   * (computed from tokens.ts, 2026-09-24):
   *
   *            light base   light Ui    dark base   dark Ui    collides
   *   purple   #7237b8      #7237b8     #7237b8     #b877ff    in light
   *   red      #e8501e      #c63100     #e8501e     #ff6430    never
   *   green    #a2d733      #517400     #a2d733     #a2d733    in dark
   *   blue     #1cafd2      #00738c     #1cafd2     #1cafd2    in dark
   *
   * Three of the four collide, and WHICH ones depends on the theme you happen
   * to look at — so checking one theme yields a different wrong answer about
   * which colours are safe to identify by hex, and there is always one colour
   * that appears to confirm whatever rule you just formed. Matching a hex does
   * not identify a field here.
   *
   * What does: `playerN` is theme-independent for 4 of 4, `playerNUi` for 0 of
   * 4. That separates the two sets completely and for every colour, so the
   * assertion below is a decision procedure rather than a spot check that
   * happens to hold.
   *
   * Deliberately NOT asserted: that no `playerNUi` is theme-independent. It is
   * true today and it is what makes the separation total, but it is a fact
   * about the palette rather than about the icon, and pinning it here would
   * fail the icon's guard for a theming change that does the icon no harm.
   * The palette's owner should be free to make a `Ui` value theme-independent
   * without this test having an opinion.
   */
  it('draws from the identity fills, which are theme-independent', () => {
    expect(COLORS.light.player1).toBe(COLORS.dark.player1);
    expect(COLORS.light.player2).toBe(COLORS.dark.player2);
    expect(COLORS.light.player3).toBe(COLORS.dark.player3);
    expect(COLORS.light.player4).toBe(COLORS.dark.player4);
  });

  it('uses exactly the five colours it is supposed to, and no others', () => {
    const expected = new Set(
      [
        COLORS.dark.bg,
        COLORS.light.player1,
        COLORS.light.player2,
        COLORS.light.player3,
        COLORS.light.player4,
      ].map(lower),
    );

    expect(new Set(iconFills())).toStrictEqual(expected);
  });

  it('uses each colour the number of times the geometry implies', () => {
    const counts = tally(iconFills());

    // The ground is `COLORS.dark.bg`, not `light.bg`: the manifest's
    // `background_color` imports that same token so the splash screen is
    // seamless with the icon drawn on top of it. See vite.config.ts.
    expect(counts.get(lower(COLORS.dark.bg))).toBe(USES_OF_GROUND);

    // North purple, east red, south green, west blue — the seating in
    // `PLAYERS`, and the rulebook artwork it comes from.
    expect(counts.get(lower(COLORS.light.player1))).toBe(USES_PER_PLAYER);
    expect(counts.get(lower(COLORS.light.player2))).toBe(USES_PER_PLAYER);
    expect(counts.get(lower(COLORS.light.player3))).toBe(USES_PER_PLAYER);
    expect(counts.get(lower(COLORS.light.player4))).toBe(USES_PER_PLAYER);

    expect(iconFills()).toHaveLength(USES_OF_GROUND + 4 * USES_PER_PLAYER);
  });
});
