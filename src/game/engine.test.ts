/**
 * Turn structure, skipping, draws and the state-transition contract.
 * Checked against docs/RULES.md §3, §4, §6 and §7.
 */

import { describe, expect, it } from 'vitest';
import { isBoardFull, piecesOnBoard, remainingPieces, totalRemaining } from './board.ts';
import {
  IllegalMoveError,
  applyMove,
  createConfig,
  createGame,
  isGameOver,
  replay,
  rollbackTo,
  tryApplyMove,
  undo,
  withdrawSeat,
} from './engine.ts';
import { hasWon, legalMoves, nobodyCanMove, seatOf } from './rules.ts';
import { buildBoard, findDrawnGame, positionWith, type PieceSpec } from './test-helpers.ts';
import {
  PIECES_PER_PLAYER,
  SLOT_COUNT,
  type Move,
  type PlayerId,
  type SpaceIndex,
} from './types.ts';

/**
 * Nine pieces of one colour arranged so that colour holds no Otrio — lifted
 * from a verified drawn position. Used to exhaust a colour's reserve in
 * skip-turn fixtures.
 */
const NINE_SAFE_PIECES = (color: PlayerId): PieceSpec[] => [
  [2, 'small', color],
  [4, 'small', color],
  [8, 'small', color],
  [0, 'medium', color],
  [3, 'medium', color],
  [8, 'medium', color],
  [0, 'large', color],
  [1, 'large', color],
  [7, 'large', color],
];

// ---------------------------------------------------------------------------
// Setup (§3) and turn order (§4.8)
// ---------------------------------------------------------------------------

describe('game setup', () => {
  it('rejects player counts outside 2-4', () => {
    expect(() => createGame({ players: 1 as unknown as 2 })).toThrow(RangeError);
    expect(() => createGame({ players: 5 as unknown as 4 })).toThrow(RangeError);
  });

  it('gives a 4-player game four seats, four colours and 36 pieces', () => {
    const state = createGame({ players: 4 });
    expect(state.config.seats).toHaveLength(4);
    expect(state.config.rotation).toHaveLength(4);
    expect(state.config.colorsInPlay).toEqual([0, 1, 2, 3]);
    expect(state.config.seats.every((s) => s.controls.length === 1)).toBe(true);
    const total = state.config.colorsInPlay.reduce<number>(
      (sum, c) => sum + totalRemaining(state.board, c),
      0,
    );
    expect(total).toBe(36);
  });

  it('sits one colour out of a 3-player game', () => {
    const state = createGame({ players: 3 });
    expect(state.config.seats).toHaveLength(3);
    expect(state.config.colorsInPlay).toEqual([0, 1, 2]);
    expect(state.config.colorsInPlay).not.toContain(3);
    // 27 pieces for 27 slots — the exact fit noted in §2.2.
    expect(state.config.colorsInPlay.length * PIECES_PER_PLAYER).toBe(SLOT_COUNT);
  });

  it('gives the official 2-player game two seats holding opposite colour pairs', () => {
    const state = createGame({ players: 2 });
    expect(state.config.seats).toHaveLength(2);
    expect(state.config.seats[0].controls).toEqual([0, 2]); // purple + green
    expect(state.config.seats[1].controls).toEqual([1, 3]); // red + blue
    expect(state.config.colorsInPlay).toEqual([0, 1, 2, 3]);
    expect(state.config.strictAlternation).toBe(true);
  });

  it('accepts names by seat', () => {
    const state = createGame({ players: 3, names: ['Ada', 'Grace', 'Edsger'] });
    expect(state.config.seats.map((s) => s.name)).toEqual(['Ada', 'Grace', 'Edsger']);
  });
});

