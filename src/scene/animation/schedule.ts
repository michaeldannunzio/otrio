/**
 * The imperative animation API.
 *
 * Everything the rest of the app can ask for, as plain functions. Deliberately
 * not hooks: a WebSocket message arriving at 3am in the React lifecycle has no
 * component to hang a hook off, and the whole point of the offset architecture
 * is that animation is a side effect on the renderer rather than a piece of
 * application state.
 *
 * Every function here is:
 *  - **idempotent** where it can be — calling `playPlacement` twice for the same
 *    slot animates once. `net/protocol.ts` explicitly permits duplicate events,
 *    so this is a correctness requirement, not a nicety.
 *  - **non-blocking** — nothing returns a promise, nothing can be awaited, and
 *    the game state is never consulted before committing a move.
 *  - **safe to call before the scene mounts** — unbound keys animate nothing and
 *    cost nothing.
 */

import {
  SIZES,
  SIZE_ORDER,
  type PlayerId,
  type Size,
  type SpaceIndex,
} from '../../game/types';
import type { AnimatableBoard, AnimatableWin } from './core/view';
import { CH, resetChannels } from './core/channels';
import { hash01 } from './core/easing';
import {
  BOARD_SLOT_COUNT,
  GHOST_KEY,
  indicatorForSlot,
  nextEffectKey,
  RESERVE_BASE,
  RESERVE_COUNT,
  reserveKey,
  slotKey,
  trayKey,
} from './core/ids';
import { armAngleOf, LAYOUT, shortestAngle, u } from './core/layout';
import {
  clearAllStatic,
  clearStatic,
  getBinding,
  setBase,
  setStatic,
} from './core/offsets';
import { dur, haptic, MOTION } from './core/prefs';
import { runner } from './core/runner';
import {
  IMPACT_RING,
  PLACE,
  PRESENCE,
  REJECT,
  RESET,
  START,
  TARGET,
  TURN,
  WIN,
} from './core/timing';
import { BEAT_IMPACT, Track, TrackKind } from './core/track';
import {
  BOARD_FX_DRAW,
  BOARD_FX_PULSE,
  BOARD_FX_WIN_SWEEP,
  NATURAL,
  PLACE_IMPACT_FRACTION,
} from './core/tracks';

const TWO_PI = Math.PI * 2;

/** Impact ring radius per size rank. A large ring displaces more air. */
const RING_SCALE = [0.55, 0.8, 1.05];

/**
 * Rings of the 3x3 grid measured from the centre space, used to stagger
 * board-wide waves outward. Space 4 is the centre, then edges, then corners.
 */
const RING_DISTANCE = [2, 1, 2, 1, 0, 1, 2, 1, 2];

/** Scratch flags for "is this slot part of the win". Reused, never allocated. */
const winFlags = new Uint8Array(BOARD_SLOT_COUNT);

/** Which target indicators are currently shown, so we know what to hide. */
const shownIndicators = new Uint8Array(BOARD_SLOT_COUNT);

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export interface PlacementOptions {
  /**
   * Where the piece starts, as a delta from its final resting place, in world
   * units.
   *
   * Supply this for a LOCAL move, where the piece has a real starting position
   * (its storage space, or wherever the player's finger released it) and the
   * animation should be continuous with the gesture.
   *
   * Omit it for a REMOTE move. The piece then flies in from the moving colour's
   * storage arm, which is both truthful and more informative than a fade —
   * you see *who* moved from the direction the piece came from.
   */
  from?: { x: number; y: number; z: number };

  /** Multiplier on playback rate. The move queue raises this to catch up. */
  speed?: number;

  /** Stagger, in seconds. */
  delay?: number;

  /** True when this device made the move; enables the placement haptic. */
  local?: boolean;

  /**
   * Fires once when the piece touches the board, and again when it fully
   * settles. This is the hook for the recess "click" — RULES.md §9 notes the
   * solid peg and the hollow rings sound different, and `size` is recoverable
   * from the key via `slotSizeRank`.
   */
  onBeat?: (key: number, beat: number) => void;
}

/**
 * Animate a piece into a board slot.
 *
 * Returns false if an animation for this slot is already running, which is the
 * duplicate-event case and is not an error.
 */
