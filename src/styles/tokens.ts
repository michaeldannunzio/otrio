/**
 * Otrio design tokens — canonical values.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SINGLE SOURCE OF TRUTH                                                    │
 * │ Every colour here is mirrored verbatim in `./tokens.css`. The DOM reads    │
 * │ the CSS custom properties; three.js (which cannot read CSS variables)      │
 * │ reads these constants. They must stay identical.                          │
 * │                                                                           │
 * │ Drift is caught automatically: in dev, `verifyThemeSync()` (theme.ts)      │
 * │ diffs every constant below against the live computed value of its CSS      │
 * │ custom property and logs a loud console error naming the token. It is      │
 * │ called from `useTheme`'s initialiser, so you find out on first paint.      │
 * │                                                                           │
 * │ If you change a colour, change it in BOTH files.                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHERE THE PLAYER COLOURS COME FROM                                        │
 * │ The four `base` hexes are NOT ours to choose. They are fixed by the        │
 * │ official setup artwork (docs/RULES.md §2.4) — purple north, red east,      │
 * │ green south, blue west — and are owned by                                  │
 * │ `src/scene/materials/palette.ts` (`PLAYER_PAINTS[].hex`). Index order      │
 * │ matches `PLAYER_COLOR_NAMES` in `src/game/types.ts`.                       │
 * │                                                                           │
 * │ Everything else in a player's set (`ui`, `rim`, `soft`, `onSoft`, `on`)    │
 * │ IS ours: derived from those four hues at whatever lightness clears the     │
 * │ contrast requirement. If a base hex changes there, re-derive here.         │
 * │                                                                           │
 * │ NOTE: `SEAT_COLORS` in `src/net/protocol.ts` is a third, stale palette.    │
 * │ Do not derive anything from it — colour is becoming a first-class          │
 * │ `PlayerColor` on the wire rather than a function of seat.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The neutrals, accent and status colours, and every derived player role, were
 * generated and verified against:
 *   - WCAG 2.1 AA (4.5:1 body text, 3:1 non-text / UI boundaries) on every
 *     surface in both themes, not just the most flattering one.
 *   - CIEDE2000 separation between the four player colours after simulating
 *     protanopia, deuteranopia, tritanopia (Machado 2009) and achromatopsia.
 * Measured worst cases are recorded in `./README.md`.
 */

/* ───────────────────────────── colour ─────────────────────────────────── */

/**
 * Semantic colour tokens. Keys map 1:1 onto CSS custom properties by
 * kebab-casing: `textPrimary` -> `--text-primary`, `player1Rim` -> `--player-1-rim`.
 */
export interface ColorTokens {
  /** Page backdrop behind the canvas and all panels. */
  bg: string
  /** Raised panel. The most common panel colour. */
  surface1: string
  /** Recessed / secondary panel (list rows, wells). */
  surface2: string
  /** The *lowest-contrast* surface. Foreground tokens are guaranteed against
   *  this one, so anything here is safe on surface1 and surface2 too. */
  surface3: string
  /** Hairline dividers. Decorative — no contrast guarantee. */
  borderSubtle: string
  /** Borders of interactive controls. Guaranteed >= 3:1 on every surface. */
  borderStrong: string

  textPrimary: string
  textSecondary: string
  /** Lowest-emphasis text that still clears 4.5:1 on every surface. */
  textMuted: string
  /** Text on a `textPrimary`-coloured fill. */
  textInverse: string

  accent: string
  accentHover: string
  accentActive: string
  /** Text/icon colour on an `accent` fill. */
  accentContrast: string
  /** Tinted accent background for chips and selected rows. */
  accentSoft: string

  success: string
  successOn: string
  successSoft: string
  successOnSoft: string
  warning: string
  warningOn: string
  warningSoft: string
  warningOnSoft: string
  danger: string
  dangerOn: string
  dangerSoft: string
  dangerOnSoft: string
  info: string
  infoOn: string
  infoSoft: string
  infoOnSoft: string

  /* Player 1 — purple (north). See PLAYER_ROLES for what each suffix means. */
  player1: string
  player1Ui: string
  player1Rim: string
  player1Soft: string
  player1OnSoft: string
  player1On: string
  /* Player 2 — red (east). */
  player2: string
  player2Ui: string
  player2Rim: string
  player2Soft: string
  player2OnSoft: string
  player2On: string
  /* Player 3 — green (south). */
  player3: string
  player3Ui: string
  player3Rim: string
  player3Soft: string
  player3OnSoft: string
  player3On: string
  /* Player 4 — blue (west). */
  player4: string
  player4Ui: string
  player4Rim: string
  player4Soft: string
  player4OnSoft: string
  player4On: string

