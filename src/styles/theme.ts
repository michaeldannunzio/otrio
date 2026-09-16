/**
 * Theme objects: the typed view of the design tokens, plus the three.js bridge.
 *
 * The DOM gets its colours from CSS custom properties (`tokens.css`).
 * three.js cannot read CSS custom properties, so the 3D scene gets them from
 * `getSceneTheme(mode)` here. Both are fed by `COLORS` in `tokens.ts`, so a
 * board cannot end up light-themed while the HUD goes dark.
 */

import {
  COLORS,
  PLAYERS,
  type ColorTokens,
  type PlayerIndex,
  type ThemeMode,
  type ThemePreference,
} from './tokens'

export type { ThemeMode, ThemePreference, ColorTokens }

/* ────────────────────────────── theme ─────────────────────────────────── */

export interface Theme {
  mode: ThemeMode
  colors: ColorTokens
  /** Per-player colours already resolved for this mode, indexed 0..3. */
  players: readonly PlayerColors[]
  scene: SceneTheme
}

export interface PlayerColors {
  index: PlayerIndex
  /** 'purple' | 'red' | 'green' | 'blue' — same vocabulary as the engine. */
  key: string
  label: string
  /** Board arm per the official setup artwork: north/east/south/west. */
  seat: string
  glyph: string
  glyphLabel: string
  /** Piece material / swatch fill. The player's identity. */
  base: string
  /** HUD text and icons. Clears 4.5:1 on every surface. */
  ui: string
  /** Piece outline. Clears 3:1 against the board — required for silhouette. */
  rim: string
  soft: string
  onSoft: string
  on: string
}

function playersFor(mode: ThemeMode): readonly PlayerColors[] {
  const c = COLORS[mode]
  return PLAYERS.map((p) => {
    const n = (p.index + 1) as 1 | 2 | 3 | 4
    return {
      index: p.index,
      key: p.key,
      label: p.label,
      seat: p.seat,
      glyph: p.glyph,
      glyphLabel: p.glyphLabel,
      base: c[`player${n}` as keyof ColorTokens],
      ui: c[`player${n}Ui` as keyof ColorTokens],
      rim: c[`player${n}Rim` as keyof ColorTokens],
      soft: c[`player${n}Soft` as keyof ColorTokens],
      onSoft: c[`player${n}OnSoft` as keyof ColorTokens],
      on: c[`player${n}On` as keyof ColorTokens],
    }
  })
}

/* ──────────────────────────── scene theme ─────────────────────────────── */

export type Vec3 = readonly [number, number, number]

export interface SceneLight {
  color: string
  intensity: number
  position: Vec3
}

/**
 * Everything the three.js side needs to match the current theme.
 *
 * COLOUR MANAGEMENT: every string here is an sRGB hex, which is what three.js
 * expects. With `THREE.ColorManagement` enabled (the default since r152, and
 * this project is on r171) `new THREE.Color('#rrggbb')` and the R3F `color`
 * prop both convert sRGB -> linear working space for you. Pass these values
 * straight through. Do NOT call `.convertSRGBToLinear()` on them — that
 * double-converts and the whole scene comes out washed out and too dark.
 */
export interface SceneTheme {
  mode: ThemeMode
  /** Renderer clear colour / `scene.background`. */
  background: string
  /** Fades the board's far edge into the backdrop. Set `scene.fog`. */
  fog: { color: string; near: number; far: number }
  board: {
    base: string
    /** Engraved grid lines / slot outlines. */
    line: string
    /** The slab's chamfered edge; reads against the backdrop. */
    edge: string
    roughness: number
    metalness: number
    clearcoat: number
  }
  piece: {
    roughness: number
    metalness: number
    clearcoat: number
    clearcoatRoughness: number
    /**
     * Dark mode gives pieces a little self-illumination so saturated colours
     * do not sink into the dark board. Use as
     * `emissive={player.base}` + `emissiveIntensity={scene.piece.emissiveIntensity}`.
     */
    emissiveIntensity: number
    /** Suggested outline thickness in world units for the `rim` colour. */
    rimWidth: number
  }
  lights: {
    ambient: { color: string; intensity: number }
    key: SceneLight
    fill: SceneLight
    rim: SceneLight
  }
  /** For drei's `<Environment />`. `background` stays false — we draw our own. */
  environment: { preset: EnvironmentPreset; intensity: number }
  /** For drei's `<ContactShadows />`. */
  shadow: { color: string; opacity: number; blur: number; far: number; resolution: number }
  toneMappingExposure: number
  highlight: {
    /** Cursor/finger is over this cell. */
    hover: string
    hoverOpacity: number
    /** This cell is a legal drop target for the piece being placed. */
    target: string
    targetOpacity: number
    /** Occupied or illegal. Pair with a shake, not a red flash — red is a
     *  player colour here. */
    blocked: string
    blockedOpacity: number
    /** Ring around the most recent placement. */
    lastMove: string
    /**
     * Neutral bloom for the winning line. Combine with the *winning player's*
     * `rim` colour so the celebration is attributable to a player; this is the
     * white-hot core, not the whole effect.
     */
    winGlow: string
  }
  players: readonly PlayerColors[]
}