export function playPlacement(
  space: SpaceIndex,
  size: Size,
  player: number,
  opts: PlacementOptions = {},
): boolean {
  const key = slotKey(space, size);
  if (runner.has(TrackKind.Place, key)) return false;

  // A rematch reuses the same slots, so clear anything latched from last game.
  clearStatic(key);

  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const delay = opts.delay ?? 0;
  const userBeat = opts.onBeat;
  const wantHaptic = opts.local === true;

  const onBeat =
    userBeat || wantHaptic
      ? (k: number, beat: number) => {
          // A short dry tick, not a buzz — this is a piece seating, not an error.
          if (wantHaptic && beat === BEAT_IMPACT) haptic(12);
          userBeat?.(k, beat);
        }
      : null;

  if (MOTION.reduced) {
    const tr = runner.spawn(TrackKind.Place, key, dur(PLACE.reducedDur) / speed, delay);
    tr.d = 1;
    tr.onBeat = onBeat;
    return true;
  }

  const binding = getBinding(key);
  let dx = 0;
  let dy = 0;
  let dz = 0;

  if (opts.from) {
    dx = opts.from.x;
    dy = opts.from.y;
    dz = opts.from.z;
  } else if (binding) {
    // No gesture to continue — this is a remote move. Fly it in from the
    // moving colour's arm so the direction identifies the player.
    const ang = armAngleOf(player);
    dx = Math.sin(ang) * LAYOUT.armRadius - binding.baseX;
    dz = Math.cos(ang) * LAYOUT.armRadius - binding.baseZ;
  }

  const total = dur(NATURAL.place) / speed;
  const tr = runner.spawn(TrackKind.Place, key, total, delay);
  tr.a = dx;
  tr.b = dy;
  tr.c = dz;
  tr.d = 0;
  tr.e = SIZE_ORDER[size];
  tr.onBeat = onBeat;

  // How far off-centre the piece arrives before the recess guides it in. Given
  // as a fraction of the approach vector, clamped to a small absolute distance
  // so a piece crossing the whole board does not come in wildly off-line. A
  // piece dropped straight down gets none — there is nothing to correct.
  const approach = Math.max(Math.abs(dx), Math.abs(dz));
  tr.f = approach > 1e-4 ? Math.min(0.08, u(0.05) / approach) : 0;

  if (MOTION.effects && binding) {
    const ek = nextEffectKey();
    clearStatic(ek);
    // Sit the ring just proud of the board so it does not z-fight the inlay.
    setBase(ek, binding.baseX, LAYOUT.surfaceY + u(0.004), binding.baseZ);
    const ring = runner.spawn(
      TrackKind.ImpactRing,
      ek,
      dur(IMPACT_RING.dur) / speed,
      delay + total * PLACE_IMPACT_FRACTION,
    );
    ring.a = RING_SCALE[SIZE_ORDER[size]];
  }

  return true;
}

/**
 * Snap a slot to its resting state with no animation.
 *
 * Used by the move queue when a backlog is too deep to be worth replaying, and
 * on reconnect. Because the piece already renders at truth, this is literally
 * just cancelling whatever was in flight.
 */
export function snapPlacement(space: SpaceIndex, size: Size): void {
  const key = slotKey(space, size);
  runner.cancel(TrackKind.Place, key);
  clearStatic(key);
}

// ---------------------------------------------------------------------------
// Hover / selection / valid targets
// ---------------------------------------------------------------------------

/**
 * Hover feedback on any bound object.
 *
 * Implemented as a damper, so moving a pointer quickly across several cells
 * produces smooth handoffs rather than a queue of competing tweens.
 */
export function playHover(key: number, hovered: boolean): void {
  const existing = runner.has(TrackKind.Hover, key);
  runner.cancel(TrackKind.Hover, key);

  if (!hovered) {
    // Release the latched value first, then animate down from it.
    setStatic(key, { sLiftY: 0, sEmissive: 0 });
  }

  const tr = runner.spawn(TrackKind.Hover, key, 3600);
  tr.a = hovered ? 1 : 0;
  // Start from the opposite end unless we interrupted a live transition, in
  // which case starting from 0/1 is close enough and avoids reading back state.
  tr.b = hovered ? (existing ? 0.35 : 0) : 1;
}

export interface TargetOptions {
  /**
   * Slots the current player may legally fill. The caller gets these from the
   * rules engine — the animation layer never decides legality.
   */
  slots: readonly { space: SpaceIndex; size: Size }[];
  /** Ripple the reveal outward from this space, if the selection has an origin. */
  originSpace?: SpaceIndex;
}

