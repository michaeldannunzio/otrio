/**
 * Drive every animation from observed game state.
 *
 * ## What this takes
 *
 * An `AnimatableGame` (see `core/view.ts`) — a narrow structural view, not the
 * engine's `GameState`. Clients never have a `GameState`: they render the
 * referee's projection and deliberately do not run the engine. Both the engine
 * state and the wire `GameSnapshot` map onto this view cheaply, and nothing has
 * to be fabricated to satisfy it.
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
 *  - A duplicated snapshot produces an empty diff, so nothing animates twice.
 *  - A dropped event changes nothing, because no event was needed.
 *  - A reconnect delivering five missed moves produces a five-move diff, which
 *    the pacing logic below turns into a readable sequence instead of five
 *    pieces landing on the same frame.
 *  - A rollback (the referee disagreed with an optimistic local move) shows up
 *    as a slot going from occupied back to empty, and snaps rather than
 *    animating.
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
 * Nothing here awaits anything. The move is already committed by the time this
 * hook sees it; pieces render at their final positions and the animation is a
 * decaying offset on top. A player can place their next piece while three
 * others are still settling.
 */

import { useEffect, useRef } from 'react';
import { SIZES, type Size, type SpaceIndex } from '../../../game/types';
import { BOARD_SLOT_COUNT, slotKey } from '../core/ids';
import { MOTION } from '../core/prefs';
import { runner } from '../core/runner';
import { QUEUE } from '../core/timing';
import type { AnimatableBoard, AnimatableGame } from '../core/view';
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

/** A placement, as the origin lookup sees it. Colours are plain indices. */
export interface AnimatableMoveRef {
  readonly player: number;
  readonly space: number;
  readonly size: Size;
}

export interface GameAnimationOptions {
  /**
   * The game, as a structural view. Map a wire `GameSnapshot` onto it — see
   * the worked example in `core/view.ts`.
   */
  state: AnimatableGame;

  /**
   * COLOURS this device controls — not seats.
   *
   * In the official 2-player game one participant owns two colours on opposite
   * arms, so this has two entries there and one otherwise. Used only to decide
   * whether a move gets the local treatment (gesture continuity + haptic) or
   * the remote one (fly in from the mover's arm). Getting it wrong is
   * cosmetic, never incorrect.
   */
  localPlayers?: readonly number[];

  /**
   * Where a local move's piece physically was, in world coordinates. Return
   * `undefined` and the move is animated as if it were remote, which is a
   * perfectly good fallback.
   */
  getMoveOrigin?: (move: AnimatableMoveRef) => { x: number; y: number; z: number } | undefined;

  /**
   * Fires when a piece touches the board. Hook audio here — RULES.md §9 notes
   * the solid peg and the hollow rings sound different, and the size is
   * recoverable from the key via `slotSizeRank`.
   */
  onBeat?: (key: number, beat: number) => void;

  /** Set false to leave the board static (e.g. while a modal owns the screen). */
  enabled?: boolean;
}

