/**
 * The animation math.
 *
 * One updater per `TrackKind`, dispatched from a flat array indexed by kind.
 * Every function here runs inside `useFrame` and obeys three hard rules:
 *
 *  1. **No allocation.** No objects, no arrays, no closures, no template
 *     strings, no `.bind()`. Only numbers.
 *  2. **Accumulate, never assign.** Offsets compose (see `offsets.ts`), so
 *     positions add, scales multiply, and dim/fade/tint take the max. Assigning
 *     would make two animations on one piece fight instead of blend.
 *  3. **Reduced motion is a parameter, not a separate path.** Where the shapes
 *     genuinely differ the track carries a flag set at spawn time, so flipping
 *     the preference mid-animation cannot produce a discontinuity.
 */

import { CH } from './channels';
import {
  arc,
  clamp,
  clamp01,
  decayingShake,
  easeInOutCubic,
  easeInQuad,
  easeOutBack,
  easeOutCubic,
  easeOutQuad,
  easeOutQuart,
  flash,
  impulse,
  smoothTowards,
} from './easing';
import { u } from './layout';
import { setStatic, touchOffset, type PieceOffset } from './offsets';
import { MOTION } from './prefs';
import {
  HOVER,
  IMPACT_RING,
  PLACE,
  PRESENCE,
  REJECT,
  RESET,
  START,
  TARGET,
  TURN,
  WIN,
} from './timing';
import { BEAT_IMPACT, BEAT_SETTLED, Track, TrackKind } from './track';

const TWO_PI = Math.PI * 2;

/**
 * Relative mass by size rank (small, medium, large).
 *
 * RULES.md §2.3: the small piece is a **solid peg**, not a ring — only medium
 * and large are annuli. So the three sizes should not land identically. The peg
 * is light and compact: it lands crisply, squashes little and barely rocks. The
 * large ring is a wide thin annulus: it squashes more, bounces less, and rocks
 * noticeably as it settles.
 *
 * These are feel numbers, not physics. They exist so that a player who has
 * placed a hundred pieces can tell which size they just played without looking
 * at it.
 */
const SIZE_MASS = [0.78, 1.0, 1.24];

type Updater = (tr: Track, p: number, dt: number) => void;

// ---------------------------------------------------------------------------
// Phase boundaries, precomputed once
// ---------------------------------------------------------------------------

/**
 * Placement is a five-beat chord and each beat has its own curve. We express
 * the beats as fractions of the whole so a single `dur` can scale the entire
 * chord (for network catch-up) without distorting its internal rhythm.
 */
const PLACE_TOTAL =
  PLACE.travelDur + PLACE.dropDur + PLACE.squashDur + PLACE.releaseDur + PLACE.bounceDur;
const F_TRAVEL = PLACE.travelDur / PLACE_TOTAL;
const F_DROP = (PLACE.travelDur + PLACE.dropDur) / PLACE_TOTAL;
const F_SQUASH = (PLACE.travelDur + PLACE.dropDur + PLACE.squashDur) / PLACE_TOTAL;
const F_RELEASE =
  (PLACE.travelDur + PLACE.dropDur + PLACE.squashDur + PLACE.releaseDur) / PLACE_TOTAL;

/** Natural total of the placement chord, in seconds, before scaling. */
export const PLACE_NATURAL_DUR = PLACE_TOTAL;

/**
 * Fraction of the placement chord at which the piece touches the board. The
 * impact ring and the audio beat are both scheduled against this, so they stay
 * in sync when the chord is time-scaled for network catch-up.
 */
export const PLACE_IMPACT_FRACTION = F_DROP;

const WIN_LINE_TOTAL = WIN.line.liftDur + WIN.line.holdDur + WIN.line.settleDur;
const F_WIN_LIFT = WIN.line.liftDur / WIN_LINE_TOTAL;
const F_WIN_HOLD = (WIN.line.liftDur + WIN.line.holdDur) / WIN_LINE_TOTAL;
export const WIN_LINE_NATURAL_DUR = WIN_LINE_TOTAL;