/**
 * Show where the held piece may legally go.
 *
 * On touch there is no hover, so this is driven by *selection* — tap a piece,
 * the legal slots light up. On mouse it runs alongside hover. Both paths are
 * the same code; only the trigger differs.
 */
export function showValidTargets({ slots, originSpace }: TargetOptions): void {
  hideValidTargets();

  const origin = originSpace ?? 4;

  for (let i = 0; i < slots.length; i++) {
    const { space, size } = slots[i];
    const slot = slotKey(space, size);
    const key = indicatorForSlot(slot);
    shownIndicators[slot] = 1;

    clearStatic(key);

    // Ripple outward from the origin so the set reads as one gesture rather
    // than nine things appearing at once.
    const ring = Math.abs(RING_DISTANCE[space] - RING_DISTANCE[origin]);
    const reveal = runner.spawn(
      TrackKind.TargetReveal,
      key,
      dur(TARGET.revealDur),
      ring * TARGET.revealStagger,
    );
    reveal.a = 1;

    // The idle breath. Only while a piece is held — see `TargetPulse`.
    if (MOTION.idleLoops && !MOTION.reduced) {
      const pulse = runner.spawn(TrackKind.TargetPulse, key, 3600, dur(TARGET.revealDur));
      pulse.a = hash01(slot) * TWO_PI * TARGET.pulsePhaseSpread;
    } else {
      setStatic(key, { sEmissive: TARGET.pulseEmissive * 0.6 });
    }
  }
}

/** Put the target indicators away. */
export function hideValidTargets(): void {
  for (let slot = 0; slot < BOARD_SLOT_COUNT; slot++) {
    if (!shownIndicators[slot]) continue;
    shownIndicators[slot] = 0;
    const key = indicatorForSlot(slot);
    runner.cancel(TrackKind.TargetPulse, key);
    runner.cancel(TrackKind.TargetReveal, key);
    setStatic(key, { sEmissive: 0 });
    const hide = runner.spawn(TrackKind.TargetReveal, key, dur(TARGET.hideDur));
    hide.a = 0;
  }
}

// ---------------------------------------------------------------------------
// Drag preview
// ---------------------------------------------------------------------------

let ghostTrack: Track | null = null;

/**
 * Begin a drag preview at a world position.
 *
 * The animation layer owns the ghost's MOTION; the pieces agent owns its MESH.
 * Bind any translucent piece to `GHOST_KEY` with `useAnimatedPiece` and it will
 * follow. This split exists because ghost geometry is piece geometry, and there
 * should be exactly one definition of what a medium ring looks like.
 */
export function startGhost(x: number, y: number, z: number): void {
  endGhost();
  clearStatic(GHOST_KEY);
  const tr = runner.spawn(TrackKind.Ghost, GHOST_KEY, 3600);
  tr.a = tr.d = x;
  tr.b = tr.e = y;
  tr.c = tr.f = z;
  ghostTrack = tr;
}

/**
 * Retarget the drag preview. Safe to call on every pointer move — it writes six
 * numbers and requests a frame, and allocates nothing.
 */
export function moveGhost(x: number, y: number, z: number): void {
  if (!ghostTrack || ghostTrack.done) return;
  ghostTrack.a = x;
  ghostTrack.b = y;
  ghostTrack.c = z;
  runner.wake();
}

/** End the drag preview and hide the mesh. */
export function endGhost(): void {
  runner.cancel(TrackKind.Ghost, GHOST_KEY);
  ghostTrack = null;
  setStatic(GHOST_KEY, { sFade: 1 });
}

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

export interface RejectOptions {
  /** Shake axis in the board plane. Defaults to the board's X axis. */
  dirX?: number;
  dirZ?: number;
  /** Suppress the haptic (e.g. this rejection was not caused by this device). */
  silent?: boolean;
}

/**
 * Refuse a move, legibly, without a modal.
 *
 * Two channels fire together — a damped shake and a red flash — because either
 * alone has a failure mode. A shake is easy to miss on a phone lying on a
 * table; a colour change is easy to miss if you are colourblind.
 *
 * Under reduced motion the shake is dropped entirely and the flash lengthens to
 * carry the whole message on its own.
 */
