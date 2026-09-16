/**
 * Animation design tokens.
 *
 * Every duration and easing decision in the game lives here so the motion
 * language stays coherent. Durations are in SECONDS (matching `useFrame` dt),
 * not milliseconds — converting in the hot loop is a pointless multiply.
 *
 * The house rules these numbers follow:
 *
 *  1. **Feedback under 150ms reads as instant.** Hover, press, and selection
 *     feedback must land inside that window or the game feels laggy, which is
 *     fatal in a 4-player networked game where real latency already exists.
 *  2. **State changes get 250-450ms.** Long enough to be seen and understood,
 *     short enough that a fast player never waits on it.
 *  3. **Payoff moments get 1.0-1.6s.** Only the win. Nothing else earns it.
 *  4. **Nothing blocks input, ever.** These durations describe pixels, not
 *     turns. The rules engine has already committed the move at t=0.
 */

import {
  easeInOutCubic,
  easeInQuad,
  easeOutBack,
  easeOutCubic,
  easeOutExpo,
  easeOutQuad,
  easeOutQuart,
  type Easing,
} from './easing';

// ---------------------------------------------------------------------------
// Placement — the core interaction, seen hundreds of times per game
// ---------------------------------------------------------------------------

export const PLACE = {
  /**
   * Travel from the piece's origin (tray slot, or the player's fingertip) to a
   * hold point directly above the target cell.
   *
   * 0.22s is deliberately short. This phase is transport, not drama — the
   * information ("that piece, that cell") is already delivered by the time it
   * arrives. Dragging it out makes the game feel slow on move 40.
   */
  travelDur: 0.22,
  /**
   * Horizontal and vertical are eased SEPARATELY and this is the whole trick.
   *
   * During transport, XZ decelerates into the space (easeOutCubic) while Y
   * decelerates into the top of its arc (easeOutQuad) — the shape of a thrown
   * object arriving. Then the drop reverses it and Y accelerates under gravity
   * (easeInQuad, below).
   *
   * Ease every axis with one curve and you get a tween. Split them and you get
   * an object with mass.
   */
  travelEaseXZ: easeOutCubic as Easing,
  travelEaseY: easeOutQuad as Easing,
  /** Height above the board the piece passes through before the drop. */
  hoverHeight: 0.42,

  /**
   * The drop. Pure gravity over a short distance, so it is *fast* — 0.13s for
   * 0.42 units. Anything slower and the piece floats down like a leaf.
   */
  dropDur: 0.13,
  dropEase: easeInQuad as Easing,

  /**
   * Impact squash. 55ms is roughly two frames at 30fps and three at 60 — right
   * at the edge of perceptible, which is exactly where squash belongs. You
   * should feel it without being able to point at it.
   */
  squashDur: 0.055,
  squashY: 0.87, // vertical compression at peak
  squashXZ: 1.055, // volume-preserving-ish bulge
  squashEase: easeOutQuad as Easing,

  /**
   * Release from squash back to rest, with a small overshoot. easeOutBack's
   * overshoot here is the "click" of the piece seating into the board groove.
   */
  releaseDur: 0.13,
  releaseEase: easeOutBack as Easing,
  releaseOvershoot: 1.9, // stronger than the default; it is a hard surface

  /**
   * Secondary bounce — 12% of the drop height, gravity-shaped. Real objects
   * bounce more than once; one visible secondary is the cheapest way to say
   * "this is a physical thing" without simulating anything.
   */
  bounceHeight: 0.052,
  bounceDur: 0.115,

  /**
   * Micro-wobble on landing: a tiny tilt that damps out. Amplitude is under a
   * degree and a half — invisible if you look for it, felt if you do not.
   */
  wobbleAmp: 0.026, // radians (~1.5deg)
  wobbleDur: 0.2,

  /** Total wall-clock for the full placement chord. */
  get totalDur(): number {
    return this.travelDur + this.dropDur + this.squashDur + this.releaseDur + this.bounceDur;
  },

  /**
   * Reduced-motion variant: no travel, no drop, no squash. The piece simply
   * resolves in place with an opacity + emissive rise. 0.16s because with the
   * movement gone the *only* remaining signal is this fade, so it must be
   * unhurried enough to catch the eye but not so slow it feels broken.
   */
  reducedDur: 0.16,
  reducedEase: easeOutQuad as Easing,
} as const;

/** The shockwave ring that expands from the cell on impact. */
export const IMPACT_RING = {
  dur: 0.26,
  /** Starts at the piece's own radius and expands to ~2.1x. */
  scaleFrom: 0.9,
  scaleTo: 2.1,
  /** Opacity falls off faster than the scale grows, so it dissipates. */
  scaleEase: easeOutQuart as Easing,
  fadeEase: easeOutCubic as Easing,
  peakOpacity: 0.55,
} as const;

// ---------------------------------------------------------------------------
// Hover / selection / valid-target indication
// ---------------------------------------------------------------------------

