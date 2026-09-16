/**
 * useTheme — light/dark with a system default and a persistent user override.
 *
 * NO PROVIDER REQUIRED. The store lives at module scope and initialises itself
 * on import, so any component can call `useTheme()` and any non-React code can
 * call `getThemeMode()`. There is nothing to wire up in `App.tsx`.
 *
 * Three states, not two — this is the part that is usually got wrong:
 *
 *   'system'  follow the OS (the default)
 *   'light'   force light, even on a dark OS
 *   'dark'    force dark, even on a light OS
 *
 * Storing a resolved mode instead of the preference is what produces the
 * classic bug where a user on a dark OS can never get light: the toggle writes
 * "light", the OS says dark, and something re-resolves to dark on next load.
 * Here the *preference* is what persists, and `mode` is derived from it.
 *
 * Pre-paint behaviour: `tokens.css` already resolves dark from
 * `prefers-color-scheme`, so a dark-OS user sees dark on the very first frame
 * with no flash, before this module runs. JS only has to intervene when the
 * stored preference disagrees with the OS.
 */

import { useCallback, useSyncExternalStore } from 'react'
import {
  applyThemeAttributes,
  getSceneTheme,
  getTheme,
  runAsThemeStore,
  verifyThemeSync,
  type SceneTheme,
  type Theme,
} from '../styles/theme'
import type { ThemeMode, ThemePreference } from '../styles/tokens'

export type { ThemeMode, ThemePreference, Theme, SceneTheme }

/**
 * THE theme preference key. There must be exactly one.
 *
 * Deliberately a FLAT STRING (`"dark"`), not a field inside a JSON bundle. The
 * pre-paint script in `index.html` is the most failure-sensitive code in the
 * app — it runs before any module, cannot import, and must never throw — so it
 * gets one `getItem` and one comparison rather than
 * `JSON.parse(raw).state.theme`. A bundle would couple the first paint to a
 * store's schema version and partialise shape: rename a field and dark-mode
 * users get a flash of light with nothing failing loudly.
 *
 * Writes are also atomic this way — changing the theme cannot clobber a
 * concurrent write to some unrelated preference in a shared bundle.
 *
 * Absent means `system`, which is the default and needs no parsing.
 */
export const THEME_STORAGE_KEY = 'otrio:theme-preference'

/**
 * Legacy location: the theme field inside the app's zustand prefs bundle.
 * Read ONCE, only when {@link THEME_STORAGE_KEY} is absent, so that anyone who
 * already chose a theme keeps it across this consolidation. Never written.
 */
const LEGACY_PREFS_KEY = 'otrio.prefs.v1'

const STORAGE_KEY = THEME_STORAGE_KEY
const DARK_QUERY = '(prefers-color-scheme: dark)'

interface ThemeState {
  /** What the user asked for. This is what persists. */
  preference: ThemePreference
  /** What the OS currently reports. */
  system: ThemeMode
  /** The resolved mode actually in effect. */
  mode: ThemeMode
}

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'

/** Read Vite's DEV flag without depending on `vite/client` being in tsconfig. */
const IS_DEV: boolean =
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false

const isPreference = (v: unknown): v is ThemePreference =>
  v === 'light' || v === 'dark' || v === 'system'

function readStoredPreference(): ThemePreference {
  if (!isBrowser) return 'system'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (isPreference(raw)) return raw
    // Nothing of ours yet — adopt a choice made under the old prefs bundle, once.
    const legacy = readLegacyPreference()
    if (legacy) {
      writeStoredPreference(legacy)
      return legacy
    }
  } catch {
    // Private browsing, disabled storage, or a blocked third-party context.
    // Falling back to 'system' is correct and harmless.
  }
  return 'system'
}

/** One-shot migration. Reads the old bundle; never writes to it. */
function readLegacyPreference(): ThemePreference | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_PREFS_KEY)
    if (!raw) return null
    const theme = (JSON.parse(raw) as { state?: { theme?: unknown } })?.state?.theme
    return isPreference(theme) ? theme : null
  } catch {
    return null
  }
}

function writeStoredPreference(preference: ThemePreference): void {
  if (!isBrowser) return
  try {
    if (preference === 'system') window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Non-fatal: the choice still applies for this session.
  }
}