export function playReject(key: number, opts: RejectOptions = {}): void {
  runner.cancel(TrackKind.Reject, key);

  const reduced = MOTION.reduced;
  const tr = runner.spawn(
    TrackKind.Reject,
    key,
    dur(reduced ? REJECT.reducedFlashDur : REJECT.shakeDur),
  );
  tr.a = opts.dirX ?? 1;
  tr.b = opts.dirZ ?? 0;
  tr.c = reduced ? 1 : 0;

  if (!opts.silent) haptic(REJECT.hapticMs);
}

/** Convenience: refuse a specific board slot. */
export function playRejectSlot(space: SpaceIndex, size: Size, opts?: RejectOptions): void {
  playReject(slotKey(space, size), opts);
}

// ---------------------------------------------------------------------------
// Turn transitions
// ---------------------------------------------------------------------------

export interface TurnChangeOptions {
  /** Colour that just finished, or null at the opening turn. */
  from: number | null;
  /** Colour due to move now. */
  to: number;
  /**
   * True when `from` and `to` belong to the SAME participant — the official
   * 2-player alternation, where one player owns two colours on opposite arms.
   *
   * This gets a visually different treatment: instead of travelling round the
   * rim to the next seat, the highlight crosses straight through the middle to
   * your other arm. "Your other colour" is a different event from "the next
   * player", and with strict alternation a player can be holding a winning
   * placement they are not allowed to make yet — so if the UI is vague about
   * which colour is due, the rules read as a bug.
   */
  sameSeat?: boolean;
  /** Colours passed over because they had no legal placement. */
  skipped?: readonly number[];
  /** Every colour on the board, so inactive arms can be dimmed. */
  colorsInPlay?: readonly number[];
}