/** Occupancy snapshot: 0 = empty, otherwise `colour + 1`. */
function readOccupancy(board: AnimatableBoard, out: Uint8Array): void {
  for (let space = 0; space < 9; space++) {
    const cell = board[space];
    for (let s = 0; s < 3; s++) {
      const who = cell[SIZES[s]];
      out[space * 3 + s] = who === null || who === undefined ? 0 : who + 1;
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
  const prevState = useRef<AnimatableGame | null>(null);
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
    readOccupancy(state.board, next);

    // --- new game / rematch -------------------------------------------------
    // A move count that went backwards means the board was reset. `gameKey`
    // catches the case a rematch does not: a fresh game in a room that never
    // reloaded, where the count legitimately starts at zero again.
    const isNewGame =
      prev === null ||
      state.gameKey !== prev.gameKey ||
      state.moveCount < prev.moveCount;

    if (isNewGame) {
      stopAllAnimations();
      playGameStart(state.colorsInPlay);
      playTurnChange({
        from: null,
        to: state.currentColor,
        colorsInPlay: state.colorsInPlay,
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
        snapPlacement(((key / 3) | 0) as SpaceIndex, SIZES[key % 3]);
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
    // The colour usually changes every turn, but not always: if every other
    // seat is skipped the same colour comes round again, and that is still a
    // new turn. So an advancing move count counts as a turn change too.
    const turnChanged =
      prev.currentColor !== state.currentColor ||
      prev.currentSeat !== state.currentSeat ||
      prev.moveCount !== state.moveCount;

    if (turnChanged && state.status === 'playing') {
      // Flatten skipped turn slots to the colours they hold, so each skipped
      // arm can flash. Allocated once per turn, never per frame.
      let skippedColors: number[] | undefined;
      const skipped = state.skipped;
      if (skipped && skipped.length > 0) {
        skippedColors = [];
        for (const slot of skipped) {
          for (const c of slot.colors) skippedColors.push(c);
        }
      }

      playTurnChange({
        from: prev.currentColor,
        to: state.currentColor,
        // The official 2-player game gives one participant two colours on
        // opposite arms. Passing to your OWN other colour is a different event
        // from passing to an opponent, and it is drawn differently.
        sameSeat: prev.currentSeat === state.currentSeat,
        skipped: skippedColors,
        colorsInPlay: state.colorsInPlay,
      });
    }

    // --- game end -----------------------------------------------------------
    if (prev.status !== state.status) {
      // Wait for the winning piece to land before celebrating it, or the
      // highlight fires while the piece is still in the air.
      const settle = MOTION.reduced ? 120 : 380;
      if (state.status === 'won' && state.win && state.win.length > 0) {
        const lines = state.win;
        const board = state.board;
        window.setTimeout(() => playWin(lines, board), settle);
      } else if (state.status === 'draw') {
        const board = state.board;
        window.setTimeout(() => playDraw(board), settle);
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
  state: AnimatableGame,
  localPlayers: readonly number[] | undefined,
  getOrigin: GameAnimationOptions['getMoveOrigin'],
  onBeat: GameAnimationOptions['onBeat'],
  lastPlacementAt: { current: number },
): void {
  const count = slotKeys.length;

  if (count >= QUEUE.snapAt) {
    for (let i = 0; i < count; i++) {
      const key = slotKeys[i];
      snapPlacement(((key / 3) | 0) as SpaceIndex, SIZES[key % 3]);
    }
    playSyncPulse();
    lastPlacementAt.current = runner.time;
    return;
  }

  const fast = count > QUEUE.fastForwardAt;
  const stagger = fast ? QUEUE.fastStagger : QUEUE.minStagger;
  const speed = fast ? 1 / QUEUE.fastDurationScale : 1;

  // Order the burst chronologically when history is available. Slot-index
  // order would make a reconnect replay the board top-left to bottom-right,
  // which is not how the game was played. The wire has no history, so this
  // usually falls through to the given order — a refinement, not a requirement.
  const ordered = orderByHistory(slotKeys, state, count);

  // Respect a global minimum gap, even across separate state updates. Two moves
  // arriving one frame apart must not start on the same frame.
  const now = runner.time;
  let cursor = Math.max(0, lastPlacementAt.current + QUEUE.minStagger - now);

  for (let i = 0; i < ordered.length; i++) {
    const key = ordered[i];
    const space = ((key / 3) | 0) as SpaceIndex;
    const size = SIZES[key % 3];
    const player = state.board[space][size] ?? 0;

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
 * using the tail of `history` when the caller has one. Falls back to the given
 * order whenever history is absent or disagrees with the diff.
 */
function orderByHistory(
  slotKeys: readonly number[],
  state: AnimatableGame,
  count: number,
): readonly number[] {
  const history = state.history;
  if (!history || history.length < count) return slotKeys;

  orderBuf.length = 0;
  for (let i = history.length - count; i < history.length; i++) {
    const move = history[i];
    const key = slotKey(move.space as SpaceIndex, move.size);
    if (slotKeys.indexOf(key) === -1) {
      // History does not explain this diff. Trust the diff.
      return slotKeys;
    }
    orderBuf.push(key);
  }
  return orderBuf.length === count ? orderBuf : slotKeys;
}