const WIN_NEST_TOTAL = WIN.nested.separateDur + WIN.nested.holdDur + WIN.nested.slamDur;
const F_NEST_SEP = WIN.nested.separateDur / WIN_NEST_TOTAL;
const F_NEST_HOLD = (WIN.nested.separateDur + WIN.nested.holdDur) / WIN_NEST_TOTAL;
export const WIN_NESTED_NATURAL_DUR = WIN_NEST_TOTAL;

// ---------------------------------------------------------------------------
// Small helpers — inlined by hand where they would cost a call in the hot path
// ---------------------------------------------------------------------------

function fireBeat(tr: Track, beat: number): void {
  if (tr.beatFired || !tr.onBeat) return;
  tr.beatFired = true;
  tr.onBeat(tr.key, beat);
}

/** Apply a uniform horizontal bulge / vertical squash, composing correctly. */
function squashInto(o: PieceOffset, sy: number, sxz: number): void {
  o.sy *= sy;
  o.sx *= sxz;
  o.sz *= sxz;
}

/** Set a tint only if it beats what is already there this frame. */
function tintInto(o: PieceOffset, a: number, r: number, g: number, b: number): void {
  if (a <= o.tintA) return;
  o.tintA = a;
  o.tintR = r;
  o.tintG = g;
  o.tintB = b;
}

export const UPDATERS: Updater[] = new Array(TrackKind.Count);

// ---------------------------------------------------------------------------
// Placement — the core interaction
// ---------------------------------------------------------------------------

/**
 * Slots: a=fromDX, b=fromDY, c=fromDZ, d=reducedFlag, e=sizeRank, f=unused.
 *
 * The piece flies from wherever it was (a storage arm, or the player's
 * fingertip), arcs up to a hold point above the target space, falls under
 * gravity, squashes on contact, springs back with a click, and settles with one
 * small secondary bounce.
 *
 * The trick that sells the weight is that horizontal and vertical are eased
 * with DIFFERENT curves. Horizontal decelerates into the space; vertical
 * accelerates downward. Ease both the same way and you get a tween; split them
 * and you get an object with mass.
 */
