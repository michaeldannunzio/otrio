/**
 * What the animation layer needs to see, and nothing more.
 *
 * The animation system originally typed against the engine's `GameState`. That
 * was wrong: **clients never have one**. A client renders the referee's
 * projection (`GameSnapshot` in `net/protocol.ts`) and deliberately does not
 * run the engine, so demanding a `GameState` would have forced the UI layer to
 * invent a `config` and a `history` purely to satisfy a type — and inventing
 * data to satisfy a type is a bug with a long fuse.
 *
 * So these are **structural view types**: the minimum an animation needs to
 * know, shaped so that both the engine's `GameState` and the wire's
 * `GameSnapshot` can be mapped onto them cheaply and without fabrication.
 *
 * Design rules:
 *  - Every field is one the animation layer genuinely reads.
 *  - Anything the wire cannot supply is **optional**, and its absence degrades
 *    one animation rather than breaking the system.
 *  - Colours are plain numbers 0..3. Both `PlayerId` (engine) and `PlayerColor`
 *    (wire) are exactly that, and both number the colours identically:
 *    0 purple (north), 1 red (east), 2 green (south), 3 blue (west).
 */

import type { Size } from '../../../game/types';

/** One space: three concentric slots holding a colour index or nothing. */
export interface AnimatableCell {
  readonly small: number | null;
  readonly medium: number | null;
  readonly large: number | null;
}

/** The nine playing spaces, row-major. */
export type AnimatableBoard = readonly AnimatableCell[];

/**
 * One completed winning triple.
 *
 * `kind` uses the engine's vocabulary. The wire calls the same three things
 * `'same-size'`, `'ascending'` and `'concentric'`; map `ascending -> sequence`
 * and `concentric -> nested`.
 *
 * `cells` and `sizes` are parallel arrays of exactly three, **already ordered
 * for animation** — increasing space index along a line, or small/medium/large
 * for a sequence or a nested triple. Both the engine and the wire already
 * guarantee that ordering, and the animation depends on it: the stagger is
 * driven straight off the array index, which is what makes the highlight draw
 * the win in the direction it reads.
 */
export interface AnimatableWin {
  readonly kind: 'same-size' | 'sequence' | 'nested';
  readonly cells: readonly number[];
  readonly sizes: readonly Size[];
  readonly color: number;
}

/**
 * The whole game, as the animation layer sees it.
 *
 * Map a wire `GameSnapshot` like this:
 *
 * ```ts
 * const view: AnimatableGame = {
 *   board:        snapshot.board,            // structurally identical
 *   colorsInPlay: snapshot.colorsInPlay,
 *   currentColor: snapshot.turnColors[0],    // never empty, by construction
 *   currentSeat:  snapshot.turn,
 *   moveCount:    snapshot.moveCount,
 *   status:       snapshot.phase === 'playing'
 *                   ? 'playing'
 *                   : snapshot.isDraw ? 'draw' : 'won',
 *   win: snapshot.winningLine
 *     ? [{
 *         kind:  snapshot.winningLine.kind === 'ascending'  ? 'sequence'
 *              : snapshot.winningLine.kind === 'concentric' ? 'nested'
 *              : 'same-size',
 *         cells: snapshot.winningLine.cells,
 *         sizes: snapshot.winningLine.sizes,
 *         color: snapshot.winningLine.color,
 *       }]
 *     : null,
 *   skipped: snapshot.skipped,               // same shape already
 * };
 * ```
 */
export interface AnimatableGame {
  /** Exactly nine spaces, row-major. */
  readonly board: AnimatableBoard;

  /** Colours actually in this game. Drives the start cascade and arm dimming. */
  readonly colorsInPlay: readonly number[];

  /**
   * The colour due to move — NOT the seat.
   *
   * In the official 2-player game one participant owns two colours on opposite
   * arms, and the turn passing between them is a different visual event from
   * the turn passing to an opponent. From the wire this is `turnColors[0]`.
   */
  readonly currentColor: number;

  /**
   * The participant due to move. Used for exactly one thing: telling "your
   * other colour" apart from "the next player", by comparing it across turns.
   */
  readonly currentSeat: number;

  /**
   * Total placements applied. Used as the new-game signal — a count that went
   * backwards means the board was reset. The wire's `moveCount` is exactly
   * this and documents itself as an animation key.
   */
  readonly moveCount: number;

  readonly status: 'playing' | 'won' | 'draw';

  /**
   * Every winning triple, or null. A single placement can complete more than
   * one; pass them all and the highlight handles the overlap. The wire
   * currently reports at most one, which is fine — pass a one-element array.
   */
  readonly win?: readonly AnimatableWin[] | null;

  /**
   * Colours skipped on the way to this turn, so their arms can flash. Both the
   * engine's `TurnSlot[]` and the wire's `{seat, colors}[]` satisfy this.
   * Optional: without it, skips simply are not shown.
   */
  readonly skipped?: readonly { readonly colors: readonly number[] }[];

  /**
   * Optional chronological ordering for a burst of moves arriving together
   * (a reconnect replaying missed turns). Without it a burst is animated in
   * slot order, which is a slightly worse reading of the same moves — a
   * refinement, never a requirement. The wire has no history, so this is
   * normally absent.
   */
  readonly history?: readonly { readonly space: number; readonly size: Size }[];

  /**
   * Optional explicit identity. When it changes, the board is torn down and
   * re-dealt regardless of `moveCount`. Use it for a rematch that starts at
   * move zero in a room that never reloaded.
   */
  readonly gameKey?: string | number;
}
