/**
 * Drive every animation from observed game state.
 *
 * ## Why state diffing, and not events
 *
 * `net/protocol.ts` is explicit that events are droppable: *"a client that
 * ignored every EventMsg would still render the right board, because a StateMsg
 * always accompanies the change"*, and that duplicating or reordering events
 * must be harmless. An animation layer that triggered off events would
 * therefore stutter, double-animate or silently miss moves the moment the
 * network misbehaved.
 *
 * So this hook animates the **difference between two board states** and nothing
 * else. Consequences:
 *
 *  - A duplicated state produces an empty diff, so nothing animates twice.
 *  - A dropped event changes nothing, because no event was needed.
 *  - A reconnect delivering five missed moves produces a five-move diff, which
 *    the pacing logic below turns into a readable sequence instead of five
 *    pieces landing on the same frame.
 *  - A rollback (server disagreed with an optimistic local move) shows up as a
 *    slot going from occupied back to empty, and snaps rather than animating.
 *
 * ## Local versus remote
 *
 * The animation is identical either way — only its ORIGIN differs, and it is
 * the origin that carries the information:
 *
 *  - **Local**: the interaction layer supplies where the piece actually was
 *    (the storage space it came from, or where the finger let go) via
 *    `getMoveOrigin`, so the animation continues the player's own gesture.
 *  - **Remote**: there was no gesture, so the piece flies in from the moving
 *    colour's storage arm. You learn who moved from the direction it came from,
 *    which a fade-in could never tell you.
 *
 * ## Never blocking
 *
 * Nothing here awaits anything. The rules engine has already committed every
 * move by the time this hook sees it; pieces render at their final positions
 * and the animation is a decaying offset on top. A player can place their next
 * piece while three others are still settling.
 */

import { useEffect, useRef } from 'react';
import {
  SIZES,
  type GameState,
  type Move,
  type PlayerId,
  type SpaceIndex,
} from '../../../game/types';
import { BOARD_SLOT_COUNT, slotKey } from '../core/ids';
import { MOTION } from '../core/prefs';
import { runner } from '../core/runner';
import { QUEUE } from '../core/timing';
import {
  playDraw,
  playGameStart,
  playPlacement,
  playSyncPulse,
  playTurnChange,
  playWin,
  snapPlacement,
  stopAllAnimations,
} from '../schedule';

export interface GameAnimationOptions {
  /** The authoritative game state. Every animation derives from changes to it. */
  state: GameState;

  /**
   * Colours this device controls. Used only to decide whether a move gets the
   * local treatment (gesture continuity + haptic) or the remote one (fly in
   * from the mover's arm). Getting it wrong is cosmetic, never incorrect.
   */
  localPlayers?: readonly PlayerId[];

  /**
   * Where a local move's piece physically was, as world coordinates. Return
   * `undefined` and the move is animated as if it were remote, which is a
   * perfectly good fallback.
   */
  getMoveOrigin?: (move: Move) => { x: number; y: number; z: number } | undefined;

  /**
   * Fires when a piece touches the board. Hook audio here — RULES.md §9 notes
   * the solid peg and the hollow rings sound different, and the size is
   * recoverable from the key.
   */
  onBeat?: (key: number, beat: number) => void;

  /** Set false to leave the board static (e.g. while a modal owns the screen). */
  enabled?: boolean;
}

/** Occupancy snapshot: 0 = empty, otherwise `PlayerId + 1`. */
function readOccupancy(state: GameState, out: Uint8Array): void {
  for (let space = 0; space < 9; space++) {
    const cell = state.board[space];
    for (let s = 0; s < 3; s++) {
      const size = SIZES[s];
      const who = cell[size];
      out[space * 3 + s] = who === null ? 0 : who + 1;
    }
  }
}