UPDATERS[TrackKind.Place] = (tr, p) => {
  const o = touchOffset(tr.key);

  // Reduced motion: no travel, no drop, no squash. The piece resolves in place
  // with an opacity and brightness rise. Still unmistakable, zero vestibular
  // provocation.
  if (tr.d === 1) {
    const f = 1 - easeOutQuad(p);
    if (f > o.fade) o.fade = f;
    o.emissive += 0.7 * flash(p, 0.3, 0.2);
    if (p >= 0.45) fireBeat(tr, BEAT_IMPACT);
    return;
  }

  const ms = MOTION.motionScale;
  const mass = SIZE_MASS[tr.e | 0] ?? 1;
  const hover = u(PLACE.hoverHeight) * ms;
  const resid = tr.f;

  // --- horizontal: approach, then SELF-CENTRE into the recess ---
  //
  // The piece does not arrive perfectly aligned. It comes in fractionally off,
  // and the last of that error is taken out during the fall, as if the tapered
  // lip of the recess were guiding it in. That correction is the single detail
  // that makes this read as a machined board rather than a grid of targets —
  // and it only exists because the piece has somewhere real to travel from.
  //
  // The residual is computed at spawn time (see `schedule.ts`) and clamped to a
  // small absolute distance, so a piece crossing the whole board does not come
  // in wildly off-centre.
  let h: number;
  if (p < F_TRAVEL) {
    h = 1 - easeOutCubic(p / F_TRAVEL) * (1 - resid);
  } else if (p < F_SQUASH) {
    h = resid * (1 - easeOutQuad((p - F_TRAVEL) / (F_SQUASH - F_TRAVEL)));
  } else {
    h = 0;
  }

  if (h > 0) {
    o.px += tr.a * h;
    o.pz += tr.c * h;
    // Lean into the direction of travel, straightening exactly as the piece
    // centres. Capped so a long flight cannot cartwheel it.
    const lean = 0.1 * ms * h;
    o.rz += clamp(-tr.a * lean, -0.14, 0.14);
    o.rx += clamp(tr.c * lean, -0.14, 0.14);
  }

  // --- vertical, contact, and settle ---
  if (p < F_TRAVEL) {
    o.py += tr.b + (hover - tr.b) * easeOutQuad(p / F_TRAVEL);
  } else if (p < F_DROP) {
    // The fall: pure gravity, plus a catch at the lip of the recess.
    const q = (p - F_TRAVEL) / (F_DROP - F_TRAVEL);
    let fall = easeInQuad(q);

    // RULES.md §9: "the pieces fit snugly into the board". A snug fit resists
    // for an instant just before it seats. One narrow gaussian dip in the fall
    // curve buys that hesitation for the cost of a single `exp`, and it is the
    // difference between dropping into a hole and dropping into a recess.
    const d = (q - 0.84) / 0.075;
    fall = clamp01(fall - Math.exp(-d * d) * 0.055);

    o.py += hover * (1 - fall);
  } else if (p < F_SQUASH) {
    fireBeat(tr, BEAT_IMPACT);
    const e = easeOutQuad((p - F_DROP) / (F_SQUASH - F_DROP));
    squashInto(
      o,
      1 + (PLACE.squashY - 1) * e * ms * mass,
      1 + (PLACE.squashXZ - 1) * e * ms * mass,
    );
  } else if (p < F_RELEASE) {
    // The click: spring back past rest and return.
    const e = easeOutBack((p - F_SQUASH) / (F_RELEASE - F_SQUASH), PLACE.releaseOvershoot);
    const sqY = 1 + (PLACE.squashY - 1) * ms * mass;
    const sqXZ = 1 + (PLACE.squashXZ - 1) * ms * mass;
    squashInto(o, sqY + (1 - sqY) * e, sqXZ + (1 - sqXZ) * e);
  } else if (MOTION.microDetail) {
    // Secondary bounce and a wobble that damps out. Heavier pieces bounce less
    // and rock more; the solid peg lands crisply and stays put.
    const q = (p - F_RELEASE) / (1 - F_RELEASE);
    o.py += ((u(PLACE.bounceHeight) * ms) / mass) * arc(q);
    const w = PLACE.wobbleAmp * ms * mass * decayingShake(q, 2, 5);
    o.rx += w;
    o.rz += w * 0.6;
  }

  // A brightness spike at contact, decaying through the settle. This is the
  // visual half of the "click"; the audio half hangs off BEAT_IMPACT.
  if (p >= F_DROP) {
    o.emissive += 0.55 * impulse((p - F_DROP) / (1 - F_DROP), 6);
  }

  if (p >= 1) fireBeat(tr, BEAT_SETTLED);
};

/**
 * Slots: a=radiusScale.
 * A shockwave quad expanding out of the space the piece just seated into.
 * Opacity falls faster than the radius grows, so it dissipates rather than
 * simply getting bigger.
 */
UPDATERS[TrackKind.ImpactRing] = (tr, p) => {
  const o = touchOffset(tr.key);
  const s = (IMPACT_RING.scaleFrom + (IMPACT_RING.scaleTo - IMPACT_RING.scaleFrom) * easeOutQuart(p)) * tr.a;
  o.sx *= s;
  o.sz *= s;
  const opacity = IMPACT_RING.peakOpacity * (1 - easeOutCubic(p));
  const f = 1 - opacity;
  if (f > o.fade) o.fade = f;
  // Effect meshes are pooled and permanently mounted, so they must hide
  // themselves again at the end. Without this the ring would settle back to
  // full opacity and sit on the board forever. `playPlacement` clears this
  // static before reusing the slot.
  if (p >= 1) setStatic(tr.key, { sFade: 1 });
};

// ---------------------------------------------------------------------------
// Hover / selection / target indication
// ---------------------------------------------------------------------------

/**
 * Slots: a=target(0|1), b=current, c=liftUnits, d=emissiveBoost.
 *
 * A damper rather than a tween, because the target flips mid-flight whenever a
 * pointer crosses between two cells. Retargeting a damper is free; retargeting
 * a tween means recomputing its start, which is how hover animations end up
 * snapping.
 *
 * On settling at "hovered" the value is latched into the static layer and the
 * track stops, so holding a hover costs no frames.
 */
