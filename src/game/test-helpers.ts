/**
 * Helpers used only by this directory's tests.
 *
 * Deliberately not re-exported from `index.ts` — nothing outside `src/game`
 * should depend on these. Kept in a normal `.ts` file rather than inside a
 * test so several test files can share them.
 */

import { emptyBoard, place } from './board.ts';
import { createConfig, initialState, type NewGameOptions } from './engine.ts';
import { legalMoves, slotAt } from './rules.ts';
import type { BoardState, GameConfig, GameState, Move, PlayerId, Size, SpaceIndex } from './types.ts';

/** One piece, as `[space, size, colour]`. */
export type PieceSpec = readonly [SpaceIndex, Size, PlayerId];

/** Build a board directly, bypassing turn order. For win-detection fixtures. */
export function buildBoard(pieces: readonly PieceSpec[]): BoardState {
  let board = emptyBoard();
  for (const [space, size, player] of pieces) {
    board = place(board, space, size, player);
  }
  return board;
}

export interface PositionOptions extends NewGameOptions {
  /** Colour to move. Must be playable in the resulting turn slot. */
  readonly toMove?: PlayerId;
}

/**
 * A `GameState` wrapped around a hand-built board.
 *
 * `history` is left empty — these are fixtures, not replays, so
 * `rollbackTo`/`undo` are not meaningful on them. Use `replay` for those.
 */
export function positionWith(board: BoardState, options: PositionOptions = {}): GameState {
  const { toMove, ...gameOptions } = options;
  const config: GameConfig = createConfig({
    players: 4,
    ...gameOptions,
    ...(toMove !== undefined ? { firstPlayer: toMove } : {}),
  });
  const slot = slotAt(config, config.firstSlot);
  const state: GameState = {
    ...initialState(config),
    board,
    turnIndex: config.firstSlot,
    currentSeat: slot.seat,
    currentPlayer: toMove ?? slot.colors[0],
    playableColors: slot.colors,
  };
  return Object.freeze(state);
}

/** A readable dump of a board, for assertion failure messages. Each cell is `sml`. */
export function formatBoard(board: BoardState): string {
  const glyph = (owner: PlayerId | null): string => (owner === null ? '.' : String(owner));
  const cellText = (space: SpaceIndex): string => {
    const cell = board[space];
    return `${glyph(cell.small)}${glyph(cell.medium)}${glyph(cell.large)}`;
  };
  const rows: string[] = [];
  for (let row = 0; row < 3; row += 1) {
    rows.push([0, 1, 2].map((col) => cellText((row * 3 + col) as SpaceIndex)).join(' '));
  }
  return rows.join('\n');
}

/**
 * Depth-first search for a game that ends without a winner.
 *
 * Only moves that do not immediately win are explored, so any leaf reached is
 * a position where nobody made an Otrio and nobody can move — a draw by
 * RULES.md §6.2. Moves are tried in `legalMoves` order, which is
 * deterministic, so this returns the same game on every run and every machine.
 *
 * Returns `null` if the node budget runs out first.
 */
export function findDrawnGame(
  start: GameState,
  apply: (state: GameState, move: Move) => GameState,
  budget = 400_000,
): GameState | null {
  let visited = 0;

  const search = (state: GameState): GameState | null => {
    if (state.status === 'draw') return state;
    if (state.status === 'won') return null;
    for (const move of legalMoves(state)) {
      if (visited >= budget) return null;
      visited += 1;
      const next = apply(state, move);
      if (next.status === 'won') continue;
      const found = search(next);
      if (found) return found;
    }
    return null;
  };

  return search(start);
}

/**
 * Play a whole game with a deterministic policy, for simulation tests.
 *
 * `choose` picks from the legal moves; the default takes the first, which is
 * deterministic and produces a real (if unimaginative) game.
 */
export function playOut(
  start: GameState,
  apply: (state: GameState, move: Move) => GameState,
  choose: (moves: readonly Move[], state: GameState) => Move = (moves) => moves[0],
  maxMoves = 40,
): GameState {
  let state = start;
  while (state.status === 'playing' && state.moveNumber < maxMoves) {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error('playing state with no legal moves — engine bug');
    state = apply(state, choose(moves, state));
  }
  return state;
}