  /** three.js scene clear colour (the void around the board). */
  sceneBg: string
  /** The board slab's material colour. */
  boardBase: string
  /** Engraved grid lines on the board. */
  boardLine: string
}

/**
 * What each player colour role is for. Using the wrong one is the usual way a
 * palette quietly fails accessibility, so they are named by job, not by shade.
 *
 * - `base`    The 3D piece material colour, and the fill of a colour swatch.
 *             This is the player's identity; never substitute another role.
 * - `ui`      Text, icons and thin strokes in the HUD that must clear 4.5:1.
 *             The official piece colours were chosen to look right under stage
 *             lighting on a board, not to be legible as 12px text on a panel,
 *             so several of these are a long way from `base`: light-mode green
 *             is an olive (#517400 from a lime #a2d733) and dark-mode purple is
 *             a lilac (#b877ff from #7237b8). That is the role doing its job.
 *             Pair a `base` swatch with `ui` text — the swatch carries the
 *             identity, the text carries the legibility.
 * - `rim`     The piece's outline / edge colour in the 3D scene. Guaranteed
 *             >= 3:1 against the board. THIS IS NOT DECORATIVE: a piece's fill
 *             alone does not clear 3:1 against the board for every player (the
 *             green piece on the light board is 1.53:1, and purple on the dark
 *             walnut is 1.53:1), so the rim is what makes the silhouette
 *             perceivable. Pieces must render with it.
 * - `soft`    Tinted background for a chip / the active player's row.
 * - `onSoft`  Text on a `soft` background.
 * - `on`      Text on a `base` fill.
 */
export const PLAYER_ROLES = ['base', 'ui', 'rim', 'soft', 'onSoft', 'on'] as const
export type PlayerRole = (typeof PLAYER_ROLES)[number]

export const COLORS: Readonly<Record<ThemeMode, Readonly<ColorTokens>>> = {
  light: {
    bg: '#e8ecf3',
    surface1: '#ffffff',
    surface2: '#f4f7fb',
    surface3: '#e4eaf2',
    borderSubtle: '#dce2ec',
    borderStrong: '#808696',
    textPrimary: '#0f141b',
    textSecondary: '#465264',
    textMuted: '#5a6575',
    textInverse: '#ffffff',
    accent: '#c81b70',
    accentHover: '#aa005c',
    accentActive: '#90004d',
    accentContrast: '#ffffff',
    accentSoft: '#ffecf1',
    success: '#007a2f',
    successOn: '#ffffff',
    successSoft: '#def3df',
    successOnSoft: '#007d30',
    warning: '#915f00',
    warningOn: '#ffffff',
    warningSoft: '#feebd6',
    warningOnSoft: '#956100',
    danger: '#d1142d',
    dangerOn: '#ffffff',
    dangerSoft: '#ffe9e6',
    dangerOnSoft: '#d4192f',
    info: '#006db2',
    infoOn: '#ffffff',
    infoSoft: '#e5eeff',
    infoOnSoft: '#0070b6',
    player1: '#7237b8',
    player1Ui: '#7237b8',
    player1Rim: '#602f99',
    player1Soft: '#f5e9ff',
    player1OnSoft: '#884bce',
    player1On: '#ffffff',
    player2: '#e8501e',
    player2Ui: '#c63100',
    player2Rim: '#c94b21',
    player2Soft: '#ffe9e2',
    player2OnSoft: '#c93401',
    player2On: '#130400',
    player3: '#a2d733',
    player3Ui: '#517400',
    player3Rim: '#6e9a0c',
    player3Soft: '#eaf1d4',
    player3OnSoft: '#537700',
    player3On: '#060900',
    player4: '#1cafd2',
    player4Ui: '#00738c',
    player4Rim: '#2c98b5',
    player4Soft: '#d3f3ff',
    player4OnSoft: '#00768f',
    player4On: '#00090d',
    sceneBg: '#cbd3e0',
    boardBase: '#f0f3f8',
    boardLine: '#96a5ba',
  },
  dark: {
    bg: '#0b0e13',
    surface1: '#161b24',
    surface2: '#1d2430',
    surface3: '#27303e',
    borderSubtle: '#2b3544',
    borderStrong: '#717887',
    textPrimary: '#edf1f8',
    textSecondary: '#a9b4c4',
    textMuted: '#939eae',
    textInverse: '#0b0e13',
    accent: '#fe599d',
    accentHover: '#ff85b1',
    accentActive: '#ffa0c0',
    accentContrast: '#1b0009',
    accentSoft: '#53323d',
    success: '#43aa59',
    successOn: '#000b00',
    successSoft: '#2a412c',
    successOnSoft: '#71d681',
    warning: '#ce8800',
    warningOn: '#0e0600',
    warningSoft: '#4a3823',
    warningOnSoft: '#ffb238',
    danger: '#ff615d',
    dangerOn: '#170200',
    dangerSoft: '#54322f',
    dangerOnSoft: '#ffaba3',
    info: '#179cf8',
    infoOn: '#000816',
    infoSoft: '#293d55',
    infoOnSoft: '#97c4ff',
    player1: '#7237b8',
    player1Ui: '#b877ff',
    player1Rim: '#a46dde',
    player1Soft: '#473754',
    player1OnSoft: '#d9b0ff',
    player1On: '#ffffff',
    player2: '#e8501e',
    player2Ui: '#ff6430',
    player2Rim: '#ef6b3e',
    player2Soft: '#583529',
    player2OnSoft: '#ffad90',
    player2On: '#130400',
    player3: '#a2d733',
    player3Ui: '#a2d733',
    player3Rim: '#bbe660',
    player3Soft: '#384122',
    player3OnSoft: '#9dd22d',
    player3On: '#060900',
    player4: '#1cafd2',
    player4Ui: '#1cafd2',
    player4Rim: '#5bbddb',
    player4Soft: '#004454',
    player4OnSoft: '#52d0f4',
    player4On: '#00090d',
    sceneBg: '#090c11',
    boardBase: '#232b38',
    boardLine: '#4e5c72',
  },
} as const