UPDATERS[TrackKind.Hover] = (tr, _p, dt) => {
  // Entering is faster than leaving: an abrupt un-highlight reads as a glitch,
  // while a slow highlight reads as lag.
  const lambda = tr.a > tr.b ? 26 : 17;
  tr.b = smoothTowards(tr.b, tr.a, lambda, dt);

  if (Math.abs(tr.b - tr.a) < 0.004) {
    tr.b = tr.a;
    if (tr.a > 0) {
      setStatic(tr.key, {
        sLiftY: u(HOVER.lift) * MOTION.motionScale,
        sEmissive: HOVER.emissiveBoost,
      });
    }
    tr.done = true;
    return;
  }

  const o = touchOffset(tr.key);
  o.py += u(HOVER.lift) * MOTION.motionScale * tr.b;
  o.emissive += HOVER.emissiveBoost * tr.b;
};

/**
 * Slots: a=direction (1 reveal, 0 hide).
 * Valid-target indicators popping in and out as a piece is selected.
 */
UPDATERS[TrackKind.TargetReveal] = (tr, p) => {
  const o = touchOffset(tr.key);
  const revealing = tr.a === 1;
  const e = revealing ? easeOutBack(p) : 1 - easeOutQuad(p);
  const s = MOTION.reduced ? 1 : clamp(e, 0, 2);
  o.sx *= s;
  o.sy *= s;
  o.sz *= s;
  const f = revealing ? 1 - easeOutQuad(p) : easeOutQuad(p);
  if (f > o.fade) o.fade = f;
  if (p >= 1) {
    if (!revealing) setStatic(tr.key, { sFade: 1 });
    fireBeat(tr, BEAT_SETTLED);
  }
};

/**
 * Slots: a=phaseOffset.
 *
 * The idle breath on a valid target. Runs ONLY while a piece is selected — a
 * permanently breathing board would hold `frameloop="demand"` open for the
 * whole game. The per-cell phase offset makes the board ripple rather than
 * throb in unison, which is the difference between "alive" and "machine".
 */
UPDATERS[TrackKind.TargetPulse] = (tr) => {
  if (!MOTION.idleLoops) {
    setStatic(tr.key, { sEmissive: TARGET.pulseEmissive * 0.6 });
    tr.done = true;
    return;
  }
  const o = touchOffset(tr.key);
  const phase = tr.t * (TWO_PI / TARGET.pulsePeriod) + tr.a;
  const w = Math.sin(phase);
  const s = 1 + TARGET.pulseAmp * MOTION.motionScale * w;
  o.sx *= s;
  o.sz *= s;
  o.emissive += TARGET.pulseEmissive * (0.5 + 0.5 * w);
};

// ---------------------------------------------------------------------------
// Illegal move rejection
// ---------------------------------------------------------------------------

/**
 * Slots: a=dirX, b=dirZ, c=reducedFlag.
 *
 * Two channels at once, deliberately. A shake can be missed on a phone glanced
 * at from across a table; a colour change can be missed by a colourblind
 * player. Under reduced motion the shake is dropped entirely — it is pure
 * vestibular provocation — and the flash lengthens to carry the whole message.
 */
UPDATERS[TrackKind.Reject] = (tr, p) => {
  const o = touchOffset(tr.key);
  const reduced = tr.c === 1;

  if (!reduced) {
    const s =
      decayingShake(p, REJECT.shakeOsc, REJECT.shakeDecay) *
      u(REJECT.shakeAmp) *
      MOTION.motionScale;
    o.px += s * tr.a;
    o.pz += s * tr.b;
  }

  const f = reduced
    ? flash(p, REJECT.reducedFlashRise, REJECT.reducedFlashHold)
    : flash(p, REJECT.flashRise, REJECT.flashHold);

  tintInto(o, f * REJECT.flashIntensity, 1, 0.12, 0.1);
  o.emissive += f * 0.7;
};

// ---------------------------------------------------------------------------
// Winning
// ---------------------------------------------------------------------------

/**
 * Slots: a=liftHeight, b=spinTurns, c=reducedFlag, d=finalEmissive.
 *
 * A line win (same-size or ordered-size). The stagger that separates the three
 * pieces is applied as a spawn delay, so the wave travels along the line in the
 * order the engine handed us — which for a `'sequence'` win is small, medium,
 * large. Feeding the engine's own ordering straight into the delay means the
 * animation literally draws the winning line in the direction it reads.
 *
 * For sequence wins the caller also ramps `a` with the index, so the three
 * pieces rise to increasing heights and the win becomes a visible staircase.
 */