export function playTurnChange({
  from,
  to,
  sameSeat = false,
  skipped,
  colorsInPlay,
}: TurnChangeOptions): void {
  runner.cancel(TrackKind.TurnSweep);

  const reduced = MOTION.reduced;
  const toAngle = armAngleOf(to);
  const fromAngle = from === null ? toAngle : armAngleOf(from);

  const sweep = runner.spawn(
    TrackKind.TurnSweep,
    -1,
    dur(reduced ? TURN.reducedDur : TURN.sweepDur),
  );
  sweep.a = reduced ? toAngle : fromAngle;
  // Always take the short way round; a 270-degree trip to reach the player on
  // your left looks like the game lost track of whose turn it is.
  sweep.b = reduced ? toAngle : fromAngle + shortestAngle(fromAngle, toAngle);
  sweep.c = sameSeat ? 1 : 0;
  sweep.d = to;
  sweep.e = from ?? -1;

  CH.activeColor = to;

  // Arms: the active colour rises and brightens, the rest settle and dim.
  const colors = colorsInPlay ?? [0, 1, 2, 3];
  for (let i = 0; i < colors.length; i++) {
    const player = colors[i] as PlayerId;
    const key = trayKey(player as PlayerId);
    const binding = getBinding(key);
    const active = player === to;

    runner.cancel(TrackKind.TurnTray, key);
    const tr = runner.spawn(TrackKind.TurnTray, key, dur(TURN.trayDur));
    tr.a = binding?.sLiftY ?? 0;
    tr.b = reduced ? 0 : active ? u(TURN.trayLift) : 0;
    tr.c = binding?.sDim ?? 0;
    tr.d = active ? 0 : TURN.trayDimInactive;
  }

  // A colour that was skipped gets a grey flash as the turn passes over it, so
  // "blue has no playable piece" is something you watch happen.
  if (skipped && skipped.length > 0) {
    for (let i = 0; i < skipped.length; i++) {
      const tr = runner.spawn(
        TrackKind.Skipped,
        trayKey(skipped[i] as PlayerId),
        dur(0.4),
        i * 0.08,
      );
      tr.a = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Winning
// ---------------------------------------------------------------------------

/**
 * Celebrate a win.
 *
 * Each line's `cells`/`sizes` arrive already ordered for animation — increasing
 * space index for a same-size line, small-medium-large for a sequence or a
 * nested win. Both the engine and the wire guarantee that ordering, so the
 * stagger is driven straight off the array index and the animation ends up
 * drawing the win in the direction it reads. That ordering is the single most
 * useful thing either layer hands us.
 *
 * Two shapes, deliberately very different:
 *
 *  - a LINE win travels: the three pieces rise in order along the line, and for
 *    an ordered-size ("sequence") win they rise to increasing heights, turning
 *    the small-medium-large ramp into a visible staircase.
 *  - a NESTED win expands: the three pieces in one space separate vertically
 *    out of their bullseye, counter-rotate, and slam back together. No travel
 *    at all, because a nested win is not a line and should not look like one.
 */
export function playWin(lines: readonly AnimatableWin[], board: AnimatableBoard): void {
  winFlags.fill(0);

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    for (let i = 0; i < 3; i++) {
      winFlags[slotKey(line.cells[i] as SpaceIndex, line.sizes[i])] = 1;
    }
  }

  // 1. Everything else recedes first. This is the highest-value beat of the
  //    whole sequence: it isolates the answer before the celebration starts.
  for (let space = 0 as SpaceIndex; space < 9; space = (space + 1) as SpaceIndex) {
    const cell = board[space];
    for (let s = 0; s < 3; s++) {
      const size = SIZES[s];
      if (cell[size] === null) continue;
      const key = slotKey(space, size);
      if (winFlags[key]) continue;
      const tr = runner.spawn(TrackKind.Dim, key, dur(WIN.dimDur), WIN.dimDelay);
      tr.a = WIN.dimAmount;
    }
  }

  const reduced = MOTION.reduced;
  let sequenceEnd = 0;
  let centroidX = 0;
  let centroidZ = 0;
  let centroidN = 0;

  // Nested triples are scheduled FIRST. One placement can complete several
  // Otrios at once, and a piece belonging to both a line and a nested win can
  // only play one of them. The nested animation is the more distinctive of the
  // two and the one that shows off the bullseye, so it gets first claim.
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 0; l < lines.length; l++) {
      const line = lines[l];
      const nested = line.kind === 'nested';
      if ((pass === 0) !== nested) continue;
      const isSequence = line.kind === 'sequence';

      for (let i = 0; i < 3; i++) {
        const key = slotKey(line.cells[i] as SpaceIndex, line.sizes[i]);

        // A piece can belong to two winning triples at once. The first claim
        // wins; a second track would double the lift and look broken.
        if (runner.has(TrackKind.WinLine, key) || runner.has(TrackKind.WinNested, key)) {
          continue;
        }

        const binding = getBinding(key);
        if (binding) {
          centroidX += binding.baseX;
          centroidZ += binding.baseZ;
          centroidN++;
        }

        const stagger = reduced ? WIN.reducedStagger : nested ? 0.05 : WIN.line.stagger;
        const delay = WIN.dimDelay + i * stagger;

        if (nested) {
          const total = dur(reduced ? WIN.reducedDur : NATURAL.winNested);
          const tr = runner.spawn(TrackKind.WinNested, key, total, delay);
          // Small rises most, large stays put — nothing has to sink into the
          // board and the stack stays legible from a low camera angle.
          tr.a = u(WIN.nested.separation) * (2 - i) * MOTION.motionScale;
          tr.b = (i % 2 === 0 ? 1 : -1) * WIN.nested.counterSpinTurns;
          tr.c = reduced ? 1 : 0;
          tr.d = 1;
          sequenceEnd = Math.max(sequenceEnd, delay + total);

          // One shared shockwave as the bullseye slams shut. Spawned off the
          // large ring only, so three pieces produce one ring rather than
          // three overlapping ones — this is the moment the whole animation
          // is built around and it should land as a single event.
          if (i === 2 && MOTION.effects && binding && !reduced) {
            const ek = nextEffectKey();
            clearStatic(ek);
            setBase(ek, binding.baseX, LAYOUT.surfaceY + u(0.004), binding.baseZ);
            const ring = runner.spawn(
              TrackKind.ImpactRing,
              ek,
              dur(IMPACT_RING.dur * 1.5),
              delay + total,
            );
            ring.a = RING_SCALE[2] * 1.6;
          }
        } else {
          const total = dur(reduced ? WIN.reducedDur : NATURAL.winLine);
          const tr = runner.spawn(TrackKind.WinLine, key, total, delay);
          // An ordered-size win ramps its lift with the index, so the
          // small-medium-large reading becomes a physical staircase.
          tr.a =
            u(WIN.line.liftHeight) *
            MOTION.motionScale *
            (isSequence ? 0.62 + 0.19 * i : 1);
          tr.b = WIN.line.spinTurns;
          tr.c = reduced ? 1 : 0;
          tr.d = 1;
          sequenceEnd = Math.max(sequenceEnd, delay + total);
        }
      }
    }
  }

  // 2. A wash of light out of the win centroid.
  if (MOTION.effects && centroidN > 0) {
    const fx = runner.spawn(TrackKind.BoardFx, -1, dur(WIN.sweepDur), WIN.dimDelay);
    fx.a = BOARD_FX_WIN_SWEEP;
    fx.b = centroidX / centroidN;
    fx.c = centroidZ / centroidN;
    fx.d = u(3.2);
  }

  // 3. A time-boxed idle glow, so the board stays celebratory for a few seconds
  //    and then hands the frame loop back to sleep.
  if (MOTION.idleLoops) {
    for (let key = 0; key < BOARD_SLOT_COUNT; key++) {
      if (!winFlags[key]) continue;
      const tr = runner.spawn(TrackKind.WinnerGlow, key, WIN.idleGlowTimeout, sequenceEnd);
      tr.a = WIN.idleGlowAmp;
    }
  }
}

