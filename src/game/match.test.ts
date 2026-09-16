/**
 * Otrio Extreme — the official alternative version (docs/RULES.md §8.1) and
 * the rotate-the-starter tip (§8.3).
 */

import { describe, expect, it } from 'vitest';
import { createConfig, createGame, replay } from './engine.ts';
import {
  DEFAULT_MATCH_TARGET,
  createMatch,
  nextGameOptions,
  recordGame,
  type MatchState,
} from './match.ts';
import type { GameState, Move, SeatId } from './types.ts';

/** A 4-player game purple wins on move 9; blue (seat 3) moved immediately before. */
function purpleWins(): GameState {
  const moves: Move[] = [
    { player: 0, space: 2, size: 'large' },
    { player: 1, space: 0, size: 'small' },
    { player: 2, space: 1, size: 'small' },
    { player: 3, space: 3, size: 'small' },
    { player: 0, space: 4, size: 'medium' },
    { player: 1, space: 0, size: 'medium' },
    { player: 2, space: 1, size: 'medium' },
    { player: 3, space: 3, size: 'medium' },
    { player: 0, space: 6, size: 'small' },
  ];
  return replay(createConfig({ players: 4, firstPlayer: 0 }), moves);
}

/** A 3-player game that fills the board with no Otrio. */
function threePlayerDraw(): GameState {
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
  return replay(createConfig({ players: 3, firstPlayer: 0 }), moves);
}

describe('match scoring', () => {
  it('starts everyone on zero with the official target of five', () => {
    const match = createMatch({ baseOptions: { players: 4 } });
    expect(match.config.target).toBe(DEFAULT_MATCH_TARGET);
    expect(match.scores).toEqual([0, 0, 0, 0]);
    expect(match.status).toBe('playing');
    expect(match.winner).toBeNull();
  });

  it('grants one point to the winner of each game', () => {
    const match = recordGame(createMatch({ baseOptions: { players: 4 } }), purpleWins());
    expect(match.scores).toEqual([1, 0, 0, 0]);
    expect(match.games).toHaveLength(1);
    expect(match.games[0].winner).toBe(0);
    expect(match.games[0].condition).toBe('sequence');
    expect(match.games[0].moves).toBe(9);
    expect(match.games[0].penalised).toBeNull(); // penalty is off by default
  });

  it('deducts a point from whoever moved immediately before the winner', () => {
    const match = recordGame(
      createMatch({ baseOptions: { players: 4 }, blockPenalty: true }),
      purpleWins(),
    );
    expect(match.games[0].penalised).toBe(3);
    expect(match.scores).toEqual([1, 0, 0, -1]);
  });

  it('scores a draw as nothing for anyone and plays on', () => {
    const match = recordGame(
      createMatch({ baseOptions: { players: 3 }, blockPenalty: true }),
      threePlayerDraw(),
    );
    expect(match.scores).toEqual([0, 0, 0]);
    expect(match.games[0].winner).toBeNull();
    expect(match.games[0].condition).toBeNull();
    expect(match.games[0].penalised).toBeNull();
    expect(match.status).toBe('playing');
  });

  it('ends at five points and then ignores further games', () => {
    let match: MatchState = createMatch({ baseOptions: { players: 4 } });
    for (let i = 0; i < 5; i += 1) match = recordGame(match, purpleWins());
    expect(match.status).toBe('complete');
    expect(match.winner).toBe(0 as SeatId);
    expect(match.scores).toEqual([5, 0, 0, 0]);

    const frozen = recordGame(match, purpleWins());
    expect(frozen).toBe(match);
  });

  it('honours a custom target', () => {
    let match = createMatch({ baseOptions: { players: 4 }, target: 2 });
    match = recordGame(match, purpleWins());
    expect(match.status).toBe('playing');
    match = recordGame(match, purpleWins());
    expect(match.status).toBe('complete');
    expect(match.winner).toBe(0);
  });

  it('refuses to record an unfinished game', () => {
    expect(() =>
      recordGame(createMatch({ baseOptions: { players: 4 } }), createGame({ players: 4 })),
    ).toThrow();
  });

  it('never mutates the match it is given', () => {
    const before = createMatch({ baseOptions: { players: 4 } });
    const snapshot = JSON.stringify(before);
    recordGame(before, purpleWins());
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('rotating who goes first between games', () => {
  it('returns the base options before any game has been played', () => {
    const match = createMatch({ baseOptions: { players: 4, seed: 9 } });
    expect(nextGameOptions(match)).toEqual({ players: 4, seed: 9 });
  });

  /** A game ended without playing it out, so the rotation can be tested on its own. */
  const ended = (game: GameState): GameState => ({ ...game, status: 'draw' });

  it('advances one step round the turn cycle after each game', () => {
    let match = createMatch({ baseOptions: { players: 4, firstPlayer: 0 } });
    const openers: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const game = createGame(nextGameOptions(match));
      openers.push(game.currentPlayer);
      match = recordGame(match, ended(game));
    }
    // First game keeps the explicit opener, then it rotates and wraps.
    expect(openers).toEqual([0, 1, 2, 3, 0]);
  });

  it('wraps over the four-slot cycle of an official 2-player game', () => {
    let match = createMatch({ baseOptions: { players: 2, firstPlayer: 0 } });
    const openers: number[] = [];
    const seats: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const game = createGame(nextGameOptions(match));
      openers.push(game.currentPlayer);
      seats.push(game.currentSeat);
      match = recordGame(match, ended(game));
    }
    expect(openers).toEqual([0, 1, 2, 3, 0]);
    // Which seat opens genuinely alternates, which is the point of the tip.
    expect(seats).toEqual([0, 1, 0, 1, 0]);
  });

  it('rotates across real games too', () => {
    let match = createMatch({ baseOptions: { players: 3, firstPlayer: 0 } });
    match = recordGame(match, threePlayerDraw());
    const second = createGame(nextGameOptions(match));
    expect(second.currentPlayer).toBe(1);
  });
});