UPDATERS[TrackKind.WinLine] = (tr, p) => {
  const o = touchOffset(tr.key);

  if (tr.c === 1) {
    // Reduced motion keeps the STAGGER — the direction of the win is still
    // communicated, purely through timing — but drops lift and spin.
    o.emissive += tr.d * (p < 0.5 ? easeOutQuad(p / 0.5) : 1);
    if (p >= 1) setStatic(tr.key, { sEmissive: tr.d * 0.75 });
    return;
  }

  let y: number;
  let spin: number;

  if (p < F_WIN_LIFT) {
    const q = p / F_WIN_LIFT;
    y = tr.a * easeOutBack(q);
    spin = tr.b * TWO_PI * easeInOutCubic(q * 0.7);
  } else if (p < F_WIN_HOLD) {
    const q = (p - F_WIN_LIFT) / (F_WIN_HOLD - F_WIN_LIFT);
    y = tr.a * (1 + 0.04 * Math.sin(q * TWO_PI));
    spin = tr.b * TWO_PI * (0.7 + 0.3 * easeOutQuad(q));
  } else {
    const q = (p - F_WIN_HOLD) / (1 - F_WIN_HOLD);
    y = tr.a * (1 - easeOutQuad(q));
    // A whole number of turns, so the piece lands exactly as it started.
    spin = tr.b * TWO_PI;
    if (q > 0.8) {
      const s = Math.sin(((q - 0.8) / 0.2) * Math.PI);
      squashInto(o, 1 - 0.07 * s, 1 + 0.04 * s);
    }
  }

  o.py += y;
  o.ry += spin;
  o.emissive += tr.d * (p < 0.15 ? p / 0.15 : 1);

  if (p >= 1) setStatic(tr.key, { sEmissive: tr.d * 0.6 });
};

/**
 * Slots: a=separation, b=spinTurns(signed), c=reducedFlag, d=finalEmissive.
 *
 * A nested win — all three sizes concentric in one space — must not read like a
 * line win, so it uses no travel at all. The three pieces separate vertically
 * out of their bullseye, counter-rotate, hold, then slam back together on the
 * same frame. It reads as a lock tumbling shut rather than a line being drawn.
 *
 * Only the small peg and medium ring rise; the large ring stays put, so nothing
 * has to sink into the board and the stack stays legible from a low camera.
 */
UPDATERS[TrackKind.WinNested] = (tr, p) => {
  const o = touchOffset(tr.key);

  if (tr.c === 1) {
    o.emissive += tr.d * (p < 0.5 ? easeOutQuad(p / 0.5) : 1);
    if (p >= 1) setStatic(tr.key, { sEmissive: tr.d * 0.75 });
    return;
  }

  let y: number;
  let spin: number;

  if (p < F_NEST_SEP) {
    const q = p / F_NEST_SEP;
    const e = easeOutCubic(q);
    y = tr.a * e;
    spin = tr.b * TWO_PI * e;
  } else if (p < F_NEST_HOLD) {
    const q = (p - F_NEST_SEP) / (F_NEST_HOLD - F_NEST_SEP);
    y = tr.a * (1 + 0.03 * Math.sin(q * TWO_PI));
    spin = tr.b * TWO_PI;
  } else {
    const q = (p - F_NEST_HOLD) / (1 - F_NEST_HOLD);
    const e = 1 - easeInQuad(q); // gravity slam
    y = tr.a * e;
    spin = tr.b * TWO_PI * e;
  }

  o.py += y;
  o.ry += spin;

  o.emissive +=
    p < F_NEST_HOLD
      ? tr.d * 0.8 * easeOutQuad(p / F_NEST_HOLD)
      : tr.d * (0.8 + 1.0 * easeInQuad((p - F_NEST_HOLD) / (1 - F_NEST_HOLD)));

  if (p >= 1) {
    setStatic(tr.key, { sEmissive: tr.d * 0.6 });
    fireBeat(tr, BEAT_IMPACT);
  }
};

