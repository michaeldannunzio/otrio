/**
 * Motion preferences — the non-React mirror.
 *
 * The animation runtime is imperative: it runs inside `useFrame`, mutates refs,
 * and never re-renders. It therefore cannot read preferences out of React
 * context without dragging the whole tree into the frame loop.
 *
 * So preferences live here, in a plain mutable module singleton, and
 * `src/hooks/useAnimationPrefs.ts` is the React owner that writes into it. The
 * runtime reads `MOTION.*` directly, for free, from anywhere.
 *
 * This is the only mutable module state in the animation system, and it is
 * written from exactly one place.
 */

export type QualityTier = 'low' | 'medium' | 'high';
export type MotionOverride = 'system' | 'full' | 'reduced';

export interface MotionState {
  /**
   * Resolved reduced-motion. True when the OS asks for it, or the player did.
   *
   * Reduced motion NEVER means "no feedback". It means no vestibular
   * provocation: no travel, no spin, no shake, no parallax. Colour, opacity,
   * brightness and *timing/stagger* all still carry state changes, which is
   * enough to communicate everything this game needs to communicate.
   */
  reduced: boolean;

  /**
   * Multiplier on spatial travel. 1 = full, 0 = pinned in place.
   * Animations multiply their positional amplitudes by this, so a single
   * number degrades every movement coherently instead of each hook branching.
   */
  motionScale: number;

  /** Multiplier on durations. Reduced motion uses shorter, simpler timings. */
  durationScale: number;

  /** Device capability tier, auto-detected and adaptively downgraded. */
  tier: QualityTier;

  /** Secondary decorative meshes: impact rings, sweeps, pulses. */
  effects: boolean;

  /** Per-piece micro-detail: landing wobble, secondary bounce, counter-spin. */
  microDetail: boolean;

  /** Idle loops (target breathing, winner glow). First thing cut on low tier. */
  idleLoops: boolean;

  /** `navigator.vibrate` on rejection and placement. Off by default on desktop. */
  haptics: boolean;

  /** Bumped whenever anything above changes, so consumers can cheaply diff. */
  revision: number;
}

/**
 * Live preference state. Read this from the frame loop; do not copy it into a
 * closure, or you will capture a stale snapshot when the player flips a setting
 * mid-game.
 */
export const MOTION: MotionState = {
  reduced: false,
  motionScale: 1,
  durationScale: 1,
  tier: 'high',
  effects: true,
  microDetail: true,
  idleLoops: true,
  haptics: false,
  revision: 0,
};

/** Effect flags implied by a tier. Kept here so tier meaning lives in one place. */
export function tierFlags(tier: QualityTier): Pick<MotionState, 'effects' | 'microDetail' | 'idleLoops'> {
  switch (tier) {
    case 'low':
      // Keep every state-communicating animation; drop everything decorative.
      return { effects: false, microDetail: false, idleLoops: false };
    case 'medium':
      return { effects: true, microDetail: false, idleLoops: true };
    default:
      return { effects: true, microDetail: true, idleLoops: true };
  }
}

/**
 * Change listeners.
 *
 * Preferences are written from two directions: the React owner (the player
 * changed a setting, or the OS did) and the runner's adaptive quality watchdog
 * (the framerate collapsed mid-animation). The second one happens inside
 * `useFrame` with no React involvement at all, so without a notification the UI
 * would silently disagree with the renderer about what tier it is on.
 */
const listeners = new Set<() => void>();

export function subscribeMotion(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Apply a partial update and bump the revision. */
export function applyMotionState(patch: Partial<Omit<MotionState, 'revision'>>): void {
  let changed = false;
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
    const next = patch[key];
    if (next !== undefined && MOTION[key] !== next) {
      (MOTION as unknown as Record<string, unknown>)[key] = next;
      changed = true;
    }
  }
  if (!changed) return;
  MOTION.revision++;
  // Notified synchronously, but from `useFrame` this lands during React's
  // commit-safe window because `useSyncExternalStore` defers the re-render.
  for (const fn of listeners) fn();
}

/**
 * Scale a duration token by the current preference.
 *
 * Note the floor: even in reduced motion a transition keeps ~60ms so it is a
 * transition and not a pop. An instantaneous change is genuinely harder to
 * notice than a fast one — reduced motion should not make the game less legible.
 */
export function dur(seconds: number): number {
  const scaled = seconds * MOTION.durationScale;
  return scaled < 0.06 ? 0.06 : scaled;
}

/** Scale a spatial amplitude by the current preference. */
export function amp(units: number): number {
  return units * MOTION.motionScale;
}

/** Fire a haptic pulse if enabled and supported. Never throws. */
export function haptic(ms: number): void {
  if (!MOTION.haptics) return;
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (!nav || typeof nav.vibrate !== 'function') return;
  try {
    nav.vibrate(ms);
  } catch {
    /* Some browsers throw when the document is not user-activated. Ignore. */
  }
}
