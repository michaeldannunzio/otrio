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
  verifyThemeSync,
  type SceneTheme,
  type Theme,
} from '../styles/theme'
import type { ThemeMode, ThemePreference } from '../styles/tokens'

export type { ThemeMode, ThemePreference, Theme, SceneTheme }

const STORAGE_KEY = 'otrio:theme-preference'
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

function readStoredPreference(): ThemePreference {
  if (!isBrowser) return 'system'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // Private browsing, disabled storage, or a blocked third-party context.
    // Falling back to 'system' is correct and harmless.
  }
  return 'system'
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
  const modeChanged = next.mode !== state.mode
  state = next
  if (modeChanged) applyThemeAttributes(next.mode)
  listeners.forEach((l) => l())
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
  applyThemeAttributes(state.mode)

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

/** Read the resolved mode outside React (e.g. in a three.js callback). */
export function getThemeMode(): ThemeMode {
  initTheme()
  return state.mode
}

export function getThemePreference(): ThemePreference {
  initTheme()
  return state.preference
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