/**
 * Slots: a=targetDim.
 * Everything that is NOT part of the win recedes. This is the highest-value
 * moment of the whole sequence: it isolates the answer before the celebration
 * starts, so the eye is already in the right place when the wave arrives.
 * Latches into the static layer so it persists for free.
 */
UPDATERS[TrackKind.Dim] = (tr, p) => {
  const o = touchOffset(tr.key);
  const v = tr.a * easeOutCubic(p);
  if (v > o.dim) o.dim = v;
  if (p >= 1) setStatic(tr.key, { sDim: tr.a });
};

/**
 * Slots: a=amplitude.
 * The time-boxed winner glow. `dur` is the timeout, so this ends by itself and
 * hands the frame loop back. A celebration that loops forever is a battery bug
 * in a party hat.
 */
UPDATERS[TrackKind.WinnerGlow] = (tr, p) => {
  if (!MOTION.idleLoops) {
    tr.done = true;
    return;
  }
  const o = touchOffset(tr.key);
  const phase = tr.t * (TWO_PI / WIN.idleGlowPeriod);
  // Fade the glow out over the last 20% so it stops rather than being cut.
  const envelope = p > 0.8 ? 1 - (p - 0.8) / 0.2 : 1;
  o.emissive += tr.a * envelope * (0.5 + 0.5 * Math.sin(phase));
};

// ---------------------------------------------------------------------------
// Game start / reset
// ---------------------------------------------------------------------------

/**
 * Slots: a=dropHeight, b=reducedFlag.
 * Pieces cascading into their storage arms at game start. Reuses the placement
 * fall and squash so the game's physical vocabulary is established in the first
 * half second, before the player has made a single move.
 */
UPDATERS[TrackKind.Enter] = (tr, p) => {
  const o = touchOffset(tr.key);

  if (tr.b === 1) {
    const f = 1 - easeOutQuad(p);
    if (f > o.fade) o.fade = f;
    return;
  }

  const fall = easeInQuad(p);
  o.py += tr.a * (1 - fall);

  const f = 1 - clamp01(p / 0.3);
  if (f > o.fade) o.fade = f;

  if (p > 0.86) {
    const s = Math.sin(((p - 0.86) / 0.14) * Math.PI);
    squashInto(o, 1 - 0.1 * s * MOTION.motionScale, 1 + 0.06 * s * MOTION.motionScale);
  }
  if (p >= 1) fireBeat(tr, BEAT_IMPACT);
};

/**
 * Slots: a=liftHeight, b=reducedFlag.
 * Reset. The entrance run backwards — pieces lift away and fade upward — which
 * is what makes it read as "undo" rather than "something else happened".
 */
UPDATERS[TrackKind.Exit] = (tr, p) => {
  const o = touchOffset(tr.key);
  if (tr.b !== 1) {
    o.py += tr.a * easeInQuad(p);
    const shrink = 1 - 0.15 * p * MOTION.motionScale;
    o.sx *= shrink;
    o.sy *= shrink;
    o.sz *= shrink;
  }
  const f = easeOutQuad(p);
  if (f > o.fade) o.fade = f;
  if (p >= 1) setStatic(tr.key, { sFade: 1 });
};

// ---------------------------------------------------------------------------
// Turn transitions
// ---------------------------------------------------------------------------

/**
 * Slots: a=fromLift, b=toLift, c=fromDim, d=toDim.
 * The active colour's storage arm rises and brightens; waiting arms settle back
 * and dim. Latches, so a whole turn of thinking time costs nothing.
 */
UPDATERS[TrackKind.TurnTray] = (tr, p) => {
  if (p >= 1) {
    // Latch and return WITHOUT accumulating. Doing both in the same frame
    // would apply the lift twice — once from the offset, once from the static
    // we just wrote — and a 0.06 tray jump for one frame is very visible.
    // Returning early is safe: the key was active last frame, so the runner
    // still applies it once at identity plus the new static.
    setStatic(tr.key, { sLiftY: tr.b, sDim: tr.d });
    return;
  }
  const o = touchOffset(tr.key);
  const e = easeOutCubic(p);
  o.py += tr.a + (tr.b - tr.a) * e;
  const d = tr.c + (tr.d - tr.c) * e;
  if (d > o.dim) o.dim = d;
};