export type EnvironmentPreset =
  | 'city' | 'studio' | 'apartment' | 'lobby' | 'warehouse'
  | 'sunset' | 'dawn' | 'night' | 'forest' | 'park'

const KEY_POS: Vec3 = [6, 10, 6]
const FILL_POS: Vec3 = [-8, 5, -4]
const RIM_POS: Vec3 = [0, 6, -10]

const SCENE: Record<ThemeMode, Omit<SceneTheme, 'players' | 'mode'>> = {
  light: {
    background: COLORS.light.sceneBg,
    fog: { color: COLORS.light.sceneBg, near: 14, far: 34 },
    board: {
      base: COLORS.light.boardBase,
      line: COLORS.light.boardLine,
      edge: COLORS.light.borderStrong,
      roughness: 0.55,
      metalness: 0.0,
      clearcoat: 0.1,
    },
    piece: {
      roughness: 0.35,
      metalness: 0.0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
      emissiveIntensity: 0,
      rimWidth: 0.012,
    },
    lights: {
      ambient: { color: '#ffffff', intensity: 0.55 },
      key: { color: '#fff6e8', intensity: 2.2, position: KEY_POS },
      fill: { color: '#dce7ff', intensity: 0.8, position: FILL_POS },
      rim: { color: '#ffffff', intensity: 0.6, position: RIM_POS },
    },
    environment: { preset: 'city', intensity: 0.7 },
    shadow: { color: '#2a3446', opacity: 0.28, blur: 2.4, far: 12, resolution: 512 },
    toneMappingExposure: 1.0,
    highlight: {
      hover: COLORS.light.textPrimary,
      hoverOpacity: 0.12,
      target: COLORS.light.boardLine,
      targetOpacity: 0.55,
      blocked: COLORS.light.textMuted,
      blockedOpacity: 0.35,
      lastMove: COLORS.light.borderStrong,
      winGlow: '#ffffff',
    },
  },
  dark: {
    background: COLORS.dark.sceneBg,
    fog: { color: COLORS.dark.sceneBg, near: 16, far: 40 },
    board: {
      base: COLORS.dark.boardBase,
      line: COLORS.dark.boardLine,
      edge: COLORS.dark.borderStrong,
      roughness: 0.5,
      metalness: 0.05,
      clearcoat: 0.15,
    },
    piece: {
      roughness: 0.3,
      metalness: 0.0,
      clearcoat: 0.7,
      clearcoatRoughness: 0.2,
      emissiveIntensity: 0.12,
      rimWidth: 0.012,
    },
    lights: {
      ambient: { color: '#8f9cb8', intensity: 0.35 },
      key: { color: '#ffeed8', intensity: 1.8, position: KEY_POS },
      fill: { color: '#4a6ea8', intensity: 0.7, position: FILL_POS },
      rim: { color: '#8fa8ff', intensity: 1.0, position: RIM_POS },
    },
    environment: { preset: 'night', intensity: 0.45 },
    shadow: { color: '#000000', opacity: 0.55, blur: 2.8, far: 12, resolution: 512 },
    toneMappingExposure: 1.15,
    highlight: {
      hover: COLORS.dark.textPrimary,
      hoverOpacity: 0.14,
      target: COLORS.dark.boardLine,
      targetOpacity: 0.7,
      blocked: COLORS.dark.textMuted,
      blockedOpacity: 0.3,
      lastMove: COLORS.dark.borderStrong,
      winGlow: '#ffffff',
    },
  },
}

const THEMES: Record<ThemeMode, Theme> = {
  light: {
    mode: 'light',
    colors: COLORS.light,
    players: playersFor('light'),
    scene: { mode: 'light', ...SCENE.light, players: playersFor('light') },
  },
  dark: {
    mode: 'dark',
    colors: COLORS.dark,
    players: playersFor('dark'),
    scene: { mode: 'dark', ...SCENE.dark, players: playersFor('dark') },
  },
}

/** The full theme object for a mode. Stable identity — safe in deps arrays. */
export function getTheme(mode: ThemeMode): Theme {
  return THEMES[mode]
}

/** Just the three.js slice. Stable identity — safe in deps arrays. */
export function getSceneTheme(mode: ThemeMode): SceneTheme {
  return THEMES[mode].scene
}

/* ───────────────────────── DOM application ────────────────────────────── */

/** Holds the RESOLVED mode: always `light` or `dark`. `tokens.css` keys off it. */
export const THEME_ATTRIBUTE = 'data-theme'

/**
 * Holds the UNRESOLVED choice: `light`, `dark` or `system`.
 *
 * Kept separate because `system` is not recoverable from `data-theme` alone —
 * a settings UI needs to know whether "Dark" is selected or merely resolved.
 * The pre-paint script in `index.html` sets both.
 */
export const THEME_PREFERENCE_ATTRIBUTE = 'data-theme-pref'

export interface ApplyThemeOptions {
  root?: HTMLElement
  /** The unresolved choice, written to `data-theme-pref`. Omit to leave it. */
  preference?: ThemePreference
}