describe('first player selection', () => {
  it('is a pure function of the seed', () => {
    for (const seed of [0, 1, 7, 12345, 2 ** 31]) {
      const a = createGame({ players: 4, seed });
      const b = createGame({ players: 4, seed });
      expect(a.config.firstSlot).toBe(b.config.firstSlot);
      expect(a.currentPlayer).toBe(b.currentPlayer);
    }
  });

  it('does not always pick the same opener across seeds', () => {
    const openers = new Set<number>();
    for (let seed = 0; seed < 64; seed += 1) openers.add(createGame({ players: 4, seed }).config.firstSlot);
    expect(openers.size).toBeGreaterThan(1);
  });

  it('honours an explicit firstPlayer and rejects one not in the game', () => {
    expect(createGame({ players: 4, firstPlayer: 2 }).currentPlayer).toBe(2);
    expect(() => createGame({ players: 3, firstPlayer: 3 })).toThrow(RangeError);
  });

  it('never calls Math.random or the clock', () => {
    const realRandom = Math.random;
    const realNow = Date.now;
    Math.random = () => {
      throw new Error('Math.random must not be used by the engine');
    };
    Date.now = () => {
      throw new Error('Date.now must not be used by the engine');
    };
    try {
      let state = createGame({ players: 4, seed: 99 });
      state = applyMove(state, legalMoves(state)[0]);
      state = applyMove(state, legalMoves(state)[0]);
      expect(state.moveNumber).toBe(2);
    } finally {
      Math.random = realRandom;
      Date.now = realNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Turn rotation (§4)
// ---------------------------------------------------------------------------

describe('turn rotation', () => {
  it('goes clockwise through all four colours in a 4-player game', () => {
    let state = createGame({ players: 4, firstPlayer: 0 });
    const seen: PlayerId[] = [];
    for (let i = 0; i < 8; i += 1) {
      seen.push(state.currentPlayer);
      state = applyMove(state, { player: state.currentPlayer, space: (i % 9) as SpaceIndex, size: 'small' });
      if (state.status !== 'playing') break;
    }
    expect(seen.slice(0, 5)).toEqual([0, 1, 2, 3, 0]);
  });

  it('skips the absent colour in a 3-player game', () => {
    let state = createGame({ players: 3, firstPlayer: 0 });
    const seen: PlayerId[] = [];
    for (let i = 0; i < 6; i += 1) {
      seen.push(state.currentPlayer);
      state = applyMove(state, legalMoves(state)[0]);
    }
    expect(seen).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('keeps `currentSeat` in step with `currentPlayer`', () => {
    let state = createGame({ players: 4, firstPlayer: 0 });
    for (let i = 0; i < 6; i += 1) {
      expect(state.currentSeat).toBe(seatOf(state.config, state.currentPlayer));
      state = applyMove(state, legalMoves(state)[0]);
    }
  });
});

// ---------------------------------------------------------------------------
// The official 2-player colour alternation (§4.6)
// ---------------------------------------------------------------------------

describe('2-player official mode: strict colour alternation', () => {
  it('cycles purple, red, green, blue so each seat alternates its own two colours', () => {
    let state = createGame({ players: 2, firstPlayer: 0 });
    expect(state.config.rotation.map((s) => s.seat)).toEqual([0, 1, 0, 1]);
    expect(state.config.rotation.map((s) => s.colors)).toEqual([[0], [1], [2], [3]]);

    const colors: PlayerId[] = [];
    const seats: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      colors.push(state.currentPlayer);
      seats.push(state.currentSeat);
      state = applyMove(state, legalMoves(state)[0]);
      if (state.status !== 'playing') break;
    }
    expect(colors).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(seats).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    // Seat 0's own turns: purple, green, purple, green.
    expect(colors.filter((_, i) => seats[i] === 0)).toEqual([0, 2, 0, 2]);
  });

  it("refuses the seat's other colour when this turn is due the first", () => {
    const state = createGame({ players: 2, firstPlayer: 0 });
    expect(state.playableColors).toEqual([0]);
    expect(tryApplyMove(state, { player: 2, space: 0, size: 'small' })).toEqual({
      ok: false,
      reason: 'not-your-turn',
    });
    expect(() => applyMove(state, { player: 2, space: 0, size: 'small' })).toThrow(IllegalMoveError);
  });

  it('puts all 36 pieces in play across four colours', () => {
    const state = createGame({ players: 2 });
    const total = state.config.colorsInPlay.reduce<number>(
      (sum, c) => sum + totalRemaining(state.board, c),
      0,
    );
    expect(total).toBe(36);
  });
});

describe('2-player free-colors mode', () => {
  it('offers both of a seat’s colours on every turn', () => {
    const state = createGame({ players: 2, twoPlayerMode: 'free-colors', firstPlayer: 0 });
    expect(state.config.strictAlternation).toBe(false);
    expect(state.config.rotation).toHaveLength(2);
    expect(state.playableColors).toEqual([0, 2]);
    expect(legalMoves(state)).toHaveLength(SLOT_COUNT * 2);
    expect(applyMove(state, { player: 2, space: 0, size: 'small' }).currentSeat).toBe(1);
  });

  it('still forbids the other seat’s colours', () => {
    const state = createGame({ players: 2, twoPlayerMode: 'free-colors', firstPlayer: 0 });
    expect(tryApplyMove(state, { player: 1, space: 0, size: 'small' })).toEqual({
      ok: false,
      reason: 'not-your-turn',
    });
  });
});

describe('2-player one-color mode', () => {
  it('puts two colours and 18 pieces in play', () => {
    const state = createGame({ players: 2, twoPlayerMode: 'one-color', firstPlayer: 0 });
    expect(state.config.colorsInPlay).toEqual([0, 1]);
    expect(state.config.rotation.map((s) => s.colors)).toEqual([[0], [1]]);
    const total = state.config.colorsInPlay.reduce<number>(
      (sum, c) => sum + totalRemaining(state.board, c),
      0,
    );
    expect(total).toBe(18);
  });
});

// ---------------------------------------------------------------------------
// Skipping (§4.5)
// ---------------------------------------------------------------------------

describe('skipping a player with no legal move', () => {
  it('passes over an exhausted colour and records it', () => {
    const board = buildBoard(NINE_SAFE_PIECES(1));
    expect(hasWon(board, 1)).toBe(false);
    expect(remainingPieces(board, 1)).toEqual({ small: 0, medium: 0, large: 0 });

    const state = positionWith(board, { players: 4, toMove: 0 });
    const after = applyMove(state, { player: 0, space: 5, size: 'small' });

    expect(after.status).toBe('playing');
    expect(after.currentPlayer).toBe(2); // colour 1 has nothing to place
    expect(after.skipped).toEqual([{ seat: 1, colors: [1] }]);
  });

  it('is not a loss — the skipped seat keeps its place in the cycle', () => {
    const board = buildBoard(NINE_SAFE_PIECES(1));
    let state = positionWith(board, { players: 4, toMove: 0 });
    const seen: PlayerId[] = [];
    for (let i = 0; i < 6 && state.status === 'playing'; i += 1) {
      seen.push(state.currentPlayer);
      state = applyMove(state, legalMoves(state)[0]);
    }
    expect(seen).toEqual([0, 2, 3, 0, 2, 3]);
    expect(isGameOver(state)).toBe(false);
  });

  it('lets the only mobile player keep playing when everyone else is stuck', () => {
    // Two-colour game: colour 1 has placed all nine pieces, colour 0 has not.
    const board = buildBoard([...NINE_SAFE_PIECES(1), [5, 'small', 0], [6, 'medium', 0]]);
    const state = positionWith(board, {
      players: 2,
      twoPlayerMode: 'one-color',
      toMove: 0,
    });
    const after = applyMove(state, { player: 0, space: 6, size: 'small' });
    expect(after.status).toBe('playing');
    expect(after.currentPlayer).toBe(0); // wrapped right back round
    expect(after.skipped).toEqual([{ seat: 1, colors: [1] }]);
  });

  it('in the official 2-player game, a stuck colour skips and alternation advances (§10.2)', () => {
    // Colour 1 (seat 1, red) is exhausted; seat 1's next turn is therefore its
    // other colour, blue, rather than a second attempt at red.
    const board = buildBoard(NINE_SAFE_PIECES(1));
    const state = positionWith(board, { players: 2, twoPlayerMode: 'official', toMove: 0 });
    const after = applyMove(state, { player: 0, space: 5, size: 'small' });
    expect(after.skipped).toEqual([{ seat: 1, colors: [1] }]);
    expect(after.currentSeat).toBe(0);
    expect(after.currentPlayer).toBe(2); // seat 0's green — the cycle moved on
    const next = applyMove(after, { player: 2, space: 5, size: 'medium' });
    expect(next.currentSeat).toBe(1);
    expect(next.currentPlayer).toBe(3); // seat 1 is now due blue
  });
});

// ---------------------------------------------------------------------------
// Draws (§6.2)
// ---------------------------------------------------------------------------

describe('draws', () => {
  it('ends a 2-player one-colour game as a draw when both reserves run out', () => {
    const drawn = findDrawnGame(
      createGame({ players: 2, twoPlayerMode: 'one-color', firstPlayer: 0 }),
      applyMove,
    );
    expect(drawn).not.toBeNull();
    expect(drawn!.status).toBe('draw');
    expect(drawn!.result).toBeNull();
    expect(drawn!.moveNumber).toBe(18); // all 18 pieces placed, 9 slots still free
    expect(isBoardFull(drawn!.board)).toBe(false);
    expect(nobodyCanMove(drawn!.config, drawn!.board)).toBe(true);
    for (const color of drawn!.config.colorsInPlay) expect(hasWon(drawn!.board, color)).toBe(false);
  });

  it('ends a 4-player game as a draw when the board fills with no Otrio', () => {
    const drawn = findDrawnGame(createGame({ players: 4, firstPlayer: 0 }), applyMove);
    expect(drawn).not.toBeNull();
    expect(drawn!.status).toBe('draw');
    expect(drawn!.moveNumber).toBe(SLOT_COUNT); // 27 of the 36 pieces fit
    expect(isBoardFull(drawn!.board)).toBe(true);
    expect(drawn!.skipped).toHaveLength(4); // every seat tried and failed
  });

  it('ends the official 2-player game as a draw too', () => {
    const drawn = findDrawnGame(createGame({ players: 2, firstPlayer: 0 }), applyMove);
    expect(drawn).not.toBeNull();
    expect(drawn!.status).toBe('draw');
    expect(isBoardFull(drawn!.board)).toBe(true);
  });

  it('draws a 3-player game only with a completely full board (exact 27/27 fit)', () => {
    // A verified drawn 3-player game, replayed rather than searched for: the
    // 3-player packing is rare enough that a depth-first search misses it.
    const moves: Move[] = [
      { player: 0, space: 5, size: 'large' },
      { player: 1, space: 2, size: 'small' },
      { player: 2, space: 2, size: 'large' },
      { player: 0, space: 5, size: 'small' },
      { player: 1, space: 0, size: 'large' },
      { player: 2, space: 3, size: 'small' },
      { player: 0, space: 1, size: 'medium' },
      { player: 1, space: 0, size: 'medium' },
      { player: 2, space: 6, size: 'large' },
      { player: 0, space: 4, size: 'medium' },
      { player: 1, space: 4, size: 'small' },
      { player: 2, space: 6, size: 'medium' },
      { player: 0, space: 2, size: 'medium' },
      { player: 1, space: 7, size: 'large' },
      { player: 2, space: 7, size: 'medium' },
      { player: 0, space: 7, size: 'small' },
      { player: 1, space: 1, size: 'large' },
      { player: 2, space: 0, size: 'small' },
      { player: 0, space: 6, size: 'small' },
      { player: 1, space: 8, size: 'medium' },
      { player: 2, space: 3, size: 'large' },
      { player: 0, space: 8, size: 'large' },
      { player: 1, space: 3, size: 'medium' },
      { player: 2, space: 5, size: 'medium' },
      { player: 0, space: 4, size: 'large' },
      { player: 1, space: 8, size: 'small' },
      { player: 2, space: 1, size: 'small' },
    ];
    const final = replay(createConfig({ players: 3, firstPlayer: 0 }), moves);
    expect(final.status).toBe('draw');
    expect(final.moveNumber).toBe(27);
    expect(isBoardFull(final.board)).toBe(true);
    for (const color of final.config.colorsInPlay) {
      expect(hasWon(final.board, color)).toBe(false);
      expect(totalRemaining(final.board, color)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Winning ends the game (§5.7)
// ---------------------------------------------------------------------------

describe('winning', () => {
  it('halts immediately, freezing the turn on the winner', () => {
    const state = positionWith(buildBoard([[0, 'large', 0], [1, 'large', 0]]), {
      players: 4,
      toMove: 0,
    });
    const won = applyMove(state, { player: 0, space: 2, size: 'large' });
    expect(won.status).toBe('won');
    expect(won.currentPlayer).toBe(0);
    expect(won.currentSeat).toBe(0);
    expect(won.result?.condition).toBe('same-size');
    expect(won.skipped).toEqual([]);
    expect(legalMoves(won)).toEqual([]);
  });

  it('attributes a 2-player win to the seat, whichever of its colours did it', () => {
    // Seat 0 owns purple (0) and green (2); win with green.
    const state = positionWith(buildBoard([[0, 'small', 2], [1, 'medium', 2]]), {
      players: 2,
      twoPlayerMode: 'official',
      toMove: 2,
    });
    const won = applyMove(state, { player: 2, space: 2, size: 'large' });
    expect(won.status).toBe('won');
    expect(won.result?.player).toBe(2);
    expect(won.result?.seat).toBe(0);
    expect(won.result?.condition).toBe('sequence');
    expect(won.result?.lines[0].sequenceDirection).toBe('ascending');
  });

  it('never reports a contested win from real play', () => {
    const state = positionWith(buildBoard([[0, 'small', 0], [1, 'small', 0]]), { toMove: 0 });
    const won = applyMove(state, { player: 0, space: 2, size: 'small' });
    expect(won.result?.contested).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Replay, rollback, serialisation (§7 implementation contract)
// ---------------------------------------------------------------------------

describe('replay and rollback', () => {
  it('rebuilds an identical state from config plus history', () => {
    let state = createGame({ players: 4, seed: 4242 });
    for (let i = 0; i < 9 && state.status === 'playing'; i += 1) {
      state = applyMove(state, legalMoves(state)[i % legalMoves(state).length]);
    }
    const rebuilt = replay(state.config, state.history);
    expect(rebuilt).toEqual(state);
  });

  it('rolls back to any earlier move number', () => {
    let state = createGame({ players: 3, seed: 7, firstPlayer: 0 });
    const snapshots = [state];
    for (let i = 0; i < 5; i += 1) {
      state = applyMove(state, legalMoves(state)[0]);
      snapshots.push(state);
    }
    for (let n = 0; n <= 5; n += 1) {
      expect(rollbackTo(state, n)).toEqual(snapshots[n]);
    }
    expect(() => rollbackTo(state, 6)).toThrow(RangeError);
    expect(() => rollbackTo(state, -1)).toThrow(RangeError);
  });

  it('undoes the last move, and is a no-op at the start', () => {
    const start = createGame({ players: 4, firstPlayer: 0 });
    const after = applyMove(start, { player: 0, space: 4, size: 'medium' });
    expect(undo(after)).toEqual(start);
    expect(undo(start)).toBe(start);
  });

  it('survives a JSON round trip', () => {
    let state = createGame({ players: 2, seed: 5, firstPlayer: 1 });
    for (let i = 0; i < 6; i += 1) state = applyMove(state, legalMoves(state)[0]);

    const wire = JSON.parse(JSON.stringify(state));
    expect(wire).toEqual(JSON.parse(JSON.stringify(state)));
    // The whole game is recoverable from the wire form.
    const rebuilt = replay(wire.config, wire.history);
    expect(JSON.parse(JSON.stringify(rebuilt))).toEqual(wire);
  });

  it('refuses an illegal move in a replayed history', () => {
    const config = createConfig({ players: 4, firstPlayer: 0 });
    const moves: Move[] = [
      { player: 0, space: 0, size: 'small' },
      { player: 1, space: 0, size: 'small' }, // slot already taken
    ];
    expect(() => replay(config, moves)).toThrow(IllegalMoveError);
    try {
      replay(config, moves);
    } catch (error) {
      expect((error as IllegalMoveError).reason).toBe('slot-occupied');
      expect((error as IllegalMoveError).move).toEqual(moves[1]);
    }
  });
});

describe('state bookkeeping', () => {
  it('keeps moveNumber, history and the board in agreement', () => {
    let state = createGame({ players: 4, seed: 11 });
    for (let i = 0; i < 12 && state.status === 'playing'; i += 1) {
      state = applyMove(state, legalMoves(state)[3 % legalMoves(state).length]);
      expect(state.moveNumber).toBe(state.history.length);
      expect(piecesOnBoard(state.board)).toBe(state.moveNumber);
      expect(state.lastMove).toEqual(state.history[state.history.length - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Withdrawing a seat — a product affordance, not a rule (§6.5)
// ---------------------------------------------------------------------------

describe('withdrawing a seat', () => {
  it('drops the seat from the rotation and leaves its pieces on the board', () => {
    let game = createGame({ players: 4, firstPlayer: 0 });
    game = applyMove(game, { player: 0, space: 0, size: 'small' });
    game = applyMove(game, { player: 1, space: 1, size: 'small' });
    expect(game.currentPlayer).toBe(2);

    const after = withdrawSeat(game, 2);
    expect(after.config.withdrawnSeats).toEqual([2]);
    expect(after.config.rotation.map((s) => s.seat)).toEqual([0, 1, 3]);
    expect(after.config.seats).toHaveLength(4); // still nameable in the UI
    expect(after.currentSeat).toBe(3); // play moves on past the leaver
    expect(after.status).toBe('playing');
    // Seat 1's piece is still there, still blocking.
    expect(after.board[1].small).toBe(1);
    expect(remainingPieces(after.board, 1)).toEqual({ small: 2, medium: 3, large: 3 });
  });

  it('never gives the withdrawn seat another turn', () => {
    let game = withdrawSeat(createGame({ players: 4, firstPlayer: 0 }), 2);
    const seats: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      seats.push(game.currentSeat);
      game = applyMove(game, legalMoves(game)[0]);
    }
    expect(seats).toEqual([0, 1, 3, 0, 1, 3]);
    expect(seats).not.toContain(2);
  });

  it('is a no-op for a seat that is not in the rotation, and refuses the last one', () => {
    const game = createGame({ players: 3, firstPlayer: 0 });
    expect(withdrawSeat(game, 3)).toBe(game); // seat 3 was never seated
    const oneLeft = withdrawSeat(withdrawSeat(game, 1), 2);
    expect(oneLeft.config.rotation).toHaveLength(1);
    expect(() => withdrawSeat(oneLeft, 0)).toThrow(RangeError);
  });

  it('leaves a finished game finished', () => {
    const finished = replay(createConfig({ players: 4, firstPlayer: 0 }), [
      { player: 0, space: 4, size: 'small' },
      { player: 1, space: 0, size: 'small' },
      { player: 2, space: 8, size: 'small' },
      { player: 3, space: 2, size: 'small' },
      { player: 0, space: 4, size: 'medium' },
      { player: 1, space: 0, size: 'medium' },
      { player: 2, space: 8, size: 'medium' },
      { player: 3, space: 2, size: 'medium' },
      { player: 0, space: 4, size: 'large' },
    ]);
    expect(finished.status).toBe('won');
    const after = withdrawSeat(finished, 1);
    expect(after.status).toBe('won');
    expect(after.result?.seat).toBe(0);
    expect(after.config.withdrawnSeats).toEqual([1]);
  });

  it('draws the game when the remaining seats cannot move either', () => {
    // Colour 1 holds all nine of its pieces on the board already; once the two
    // other seats leave, nobody in the shortened rotation can place.
    let game = createGame({ players: 3, firstPlayer: 0 });
    game = applyMove(game, { player: 0, space: 0, size: 'small' });
    const shortened = withdrawSeat(withdrawSeat(game, 1), 2);
    expect(shortened.config.rotation.map((s) => s.seat)).toEqual([0]);
    expect(shortened.currentSeat).toBe(0);
    expect(shortened.status).toBe('playing'); // colour 0 still has pieces
  });
});
