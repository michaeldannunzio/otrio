/**
 * useBreakpoint — the React-side view of the responsive system.
 *
 * `layout.css` already handles anything CSS can express. Use this hook for the
 * decisions CSS cannot make:
 *   - rendering *different components* (a docked sidebar vs a bottom sheet)
 *     rather than restyling the same one,
 *   - telling the 3D camera how much of the viewport the panels are covering,
 *   - skipping animation when the user has asked for reduced motion (CSS
 *     handles its own transitions; three.js and react-spring do not).
 *
 * NO PROVIDER REQUIRED. One shared store, one set of listeners, however many
 * components subscribe. Reads are throttled to an animation frame so dragging
 * a desktop window edge does not thrash React.
 */

import { useCallback, useSyncExternalStore } from 'react'
import {
  BREAKPOINTS,
  BREAKPOINT_ORDER,
  LAYOUT,
  MEDIA,
  PHONE_LANDSCAPE_RAIL,
  densityFor,
  type BreakpointName,
  type Density,
  type LayoutMetrics,
} from '../styles/tokens'

export type { BreakpointName, Density, LayoutMetrics }

export interface BreakpointState {
  /** Current named breakpoint. `'xs'` is a 360-479px phone. */
  name: BreakpointName
  width: number
  height: number
  orientation: 'portrait' | 'landscape'
  /** Viewport is 500px tall or less — a phone on its side, or a short window.
   *  Vertical space, not horizontal, is the constraint. */
  isCompactHeight: boolean
  /** Landscape AND short. The layout switches to side rails here. */
  isPhoneLandscape: boolean
  /** Coarse pointer: finger or stylus. Targets grow to 48px. */
  isTouch: boolean
  /** Real hover exists. Do not hide anything essential behind hover without it. */
  canHover: boolean
  /** 2:1 or wider. The interface is capped and centred. */
  isUltrawide: boolean
  /** How much the interface should show at this size. */
  density: Density
  /** CSS transitions are already neutralised; this is for three.js/react-spring. */
  prefersReducedMotion: boolean
  /**
   * Interface chrome the 3D board must stay clear of, in CSS pixels.
   * `panelStart` is 0 whenever the panel is not docked at this size.
   * Offset the camera (or the board's x position) by
   * `(panelStart - panelEnd) / 2` to keep it visually centred in what is left.
   */
  layout: LayoutMetrics
}

const isBrowser = typeof window !== 'undefined'

function nameForWidth(width: number): BreakpointName {
  let match: BreakpointName = 'xs'
  for (const bp of BREAKPOINT_ORDER) {
    if (width >= BREAKPOINTS[bp]) match = bp
  }
  return match
}

const matches = (query: string): boolean =>
  isBrowser && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false

const FALLBACK: BreakpointState = {
  name: 'xs',
  width: 360,
  height: 800,
  orientation: 'portrait',
  isCompactHeight: false,
  isPhoneLandscape: false,
  isTouch: false,
  canHover: true,
  isUltrawide: false,
  density: 'compact',
  prefersReducedMotion: false,
  layout: LAYOUT.xs,
}

function compute(): BreakpointState {
  if (!isBrowser) return FALLBACK

  const width = window.innerWidth
  const height = window.innerHeight
  const name = nameForWidth(width)
  const orientation: 'portrait' | 'landscape' = width >= height ? 'landscape' : 'portrait'
  const isCompactHeight = height <= 500
  const isPhoneLandscape = orientation === 'landscape' && isCompactHeight

  // Mirrors layout.css: the phone-landscape block comes last and overrides the
  // width-based panel widths, because height is the binding constraint.
  const layout: LayoutMetrics = isPhoneLandscape
    ? { panelStart: PHONE_LANDSCAPE_RAIL, panelEnd: PHONE_LANDSCAPE_RAIL, hudPad: 8, controlSize: 40 }
    : LAYOUT[name]

  return {
    name,
    width,
    height,
    orientation,
    isCompactHeight,
    isPhoneLandscape,
    isTouch: matches(MEDIA.touch),
    canHover: matches(MEDIA.hover),
    isUltrawide: width / Math.max(height, 1) >= 2,
    density: densityFor(name),
    prefersReducedMotion: matches(MEDIA.reducedMotion),
    layout,
  }
}

