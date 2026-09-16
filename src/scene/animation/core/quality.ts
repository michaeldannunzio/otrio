/**
 * Device capability tiering + adaptive downgrade.
 *
 * The target is "four mid-range phones", which in practice means a wide spread
 * of GPUs and no way to know in advance which one you got. So: guess from the
 * device hints, then measure, then degrade if the guess was optimistic.
 *
 * Degradation is deliberately ONE-WAY within a session. A tier that can go back
 * up will oscillate — you drop effects, the framerate recovers *because* you
 * dropped them, you restore them, it tanks again. That flapping is far more
 * noticeable than simply running at the lower tier.
 */

import type { QualityTier } from './prefs';

/**
 * Static guess from device hints. Runs once, cheaply, before first paint.
 *
 * `deviceMemory` and `hardwareConcurrency` are both absent or lying on plenty
 * of browsers, so every branch has to survive `undefined`. When we know
 * nothing we return 'medium' — an over-eager 'high' on a weak phone is a worse
 * failure than a slightly plain-looking game on a strong one.
 */
export function detectTier(): QualityTier {
  if (typeof navigator === 'undefined') return 'medium';

  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined;
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  const coarsePointer =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

  // Explicitly weak signals win outright.
  if ((cores !== undefined && cores <= 4) || (memory !== undefined && memory <= 2)) {
    return 'low';
  }

  // A phone pushing 3x pixels is doing far more fill than its core count
  // suggests. Fill rate, not CPU, is what kills us — every effect here is a
  // transparent overdrawing quad.
  if (coarsePointer && dpr >= 3 && (cores === undefined || cores < 8)) {
    return 'low';
  }

  const strongCores = cores !== undefined && cores >= 8;
  const strongMemory = memory === undefined || memory >= 8;

  if (strongCores && strongMemory && !coarsePointer) return 'high';
  if (strongCores && strongMemory) return 'medium';

  return 'medium';
}

const ORDER: readonly QualityTier[] = ['low', 'medium', 'high'];

export function tierIndex(tier: QualityTier): number {
  const i = ORDER.indexOf(tier);
  return i < 0 ? 1 : i;
}

export function lowerTier(tier: QualityTier): QualityTier {
  const i = tierIndex(tier);
  return i <= 0 ? 'low' : ORDER[i - 1];
}

/**
 * Rolling frame-time watchdog.
 *
 * Only sampled while animations are actually running. Under
 * `frameloop="demand"` the renderer is asleep most of the time, so measuring
 * "fps" continuously would be meaningless — the gaps between demanded frames
 * are idle, not slow.
 *
 * Allocation-free: a fixed ring buffer, no arrays grown, no objects made.
 */
export class FpsWatchdog {
  private readonly samples: Float32Array;
  private cursor = 0;
  private filled = 0;
  private sum = 0;

  /** Frames above this budget count as late. ~45fps. */
  private readonly budget: number;
  /** Fraction of late frames in the window that triggers a downgrade. */
  private readonly lateRatio: number;

  private lateCount = 0;

  constructor(windowSize = 90, budgetSeconds = 1 / 45, lateRatio = 0.35) {
    this.samples = new Float32Array(windowSize);
    this.budget = budgetSeconds;
    this.lateRatio = lateRatio;
  }

  /** Feed one frame. Returns true when the window says we are consistently late. */
  sample(dt: number): boolean {
    // Ignore wake-up spikes: the first frame after the demand loop resumes can
    // be hundreds of ms and says nothing about rendering cost.
    if (dt > 0.25) return false;

    const n = this.samples.length;
    const prev = this.samples[this.cursor];

    if (this.filled === n) {
      this.sum -= prev;
      if (prev > this.budget) this.lateCount--;
    } else {
      this.filled++;
    }

    this.samples[this.cursor] = dt;
    this.sum += dt;
    if (dt > this.budget) this.lateCount++;

    this.cursor = (this.cursor + 1) % n;

    if (this.filled < n) return false;
    return this.lateCount / n >= this.lateRatio;
  }

  /** Mean frame time over the window, or 0 before it fills. */
  get meanFrameTime(): number {
    return this.filled === 0 ? 0 : this.sum / this.filled;
  }

  /** Clear the window — call after acting on a downgrade. */
  reset(): void {
    this.samples.fill(0);
    this.cursor = 0;
    this.filled = 0;
    this.sum = 0;
    this.lateCount = 0;
  }
}
