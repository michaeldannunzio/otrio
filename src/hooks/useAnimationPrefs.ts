/**
 * Motion and quality preferences.
 *
 * This hook is the React-side owner of the animation system's settings. It
 * resolves three inputs — the OS `prefers-reduced-motion` setting, the player's
 * explicit override, and an auto-detected device tier — into the single mutable
 * `MOTION` record that the imperative animation runtime reads every frame.
 *
 * ## What "reduced motion" means here
 *
 * It does NOT mean "no feedback". Every state change in this game stays just as
 * legible with reduced motion on; what goes away is the vestibular provocation:
 * travel, spin, shake, bounce, parallax. What stays is colour, brightness,
 * opacity, and — importantly — **timing and stagger**.
 *
 * That last one matters more than it sounds. The win animation communicates the
 * *direction* of a winning line by lighting its three pieces in order. With
 * reduced motion the pieces no longer rise, but they still light in that same
 * order, so the player still sees which way the line runs. Order carries the
 * meaning when movement cannot.
 *
 * ## Why this is not React state
 *
 * The frame loop cannot read React context without dragging the component tree
 * into `useFrame`. So the real value lives in a module singleton
 * (`animation/core/prefs.ts`) and this hook writes into it. The hook re-renders
 * only when a preference actually changes — never per frame.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  applyMotionState,
  MOTION,
  subscribeMotion,
  tierFlags,
  type MotionOverride,
  type QualityTier,
} from '../scene/animation/core/prefs';
import { detectTier } from '../scene/animation/core/quality';
import { runner } from '../scene/animation/core/runner';

const STORAGE_KEY = 'otrio.motion.v1';

interface StoredPrefs {
  override?: MotionOverride;
  haptics?: boolean;
  /** 'auto' means "keep detecting and adapting". */
  tier?: QualityTier | 'auto';
}

function readStored(): StoredPrefs {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredPrefs;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    // Private mode, blocked storage, corrupt JSON. Defaults are fine.
    return {};
  }
}

function writeStored(patch: StoredPrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStored(), ...patch }));
  } catch {
    /* Storage is a convenience here, never a requirement. */
  }
}

function systemReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Touch devices get haptics on by default and desktops do not.
 *
 * A short vibration is the single most effective way to report an illegal move
 * on a phone — it lands even if the player is looking at another player rather
 * than the screen. On a desktop there is nothing to vibrate.
 */
function defaultHaptics(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

// ---------------------------------------------------------------------------
// One-time bootstrap
// ---------------------------------------------------------------------------

let bootstrapped = false;

function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const stored = readStored();
  const tier = stored.tier && stored.tier !== 'auto' ? stored.tier : detectTier();
  const override = stored.override ?? 'system';
  const reduced = override === 'reduced' || (override === 'system' && systemReducedMotion());

  runner.setAutoTier(!stored.tier || stored.tier === 'auto');

  applyMotionState({
    reduced,
    motionScale: reduced ? 0 : 1,
    durationScale: reduced ? 0.7 : 1,
    tier,
    haptics: stored.haptics ?? defaultHaptics(),
    ...tierFlags(tier),
  });
}

export interface AnimationPrefs {
  /** Resolved: the OS asked for reduced motion, or the player did. */
  reducedMotion: boolean;
  /** The raw OS setting, so the UI can show "following your system setting". */
  systemReducedMotion: boolean;
  /** What the player chose. `'system'` defers to the OS. */
  override: MotionOverride;
  /** Effective device tier, possibly downgraded automatically mid-session. */
  tier: QualityTier;
  /** False when the player pinned a tier and disabled adaptive downgrade. */
  autoTier: boolean;
  /** Vibration feedback on rejected moves. */
  haptics: boolean;

  setOverride(next: MotionOverride): void;
  setTier(next: QualityTier | 'auto'): void;
  setHaptics(next: boolean): void;
}

/**
 * Read and control motion preferences.
 *
 * Safe to call from several components; they all share the same underlying
 * singleton and re-render together when it changes.
 */
export function useAnimationPrefs(): AnimationPrefs {
  bootstrap();

  // Revision is a plain number, so the snapshot is stable and cannot cause the
  // infinite-loop failure mode that returning a fresh object here would.
  const revision = useSyncExternalStore(
    subscribeMotion,
    () => MOTION.revision,
    () => MOTION.revision,
  );

  const sysReduced = useSyncExternalStore(
    subscribeSystemMotion,
    systemReducedMotion,
    () => false, // server snapshot: assume full motion, corrected on hydration
  );

  const stored = useMemo(() => readStored(), [revision]);
  const override = stored.override ?? 'system';

  // Keep the singleton in step with the OS setting changing underneath us.
  useEffect(() => {
    if (override !== 'system') return;
    const reduced = sysReduced;
    applyMotionState({
      reduced,
      motionScale: reduced ? 0 : 1,
      durationScale: reduced ? 0.7 : 1,
    });
  }, [override, sysReduced]);

  const setOverride = useCallback((next: MotionOverride) => {
    writeStored({ override: next });
    const reduced = next === 'reduced' || (next === 'system' && systemReducedMotion());
    applyMotionState({
      reduced,
      motionScale: reduced ? 0 : 1,
      durationScale: reduced ? 0.7 : 1,
    });
  }, []);

  const setTier = useCallback((next: QualityTier | 'auto') => {
    writeStored({ tier: next });
    const auto = next === 'auto';
    runner.setAutoTier(auto);
    const tier = auto ? detectTier() : next;
    applyMotionState({ tier, ...tierFlags(tier) });
  }, []);

  const setHaptics = useCallback((next: boolean) => {
    writeStored({ haptics: next });
    applyMotionState({ haptics: next });
  }, []);

  return useMemo<AnimationPrefs>(
    () => ({
      reducedMotion: MOTION.reduced,
      systemReducedMotion: sysReduced,
      override,
      tier: MOTION.tier,
      autoTier: !stored.tier || stored.tier === 'auto',
      haptics: MOTION.haptics,
      setOverride,
      setTier,
      setHaptics,
    }),
    [revision, sysReduced, override, stored.tier, setOverride, setTier, setHaptics],
  );
}

/** Subscribe to the OS reduced-motion media query. */
function subscribeSystemMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Safari before 14 only has the deprecated listener API.
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }
  mq.addListener(onChange);
  return () => mq.removeListener(onChange);
}

export type { MotionOverride, QualityTier };