export const HOVER = {
  /**
   * 0.11s. Hover feedback is the one place where "instant" beats "smooth".
   * Above ~150ms a hover highlight feels like it is thinking about it.
   */
  dur: 0.11,
  ease: easeOutQuad as Easing,
  lift: 0.022,
  emissiveBoost: 0.45,
  /** Leaving is slower than entering — abrupt un-highlight reads as a glitch. */
  outDur: 0.17,
} as const;

export const TARGET = {
  /** Valid cells rising into view when a piece gets selected. */
  revealDur: 0.19,
  revealEase: easeOutBack as Easing,
  revealStagger: 0.016, // ripples outward from the selected piece
  hideDur: 0.13,
  hideEase: easeOutQuad as Easing,

  /**
   * Idle breathing on valid targets.
   *
   * IMPORTANT: this runs ONLY while a piece is actually selected. A permanently
   * breathing indicator would pin `frameloop="demand"` awake for the entire
   * game and cook the battery on the four phones this has to run on.
   *
   * 1.8s period is slower than a resting breath (~4s) but slower than a
   * heartbeat — fast enough to read as "live", slow enough not to nag.
   */
  pulsePeriod: 1.8,
  pulseAmp: 0.035, // scale, ±3.5%
  pulseEmissive: 0.22,
  /** Per-cell phase offset spread, so the board ripples instead of throbbing. */
  pulsePhaseSpread: 0.55,

  /** Ghost piece following the pointer. Critically damped: overshoot on a */
  /** cursor-follower feels like the piece is slipping out of your hand. */
  ghostLambda: 22,
  ghostOpacity: 0.42,
} as const;

// ---------------------------------------------------------------------------
// Illegal move rejection
// ---------------------------------------------------------------------------

export const REJECT = {
  /**
   * 0.3s of damped shake at 3.5 oscillations. Long enough to register as
   * deliberate refusal, short enough that a player mashing a bad cell does not
   * queue up a second of jitter.
   */
  shakeDur: 0.3,
  shakeAmp: 0.055,
  shakeOsc: 3.5,
  shakeDecay: 4.2,

  /**
   * Colour is the second channel. Shake alone can be missed on a phone glanced
   * at from across a table; colour alone can be missed by a colourblind player.
   * Both, always.
   */
  flashDur: 0.32,
  flashRise: 0.19,
  flashHold: 0.13,
  flashIntensity: 1.0,

  /** Haptic pulse in ms — short and dry, not a buzz. */
  hapticMs: 28,

  /**
   * Reduced motion: the shake is removed entirely (it is pure vestibular
   * provocation), so the flash carries the whole message and gets longer and
   * brighter to compensate.
   */
  reducedFlashDur: 0.46,
  reducedFlashRise: 0.17,
  reducedFlashHold: 0.3,
} as const;

// ---------------------------------------------------------------------------
// Turn transitions
// ---------------------------------------------------------------------------

export const TURN = {
  /**
   * The rim sweep travels around the board perimeter from the outgoing player's
   * side to the incoming player's side. The *direction of travel* is the
   * message: you can tell whose turn it became, and from whom, without reading
   * anything. This is what makes it legible on a phone across a table.
   *
   * 0.42s with easeInOutCubic — it accelerates away from the old player and
   * decelerates into the new one, which gives the sweep a subject and an object.
   */
  sweepDur: 0.42,
  sweepEase: easeInOutCubic as Easing,
  /** Angular width of the travelling bright band, in turns (0..1). */
  sweepWidth: 0.16,

  /** Active player's tray rises; outgoing tray settles back. */
  trayLift: 0.06,
  trayDur: 0.3,
  trayEase: easeOutCubic as Easing,
  trayDimInactive: 0.55, // brightness multiplier for waiting players

  /** A pulse ring under the incoming player's tray, to pull the eye there. */
  pulseDur: 0.5,
  pulseEase: easeOutQuart as Easing,
  pulseScaleTo: 2.6,

  /**
   * Reduced motion: no sweep travel, no tray lift. Instead the rim cross-fades
   * from the old player's colour to the new one over 0.3s and the tray
   * brightness swaps. The state change stays completely unambiguous; only the
   * movement is gone.
   */
  reducedDur: 0.3,
  reducedEase: easeOutQuad as Easing,
} as const;

// ---------------------------------------------------------------------------
// Winning
// ---------------------------------------------------------------------------

