/**
 * useSafeArea — the notch, the rounded corners, the home indicator, and the
 * on-screen keyboard, as numbers.
 *
 * Most layout should use the CSS variables (`--safe-top`, `--safe-bottom`, ...
 * or the `.u-safe-*` utilities) rather than this hook. Reach for the hook when
 * a number is genuinely needed — positioning something inside the WebGL canvas,
 * or deciding whether a control fits at all.
 *
 * Why a probe element instead of reading the variables directly: `env()` is
 * substituted at computed-value time, and reading it back off a custom property
 * is not reliable across browsers. A hidden element that has the insets as real
 * padding always reports real pixels.
 *
 * REQUIRES `viewport-fit=cover` in the viewport meta tag — without it iOS
 * reports every inset as 0 and the layout silently ends up under the notch.
 * `index.html` should carry:
 *
 *   <meta name="viewport"
 *         content="width=device-width, initial-scale=1, viewport-fit=cover">
 *
 * If it does not, this module patches the tag at runtime so the app is still
 * correct. Note there is deliberately no `user-scalable=no` or `maximum-scale`:
 * double-tap zoom is handled by `touch-action: manipulation` in reset.css,
 * which does not take pinch-zoom away from people who need it.
 */

import { useSyncExternalStore } from 'react'

export interface SafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
  /**
   * Height covered by the on-screen keyboard, in CSS pixels; 0 when none is
   * open. Also published as the `--keyboard-inset` CSS variable, which
   * `.app-hud-bottom` already uses to lift clear of it.
   */
  keyboard: number
}

const ZERO: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0, keyboard: 0 }

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'

/* ─────────────────────── viewport meta ─────────────────────────────────── */

let viewportChecked = false

function ensureViewportFitCover(): void {
  if (viewportChecked || !isBrowser) return
  viewportChecked = true

  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover'
    document.head.appendChild(meta)
    return
  }
  if (/viewport-fit\s*=\s*cover/i.test(meta.content)) return

  const cleaned = meta.content
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !/^viewport-fit\s*=/i.test(part))
  cleaned.push('viewport-fit=cover')
  meta.content = cleaned.join(', ')
}

/* ───────────────────────────── probe ──────────────────────────────────── */

let probe: HTMLDivElement | null = null

function getProbe(): HTMLDivElement | null {
  if (!isBrowser || !document.body) return null
  if (probe?.isConnected) return probe
  probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:0',
    'height:0',
    'visibility:hidden',
    'pointer-events:none',
    'padding-top:env(safe-area-inset-top, 0px)',
    'padding-right:env(safe-area-inset-right, 0px)',
    'padding-bottom:env(safe-area-inset-bottom, 0px)',
    'padding-left:env(safe-area-inset-left, 0px)',
  ].join(';')
  document.body.appendChild(probe)
  return probe
}

function readKeyboardInset(): number {
  const vv = window.visualViewport
  if (!vv) return 0
  // When a keyboard opens, the VISUAL viewport shrinks while the layout
  // viewport does not. The difference, minus however far the browser scrolled
  // the page up to keep the focused field visible, is the covered height.
  const covered = window.innerHeight - vv.height - vv.offsetTop
  return covered > 1 ? Math.round(covered) : 0
}

function compute(): SafeAreaInsets {
  if (!isBrowser) return ZERO
  ensureViewportFitCover()
  const el = getProbe()
  if (!el) return ZERO
  const cs = getComputedStyle(el)
  const px = (v: string): number => {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : 0
  }
  return {
    top: px(cs.paddingTop),
    right: px(cs.paddingRight),
    bottom: px(cs.paddingBottom),
    left: px(cs.paddingLeft),
    keyboard: readKeyboardInset(),
  }
}

/* ───────────────────────────── store ──────────────────────────────────── */

let state: SafeAreaInsets = ZERO
let started = false
let frame = 0
const listeners = new Set<() => void>()

const equal = (a: SafeAreaInsets, b: SafeAreaInsets): boolean =>
  a.top === b.top &&
  a.right === b.right &&
  a.bottom === b.bottom &&
  a.left === b.left &&
  a.keyboard === b.keyboard

function publish(insets: SafeAreaInsets): void {
  // `.app-hud-bottom` reads this so a bottom bar lifts above the keyboard.
  document.documentElement.style.setProperty('--keyboard-inset', `${insets.keyboard}px`)
}

function schedule(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const next = compute()
    if (equal(state, next)) return
    state = next
    publish(next)
    listeners.forEach((l) => l())
  })
}

function start(): void {
  if (started || !isBrowser) return
  started = true
  ensureViewportFitCover()
  state = compute()
  publish(state)

  window.addEventListener('resize', schedule, { passive: true })
  // Insets move to the sides when a phone is rotated, and iOS reports the new
  // values a beat after the event, so re-read shortly afterwards too.
  window.addEventListener(
    'orientationchange',
    () => {
      schedule()
      setTimeout(schedule, 120)
      setTimeout(schedule, 400)
    },
    { passive: true }
  )
  window.visualViewport?.addEventListener('resize', schedule, { passive: true })
  window.visualViewport?.addEventListener('scroll', schedule, { passive: true })
}

if (isBrowser) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): SafeAreaInsets => state
const getServerSnapshot = (): SafeAreaInsets => ZERO

/** Read the insets outside React. */
export function getSafeArea(): SafeAreaInsets {
  start()
  return state
}

/**
 * Current safe-area insets, in CSS pixels. Updates on rotation, on browser
 * chrome changes, and when a keyboard opens or closes.
 */
export function useSafeArea(): SafeAreaInsets {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** True when the device actually has insets to avoid (a notch, a home bar). */
export function useHasSafeAreaInsets(): boolean {
  const { top, right, bottom, left } = useSafeArea()
  return top > 0 || right > 0 || bottom > 0 || left > 0
}