export type ThemeMode = 'light' | 'dark'
export type ThemePreference = ThemeMode | 'system'

/* ───────────────────────── player identity ────────────────────────────── */

export type PlayerIndex = 0 | 1 | 2 | 3

export interface PlayerIdentity {
  index: PlayerIndex
  /**
   * Stable machine key. Matches `PLAYER_COLOR_NAMES` in `src/game/types.ts`
   * and `PlayerColorId` in `src/scene/materials/palette.ts` — one vocabulary
   * across the engine, the scene and the interface.
   */
  key: 'purple' | 'red' | 'green' | 'blue'
  /** Default display name. Overridden by a user-entered name. */
  label: string
  /** Seat on the cross-shaped board, per the official setup artwork (§2.4). */
  seat: 'north' | 'east' | 'south' | 'west'
  /**
   * A NON-COLOUR channel for player identity. Colour separation is strong
   * (see README) but never perfect — total colour blindness, a sun-washed
   * phone screen, or a cheap projector all flatten hue. Render this glyph on
   * the piece's top face and beside the player's name in the HUD so identity
   * survives without colour. Cheap to add, and the only way the design is
   * genuinely robust rather than statistically robust.
   *
   * The scene carries a second non-colour channel of its own: each player has
   * a distinct surface finish (`PLAYER_PAINTS[].finish`), a gloss-to-matte
   * ladder running the same direction as the lightness ladder. That matters
   * most for greyscale, where the four bases sit only ~10 ΔE apart.
   *
   * GLYPH ASSIGNMENT IS FROZEN BY INDEX — the UI already consumes it. The
   * colour names changed to match the rulebook; these did not.
   */
  glyph: '●' | '▲' | '■' | '◆'
  /** Accessible name for the glyph, for aria-labels and screen readers. */
  glyphLabel: 'circle' | 'triangle' | 'square' | 'diamond'
  /** CIELAB hue angle, for anyone generating further shades on-palette. */
  hue: number
}

export const PLAYERS: readonly PlayerIdentity[] = [
  { index: 0, key: 'purple', label: 'Purple', seat: 'north', glyph: '●', glyphLabel: 'circle', hue: 311 },
  { index: 1, key: 'red', label: 'Red', seat: 'east', glyph: '▲', glyphLabel: 'triangle', hue: 45 },
  { index: 2, key: 'green', label: 'Green', seat: 'south', glyph: '■', glyphLabel: 'square', hue: 120 },
  { index: 3, key: 'blue', label: 'Blue', seat: 'west', glyph: '◆', glyphLabel: 'diamond', hue: 230 },
] as const