let state: BreakpointState = FALLBACK
let started = false
const listeners = new Set<() => void>()

function equal(a: BreakpointState, b: BreakpointState): boolean {
  return (
    a.name === b.name &&
    a.width === b.width &&
    a.height === b.height &&
    a.orientation === b.orientation &&
    a.isCompactHeight === b.isCompactHeight &&
    a.isPhoneLandscape === b.isPhoneLandscape &&
    a.isTouch === b.isTouch &&
    a.canHover === b.canHover &&
    a.isUltrawide === b.isUltrawide &&
    a.density === b.density &&
    a.prefersReducedMotion === b.prefersReducedMotion &&
    a.layout === b.layout
  )
}

let frame = 0

function schedule(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const next = compute()
    if (equal(state, next)) return
    state = next
    listeners.forEach((l) => l())
  })
}

const WATCHED = [MEDIA.touch, MEDIA.hover, MEDIA.reducedMotion] as const

function start(): void {
  if (started || !isBrowser) return
  started = true
  state = compute()

  window.addEventListener('resize', schedule, { passive: true })
  window.addEventListener('orientationchange', schedule, { passive: true })

  // Mobile browser toolbars sliding in and out change the usable height
  // without firing `resize` on some versions of iOS Safari.
  window.visualViewport?.addEventListener('resize', schedule, { passive: true })

  if (typeof window.matchMedia === 'function') {
    for (const query of WATCHED) {
      const mql = window.matchMedia(query)
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', schedule)
      else (mql as unknown as { addListener(cb: () => void): void }).addListener(schedule)
    }
  }
}

if (isBrowser) start()

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): BreakpointState => state
const getServerSnapshot = (): BreakpointState => FALLBACK

/** Read the current breakpoint state outside React. */
export function getBreakpointState(): BreakpointState {
  start()
  return state
}

/* ──────────────────────────── React API ───────────────────────────────── */

export interface UseBreakpointResult extends BreakpointState {
  /** `isAtLeast('lg')` — true at lg, xl and xxl. */
  isAtLeast: (bp: BreakpointName) => boolean
  /** `isBelow('lg')` — true at xs, sm and md. */
  isBelow: (bp: BreakpointName) => boolean
}

export function useBreakpoint(): UseBreakpointResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const isAtLeast = useCallback(
    (bp: BreakpointName) => snapshot.width >= BREAKPOINTS[bp],
    [snapshot.width]
  )
  const isBelow = useCallback(
    (bp: BreakpointName) => snapshot.width < BREAKPOINTS[bp],
    [snapshot.width]
  )
  return { ...snapshot, isAtLeast, isBelow }
}

/** Just the name, when you only branch on the breakpoint itself. */
export function useBreakpointName(): BreakpointName {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot).name
}

/** `useIsAtLeast('lg')` — the common case: "is the sidebar docked?" */
export function useIsAtLeast(bp: BreakpointName): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot).width >= BREAKPOINTS[bp]
}

/**
 * For three.js and react-spring, which CSS's reduced-motion handling does not
 * reach. Skip camera fly-throughs, piece bounce and the win celebration —
 * show the end state immediately instead.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot).prefersReducedMotion
}

/** Escape hatch for a one-off query. Prefer the named breakpoints. */
export function useMediaQuery(query: string): boolean {
  const subscribeToQuery = useCallback(
    (listener: () => void) => {
      if (!isBrowser || typeof window.matchMedia !== 'function') return () => {}
      const mql = window.matchMedia(query)
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', listener)
        return () => mql.removeEventListener('change', listener)
      }
      const legacy = mql as unknown as {
        addListener(cb: () => void): void
        removeListener(cb: () => void): void
      }
      legacy.addListener(listener)
      return () => legacy.removeListener(listener)
    },
    [query]
  )
  const read = useCallback(() => matches(query), [query])
  return useSyncExternalStore(subscribeToQuery, read, () => false)
}