export const WIN = {
  /**
   * Everything that is NOT part of the win dims first. This is the single
   * highest-value frame of the whole sequence — it isolates the answer before
   * the celebration starts, so the eye is already in the right place.
   */
  dimDur: 0.4,
  dimEase: easeOutCubic as Easing,
  dimAmount: 0.45, // non-winning pieces drop to 55% brightness
  dimDelay: 0.06,

  /**
   * LINE win (row / column / diagonal / ascending-descending across cells).
   * A travelling wave along the winning cells IN BOARD ORDER. The stagger
   * direction is the line direction — the animation draws the line for you.
   */
  line: {
    stagger: 0.09, // per-cell delay along the line
    liftDur: 0.34,
    liftHeight: 0.2,
    liftEase: easeOutBack as Easing,
    spinTurns: 1, // one full revolution while lifted
    spinDur: 0.6,
    holdDur: 0.26,
    /** All three settle back together — the wave goes out, the answer lands. */
    settleDur: 0.24,
    settleEase: easeOutQuad as Easing,
  },

  /**
   * NESTED win (small + medium + large in one cell). Must feel categorically
   * different from a line, so it uses no travel at all: the three rings
   * SEPARATE vertically, counter-rotate, then slam back together. It reads as a
   * lock tumbling shut rather than a line being drawn.
   */
  nested: {
    separateDur: 0.34,
    separateEase: easeOutCubic as Easing,
    separation: 0.18, // vertical gap between adjacent rings
    counterSpinDur: 0.52,
    counterSpinTurns: 0.5, // alternating sign per ring
    holdDur: 0.18,
    /** The slam is fast and lands all three on the same frame. */
    slamDur: 0.14,
    slamEase: easeInQuad as Easing,
    slamRingScale: 3.0,
  },

  /** Radial light sweep outward from the win centroid across the board. */
  sweepDur: 0.7,
  sweepEase: easeOutExpo as Easing,

  /**
   * Post-celebration idle glow on the winning pieces. Deliberately TIME-BOXED:
   * after this many seconds it stops and releases the frame loop back to sleep.
   * A permanent celebration loop is a battery bug wearing a party hat.
   */
  idleGlowPeriod: 2.4,
  idleGlowAmp: 0.3,
  idleGlowTimeout: 6.0,

  /**
   * Reduced motion: no lift, no spin, no separation. The STAGGER IS KEPT — the
   * winning pieces brighten in line order, so the direction of the win is still
   * communicated, purely through timing. Nested wins brighten outward from the
   * smallest ring instead, preserving the distinction.
   */
  reducedStagger: 0.11,
  reducedDur: 0.3,
} as const;

// ---------------------------------------------------------------------------
// Game start / reset / presence
// ---------------------------------------------------------------------------

export const START = {
  /** Board scales up from slightly small with a soft overshoot. */
  boardDur: 0.52,
  boardEase: easeOutBack as Easing,
  boardScaleFrom: 0.94,

  /**
   * Pieces cascade into their trays reusing the exact placement drop, so the
   * game's physical language is established in the first half-second. Stagger
   * is by player, then by size — you watch each seat get dealt in.
   */
  pieceStagger: 0.04,
  playerStagger: 0.12,
  dropFrom: 0.9, // higher than a normal placement; it is an entrance

  reducedDur: 0.34,
} as const;

export const RESET = {
  /**
   * The inverse of START, played in reverse order: pieces lift away and fade
   * upward. Running the entrance backwards is what makes it read as "undo"
   * rather than "something else happened".
   */
  liftDur: 0.38,
  liftHeight: 0.7,
  liftEase: easeInQuad as Easing, // mirror of the gravity drop
  stagger: 0.028,
  /** Gap before the new game cascades in. */
  gap: 0.1,
  reducedDur: 0.26,
} as const;

export const PRESENCE = {
  /** A player joining: their tray + pieces cascade in, their colour washes in. */
  joinDur: 0.5,
  joinEase: easeOutCubic as Easing,
  joinStagger: 0.045,

  /**
   * A player leaving. Their pieces are NOT removed — the game state keeps them
   * on the board — so the animation has to say "gone" without deleting
   * anything. Desaturate to grey and drop the tray. Nothing moves on the board.
   */
  leaveDur: 0.34,
  leaveEase: easeOutQuad as Easing,
  leaveDesaturate: 0.85,
  leaveTrayDrop: 0.045,
} as const;

// ---------------------------------------------------------------------------
// Network move queue pacing
// ---------------------------------------------------------------------------

export const QUEUE = {
  /**
   * Minimum gap between two placement animations starting. Two remote moves
   * arriving in the same tick must not begin on the same frame — they would
   * read as one event. 0.11s is enough separation to count them.
   */
  minStagger: 0.11,

  /**
   * Catch-up. If the backlog exceeds `fastForwardAt`, we compress: shorter
   * stagger and scaled-down durations. This is the reconnect case, where a
   * client can receive a burst of moves it missed.
   */
  fastForwardAt: 4,
  fastStagger: 0.035,
  fastDurationScale: 0.5,

  /**
   * Beyond this, do not animate at all — snap the board to truth and play a
   * single "synced" pulse. Replaying twenty moves as a cutscene while the
   * player waits is worse than not animating.
   */
  snapAt: 8,
  snapPulseDur: 0.34,

  /** A queued animation older than this is stale; snap it instead. */
  staleAfter: 1.5,
} as const;