function readSystemMode(): ThemeMode {
  if (!isBrowser || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

const resolve = (preference: ThemePreference, system: ThemeMode): ThemeMode =>
  preference === 'system' ? system : preference

let state: ThemeState = { preference: 'system', system: 'light', mode: 'light' }

const listeners = new Set<() => void>()

function setState(next: ThemeState): void {
  if (
    next.preference === state.preference &&
    next.system === state.system &&
    next.mode === state.mode
  ) {
    return
  }
  const needsPaint = next.mode !== state.mode || next.preference !== state.preference
  state = next
  // `data-theme-pref` has to follow the preference even when the resolved mode
  // did not move — switching 'dark' -> 'system' on a dark OS changes nothing
  // visually, but a settings UI still has to show the new selection.
  if (needsPaint) paint(next)
  listeners.forEach((l) => l())
}

/** The one place the DOM is told about the theme. */
function paint(next: ThemeState): void {
  runAsThemeStore(() => {
    applyThemeAttributes(next.mode, { preference: next.preference })
  })
}

let initialised = false

/**
 * Wire up the store and paint the current mode onto `<html>`. Idempotent, and
 * called automatically when this module is imported in a browser, so you do
 * not normally need it. Call it explicitly from `main.tsx` only if you want to
 * guarantee it runs before the first React render.
 */
export function initTheme(): void {
  if (initialised || !isBrowser) return
  initialised = true

  const preference = readStoredPreference()
  const system = readSystemMode()
  state = { preference, system, mode: resolve(preference, system) }
  paint(state)

  if (typeof window.matchMedia === 'function') {
    const mql = window.matchMedia(DARK_QUERY)
    const onSystemChange = (event: MediaQueryListEvent): void => {
      const nextSystem: ThemeMode = event.matches ? 'dark' : 'light'
      setState({
        preference: state.preference,
        system: nextSystem,
        mode: resolve(state.preference, nextSystem),
      })
    }
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onSystemChange)
    } else {
      // Safari < 14
      ;(mql as unknown as { addListener(cb: (e: MediaQueryListEvent) => void): void }).addListener(
        onSystemChange
      )
    }
  }

  // Keep multiple tabs of the game in agreement.
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    const preferenceNow = readStoredPreference()
    setState({
      preference: preferenceNow,
      system: state.system,
      mode: resolve(preferenceNow, state.system),
    })
  })

  if (IS_DEV) {
    // Catches tokens.ts and tokens.css drifting apart, which would show up as
    // a 3D board that does not match the interface around it.
    verifyThemeSync('light')
    verifyThemeSync('dark')
  }
}

if (isBrowser) initTheme()

function subscribe(listener: () => void): () => void {
  initTheme()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): ThemeState => state
const getServerSnapshot = (): ThemeState => state

/* ───────────────────────── imperative API ─────────────────────────────── */
/*
 * For non-React owners — chiefly `src/store/prefsStore.ts`, which surfaces the
 * theme in the settings UI but must NOT own it.
 *
 * Why this module owns the preference: `src/hooks/` is lower-level than
 * `src/store/`, so the dependency has to point that way. A store reaching down
 * is fine; the theme layer reaching up into app preferences is not.
 *
 * To delegate, a store keeps no theme state of its own and no `matchMedia`
 * listener. It calls `setThemePreference()` on write, reads
 * `getThemePreference()`, and mirrors with `subscribeToTheme()`:
 *
 *   setTheme: (theme) => setThemePreference(theme),
 *   // once, at store creation:
 *   subscribeToTheme(({ preference, mode }) => setState({ theme: preference, mode })),
 *
 * Do not also call `applyThemeAttributes` — this module already did, including
 * `data-theme`, `data-theme-pref`, `color-scheme` and the `theme-color` meta.
 */

/** Read the resolved mode outside React (e.g. in a three.js callback). */
export function getThemeMode(): ThemeMode {
  initTheme()
  return state.mode
}

/** The unresolved choice: `'light' | 'dark' | 'system'`. */
export function getThemePreference(): ThemePreference {
  initTheme()
  return state.preference
}

/** Everything a mirroring store needs, in one object. */
export interface ThemeSnapshot {
  /** The unresolved choice. */
  preference: ThemePreference
  /** What is actually showing. */
  mode: ThemeMode
  /** What the OS reports, regardless of the override. */
  systemMode: ThemeMode
}

