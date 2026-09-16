/**
 * Easing + damping math.
 *
 * Every function here is a pure numeric transform with zero allocation. They are
 * called thousands of times per second inside `useFrame`, so nothing in this file
 * may create an object, a closure, or an array.
 *
 * Two families live here and they solve different problems:
 *
 *  - **Easings** `(t: 0..1) => 0..1`. Use when the animation has a known duration
 *    and a known endpoint: a drop, a flash, a sweep. Deterministic, so a network
 *    move and a local move with the same duration land on the same frame.
 *
 *  - **Dampers** (`smoothTowards`, `springStep`). Use when the target can move
 *    mid-flight: a ghost piece chasing a finger, a value being retargeted by an
 *    arriving state delta. These are framerate-independent, which matters here
 *    because `frameloop="demand"` produces wildly uneven `dt` on wake.
 */

export type Easing = (t: number) => number;

/** Largest timestep we will integrate in one go. */
export const MAX_DT = 1 / 20;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Remap `v` from [inA,inB] to [outA,outB], clamped. */
export function remap(v: number, inA: number, inB: number, outA: number, outB: number): number {
  if (inB === inA) return outA;
  return outA + (outB - outA) * clamp01((v - inA) / (inB - inA));
}

// ---------------------------------------------------------------------------
// Polynomial easings
// ---------------------------------------------------------------------------

export const linear: Easing = (t) => t;

export const easeInQuad: Easing = (t) => t * t;
export const easeOutQuad: Easing = (t) => t * (2 - t);
export const easeInOutQuad: Easing = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

export const easeInCubic: Easing = (t) => t * t * t;
export const easeOutCubic: Easing = (t) => {
  const u = t - 1;
  return u * u * u + 1;
};
export const easeInOutCubic: Easing = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeInQuart: Easing = (t) => t * t * t * t;
export const easeOutQuart: Easing = (t) => 1 - Math.pow(1 - t, 4);

export const easeOutQuint: Easing = (t) => 1 - Math.pow(1 - t, 5);

// ---------------------------------------------------------------------------
// Expressive easings
// ---------------------------------------------------------------------------

/**
 * Overshoot-and-return. `s` is the overshoot magnitude; 1.70158 is the classic
 * ~10% overshoot. We keep ours gentler by default — on a small phone screen a
 * large overshoot on a physical object reads as rubber, not weight.
 */
export function easeOutBack(t: number, s = 1.20158): number {
  const u = t - 1;
  return u * u * ((s + 1) * u + s) + 1;
}

export function easeInBack(t: number, s = 1.20158): number {
  return t * t * ((s + 1) * t - s);
}

/**
 * Exponential decay toward 1 — the "arrives fast, creeps in" curve. Good for
 * hover states where the first 30% of the motion carries all the information.
 */
export const easeOutExpo: Easing = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * Damped oscillation settling at 1. Used for the seat-click on placement.
 * `freq` is oscillations across the normalized span, `decay` how fast they die.
 */
export function easeOutElastic(t: number, freq = 3, decay = 6): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.exp(-decay * t) * Math.cos(freq * Math.PI * 2 * t * 0.5);
}

/**
 * A single decaying oscillation centred on ZERO, not 1. This is the shake
 * primitive: returns an offset in [-1, 1] that damps to 0 by t=1.
 *
 * `osc` is the number of full shakes. 3.5 is the sweet spot for a refusal —
 * 2 reads as a nudge, 5+ reads as an error state that needs dismissing.
 */
export function decayingShake(t: number, osc = 3.5, decay = 4.2): number {
  if (t <= 0 || t >= 1) return 0;
  return Math.sin(t * osc * Math.PI * 2) * Math.exp(-decay * t);
}

/**
 * Ballistic arc: 0 -> 1 -> 0 with gravity shape. Used for hop/bounce heights.
 * Peaks at t=0.5 with value 1.
 */
export function arc(t: number): number {
  const u = clamp01(t);
  return 4 * u * (1 - u);
}

/**
 * Gravity-shaped fall: slow start, fast finish, normalized so f(0)=0, f(1)=1.
 * This is `easeInQuad` and it is the single most important curve in the file —
 * it is what makes a placed piece read as heavy rather than as a tween.
 */
export const gravity: Easing = easeInQuad;

/**
 * Impulse: spikes to 1 quickly then decays. `k` controls sharpness (higher =
 * snappier). Used for emissive flashes where the rise must be near-instant.
 */
export function impulse(t: number, k = 8): number {
  const h = k * t;
  return h * Math.exp(1 - h);
}

/** Symmetric 0->1->0 pulse with an eased shape (softer than `arc`). */
export function pulse(t: number): number {
  const u = clamp01(t);
  return Math.sin(u * Math.PI);
}

/** Smooth 0->1->0 with flat-ish top, for hold-then-release flashes. */
export function flash(t: number, rise = 0.18, hold = 0.14): number {
  const u = clamp01(t);
  if (u < rise) return easeOutQuad(u / rise);
  if (u < rise + hold) return 1;
  return 1 - easeInOutCubic((u - rise - hold) / (1 - rise - hold));
}

// ---------------------------------------------------------------------------
// Framerate-independent damping
// ---------------------------------------------------------------------------

/**
 * Exponential smoothing that behaves identically at 30, 60 and 120 fps, and
 * survives the multi-hundred-millisecond `dt` you get on the first frame after
 * a `frameloop="demand"` wake.
 *
 * `lambda` is the rate constant: the value covers ~63% of the remaining
 * distance in `1/lambda` seconds. lambda=12 is a snappy UI follow, lambda=4 is
 * a lazy drift.
 *
 * Naive `lerp(a, b, 0.1)` per frame is the bug this exists to avoid — it makes
 * everything move twice as fast on a 120Hz phone as on a 60Hz one.
 */
export function smoothTowards(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

/**
 * Semi-implicit Euler spring step. Returns the new velocity; caller integrates
 * position. Semi-implicit (velocity updated before position) is unconditionally
 * more stable than explicit Euler at the timesteps we see here.
 *
 * `stiffness` ~ omega^2, `damping` ~ 2*zeta*omega.
 * Critical damping (no overshoot) is `damping = 2 * sqrt(stiffness)`.
 */
export function springStep(
  position: number,
  velocity: number,
  target: number,
  stiffness: number,
  damping: number,
  dt: number,
): number {
  const accel = -stiffness * (position - target) - damping * velocity;
  return velocity + accel * dt;
}

/** Damping coefficient for a given stiffness and damping ratio zeta. */
export function dampingFor(stiffness: number, zeta: number): number {
  return 2 * zeta * Math.sqrt(stiffness);
}

/**
 * True when a spring has effectively stopped. We need an explicit settle test
 * because under `frameloop="demand"` a spring that never formally settles keeps
 * the GPU awake forever and eats the battery.
 */
export function springSettled(
  position: number,
  velocity: number,
  target: number,
  posEps = 1e-4,
  velEps = 1e-3,
): boolean {
  return Math.abs(position - target) < posEps && Math.abs(velocity) < velEps;
}

// ---------------------------------------------------------------------------
// Deterministic jitter
// ---------------------------------------------------------------------------

/**
 * Stable hash -> [0,1). Used to phase-offset idle pulses per cell so a board of
 * indicators breathes as a wave rather than in lockstep. Deterministic, so every
 * client in a networked game sees the same wave.
 */
export function hash01(n: number): number {
  let h = (n | 0) * 374761393;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Stable hash of a string id -> [0,1). */
export function hashString01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