/**
 * A drawn game.
 *
 * The rulebook is emphatic that a tie means "pat each other on the back: You
 * all win!", so this is explicitly NOT the win animation with the colour
 * drained out of it. Nothing dims, nobody is singled out: every piece on the
 * board lifts and brightens in a wave travelling outward from the centre.
 *
 * A 3-player game is an exact fit — 27 pieces into 27 slots — so a drawn
 * 3-player board is completely full and this blooms across all of it.
 */
export function playDraw(board: AnimatableBoard): void {
  for (let space = 0 as SpaceIndex; space < 9; space = (space + 1) as SpaceIndex) {
    const cell = board[space];
    for (let s = 0; s < 3; s++) {
      const size = SIZES[s];
      if (cell[size] === null) continue;
      const key = slotKey(space, size);
      clearStatic(key);
      const tr = runner.spawn(
        TrackKind.DrawWave,
        key,
        dur(0.62),
        RING_DISTANCE[space] * 0.14 + s * 0.03,
      );
      tr.a = u(0.1) * MOTION.motionScale;
    }
  }

  if (MOTION.effects) {
    const fx = runner.spawn(TrackKind.BoardFx, -1, dur(1.1));
    fx.a = BOARD_FX_DRAW;
  }
}

// ---------------------------------------------------------------------------
// Game start / reset
// ---------------------------------------------------------------------------

/**
 * Deal the pieces in.
 *
 * Reuses the placement fall, so the game's physical vocabulary — things have
 * weight and they seat into recesses — is established in the first half second,
 * before the player has made a single move.
 */
export function playGameStart(colorsInPlay: readonly number[]): void {
  runner.clear();
  clearAllStatic();
  resetChannels();

  const reduced = MOTION.reduced;

  for (let p = 0; p < colorsInPlay.length; p++) {
    const player = colorsInPlay[p] as PlayerId;
    for (let s = 0; s < 3; s++) {
      for (let ordinal = 0; ordinal < 3; ordinal++) {
        const key = reserveKey(player, SIZES[s], ordinal);
        const delay = p * START.playerStagger + (s * 3 + ordinal) * START.pieceStagger;
        const tr = runner.spawn(
          TrackKind.Enter,
          key,
          dur(reduced ? START.reducedDur : 0.42),
          delay,
        );
        tr.a = u(START.dropFrom) * MOTION.motionScale;
        tr.b = reduced ? 1 : 0;
      }
    }
  }

  if (MOTION.effects) {
    const fx = runner.spawn(TrackKind.BoardFx, -1, dur(START.boardDur));
    fx.a = BOARD_FX_PULSE;
  }
}

/**
 * Clear the board.
 *
 * The entrance run backwards — pieces lift away and fade upward, in reverse
 * order. Reversing the same motion is what makes it read as "undo" rather than
 * "something else happened".
 */
