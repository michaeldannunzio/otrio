/**
 * The animation runner: one list of tracks, one tick, one frame-loop contract.
 *
 * ## Why there is exactly one of these
 *
 * The obvious R3F design is `useFrame` inside every animated component. With 36
 * rings plus a board plus indicators that is ~40 subscriber closures invoked
 * every frame, each doing its own bookkeeping. Here there is a single
 * subscriber (`<AnimationDriver/>`) that ticks this runner, and the runner
 * touches only the handful of pieces actually moving.
 *
 * ## The `frameloop="demand"` contract
 *
 * The scene may run the canvas on demand to save battery, which means React
 * Three Fiber renders only when something calls `invalidate()`. An imperative
 * animation system is exactly the thing that breaks under that, because nothing
 * in React knows it is running.
 *
 * So the runner owns the whole contract:
 *
 *  - **Starting** an animation calls `invalidate()` immediately, which wakes the
 *    loop. This is what makes an animation triggered by an arriving WebSocket
 *    message work at all — there is no render, no event, nothing else to wake it.
 *  - **While** tracks are alive, every tick calls `invalidate()` again to
 *    request the next frame. Missing this stops the animation dead after one
 *    frame, which is the classic demand-mode bug.
 *  - **Stopping** is explicit. When the last track finishes we run a few tail
 *    frames to flush offsets back to identity and then go quiet, so a settled
 *    board costs zero GPU. Nothing here loops forever; even the winner glow is
 *    time-boxed.
 */

import { MAX_DT } from './easing';
import {
  applyOffsets,
  currentActiveKeys,
  resetActiveOffsets,
  setDirtyListener,
} from './offsets';
import { FpsWatchdog, lowerTier } from './quality';
import { applyMotionState, MOTION, tierFlags } from './prefs';
import { acquireTrack, releaseTrack, Track, TrackKind } from './track';
import { UPDATERS } from './tracks';

type InvalidateFn = () => void;

/** Frames rendered after the last track dies, to flush offsets to identity. */
const TAIL_FRAMES = 2;

export class AnimationRunner {
  private tracks: Track[] = [];
  private invalidateFn: InvalidateFn | null = null;
  private tail = 0;

  /** Snapshot of keys that accumulated last frame, reused to avoid allocation. */
  private prevActive: number[] = [];

  /** Monotonic clock, seconds. Used by idle loops that need absolute phase. */
  private clock = 0;

  private watchdog = new FpsWatchdog();
  private autoTier = true;

  constructor() {
    // A change to the persistent layer (a piece latching its dim, a tray
    // latching its lift) has no track behind it, so it needs its own way to
    // buy a frame under `frameloop="demand"`.
    setDirtyListener(() => this.wake());
  }

  /** Set by the driver once the canvas exists. */
  setInvalidate(fn: InvalidateFn | null): void {
    this.invalidateFn = fn;
    // Anything scheduled before mount gets its wake-up now.
    if (fn && (this.tracks.length > 0 || this.tail > 0)) fn();
  }

  /** Disable adaptive downgrade (e.g. the player pinned a quality level). */
  setAutoTier(enabled: boolean): void {
    this.autoTier = enabled;
  }

  get time(): number {
    return this.clock;
  }

  get activeCount(): number {
    return this.tracks.length;
  }

  get isAnimating(): boolean {
    return this.tracks.length > 0 || this.tail > 0;
  }

  /**
   * Request a frame. Safe to call from anywhere — a network callback, a pointer
   * handler, a React effect — and safe to call before the canvas mounts.
   */
  wake(): void {
    if (this.tail < TAIL_FRAMES) this.tail = TAIL_FRAMES;
    this.invalidateFn?.();
  }

  /** Schedule a prepared track. Wakes the frame loop. */
  add(tr: Track): Track {
    this.tracks.push(tr);
    this.wake();
    return tr;
  }

  /** Convenience: acquire, configure via the caller, and schedule. */
  spawn(kind: TrackKind, key: number, dur: number, delay = 0): Track {
    const tr = acquireTrack();
    tr.kind = kind;
    tr.key = key;
    tr.dur = dur > 0 ? dur : 0.0001;
    tr.t = -delay;
    return this.add(tr);
  }

