/**
 * Tracks — the unit of scheduled animation.
 *
 * A track is a pooled, plain-numeric object. It never holds a closure for its
 * per-frame work; the update function is looked up from a module-level table by
 * `kind`, so a thousand tracks share four kilobytes of code and allocate
 * nothing while running.
 *
 * Parameters are generic numbered slots (`a`..`f`). That is uglier than named
 * fields but it keeps every track the same hidden class, which is what lets V8
 * keep the update loop monomorphic. Each kind documents its own slot meanings
 * in `tracks.ts`, next to the code that reads them.
 */

/**
 * Deliberately a plain enum, not a `const enum`. Vite compiles TypeScript with
 * esbuild under `isolatedModules`, which cannot inline a `const enum` across
 * module boundaries — it is a build error, not a slow path. The runtime cost is
 * one property read at spawn time; the frame loop only ever sees the number.
 */
export enum TrackKind {
  Place = 0,
  ImpactRing = 1,
  Hover = 2,
  TargetReveal = 3,
  TargetPulse = 4,
  Reject = 5,
  WinLine = 6,
  WinNested = 7,
  Dim = 8,
  Enter = 9,
  Exit = 10,
  TurnTray = 11,
  TurnSweep = 12,
  WinnerGlow = 13,
  PresenceLeave = 14,
  PresenceJoin = 15,
  DrawWave = 16,
  Skipped = 17,
  /** Board-level effects that write channels rather than piece offsets. */
  BoardFx = 18,
  /** The pointer-following drag preview. */
  Ghost = 19,
  Count = 20,
}

export class Track {
  kind: TrackKind = TrackKind.Place;

  /** Target offset key (see `ids.ts`), or -1 for tracks with no piece target. */
  key = -1;

  /** Seconds since the track started, negative while still delayed. */
  t = 0;

  /** Total run length in seconds, excluding delay. */
  dur = 1;

  /** Generic numeric parameters. Meaning is per-kind; see `tracks.ts`. */
  a = 0;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  f = 0;

  /**
   * Cancellation tag. Animations that can be superseded (a second placement
   * into the same slot after a rollback, a hover replaced by another hover)
   * carry a tag so the runner can kill the old one in O(n) without searching by
   * identity.
   */
  tag = 0;

  /**
   * Called once when the track reaches a meaningful physical beat — currently
   * only the placement impact, so audio can play the recess click. Optional and
   * allocated only when a caller asks for it.
   */
  onBeat: ((key: number, beat: number) => void) | null = null;

  /** True once `onBeat` has fired, so it fires exactly once per track. */
  beatFired = false;

  /** Set by the updater or the runner when the track is finished. */
  done = false;

  /** Pool linkage. */
  pooled = false;

  reset(): void {
    this.kind = TrackKind.Place;
    this.key = -1;
    this.t = 0;
    this.dur = 1;
    this.a = this.b = this.c = this.d = this.e = this.f = 0;
    this.tag = 0;
    this.onBeat = null;
    this.beatFired = false;
    this.done = false;
  }
}

/**
 * Free list. Tracks are recycled rather than collected — a placement animation
 * happens several times a minute for an hour and we would rather not hand the
 * GC a steady drip of short-lived objects on a phone.
 */
const pool: Track[] = [];

export function acquireTrack(): Track {
  const tr = pool.pop();
  if (tr) {
    tr.reset();
    tr.pooled = false;
    return tr;
  }
  return new Track();
}

export function releaseTrack(tr: Track): void {
  if (tr.pooled) return;
  tr.pooled = true;
  tr.onBeat = null;
  // Cap the pool: a pathological burst should not permanently retain memory.
  if (pool.length < 128) pool.push(tr);
}

/** Beat identifiers passed to `onBeat`. */
export const BEAT_IMPACT = 1;
export const BEAT_SETTLED = 2;
