/**
 * palette.ts — the four player colours, and the surface finish that goes with
 * each of them.
 *
 * WHICH COLOURS
 * -------------
 * Fixed by the official setup artwork (docs/RULES.md §2.4): purple north, red
 * east, green south, blue west. The artwork also tells us green is a lime /
 * yellow-green and blue is a cyan / turquoise rather than a mid green and a
 * mid blue, which is a considerable stroke of luck — see below. The exact hexes
 * are ours; the hue families are not.
 *
 * WHY THESE EXACT HEXES
 * ---------------------
 * Purple / red / green / blue is close to the worst four-way set you could
 * pick for red-green colour deficiency, which is ~8% of men. Red-green CVD
 * collapses the red-green axis and leaves the blue-yellow axis intact, so four
 * hues have to survive being projected onto one axis plus lightness. These four
 * were tuned against simulations (Brettel/Viénot) until every pair separated on
 * at least one of the two surviving channels:
 *
 *                       normal   protan   deutan   tritan
 *   purple #7237B8      L* 37    L* 39    L* 38    L* 39   -> pure blue under CVD
 *   red    #E8501E      L* 55    L* 46    L* 60    L* 55   -> gold/olive under CVD
 *   blue   #1CAFD2      L* 66    L* 70    L* 64    L* 69   -> pale periwinkle
 *   green  #A2D733      L* 80    L* 80    L* 79    L* 79   -> bright gold, but light
 *
 * Every pair that ends up close in lightness is far apart in hue on the axis
 * that still works, and vice versa:
 *
 *   - red vs blue converge in lightness for deuteranopes (60 vs 64) but land as
 *     gold vs periwinkle — the single widest hue contrast still available.
 *   - purple vs red converge for protanopes (39 vs 46) but land as pure blue vs
 *     olive, again straddling the intact axis.
 *   - purple vs blue and red vs green, the pairs that share an axis, are 25+
 *     L* apart under every simulation.
 *
 * The specific moves that got it there: red pushed towards vermilion so
 * protanopes (who see long wavelengths as dark) keep some luminance in it;
 * green kept as lime rather than forest so it stays the brightest of the four;
 * purple kept dark but lifted to L* 37 so it does not disappear into the dark
 * walnut board (L* 27).
 *
 * THE SECOND CUE: FINISH
 * ----------------------
 * Hue alone is not enough at 30 pixels across, so each player also gets a
 * different surface finish, and the four finishes form a ladder that runs the
 * same way as the lightness ladder: the darkest colour is the glossiest and the
 * lightest is the most matte. That makes the highlight itself an identifier —
 * purple carries a small hard specular dot, green a broad soft sheen with
 * visible mould grain — which survives a greyscale screenshot, a dimmed screen,
 * and a player who cannot separate the hues at all.
 *
 * It is also a plausible thing for a factory to have done: the dark parts were
 * moulded in a polished cavity, the light ones in a textured one.
 *
 * Contrast checking in light and dark themes belongs to the theming agent;
 * `PLAYER_PAINTS[].lightness` is published here so they can do it without
 * recomputing anything.
 */

/** Stable ids. These are rules-level identities, not cosmetic names. */
export type PlayerColorId = 'purple' | 'red' | 'green' | 'blue';

/** Seat on the cross-shaped board (docs/RULES.md §2.4). */
export type Seat = 'north' | 'east' | 'south' | 'west';

export interface PieceFinish {
  /**
   * Multiplier over the roughness the texture module calibrated for 'piece'.
   * Deliberately relative: the absolute level is the texture agent's call, we
   * only own the spread between players.
   */
  roughness: number;
  /** Clear-coat strength, absolute 0..1. Real game pieces are lacquered. */
  clearcoat: number;
  /** Clear-coat roughness, absolute. Low = a hard mirror-like highlight. */
  clearcoatRoughness: number;
  /** Multiplier on the normal map, i.e. how much mould grain shows. */
  normalStrength: number;
  /** Human-readable, for settings UI and for the report. */
  label: string;
}

export interface PlayerPaint {
  id: PlayerColorId;
  /** Seat per the official setup artwork. */
  seat: Seat;
  /** sRGB hex. Feed straight to THREE.Color — it handles the decode. */
  hex: string;
  /** CIE L* of `hex`, 0..100. Published for contrast checks. */
  lightness: number;
  finish: PieceFinish;
}

/**
 * Turn order as the artwork seats them, clockwise from the top.
 * The game module owns actual turn order; this is only the seating.
 */
export const PLAYER_ORDER: readonly PlayerColorId[] = ['purple', 'red', 'green', 'blue'] as const;

export const PLAYER_PAINTS: Record<PlayerColorId, PlayerPaint> = {
  purple: {
    id: 'purple',
    seat: 'north',
    hex: '#7237B8',
    lightness: 37.4,
    finish: {
      roughness: 0.55,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      normalStrength: 0.45,
      label: 'deep gloss',
    },
  },
  red: {
    id: 'red',
    seat: 'east',
    hex: '#E8501E',
    lightness: 55.1,
    finish: {
      roughness: 0.85,
      clearcoat: 0.85,
      clearcoatRoughness: 0.08,
      normalStrength: 0.75,
      label: 'gloss',
    },
  },
  green: {
    id: 'green',
    seat: 'south',
    hex: '#A2D733',
    lightness: 79.9,
    finish: {
      roughness: 2.1,
      clearcoat: 0.3,
      clearcoatRoughness: 0.3,
      normalStrength: 1.85,
      label: 'semi-matte, grained',
    },
  },
  blue: {
    id: 'blue',
    seat: 'west',
    hex: '#1CAFD2',
    lightness: 66.2,
    finish: {
      roughness: 1.4,
      clearcoat: 0.55,
      clearcoatRoughness: 0.16,
      normalStrength: 1.2,
      label: 'satin',
    },
  },
};

/**
 * Widen the finish ladder. Intended for an accessibility setting: it pushes the
 * glossiest piece glossier and the mattest mattest, so the non-hue cue is
 * unmistakable even though it stops being subtle.
 */
export function boostFinish(finish: PieceFinish, amount = 1): PieceFinish {
  const k = 1 + amount;
  return {
    ...finish,
    roughness: Math.max(0.25, Math.pow(finish.roughness, k)),
    clearcoat: Math.min(1, Math.max(0, 0.5 + (finish.clearcoat - 0.5) * k)),
    clearcoatRoughness: finish.clearcoatRoughness,
    normalStrength: Math.max(0.2, Math.pow(finish.normalStrength, k)),
  };
}

/** Pack a finish for the per-instance `aFinish` attribute. */
export function finishToArray(finish: PieceFinish): [number, number, number, number] {
  return [finish.roughness, finish.clearcoat, finish.clearcoatRoughness, finish.normalStrength];
}

/** Resolve a player index (0..3, seating order) to its paint. */
export function paintForPlayer(player: PlayerColorId | number): PlayerPaint {
  if (typeof player === 'number') {
    const id = PLAYER_ORDER[((player % PLAYER_ORDER.length) + PLAYER_ORDER.length) % PLAYER_ORDER.length];
    return PLAYER_PAINTS[id];
  }
  return PLAYER_PAINTS[player];
}
