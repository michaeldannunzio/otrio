/**
 * Full-game simulations and cross-cutting invariants.
 *
 * The scripted games are narrated end to end so a rules change that breaks a
 * real sequence shows up as a readable diff. The randomised sweep then plays
 * several hundred complete games across every supported configuration and
 * asserts the engine's invariants after every single move.
 */

import { describe, expect, it } from 'vitest';
import { isBoardFull, piecesOnBoard, remainingPieces } from './board.ts';
import { applyMove, createGame, replay, createConfig } from './engine.ts';
import { WIN_PATTERNS } from './patterns.ts';
import {
  hasWon,
  isLegal,
  isSlotBanned,
  legalMoves,
  nobodyCanMove,
  seatOf,
  winningLinesFor,
} from './rules.ts';
import { makeRng } from './random.ts';
import { playOut } from './test-helpers.ts';
import {
  PIECES_PER_SIZE,
  SIZES,
  SPACES,
  type GameState,
  type Move,
  type PlayerId,
} from './types.ts';
import type { NewGameOptions } from './engine.ts';

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** Everything that must be true of any state the engine ever produces. */
function checkInvariants(state: GameState): void {
  const { config, board } = state;

  expect(state.moveNumber).toBe(state.history.length);
  expect(piecesOnBoard(board)).toBe(state.moveNumber);
  expect(state.currentSeat).toBe(seatOf(config, state.currentPlayer));
  expect(state.playableColors.length).toBeGreaterThan(0);
  expect(state.playableColors).toContain(state.currentPlayer);

  // Nobody ever has more than three pieces of a size on the board, or fewer
  // than zero left.
  for (const color of config.colorsInPlay) {
    const left = remainingPieces(board, color);
    for (const size of SIZES) {
      expect(left[size]).toBeGreaterThanOrEqual(0);
      expect(left[size]).toBeLessThanOrEqual(PIECES_PER_SIZE);
    }
  }

  // A banned slot is never occupied.
  for (const banned of config.bannedSlots) {
    expect(board[banned.space][banned.size]).toBeNull();
  }

  const winners = config.colorsInPlay.filter((c) => hasWon(board, c));

  if (state.status === 'playing') {
    expect(state.result).toBeNull();
    expect(winners).toEqual([]);
    expect(legalMoves(state).length).toBeGreaterThan(0);
  } else if (state.status === 'draw') {
    expect(state.result).toBeNull();
    expect(winners).toEqual([]);
    expect(nobodyCanMove(config, board)).toBe(true);
    expect(legalMoves(state)).toEqual([]);
  } else {
    // §6.1: exactly one colour can ever be winning.
    expect(winners).toEqual([state.result!.player]);
    expect(state.result!.contested).toEqual([]);
    expect(state.result!.seat).toBe(seatOf(config, state.result!.player));
    expect(state.result!.condition).toBe(state.result!.lines[0].condition);
    expect(state.result!.lines.length).toBeGreaterThan(0);
    expect(state.result!.lines).toEqual(winningLinesFor(board, state.result!.player));
    expect(state.lastMove!.player).toBe(state.result!.player);

    for (const line of state.result!.lines) {
      // Every reported triple really is on the board, really is one colour,
      // and really is one of the 49 official patterns.
      expect(line.pieces).toHaveLength(3);
      expect(line.spaces).toEqual(line.pieces.map((p) => p.space));
      for (const piece of line.pieces) {
        expect(piece.player).toBe(state.result!.player);
        expect(board[piece.space][piece.size]).toBe(state.result!.player);
      }
      const key = line.pieces
        .map((p) => `${p.space}:${p.size}`)
        .slice()
        .sort()
        .join('|');
      const known = WIN_PATTERNS.some(
        (p) =>
          p.slots
            .map((s) => `${s.space}:${s.size}`)
            .slice()
            .sort()
            .join('|') === key,
      );
      expect(known, `unknown winning triple ${key}`).toBe(true);
    }
    expect(
      state.result!.lines.some((line) =>
        line.pieces.some(
          (p) => p.space === state.lastMove!.space && p.size === state.lastMove!.size,
        ),
      ),
      'the winning move must appear in at least one reported triple',
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Scripted games
// ---------------------------------------------------------------------------

describe('scripted full games', () => {
  it('official 2-player: seat 0 wins by nesting purple in the centre', () => {
    // Rotation is purple(s0), red(s1), green(s0), blue(s1). Seat 0 builds a
    // concentric Otrio in the centre with purple over its three purple turns,
    // while seat 1 stacks two colours it never gets to finish.
    const moves: Move[] = [
      { player: 0, space: 4, size: 'small' },
      { player: 1, space: 0, size: 'small' },
      { player: 2, space: 8, size: 'small' },
      { player: 3, space: 2, size: 'small' },
      { player: 0, space: 4, size: 'medium' },
      { player: 1, space: 0, size: 'medium' },
      { player: 2, space: 8, size: 'medium' },
      { player: 3, space: 2, size: 'medium' },
      { player: 0, space: 4, size: 'large' }, // Otrio!
    ];
    const final = replay(createConfig({ players: 2, firstPlayer: 0 }), moves);

    expect(final.status).toBe('won');
    expect(final.moveNumber).toBe(9);
    expect(final.result?.player).toBe(0);
    expect(final.result?.seat).toBe(0);
    expect(final.result?.condition).toBe('nested');
    expect(final.result?.lines).toHaveLength(1);
    expect(final.result?.lines[0].spaces).toEqual([4, 4, 4]);
    expect(final.result?.lines[0].pieces.map((p) => p.size)).toEqual(['small', 'medium', 'large']);
    checkInvariants(final);

    // The game was decided on the last move and not before.
    expect(replay(final.config, moves.slice(0, 8)).status).toBe('playing');
  });

  it('4-player: purple wins with a descending run down the anti-diagonal', () => {
    const moves: Move[] = [
      { player: 0, space: 2, size: 'large' },
      { player: 1, space: 0, size: 'small' },
      { player: 2, space: 1, size: 'small' },
      { player: 3, space: 3, size: 'small' },
      { player: 0, space: 4, size: 'medium' },
      { player: 1, space: 0, size: 'medium' },
      { player: 2, space: 1, size: 'medium' },
      { player: 3, space: 3, size: 'medium' },
      { player: 0, space: 6, size: 'small' }, // Otrio!
    ];
    const final = replay(createConfig({ players: 4, firstPlayer: 0 }), moves);

    expect(final.status).toBe('won');
    expect(final.result?.condition).toBe('sequence');
    expect(final.result?.lines[0].sequenceDirection).toBe('descending');
    expect(final.result?.lines[0].orientation).toBe('anti-diagonal');
    // Reported small-to-large, so the spaces run 6, 4, 2.
    expect(final.result?.lines[0].spaces).toEqual([6, 4, 2]);
    checkInvariants(final);
  });

  it('3-player: purple wins the middle column with three mediums', () => {
    const moves: Move[] = [
      { player: 0, space: 1, size: 'medium' },
      { player: 1, space: 0, size: 'small' },
      { player: 2, space: 2, size: 'small' },
      { player: 0, space: 4, size: 'medium' },
      { player: 1, space: 3, size: 'small' },
      { player: 2, space: 5, size: 'small' },
      { player: 0, space: 7, size: 'medium' }, // Otrio!
    ];
    const final = replay(createConfig({ players: 3, firstPlayer: 0 }), moves);

    expect(final.status).toBe('won');
    expect(final.result?.condition).toBe('same-size');
    expect(final.result?.lines[0].orientation).toBe('column');
    expect(final.result?.lines[0].spaces).toEqual([1, 4, 7]);
    expect(final.result?.lines[0].pieces.every((p) => p.size === 'medium')).toBe(true);
    checkInvariants(final);
  });

  it('blocking works: taking one slot of a space denies the concentric Otrio', () => {
    const config = createConfig({ players: 4, firstPlayer: 0 });
    const blocked = replay(config, [
      { player: 0, space: 4, size: 'small' },
      { player: 1, space: 4, size: 'medium' }, // red takes the slot purple needs
      { player: 2, space: 0, size: 'small' },
      { player: 3, space: 8, size: 'small' },
      { player: 0, space: 4, size: 'large' },
    ]);
    expect(blocked.status).toBe('playing');
    expect(hasWon(blocked.board, 0)).toBe(false);
    // Purple still owns two of the three slots; red owns the third.
    expect(blocked.board[4]).toEqual({ small: 0, medium: 1, large: 0 });
  });
});

// ---------------------------------------------------------------------------
// Randomised sweep
// ---------------------------------------------------------------------------

const CONFIGS: { label: string; options: NewGameOptions }[] = [
  { label: '2p official', options: { players: 2, twoPlayerMode: 'official' } },
  { label: '2p free-colors', options: { players: 2, twoPlayerMode: 'free-colors' } },
  { label: '2p one-color', options: { players: 2, twoPlayerMode: 'one-color' } },
  { label: '2p official + centre handicap', options: { players: 2, banCenterMedium: true } },
  { label: '3p', options: { players: 3 } },
  { label: '4p', options: { players: 4 } },
];

describe('randomised full games', () => {
  for (const { label, options } of CONFIGS) {
    it(`plays 60 complete ${label} games with every invariant holding throughout`, () => {
      const outcomes = { won: 0, draw: 0 };

      for (let seed = 1; seed <= 60; seed += 1) {
        const rng = makeRng(seed * 7919);
        let state = createGame({ ...options, seed });
        checkInvariants(state);

        const seenMoves: Move[] = [];
        while (state.status === 'playing') {
          const moves = legalMoves(state);
          expect(moves.length).toBeGreaterThan(0);
          const move = moves[Math.floor(rng() * moves.length)];
          expect(isLegal(state, move)).toBe(true);
          seenMoves.push(move);
          state = applyMove(state, move);
          checkInvariants(state);
        }

        // Terminates, and within the physical bound of 27 slots.
        expect(state.moveNumber).toBeLessThanOrEqual(27);
        expect(state.history).toEqual(seenMoves);
        // The whole game replays to exactly the same place.
        expect(replay(state.config, state.history)).toEqual(state);

        if (state.status === 'won') outcomes.won += 1;
        else outcomes.draw += 1;
      }

      // Random play should produce at least some decisive games everywhere.
      expect(outcomes.won + outcomes.draw).toBe(60);
      expect(outcomes.won).toBeGreaterThan(0);
    });
  }
});

describe('a win-seeking bot', () => {
  const winSeeking = (moves: readonly Move[], state: GameState): Move => {
    for (const move of moves) {
      const after = applyMove(state, move);
      if (after.status === 'won') return move;
    }
    return moves[0];
  };

  it('always finds an available Otrio rather than passing it by', () => {
    for (const { options } of CONFIGS) {
      for (let seed = 1; seed <= 8; seed += 1) {
        const final = playOut(createGame({ ...options, seed }), applyMove, winSeeking);
        expect(final.status === 'won' || final.status === 'draw').toBe(true);
        checkInvariants(final);

        // At no point did a player have a winning move and decline it.
        let state = createGame({ ...options, seed });
        for (const move of final.history) {
          const winningAvailable = legalMoves(state).filter(
            (m) => applyMove(state, m).status === 'won',
          );
          if (winningAvailable.length > 0) {
            expect(applyMove(state, move).status).toBe('won');
          }
          state = applyMove(state, move);
        }
      }
    }
  });
});

describe('physical bounds', () => {
  it('never puts more than 27 pieces on the board, whatever the player count', () => {
    for (const { options } of CONFIGS) {
      for (let seed = 1; seed <= 12; seed += 1) {
        const rng = makeRng(seed);
        const final = playOut(createGame({ ...options, seed }), applyMove, (moves) =>
          moves[Math.floor(rng() * moves.length)],
        );
        expect(piecesOnBoard(final.board)).toBeLessThanOrEqual(27);
        if (isBoardFull(final.board)) expect(piecesOnBoard(final.board)).toBe(27);
      }
    }
  });

  it('never fills a banned slot, over a whole game', () => {
    const rng = makeRng(31337);
    for (let seed = 1; seed <= 20; seed += 1) {
      const final = playOut(
        createGame({ players: 2, banCenterMedium: true, seed }),
        applyMove,
        (moves) => moves[Math.floor(rng() * moves.length)],
      );
      expect(isSlotBanned(final.config, 4, 'medium')).toBe(true);
      expect(final.board[4].medium).toBeNull();
      expect(piecesOnBoard(final.board)).toBeLessThanOrEqual(26);
    }
  });

  it('gives every colour exactly 3 pieces of each size, never more', () => {
    const rng = makeRng(24601);
    for (let seed = 1; seed <= 20; seed += 1) {
      const final = playOut(createGame({ players: 4, seed }), applyMove, (moves) =>
        moves[Math.floor(rng() * moves.length)],
      );
      for (const color of final.config.colorsInPlay as PlayerId[]) {
        for (const size of SIZES) {
          const placed = SPACES.filter((s) => final.board[s][size] === color).length;
          expect(placed).toBeLessThanOrEqual(PIECES_PER_SIZE);
        }
      }
    }
  });
});