/**
 * `playerColor(colors, 0, 'rim')` -> the purple player's rim colour.
 *
 * `index` is 0-based, matching `PlayerColor` in the engine: 0 purple, 1 red,
 * 2 green, 3 blue.
 */
export function playerColor(colors: ColorTokens, index: PlayerIndex, role: PlayerRole = 'base'): string {
  const n = (index + 1) as 1 | 2 | 3 | 4
  const key = role === 'base' ? `player${n}` : `player${n}${role[0].toUpperCase()}${role.slice(1)}`
  return colors[key as keyof ColorTokens]
}

/**
 * The CSS custom property name for a player role, e.g. `--player-1-rim`.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ MIND THE OFF-BY-ONE. `PlayerIndex` is 0-based, matching `PlayerColor` in   │
 * │ the engine. The CSS variables are 1-BASED, because `--player-0` reads      │
 * │ wrong in a stylesheet. So:                                                │
 * │                                                                           │
 * │     playerVar(0, 'rim')  ===  '--player-1-rim'   // both mean PURPLE      │
 * │     playerVar(2)         ===  '--player-3'       // both mean GREEN       │
 * │                                                                           │
 * │ Call this function instead of interpolating the number yourself. A slip    │
 * │ here is silent — you get another player's colour and nothing throws.       │
 * │ Same applies to the `u-player-N` utility classes, which are also 1-based.  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function playerVar(index: PlayerIndex, role: PlayerRole = 'base'): string {
  const n = index + 1
  return role === 'base'
    ? `--player-${n}`
    : `--player-${n}-${role.replace(/([A-Z])/g, (m) => '-' + m.toLowerCase())}`
}

/* ──────────────────────────── breakpoints ─────────────────────────────── */

/**
 * Min-width breakpoints, in px. These are the *only* widths the app branches
 * on; see README for what changes at each. `xs` is the base (no media query) —
 * the design starts at a 360px phone and adds, it never subtracts.
 */
export const BREAKPOINTS = {
  xs: 0,
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1440,
  xxl: 1920,
} as const

export type BreakpointName = keyof typeof BREAKPOINTS
export const BREAKPOINT_ORDER: readonly BreakpointName[] = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl']

/**
 * Non-width conditions that change layout. Phone-in-landscape is the one most
 * often missed: it is a *short* viewport, not a wide one, and a HUD laid out
 * for portrait will eat the whole screen.
 */
export const MEDIA = {
  /** Phone held sideways: wide but < 500px tall. Vertical space is precious. */
  compactHeight: '(max-height: 500px)',
  landscape: '(orientation: landscape)',
  portrait: '(orientation: portrait)',
  /** Phone landscape specifically. */
  phoneLandscape: '(orientation: landscape) and (max-height: 500px)',
  /** Finger input: hit targets grow, hover affordances are not relied on. */
  touch: '(pointer: coarse)',
  hover: '(hover: hover) and (pointer: fine)',
  /** 21:9 and wider. Cap the shell so controls stay in one field of view. */
  ultrawide: '(min-aspect-ratio: 2/1)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
  reducedTransparency: '(prefers-reduced-transparency: reduce)',
  highContrast: '(prefers-contrast: more)',
  dark: '(prefers-color-scheme: dark)',
} as const

/** `mq('md')` -> `'(min-width: 768px)'`. For matchMedia and CSS-in-JS. */
export function mq(bp: BreakpointName): string {
  return BREAKPOINTS[bp] === 0 ? 'all' : `(min-width: ${BREAKPOINTS[bp]}px)`
}

/** Information density, derived from breakpoint. Drives what the HUD shows. */
export type Density = 'compact' | 'cozy' | 'comfortable'

export function densityFor(bp: BreakpointName): Density {
  if (bp === 'xs' || bp === 'sm') return 'compact'
  if (bp === 'md' || bp === 'lg') return 'cozy'
  return 'comfortable'
}

/* ───────────────────────────── layout ─────────────────────────────────── */

export interface LayoutMetrics {
  /** Width of the docked panel on the inline-start edge. 0 = not docked at
   *  this size (render its content in a sheet instead). */
  panelStart: number
  /** Width of the docked rail on the inline-end edge. 0 = not docked. */
  panelEnd: number
  hudPad: number
  controlSize: number
}

/**
 * Mirrored by `layout.css`. Exported because the 3D camera needs them too: if
 * a 320px sidebar is docked, the board must be offset by 320px or it sits
 * half-hidden behind the panel. `useBreakpoint().layout` returns the row for
 * the current size.
 */