export function useGameAnimations({
  state,
  localPlayers,
  getMoveOrigin,
  onBeat,
  enabled = true,
}: GameAnimationOptions): void {
  const prevOccupancy = useRef<Uint8Array>(new Uint8Array(BOARD_SLOT_COUNT));
  const prevState = useRef<GameState | null>(null);
  const nextOccupancy = useRef<Uint8Array>(new Uint8Array(BOARD_SLOT_COUNT));
  /** Runner time at which the last placement was scheduled to begin. */
  const lastPlacementAt = useRef(-Infinity);
  /** Newly occupied slot keys for this diff. Reused; never reallocated. */
  const added = useRef<number[]>([]);

  // Keep the callbacks fresh without making them effect dependencies — a new
  // inline lambda from the caller must not re-run the whole diff.
  const originRef = useRef(getMoveOrigin);
  originRef.current = getMoveOrigin;
  const beatRef = useRef(onBeat);
  beatRef.current = onBeat;
  // Held in a ref rather than listed as a dependency: callers naturally pass a
  // fresh array literal every render, and re-running the diff on every render
  // would be pure churn.
  const localRef = useRef(localPlayers);
  localRef.current = localPlayers;

  useEffect(() => {
    if (!enabled) return;

    const prev = prevState.current;
    const next = nextOccupancy.current;
    readOccupancy(state, next);

    // --- new game / rematch -------------------------------------------------
    const isNewGame =
      prev === null ||
      prev.config !== state.config ||
      state.moveNumber < prev.moveNumber;

    if (isNewGame) {
      stopAllAnimations();
      playGameStart(state.config.colorsInPlay);
      playTurnChange({
        from: null,
        to: state.currentPlayer,
        colorsInPlay: state.config.colorsInPlay,
      });
      prevOccupancy.current.set(next);
      prevState.current = state;
      lastPlacementAt.current = runner.time;
      return;
    }

    // --- diff the board -----------------------------------------------------
    const before = prevOccupancy.current;
    const list = added.current;
    list.length = 0;

    for (let key = 0; key < BOARD_SLOT_COUNT; key++) {
      const was = before[key];
      const now = next[key];
      if (was === now) continue;
      if (now === 0) {
        // Occupied -> empty. A rollback or a reconciliation. Never animate a
        // piece leaving the board mid-game; just make it correct.
        snapPlacement((((key / 3) | 0) as SpaceIndex), SIZES[key % 3]);
      } else {
        list.push(key);
      }
    }

    if (list.length > 0) {
      scheduleMoves(
        list,
        state,
        localRef.current,
        originRef.current,
        beatRef.current,
        lastPlacementAt,
      );
    }

    // --- turn change --------------------------------------------------------
    const turnChanged =
      prev.currentPlayer !== state.currentPlayer || prev.turnIndex !== state.turnIndex;

    if (turnChanged && state.status === 'playing') {
      // `skipped` is a list of turn slots; flatten to the colours they hold so
      // each skipped arm can flash. Allocated once per turn, never per frame.
      let skippedColors: PlayerId[] | undefined;
      if (state.skipped.length > 0) {
        skippedColors = [];
        for (const slot of state.skipped) {
          for (const c of slot.colors) skippedColors.push(c);
        }
      }

      playTurnChange({
        from: prev.currentPlayer,
        to: state.currentPlayer,
        // The official 2-player game gives one participant two colours on
        // opposite arms. Passing to your OWN other colour is a different event
        // from passing to an opponent, and it is drawn differently.
        sameSeat: prev.currentSeat === state.currentSeat,
        skipped: skippedColors,
        colorsInPlay: state.config.colorsInPlay,
      });
    }

    // --- game end -----------------------------------------------------------
    if (prev.status !== state.status) {
      if (state.status === 'won' && state.result) {
        // Delay the celebration until the winning piece has actually landed,
        // otherwise the highlight fires while the piece is still in the air.
        const settle = MOTION.reduced ? 120 : 380;
        const result = state.result;
        const board = state.board;
        window.setTimeout(() => playWin(result, board), settle);
      } else if (state.status === 'draw') {
        const board = state.board;
        window.setTimeout(() => playDraw(board), MOTION.reduced ? 120 : 380);
      }
    }

    prevOccupancy.current.set(next);
    prevState.current = state;
  }, [state, enabled]);
}

