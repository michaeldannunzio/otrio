/**
 * Board geometry and pure board queries.
 *
 * Nothing here knows about turns, seats or victory — it is only "what is on the
 * 3x3 grid". Everything is immutable: `place` returns a new `BoardState`.
 */

import {
  PIECES_PER_SIZE,
  SIZES,
  SPACES,
  type BoardState,
  type Cell,
  type Line,
  type LineOrientation,
  type PlayerId,
  type Size,
  type SpaceIndex,
} from './types.ts';

/** An empty space. Shared and frozen — cells are never mutated in place. */
const EMPTY_CELL: Cell = Object.freeze({ small: null, medium: null, large: null });

/**
 * The eight lines of three spaces: 3 rows, 3 columns, 2 diagonals.
 *
 * Each line is stored in increasing `SpaceIndex` order. That gives a canonical
 * "reading direction" (left-to-right, top-to-bottom) which is what
 * `WinningLine.sequenceDirection` is relative to. Both reading directions win,
 * so the direction is reported, never required.
 */
export const LINES: readonly Line[] = Object.freeze([
  [0, 1, 2], // row 0
  [3, 4, 5], // row 1
  [6, 7, 8], // row 2
  [0, 3, 6], // column 0
  [1, 4, 7], // column 1
  [2, 5, 8], // column 2
  [0, 4, 8], // diagonal, top-left to bottom-right
  [2, 4, 6], // anti-diagonal, top-right to bottom-left
] as const satisfies readonly Line[]);

/** Orientation of `LINES[i]`, same indexing. */
export const LINE_ORIENTATIONS: readonly LineOrientation[] = Object.freeze([
  'row',
  'row',
  'row',
  'column',
  'column',
  'column',
  'diagonal',
  'anti-diagonal',
] as const satisfies readonly LineOrientation[]);

/** A fresh, empty, frozen board. */
export function emptyBoard(): BoardState {
  const cells: readonly [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell] = [
    EMPTY_CELL,
    EMPTY_CELL,
    EMPTY_CELL,
    EMPTY_CELL,
    EMPTY_CELL,
    EMPTY_CELL,
    EMPTY_CELL,
    EMPTY_CELL,
    EMPTY_CELL,
  ];
  return Object.freeze(cells);
}

/** Row (0..2) of a space. */
export function rowOf(space: SpaceIndex): 0 | 1 | 2 {
  return Math.floor(space / 3) as 0 | 1 | 2;
}

/** Column (0..2) of a space. */
export function colOf(space: SpaceIndex): 0 | 1 | 2 {
  return (space % 3) as 0 | 1 | 2;
}

/** Space index from row/column, both 0..2. */
export function spaceAt(row: number, col: number): SpaceIndex {
  if (!Number.isInteger(row) || row < 0 || row > 2) throw new RangeError(`Bad row: ${row}`);
  if (!Number.isInteger(col) || col < 0 || col > 2) throw new RangeError(`Bad column: ${col}`);
  return (row * 3 + col) as SpaceIndex;
}

/** Whoever owns the given slot, or `null` if it is empty. */
export function pieceAt(board: BoardState, space: SpaceIndex, size: Size): PlayerId | null {
  return board[space][size];
}

/** True when that space has no ring of that size, of any colour. */
export function isSlotEmpty(board: BoardState, space: SpaceIndex, size: Size): boolean {
  return board[space][size] === null;
}

/**
 * A new board with `player`'s ring of `size` in `space`.
 *
 * Throws if the slot is already taken — callers should have gone through
 * `isLegal` / `applyMove`, which check reserves and turn order too.
 */
export function place(
  board: BoardState,
  space: SpaceIndex,
  size: Size,
  player: PlayerId,
): BoardState {
  const cell = board[space];
  if (cell[size] !== null) {
    throw new Error(`Slot ${size}@${space} is already occupied by colour ${cell[size]}`);
  }
  // Written out rather than `{...cell, [size]: player}` so the result is a
  // `Cell` and not an index signature.
  const updated: Cell = {
    small: size === 'small' ? player : cell.small,
    medium: size === 'medium' ? player : cell.medium,
    large: size === 'large' ? player : cell.large,
  };
  const next: Cell[] = board.slice();
  next[space] = Object.freeze(updated);
  return Object.freeze(next) as unknown as BoardState;
}

/** How many rings of each size `player` has left in reserve (3 minus those placed). */
export function remainingPieces(board: BoardState, player: PlayerId): Record<Size, number> {
  const left: Record<Size, number> = { small: PIECES_PER_SIZE, medium: PIECES_PER_SIZE, large: PIECES_PER_SIZE };
  for (const space of SPACES) {
    const cell = board[space];
    for (const size of SIZES) {
      if (cell[size] === player) left[size] -= 1;
    }
  }
  return left;
}

/** How many rings of one size `player` has left. */
export function remainingOfSize(board: BoardState, player: PlayerId, size: Size): number {
  let used = 0;
  for (const space of SPACES) {
    if (board[space][size] === player) used += 1;
  }
  return PIECES_PER_SIZE - used;
}

/** Total rings `player` still holds, across all sizes. */
export function totalRemaining(board: BoardState, player: PlayerId): number {
  const left = remainingPieces(board, player);
  return left.small + left.medium + left.large;
}

/** Every slot on the board is taken — 27 rings placed. */
export function isBoardFull(board: BoardState): boolean {
  for (const space of SPACES) {
    const cell = board[space];
    if (cell.small === null || cell.medium === null || cell.large === null) return false;
  }
  return true;
}

/** Number of rings on the board, of any colour. */
export function piecesOnBoard(board: BoardState): number {
  let n = 0;
  for (const space of SPACES) {
    const cell = board[space];
    for (const size of SIZES) {
      if (cell[size] !== null) n += 1;
    }
  }
  return n;
}

/** Every ring `player` has on the board. Useful for the reserve/board animation. */
export function piecesOf(board: BoardState, player: PlayerId): { space: SpaceIndex; size: Size }[] {
  const out: { space: SpaceIndex; size: Size }[] = [];
  for (const space of SPACES) {
    for (const size of SIZES) {
      if (board[space][size] === player) out.push({ space, size });
    }
  }
  return out;
}

/**
 * Rebuild a board from a plain object that came off the network or out of
 * `localStorage`, validating it. Returns a frozen `BoardState`.
 */
export function boardFromJSON(value: unknown): BoardState {
  if (!Array.isArray(value) || value.length !== SPACES.length) {
    throw new TypeError('Board must be an array of 9 cells');
  }
  const cells = SPACES.map((space) => {
    const raw = value[space] as Record<string, unknown> | null | undefined;
    if (raw === null || typeof raw !== 'object') throw new TypeError(`Cell ${space} is not an object`);
    const cell: Record<string, PlayerId | null> = {};
    for (const size of SIZES) {
      const owner = raw[size] ?? null;
      if (owner !== null && !(typeof owner === 'number' && owner >= 0 && owner <= 3 && Number.isInteger(owner))) {
        throw new TypeError(`Cell ${space}.${size} is not a PlayerId or null`);
      }
      cell[size] = owner as PlayerId | null;
    }
    return Object.freeze(cell) as unknown as Cell;
  });
  return Object.freeze(cells) as unknown as BoardState;
}