export const LAYOUT: Readonly<Record<BreakpointName, LayoutMetrics>> = {
  xs: { panelStart: 0, panelEnd: 0, hudPad: 12, controlSize: 40 },
  sm: { panelStart: 0, panelEnd: 0, hudPad: 14, controlSize: 42 },
  md: { panelStart: 0, panelEnd: 0, hudPad: 16, controlSize: 44 },
  lg: { panelStart: 296, panelEnd: 0, hudPad: 18, controlSize: 44 },
  xl: { panelStart: 320, panelEnd: 300, hudPad: 20, controlSize: 46 },
  xxl: { panelStart: 344, panelEnd: 320, hudPad: 24, controlSize: 48 },
} as const

/** Narrow icon rails used when a phone is held sideways. */
export const PHONE_LANDSCAPE_RAIL = 72

/**
 * The UI layer stops growing here and centres. On a 3440px ultrawide an
 * uncapped layout puts your piece tray and your opponents' trays at opposite
 * edges of peripheral vision — you would turn your head to read a counter.
 * The 3D canvas stays full-bleed; only the interface is capped.
 */
export const SHELL_MAX = 2240

/* ─────────────────────────────── space ────────────────────────────────── */

/** Fixed 4px geometric scale. Does NOT change with viewport — the responsive
 *  part lives in the semantic layout tokens (`--hud-pad` etc.) instead, so
 *  that a `--space-4` gap is the same everywhere and stays predictable. */
export const SPACE = {
  0: '0',
  px: '1px',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  8: '2rem',
  10: '2.5rem',
  12: '3rem',
  16: '4rem',
  20: '5rem',
  24: '6rem',
} as const

export const RADIUS = {
  xs: '4px',
  sm: '6px',
  md: '10px',
  lg: '14px',
  xl: '20px',
  '2xl': '28px',
  pill: '999px',
  full: '50%',
} as const

/** Minimum interactive target. 44px is the WCAG 2.5.5 / iOS floor; touch
 *  devices get 48px because a thumb on a moving 3D board is not a mouse. */
export const HIT_TARGET = { mouse: 44, touch: 48 } as const

/* ──────────────────────────────── type ────────────────────────────────── */

export const FONT = {
  sans: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
  /** For scores, counts and timers. Pair with `font-variant-numeric: tabular-nums`
   *  (or the `.u-tabular` utility) so digits do not jitter as they change. */
  mono: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`,
} as const

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const

/** Fluid sizes: each interpolates between a 360px phone and a 1440px desktop,
 *  then clamps. Values are px at each end; the CSS holds the clamp() form. */
export const TYPE_SCALE = {
  '2xs': [11, 12],
  xs: [12, 13],
  sm: [13, 14.5],
  base: [15, 16],
  md: [16, 18],
  lg: [18, 21],
  xl: [21, 25],
  '2xl': [25, 31],
  '3xl': [30, 40],
  display: [34, 56],
} as const

export const LINE_HEIGHT = {
  tight: 1.15,
  snug: 1.3,
  normal: 1.5,
  relaxed: 1.65,
} as const

/* ────────────────────────────── motion ────────────────────────────────── */

/** Durations in ms. The CSS mirrors these; `prefers-reduced-motion: reduce`
 *  collapses all of them to ~0 in one place (base.css) rather than requiring
 *  every component to remember. */
export const DURATION = {
  instant: 0,
  fast: 120,
  base: 180,
  slow: 260,
  slower: 400,
  slowest: 650,
} as const

export const EASING = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  decelerate: 'cubic-bezier(0, 0, 0, 1)',
  accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  /** Slight overshoot. For a piece settling onto the board. */
  overshoot: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const

/** @react-spring configs, for the 3D side where CSS easings do not apply. */
export const SPRING = {
  /** UI affordances: hover lift, selection ring. */
  snappy: { tension: 320, friction: 28, mass: 1 },
  /** Camera moves, panel transitions. */
  gentle: { tension: 180, friction: 26, mass: 1 },
  /** A piece dropping onto the board — a little weight, a little bounce. */
  drop: { tension: 260, friction: 22, mass: 1.1 },
  /** Win celebration. */
  wobble: { tension: 200, friction: 12, mass: 1 },
} as const

export type SpringName = keyof typeof SPRING

/* ─────────────────────────────── layering ─────────────────────────────── */

export const Z = {
  canvas: 0,
  hud: 10,
  panel: 20,
  sheet: 30,
  modal: 40,
  toast: 50,
  tooltip: 60,
} as const
