/**
 * The public surface other agents import.
 *
 * Everything here goes through `src/game/index.ts` exactly as the scene, UI and
 * network layers will, so a barrel that stops re-exporting something fails
 * here rather than in someone else's build.
 */

import { describe, expect, it } from 'vitest';
import {
  PIECES_PER_PLAYER,
  PIECES_PER_SIZE,
  PLAYER_COLOR_NAMES,
  SIZES,
  SLOT_COUNT,
  SPACES,
  SPACE_COUNT,
  TWO_PLAYER_COLOR_PAIRS,
  WIN_PATTERN_COUNT,
  applyMove,
  checkWin,
  colOf,
  createGame,
  createMove,
  isLegal,
  isPlayerId,
  isSize,
  isSpaceIndex,
  legalMoves,
  pieceAt,
  remainingPieces,
  replay,
  rowOf,
  seatOf,
  seedFromString,
  spaceAt,
  toSpaceIndex,
  type BoardState,
  type Cell,
  type GameState,
  type Move,
  type PlayerId,
  type Size,
  type WinResult,
} from './index.ts';

describe('public API', () => {
  it('exposes the board constants a renderer needs', () => {
    expect(SPACES).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(SPACE_COUNT).toBe(9);
    expect(SIZES).toEqual(['small', 'medium', 'large']);
    expect(SLOT_COUNT).toBe(27);
    expect(PIECES_PER_SIZE).toBe(3);
    expect(PIECES_PER_PLAYER).toBe(9);
    expect(WIN_PATTERN_COUNT).toBe(49);
    expect(PLAYER_COLOR_NAMES).toEqual(['purple', 'red', 'green', 'blue']);
    expect(TWO_PLAYER_COLOR_PAIRS).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it('maps between space indices and row/column', () => {
    expect(rowOf(0)).toBe(0);
    expect(colOf(0)).toBe(0);
    expect(rowOf(4)).toBe(1);
    expect(colOf(4)).toBe(1);
    expect(rowOf(8)).toBe(2);
    expect(colOf(8)).toBe(2);
    for (const space of SPACES) expect(spaceAt(rowOf(space), colOf(space))).toBe(space);
    expect(() => spaceAt(3, 0)).toThrow(RangeError);
  });

  it('narrows loose input from the network or a click handler', () => {
    expect(isSpaceIndex(4)).toBe(true);
    expect(isSpaceIndex(9)).toBe(false);
    expect(isSpaceIndex('4')).toBe(false);
    expect(isSize('medium')).toBe(true);
    expect(isSize('enormous')).toBe(false);
    expect(isPlayerId(3)).toBe(true);
    expect(isPlayerId(4)).toBe(false);
    expect(toSpaceIndex(8)).toBe(8);
    expect(() => toSpaceIndex(11)).toThrow(RangeError);
    expect(createMove(1, 7, 'large')).toEqual({ player: 1, space: 7, size: 'large' });
  });

  it('runs an end-to-end game through the barrel only', () => {
    let state: GameState = createGame({ players: 4, seed: seedFromString('room-42') });
    expect(state.status).toBe('playing');

    const board: BoardState = state.board;
    const cell: Cell = board[0];
    expect(cell).toEqual({ small: null, medium: null, large: null });
    expect(pieceAt(board, 0, 'small')).toBeNull();
    expect(checkWin(state)).toBeNull();

    const moves: Move[] = legalMoves(state);
    expect(moves).toHaveLength(27);
    expect(isLegal(state, moves[0])).toBe(true);

    state = applyMove(state, moves[0]);
    expect(state.moveNumber).toBe(1);
    expect(pieceAt(state.board, moves[0].space, moves[0].size)).toBe(moves[0].player);

    const color: PlayerId = moves[0].player;
    const size: Size = moves[0].size;
    const left: Record<Size, number> = remainingPieces(state.board, color);
    expect(left[size]).toBe(2);
    expect(seatOf(state.config, color)).toBe(color);

    // And the whole thing replays from config + history.
    expect(replay(state.config, state.history)).toEqual(state);
  });

  it('reports a win with the pieces the animation layer highlights', () => {
    let state = createGame({ players: 4, firstPlayer: 0 });
    for (const move of [
      { player: 0, space: 0, size: 'large' },
      { player: 1, space: 1, size: 'small' },
      { player: 2, space: 2, size: 'small' },
      { player: 3, space: 3, size: 'small' },
      { player: 0, space: 1, size: 'large' },
      { player: 1, space: 4, size: 'small' },
      { player: 2, space: 5, size: 'small' },
      { player: 3, space: 6, size: 'small' },
      { player: 0, space: 2, size: 'large' },
    ] as Move[]) {
      state = applyMove(state, move);
    }

    const result: WinResult = state.result!;
    expect(state.status).toBe('won');
    expect(result.player).toBe(0);
    expect(result.seat).toBe(0);
    expect(result.condition).toBe('same-size');
    expect(result.contested).toEqual([]);
    expect(result.lines[0].spaces).toEqual([0, 1, 2]);
    expect(result.lines[0].orientation).toBe('row');
    expect(result.lines[0].pieces).toEqual([
      { space: 0, size: 'large', player: 0 },
      { space: 1, size: 'large', player: 0 },
      { space: 2, size: 'large', player: 0 },
    ]);
  });
});