export function getThemeSnapshot(): ThemeSnapshot {
  initTheme()
  return { preference: state.preference, mode: state.mode, systemMode: state.system }
}

/**
 * Observe theme changes from outside React. Returns an unsubscribe function.
 *
 * Fires for every cause: an explicit `setThemePreference`, the OS flipping
 * while the preference is `system`, and another tab changing it. That last one
 * is why a mirroring store must subscribe rather than just write — otherwise
 * two tabs of the same game drift apart.
 *
 * The listener is NOT called on subscribe; seed with `getThemeSnapshot()`.
 */
export function subscribeToTheme(listener: (snapshot: ThemeSnapshot) => void): () => void {
  initTheme()
  const wrapped = (): void => {
    listener({ preference: state.preference, mode: state.mode, systemMode: state.system })
  }
  listeners.add(wrapped)
  return () => {
    listeners.delete(wrapped)
  }
}

/** Set the preference. `'system'` clears the override and follows the OS. */
export function setThemePreference(preference: ThemePreference): void {
  initTheme()
  writeStoredPreference(preference)
  setState({
    preference,
    system: state.system,
    mode: resolve(preference, state.system),
  })
}

/**
 * Flip to the opposite of what is currently showing, as an explicit override.
 *
 * Deliberately resolves against the *current mode* rather than the preference:
 * a user on a dark OS who has never touched the setting and presses "light"
 * gets light. Toggling the preference instead would take them from 'system' to
 * 'light'... which on a dark OS is also what they want, but toggling again
 * would send them back to 'system' and therefore back to dark, so the button
 * would appear to do nothing every other press.
 */
export function toggleTheme(): void {
  setThemePreference(state.mode === 'dark' ? 'light' : 'dark')
}

/** Cycle system -> light -> dark -> system. For a three-state control. */
export function cycleTheme(): void {
  const next: ThemePreference =
    state.preference === 'system' ? 'light' : state.preference === 'light' ? 'dark' : 'system'
  setThemePreference(next)
}

/* ──────────────────────────── React API ───────────────────────────────── */

export interface UseThemeResult {
  /** The mode actually in effect right now. */
  mode: ThemeMode
  /** What the user chose. `'system'` means "follow the OS". */
  preference: ThemePreference
  /** What the OS reports, regardless of the override. */
  systemMode: ThemeMode
  /** True when no explicit override is set. */
  isFollowingSystem: boolean
  /** Full typed tokens for the current mode. Stable identity. */
  theme: Theme
  setPreference: (preference: ThemePreference) => void
  /** Switch to the opposite of what is showing, as an explicit override. */
  toggle: () => void
  /** system -> light -> dark -> system. */
  cycle: () => void
}

export function useTheme(): UseThemeResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const setPreference = useCallback(setThemePreference, [])
  const toggle = useCallback(toggleTheme, [])
  const cycle = useCallback(cycleTheme, [])

  return {
    mode: snapshot.mode,
    preference: snapshot.preference,
    systemMode: snapshot.system,
    isFollowingSystem: snapshot.preference === 'system',
    theme: getTheme(snapshot.mode),
    setPreference,
    toggle,
    cycle,
  }
}

/** Just the mode. Re-renders only when the resolved mode changes. */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot).mode
}

/** Just the colour tokens for the current mode. */
export function useThemeColors(): Theme['colors'] {
  return getTheme(useThemeMode()).colors
}

/**
 * The three.js slice of the theme: background, fog, lights, materials,
 * highlights and per-player piece colours.
 *
 * Use this anywhere inside `<Canvas>`. The returned object has a stable
 * identity per mode, so it is safe in a `useMemo`/`useEffect` dependency array
 * and will only change when the theme actually changes.
 *
 * ```tsx
 * const scene = useSceneTheme()
 * <color attach="background" args={[scene.background]} />
 * <fog attach="fog" args={[scene.fog.color, scene.fog.near, scene.fog.far]} />
 * <ambientLight color={scene.lights.ambient.color} intensity={scene.lights.ambient.intensity} />
 * <meshPhysicalMaterial color={scene.players[i].base} roughness={scene.piece.roughness} />
 * ```
 *
 * Hex strings are sRGB; three.js converts them for you. Do not call
 * `.convertSRGBToLinear()` on them.
 */
export function useSceneTheme(): SceneTheme {
  return getSceneTheme(useThemeMode())
}