/**
 * Put a resolved mode on the document.
 *
 * Sets `data-theme` (which `tokens.css` keys off) and, just as importantly,
 * `color-scheme` — that is what makes form controls, scrollbars and the
 * browser's own UI follow the theme instead of staying stubbornly light.
 * Also updates the `theme-color` meta tag so a phone's status bar matches.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ APPLICATION CODE SHOULD NOT CALL THIS. Call `setThemePreference()` from    │
 * │ `src/hooks/useTheme.ts` instead — it persists the choice, resolves         │
 * │ `system`, notifies subscribers AND calls this. Calling this directly       │
 * │ paints the DOM without telling the store, so the next state change from    │
 * │ anywhere else silently reverts you. It is exported for tests and for       │
 * │ `useTheme` itself; in dev, any other caller gets a one-time warning.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function applyThemeAttributes(
  mode: ThemeMode,
  options?: HTMLElement | ApplyThemeOptions
): void {
  // Back-compatible: (mode), (mode, rootElement) and (mode, { root, preference }).
  const opts: ApplyThemeOptions =
    options && typeof (options as HTMLElement).setAttribute === 'function'
      ? { root: options as HTMLElement }
      : ((options as ApplyThemeOptions | undefined) ?? {})

  const el = opts.root ?? (typeof document !== 'undefined' ? document.documentElement : null)
  if (!el) return

  warnOnForeignApply()

  el.setAttribute(THEME_ATTRIBUTE, mode)
  if (opts.preference) el.setAttribute(THEME_PREFERENCE_ATTRIBUTE, opts.preference)
  el.style.colorScheme = mode

  const meta =
    typeof document !== 'undefined'
      ? document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      : null
  if (meta) meta.content = COLORS[mode].bg
}

/* `useTheme` brackets its own calls with this so the dev warning below can tell
 * the owner apart from everyone else. Not exported from the barrel. */
let insideThemeStore = false
let warnedForeignApply = false

/** @internal — for `useTheme.ts` only. */
export function runAsThemeStore<T>(fn: () => T): T {
  insideThemeStore = true
  try {
    return fn()
  } finally {
    insideThemeStore = false
  }
}

function warnOnForeignApply(): void {
  if (insideThemeStore || warnedForeignApply) return
  const dev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false
  if (!dev) return
  warnedForeignApply = true
  console.warn(
    '[otrio/theme] applyThemeAttributes() was called from outside the theme store.\n' +
      'The DOM is now painted with a mode the store does not know about, so the next\n' +
      'change from anywhere else will silently revert it. Use setThemePreference()\n' +
      "from 'src/hooks/useTheme.ts' instead — it persists, resolves 'system', notifies\n" +
      'subscribers and applies the attributes. This warning fires once per session.'
  )
}

/* ───────────────────────── drift detection ────────────────────────────── */

const norm = (v: string): string => {
  const s = v.trim().toLowerCase()
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s)
  if (m) {
    return (
      '#' +
      [m[1], m[2], m[3]]
        .map((n) => Math.round(parseFloat(n)).toString(16).padStart(2, '0'))
        .join('')
    )
  }
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('')
  return s
}

/** `player1OnSoft` -> `--player-1-on-soft`, `surface2` -> `--surface-2`. */
const camelToVar = (k: string): string =>
  '--' +
  k
    .replace(/([a-z])(\d)/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()

/**
 * Dev-only: assert that every colour constant matches its CSS custom property.
 *
 * This is what keeps `tokens.ts` and `tokens.css` honest without a build step.
 * Called once from `useTheme`'s initialiser under `import.meta.env.DEV`;
 * it is a no-op in production. Returns the list of mismatches so a test could
 * assert on it too.
 */
export function verifyThemeSync(mode: ThemeMode, root?: HTMLElement): string[] {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return []
  const el = root ?? document.documentElement
  const previous = el.getAttribute(THEME_ATTRIBUTE)
  el.setAttribute(THEME_ATTRIBUTE, mode)
  const cs = getComputedStyle(el)
  const problems: string[] = []
  for (const [key, expected] of Object.entries(COLORS[mode])) {
    const varName = camelToVar(key)
    const actual = cs.getPropertyValue(varName)
    if (!actual.trim()) {
      problems.push(`${varName} is not defined in CSS (tokens.ts has ${expected})`)
    } else if (norm(actual) !== norm(expected)) {
      problems.push(`${varName}: CSS has ${norm(actual)}, tokens.ts has ${norm(expected)}`)
    }
  }
  if (previous === null) el.removeAttribute(THEME_ATTRIBUTE)
  else el.setAttribute(THEME_ATTRIBUTE, previous)

  if (problems.length) {
    console.error(
      `[otrio/theme] ${problems.length} token(s) differ between tokens.ts and tokens.css in ${mode} mode.\n` +
        `The 3D scene reads tokens.ts and the DOM reads tokens.css, so these will render differently.\n` +
        problems.map((p) => '  • ' + p).join('\n')
    )
  }
  return problems
}