/**
 * Slots: a=fromAngle, b=toAngle, c=isColorSwap, d=toPlayer, e=fromPlayer.
 *
 * Writes channels only — the rim belongs to the board agent's material.
 *
 * The band travels from the outgoing colour's arm to the incoming one, and the
 * DIRECTION OF TRAVEL is the message: you can see whose turn it became, and
 * from whom, without reading a word. That is what makes it legible on a phone
 * lying on a table three feet away.
 *
 * `easeInOutCubic` gives the sweep a subject and an object — it accelerates
 * away from the old arm and decelerates into the new one.
 */
UPDATERS[TrackKind.TurnSweep] = (tr, p) => {
  CH.turnSweepAngle = tr.a + (tr.b - tr.a) * easeInOutCubic(p);
  CH.turnSweepStrength = flash(p, 0.15, 0.55);
  CH.turnSweepIsColorSwap = tr.c;
  CH.turnSweepSource = tr.e;
  CH.turnSweepTarget = tr.d;
  CH.activeArmGlow = easeOutCubic(p);

  if (p >= 1) {
    CH.turnSweepStrength = 0;
    CH.turnSweepSource = -1;
    CH.turnSweepTarget = -1;
    CH.turnSweepIsColorSwap = 0;
    CH.activeColor = tr.d;
    CH.activeArmGlow = 1;
  }
};

/**
 * Slots: (none) — key is the skipped player's arm.
 * A colour that had no legal placement gets a brief grey flash as the turn
 * passes over it, so "blue was skipped" is something you see happen rather
 * than something you have to read in a log.
 */
UPDATERS[TrackKind.Skipped] = (tr, p) => {
  const o = touchOffset(tr.key);
  const w = flash(p, 0.2, 0.2);
  o.emissive += 0.35 * w;
  tintInto(o, 0.5 * w, 0.45, 0.45, 0.48);
};

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * Slots: a=desaturateTarget, b=trayDrop, c=playerIndex.
 *
 * A player leaving. Their pieces are NOT removed — the rules engine keeps them
 * on the board — so this has to say "gone" without deleting anything. Grey and
 * a dropped arm do that, and nothing on the playing area moves, which matters
 * because a departure must never look like a move.
 */
UPDATERS[TrackKind.PresenceLeave] = (tr, p) => {
  if (p >= 1) {
    // Latch and return — see the note on `TurnTray`. Accumulating as well
    // would drop the arm twice for one frame.
    if (tr.c >= 0) CH.playerPresence[tr.c] = 0.25;
    setStatic(tr.key, {
      sDim: tr.a,
      sTintA: 0.6,
      sTintR: 0.45,
      sTintG: 0.45,
      sTintB: 0.48,
      sLiftY: -tr.b,
    });
    return;
  }
  const o = touchOffset(tr.key);
  const e = easeOutQuad(p);
  const d = tr.a * e;
  if (d > o.dim) o.dim = d;
  tintInto(o, 0.6 * e, 0.45, 0.45, 0.48);
  o.py -= tr.b * e;
  if (tr.c >= 0) CH.playerPresence[tr.c] = 1 - 0.75 * e;
};

/**
 * Slots: a=fromDim, b=playerIndex.
 * A player joining, or reconnecting: colour washes back in and the arm rises.
 */
UPDATERS[TrackKind.PresenceJoin] = (tr, p) => {
  const o = touchOffset(tr.key);
  const e = easeOutCubic(p);
  const remain = 1 - e;
  const d = tr.a * remain;
  if (d > o.dim) o.dim = d;
  tintInto(o, 0.6 * remain, 0.45, 0.45, 0.48);
  o.emissive += 0.4 * arc(p);
  if (tr.b >= 0) CH.playerPresence[tr.b] = 0.25 + 0.75 * e;
  if (p >= 1) setStatic(tr.key, { sDim: 0, sTintA: 0, sLiftY: 0 });
};