export function playReset(onComplete?: () => void): number {
  runner.cancel(TrackKind.WinnerGlow);
  runner.cancel(TrackKind.TargetPulse);

  const reduced = MOTION.reduced;
  const total = dur(reduced ? RESET.reducedDur : RESET.liftDur);
  let last = 0;

  // Board pieces leave first, outermost first, then the reserves.
  for (let space = 8; space >= 0; space--) {
    for (let s = 2; s >= 0; s--) {
      const key = slotKey(space as SpaceIndex, SIZES[s]);
      const delay = (8 - space) * RESET.stagger * 0.5;
      const tr = runner.spawn(TrackKind.Exit, key, total, delay);
      tr.a = u(RESET.liftHeight) * MOTION.motionScale;
      tr.b = reduced ? 1 : 0;
      last = Math.max(last, delay + total);
    }
  }

  for (let key = RESERVE_BASE; key < RESERVE_BASE + RESERVE_COUNT; key++) {
    const delay = RESET.stagger * 4;
    const tr = runner.spawn(TrackKind.Exit, key, total, delay);
    tr.a = u(RESET.liftHeight) * MOTION.motionScale;
    tr.b = reduced ? 1 : 0;
    last = Math.max(last, delay + total);
  }

  if (onComplete) {
    // A plain timer, not a frame callback: the caller is changing React state
    // (a new game), which must not happen inside the render loop.
    window.setTimeout(onComplete, (last + RESET.gap) * 1000);
  }

  return last + RESET.gap;
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * A player left.
 *
 * Their pieces stay on the board — the rules engine keeps them, and they still
 * block — so this has to say "gone" without deleting anything. Their colour
 * drains to grey and their arm drops. Crucially nothing on the playing area
 * moves, because a departure must never be mistakable for a move.
 */
export function playPlayerLeave(player: number, board: AnimatableBoard): void {
  const tray = runner.spawn(
    TrackKind.PresenceLeave,
    trayKey(player as PlayerId),
    dur(PRESENCE.leaveDur),
  );
  tray.a = PRESENCE.leaveDesaturate;
  tray.b = u(PRESENCE.leaveTrayDrop) * MOTION.motionScale;
  tray.c = player;

  for (let space = 0 as SpaceIndex; space < 9; space = (space + 1) as SpaceIndex) {
    const cell = board[space];
    for (let s = 0; s < 3; s++) {
      const size = SIZES[s];
      if (cell[size] !== player) continue;
      const tr = runner.spawn(
        TrackKind.PresenceLeave,
        slotKey(space, size),
        dur(PRESENCE.leaveDur),
        RING_DISTANCE[space] * 0.03,
      );
      tr.a = PRESENCE.leaveDesaturate;
      tr.b = 0;
      tr.c = -1;
    }
  }

  for (let s = 0; s < 3; s++) {
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      const tr = runner.spawn(
        TrackKind.PresenceLeave,
        reserveKey(player as PlayerId, SIZES[s], ordinal),
        dur(PRESENCE.leaveDur),
        (s * 3 + ordinal) * 0.02,
      );
      tr.a = PRESENCE.leaveDesaturate;
      tr.b = 0;
      tr.c = -1;
    }
  }
}

/** A player joined, or reconnected: colour washes back in and the arm rises. */
export function playPlayerJoin(player: number, board?: AnimatableBoard): void {
  const tray = runner.spawn(TrackKind.PresenceJoin, trayKey(player as PlayerId), dur(PRESENCE.joinDur));
  tray.a = PRESENCE.leaveDesaturate;
  tray.b = player;

  for (let s = 0; s < 3; s++) {
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      const tr = runner.spawn(
        TrackKind.PresenceJoin,
        reserveKey(player as PlayerId, SIZES[s], ordinal),
        dur(PRESENCE.joinDur),
        (s * 3 + ordinal) * PRESENCE.joinStagger * 0.3,
      );
      tr.a = PRESENCE.leaveDesaturate;
      tr.b = -1;
    }
  }

  if (!board) return;
  for (let space = 0 as SpaceIndex; space < 9; space = (space + 1) as SpaceIndex) {
    const cell = board[space];
    for (let s = 0; s < 3; s++) {
      const size = SIZES[s];
      if (cell[size] !== player) continue;
      const tr = runner.spawn(
        TrackKind.PresenceJoin,
        slotKey(space, size),
        dur(PRESENCE.joinDur),
        RING_DISTANCE[space] * 0.03,
      );
      tr.a = PRESENCE.leaveDesaturate;
      tr.b = -1;
    }
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/**
 * A single settle pulse, played after the board is snapped to an authoritative
 * state. It says "you are looking at something new" without pretending the
 * intervening moves were watched.
 */
export function playSyncPulse(): void {
  const fx = runner.spawn(TrackKind.BoardFx, -1, dur(0.34));
  fx.a = BOARD_FX_PULSE;
}

/** Stop everything and return every piece to truth. */
export function stopAllAnimations(): void {
  runner.clear();
  clearAllStatic();
  resetChannels();
  shownIndicators.fill(0);
}
