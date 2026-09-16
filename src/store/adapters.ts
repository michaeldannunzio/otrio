/**
 * Bridge between the two vocabularies in this codebase.
 *
 * There are, unavoidably, two:
 *
 *  - `src/net/protocol.ts` — the wire. `PlayerColor` and `CellIndex` are plain
 *    numbers and a board is `CellState[]`. This is what arrives from the
 *    referee and what the UI renders.
 *  - `src/game/types.ts` — the rules engine. `PlayerId` is `0 | 1 | 2 | 3`,
 *    `SpaceIndex` is `0..8`, a board is a frozen 9-tuple of `Cell`.
 *
 * The two are structurally identical for the board (`{small, medium, large}` of
 * owner-or-null) and differ only in how tightly they are typed. These helpers do
 * the narrowing once, with validation, so nobody scatters `as unknown as`
 * casts around.
 *
 * Use this when you want the engine's pure helpers -- `remainingPieces`,
 * `LINES`, `legalMoves` -- against a board that came off the wire.
 *
 * These two now agree about the thing they used to disagree on: the protocol's
 * `CellState` holds a `PlayerColor`, exactly like the engine's `Cell` holds a
 * `PlayerId`, and both number the colours in the same clockwise order. So the
 * narrowing below is a validation step rather than a translation.
 */

import { boardFromJSON } from '../game/board';
import type { BoardState, PlayerId as EnginePlayerId, SpaceIndex } from '../game/types';
import { isPlayerId, isSpaceIndex } from '../game/types';

import type { CellIndex, GameSnapshot, PlayerColor } from '../net/protocol';

/**
 * Validate and narrow a wire board into the engine's `BoardState`.
 *
 * Returns `null` rather than throwing when the snapshot is malformed: a bad
 * frame from a peer should degrade the board, not take down the render tree.
 */
export function toBoardState(game: GameSnapshot | null | undefined): BoardState | null {
  if (!game) return null;
  try {
    return boardFromJSON(game.board);
  } catch {
    return null;
  }
}

/**
 * Narrow a wire `PlayerColor` to the engine's `PlayerId`, or `null`.
 * Both are 0-3 in the same clockwise order, so this is a guard, not a mapping.
 */
export function toGamePlayerId(colour: PlayerColor | null | undefined): EnginePlayerId | null {
  return isPlayerId(colour) ? colour : null;
}

/** Narrow a wire `CellIndex` to the engine's `SpaceIndex`, or `null`. */
export function toSpace(cell: CellIndex | null | undefined): SpaceIndex | null {
  return isSpaceIndex(cell) ? cell : null;
}