  /**
   * Kill tracks matching a kind and/or key and/or tag.
   *
   * Cancellation is safe at any instant precisely because of the offset model:
   * the piece's offset decays to identity on the next tick and the piece is
   * immediately correct. There is no unwinding to do.
   */
  cancel(kind?: TrackKind, key?: number, tag?: number): number {
    let killed = 0;
    for (let i = 0; i < this.tracks.length; i++) {
      const tr = this.tracks[i];
      if (kind !== undefined && tr.kind !== kind) continue;
      if (key !== undefined && tr.key !== key) continue;
      if (tag !== undefined && tr.tag !== tag) continue;
      tr.done = true;
      killed++;
    }
    if (killed > 0) this.wake();
    return killed;
  }

  /** True if any live track matches. Used to dedupe repeat triggers. */
  has(kind: TrackKind, key: number): boolean {
    for (let i = 0; i < this.tracks.length; i++) {
      const tr = this.tracks[i];
      if (tr.kind === kind && tr.key === key && !tr.done) return true;
    }
    return false;
  }

  /** Remove everything immediately. Used on unmount and on hard resync. */
  clear(): void {
    for (let i = 0; i < this.tracks.length; i++) releaseTrack(this.tracks[i]);
    this.tracks.length = 0;
    // Still need a tail so offsets flush back to identity.
    this.tail = TAIL_FRAMES;
    this.invalidateFn?.();
  }

  /**
   * One frame. Called from a single `useFrame` in `<AnimationDriver/>`.
   *
   * Order is fixed and load-bearing:
   *   1. snapshot which keys were written last frame
   *   2. zero them
   *   3. tick tracks, which ACCUMULATE into offsets
   *   4. write offsets (plus the snapshot, so stopped pieces land at identity)
   */
  tick(rawDt: number): void {
    // Clamp: the first frame after a demand-mode wake, or after the tab was
    // backgrounded, can carry a dt of many seconds. Integrating that would
    // teleport every in-flight animation to its end (or past it).
    const dt = rawDt > MAX_DT ? MAX_DT : rawDt < 0 ? 0 : rawDt;
    this.clock += dt;

    // 1. snapshot
    const active = currentActiveKeys();
    const prev = this.prevActive;
    prev.length = 0;
    for (let i = 0; i < active.length; i++) prev.push(active[i]);

    // 2. zero
    resetActiveOffsets();

    // 3. tick
    const tracks = this.tracks;
    let write = 0;
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      if (tr.done) {
        releaseTrack(tr);
        continue;
      }

      tr.t += dt;
      if (tr.t < 0) {
        // Still inside its stagger delay. Keep it, do nothing.
        tracks[write++] = tr;
        continue;
      }

      const raw = tr.t / tr.dur;
      const p = raw >= 1 ? 1 : raw;

      UPDATERS[tr.kind](tr, p, dt);

      // `tr.done` may have been set by the updater itself. Self-terminating
      // tracks are how hovers, idle pulses and glows hand the frame loop back
      // the moment they settle, instead of running out a nominal duration.
      if (p >= 1 || tr.done) {
        tr.done = true;
        releaseTrack(tr);
      } else {
        tracks[write++] = tr;
      }
    }
    tracks.length = write;

    // 4. write
    applyOffsets(prev);

    // 5. frame-loop contract
    if (tracks.length > 0) {
      this.tail = TAIL_FRAMES;
      this.invalidateFn?.();
    } else if (this.tail > 0) {
      this.tail--;
      if (this.tail > 0) this.invalidateFn?.();
    }

    // 6. adaptive quality — sampled only while we are actually rendering
    if (this.autoTier && tracks.length > 0 && MOTION.tier !== 'low') {
      if (this.watchdog.sample(dt)) {
        const next = lowerTier(MOTION.tier);
        applyMotionState({ tier: next, ...tierFlags(next) });
        this.watchdog.reset();
      }
    }
  }
}

/**
 * The instance. A module singleton rather than context state, because the
 * imperative half of this system (network callbacks, pointer handlers) needs to
 * reach it without a hook, and there is exactly one canvas.
 */
export const runner = new AnimationRunner();