/**
 * Turn a set of newly occupied slots into a readable sequence of animations.
 *
 * Three regimes, by backlog depth:
 *
 *  - **1-4 moves** — normal play, or a small burst from two players moving at
 *    once. Played at full speed, separated by `minStagger` so two moves
 *    landing in the same tick still read as two events rather than one.
 *  - **5-8 moves** — a reconnect that missed a few turns. Compressed: shorter
 *    stagger, halved durations. Still watchable, but it does not make the
 *    player sit through a replay.
 *  - **9+ moves** — a full resync or a spectator joining mid-game. Snapped
 *    outright, with a single board pulse to say "this is new". Replaying twenty
 *    moves as a cutscene is worse than not animating at all.
 */
function scheduleMoves(
  slotKeys: readonly number[],
  state: GameState,
  localPlayers: readonly PlayerId[] | undefined,
  getOrigin: GameAnimationOptions['getMoveOrigin'],
  onBeat: GameAnimationOptions['onBeat'],
  lastPlacementAt: { current: number },
): void {
  const count = slotKeys.length;

  if (count >= QUEUE.snapAt) {
    for (let i = 0; i < count; i++) {
      const key = slotKeys[i];
      snapPlacement((((key / 3) | 0) as SpaceIndex), SIZES[key % 3]);
    }
    playSyncPulse();
    lastPlacementAt.current = runner.time;
    return;
  }

  const fast = count > QUEUE.fastForwardAt;
  const stagger = fast ? QUEUE.fastStagger : QUEUE.minStagger;
  const speed = fast ? 1 / QUEUE.fastDurationScale : 1;

  // Order the burst chronologically where we can. The history tail is the true
  // order; slot-index order would make a reconnect replay the board top-left to
  // bottom-right, which is not how the game was played.
  const ordered = orderByHistory(slotKeys, state, count);

  // Respect a global minimum gap, even across separate state updates. Two moves
  // arriving one frame apart must not start on the same frame.
  const now = runner.time;
  let cursor = Math.max(0, lastPlacementAt.current + QUEUE.minStagger - now);

  for (let i = 0; i < ordered.length; i++) {
    const key = ordered[i];
    const space = (((key / 3) | 0) as SpaceIndex);
    const size = SIZES[key % 3];
    const player = (state.board[space][size] ?? 0) as PlayerId;

    const isLocal = localPlayers ? localPlayers.indexOf(player) !== -1 : false;
    let origin: { x: number; y: number; z: number } | undefined;
    if (isLocal && getOrigin) {
      origin = getOrigin({ player, space, size });
    }

    playPlacement(space, size, player, {
      from: origin,
      delay: cursor,
      speed,
      local: isLocal,
      onBeat,
    });

    cursor += stagger;
  }

  lastPlacementAt.current = now + cursor;
}

/** Scratch buffer for the ordering pass. Module-level, never reallocated. */
const orderBuf: number[] = [];

/**
 * Put a burst of newly occupied slots into the order they were actually played,
 * using the tail of `history`. Falls back to the given order if history and the
 * diff disagree, which can happen after a hand-built or repaired state.
 */
function orderByHistory(
  slotKeys: readonly number[],
  state: GameState,
  count: number,
): readonly number[] {
  const history = state.history;
  if (history.length < count) return slotKeys;

  orderBuf.length = 0;
  for (let i = history.length - count; i < history.length; i++) {
    const move = history[i];
    const key = slotKey(move.space, move.size);
    if (slotKeys.indexOf(key) === -1) {
      // History does not explain this diff. Trust the diff.
      return slotKeys;
    }
    orderBuf.push(key);
  }
  return orderBuf.length === count ? orderBuf : slotKeys;
}