/**
 * Slots: a=amplitude.
 *
 * A draw. The rulebook is emphatic that a tie means "pat each other on the
 * back: You all win!", so this is deliberately NOT the win animation with the
 * colour drained out. Nothing dims, nobody is singled out — every piece on the
 * board lifts and brightens in a wave travelling out from the centre. The
 * stagger is set by distance from the middle, so a full 3-player board (27
 * pieces into 27 slots, which always fills) blooms outward as one gesture.
 */
UPDATERS[TrackKind.DrawWave] = (tr, p) => {
  const o = touchOffset(tr.key);
  const w = Math.sin(clamp01(p) * Math.PI);
  o.py += tr.a * w;
  o.emissive += 0.85 * w;
  squashInto(o, 1 + 0.03 * w, 1 + 0.02 * w);
};

/**
 * Slots: a=mode, b=centreX, c=centreZ, d=maxRadius.
 *
 * Board-wide light effects. These write channels instead of offsets because the
 * board's material belongs to the scene agent — see `channels.ts`. Each mode
 * returns its channel to neutral on the final frame, so a consumer never has to
 * reset anything itself.
 */
UPDATERS[TrackKind.BoardFx] = (tr, p) => {
  switch (tr.a) {
    case BOARD_FX_WIN_SWEEP: {
      CH.winSweepX = tr.b;
      CH.winSweepZ = tr.c;
      // Expands fast then creeps, like light spreading rather than a ring
      // being drawn.
      CH.winSweepRadius = tr.d * (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
      CH.winSweepStrength = 1 - easeInQuad(p);
      if (p >= 1) {
        CH.winSweepStrength = 0;
        CH.winSweepRadius = 0;
      }
      break;
    }
    case BOARD_FX_PULSE: {
      CH.boardPulse = Math.sin(clamp01(p) * Math.PI);
      if (p >= 1) CH.boardPulse = 0;
      break;
    }
    case BOARD_FX_DRAW: {
      CH.drawWave = flash(p, 0.25, 0.4);
      if (p >= 1) CH.drawWave = 0;
      break;
    }
    default:
      break;
  }
};

/** `BoardFx` modes. */
export const BOARD_FX_WIN_SWEEP = 0;
export const BOARD_FX_PULSE = 1;
export const BOARD_FX_DRAW = 2;

/**
 * Slots: a,b,c = target position; d,e,f = current position.
 *
 * The drag preview chasing a finger. Critically damped by construction — a
 * spring with overshoot feels like the piece is slipping out of your hand, and
 * on a touch screen where the finger occludes the piece anyway, lag reads as
 * broken rather than as weight.
 *
 * `smoothTowards` rather than a fixed lerp factor, so the follow feels the same
 * on a 60Hz phone and a 120Hz one.
 */
UPDATERS[TrackKind.Ghost] = (tr, _p, dt) => {
  const l = TARGET.ghostLambda;
  tr.d = smoothTowards(tr.d, tr.a, l, dt);
  tr.e = smoothTowards(tr.e, tr.b, l, dt);
  tr.f = smoothTowards(tr.f, tr.c, l, dt);

  const o = touchOffset(tr.key);
  o.px += tr.d;
  o.py += tr.e;
  o.pz += tr.f;
  const f = 1 - TARGET.ghostOpacity;
  if (f > o.fade) o.fade = f;
};

// ---------------------------------------------------------------------------
// Safety net
// ---------------------------------------------------------------------------

// A kind with no updater would throw inside the frame loop and take the canvas
// down with it. Fill any gap with a no-op that retires the track immediately.
for (let i = 0; i < TrackKind.Count; i++) {
  if (typeof UPDATERS[i] !== 'function') {
    UPDATERS[i] = (tr) => {
      tr.done = true;
    };
  }
}

/** Natural durations, exported so schedulers can compute total sequence length. */
export const NATURAL = {
  place: PLACE_NATURAL_DUR,
  winLine: WIN_LINE_NATURAL_DUR,
  winNested: WIN_NESTED_NATURAL_DUR,
  turn: Math.max(TURN.sweepDur, TURN.trayDur),
  start: START.boardDur,
  reset: RESET.liftDur,
  presenceJoin: PRESENCE.joinDur,
  presenceLeave: PRESENCE.leaveDur,
} as const;
