/**
 * The referee adapter, and the withdrawal affordance it needs.
 *
 * `server/src/rules.ts` binds to `rules` at startup and refuses to boot if it
 * cannot. These tests hold that contract in place.
 */

import { describe, expect, it } from 'vitest';
import { applyMove, createConfig, createGame, replay, withdrawSeat } from './engine.ts';
import { rules, referee, toSnapshot } from './adapter.ts';
import { legalMoves } from './rules.ts';
import { remainingPieces } from './board.ts';
import type { GameState, Move } from './types.ts';

/** Play a scripted 4-player game to its end. */
function scripted(moves: Move[]): GameState {
  return replay(createConfig({ players: 4, firstPlayer: 0 }), moves);
}

const NESTED_WIN: Move[] = [
  { player: 0, space: 4, size: 'small' },
  { player: 1, space: 0, size: 'small' },
  { player: 2, space: 8, size: 'small' },
  { player: 3, space: 2, size: 'small' },
  { player: 0, space: 4, size: 'medium' },
  { player: 1, space: 0, size: 'medium' },
  { player: 2, space: 8, size: 'medium' },
  { player: 3, space: 2, size: 'medium' },
  { player: 0, space: 4, size: 'large' },
];

const ASCENDING_WIN: Move[] = [
  { player: 0, space: 0, size: 'small' },
  { player: 1, space: 3, size: 'small' },
  { player: 2, space: 6, size: 'small' },
  { player: 3, space: 8, size: 'small' },
  { player: 0, space: 1, size: 'medium' },
  { player: 1, space: 3, size: 'medium' },
  { player: 2, space: 6, size: 'medium' },
  { player: 3, space: 8, size: 'medium' },
  { player: 0, space: 2, size: 'large' },
];

describe('referee adapter', () => {
  it('is exported under both names the server probes for', () => {
    expect(referee).toBe(rules);
    expect(typeof rules.createGame).toBe('function');
    expect(typeof rules.currentSeat).toBe('function');
    expect(typeof rules.isFinished).toBe('function');
    expect(typeof rules.applyMove).toBe('function');
    expect(typeof rules.legalMoves).toBe('function');
    expect(typeof rules.snapshot).toBe('function');
    expect(typeof rules.withdraw).toBe('function');
  });

  it('creates a game for 2, 3 or 4 seats with seat 0 to move', () => {
    for (const players of [2, 3, 4]) {
      const game = rules.createGame(players);
      expect(rules.currentSeat(game)).toBe(0);
      expect(rules.isFinished(game)).toBe(false);
      expect(rules.snapshot(game).reserves).toHaveLength(players);
    }
    expect(() => rules.createGame(1)).toThrow(RangeError);
    expect(() => rules.createGame(5)).toThrow(RangeError);
  });

  it('gives a networked 2-player game one colour per seat', () => {
    // The documented divergence: the wire has one reserve per seat, which the
    // official two-colours-per-seat variant cannot fill. See adapter.ts.
    const game = rules.createGame(2);
    expect(game.config.colorsInPlay).toEqual([0, 1]);
    expect(game.config.seats.map((s) => s.controls)).toEqual([[0], [1]]);
    expect(rules.snapshot(game).reserves).toEqual([
      { small: 3, medium: 3, large: 3 },
      { small: 3, medium: 3, large: 3 },
    ]);
  });

  it('rejects rather than throws, and never mutates the game', () => {
    const game = rules.createGame(4);
    const before = JSON.stringify(game);

    expect(rules.applyMove(game, 1, { cell: 0, size: 'small' })).toEqual({
      ok: false,
      reason: 'not your turn',
    });
    expect(rules.applyMove(game, 0, { cell: 9, size: 'small' })).toEqual({
      ok: false,
      reason: 'no such cell: 9',
    });
    expect(
      rules.applyMove(game, 0, { cell: 0, size: 'enormous' as 'small' }).ok,
    ).toBe(false);
    expect(JSON.stringify(game)).toBe(before);

    const ok = rules.applyMove(game, 0, { cell: 4, size: 'medium' });
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(game)).toBe(before);
    if (!ok.ok) throw new Error('unreachable');
    expect(rules.currentSeat(ok.game)).toBe(1);

    // The slot is now taken, whoever asks.
    expect(rules.applyMove(ok.game, 1, { cell: 4, size: 'medium' })).toEqual({
      ok: false,
      reason: 'slot-occupied',
    });
  });

  it('offers legal moves only to the seat on turn', () => {
    const game = rules.createGame(4);
    expect(rules.legalMoves(game, 0)).toHaveLength(27);
    expect(rules.legalMoves(game, 1)).toEqual([]);
    expect(rules.legalMoves(game, 3)).toEqual([]);
    expect(rules.legalMoves(game, 0)[0]).toEqual({ cell: 0, size: 'small' });

    const finished = scripted(NESTED_WIN);
    expect(rules.legalMoves(finished, 0)).toEqual([]);
    expect(rules.applyMove(finished, 1, { cell: 5, size: 'small' })).toEqual({
      ok: false,
      reason: 'game is already over',
    });
  });

  it('projects a live game onto the wire snapshot', () => {
    let game = rules.createGame(4);
    const applied = rules.applyMove(game, 0, { cell: 4, size: 'large' });
    if (!applied.ok) throw new Error('unreachable');
    game = applied.game;

    const snap = rules.snapshot(game);
    expect(snap.board).toHaveLength(9);
    expect(snap.board[4]).toEqual({ small: null, medium: null, large: 0 });
    expect(snap.board[0]).toEqual({ small: null, medium: null, large: null });
    expect(snap.reserves[0]).toEqual({ small: 3, medium: 3, large: 2 });
    expect(snap.reserves[1]).toEqual({ small: 3, medium: 3, large: 3 });
    expect(snap.turn).toBe(1);
    expect(snap.phase).toBe('playing');
    expect(snap.winner).toBeNull();
    expect(snap.isDraw).toBe(false);
    expect(snap.winningLine).toBeNull();
    expect(snap.moveCount).toBe(1);
    expect(snap.lastMove).toEqual({ seat: 0, move: { cell: 4, size: 'large' } });
    expect(snap.forfeitedSeats).toEqual([]);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it('translates each win condition into the wire spelling', () => {
    const sameSize = scripted([
      { player: 0, space: 0, size: 'large' },
      { player: 1, space: 3, size: 'small' },
      { player: 2, space: 6, size: 'small' },
      { player: 3, space: 8, size: 'small' },
      { player: 0, space: 1, size: 'large' },
      { player: 1, space: 3, size: 'medium' },
      { player: 2, space: 6, size: 'medium' },
      { player: 3, space: 8, size: 'medium' },
      { player: 0, space: 2, size: 'large' },
    ]);
    expect(toSnapshot(sameSize).winningLine).toEqual({
      kind: 'same-size',
      cells: [0, 1, 2],
      sizes: ['large', 'large', 'large'],
      seat: 0,
    });

    expect(toSnapshot(scripted(ASCENDING_WIN)).winningLine).toEqual({
      kind: 'ascending',
      cells: [0, 1, 2],
      sizes: ['small', 'medium', 'large'],
      seat: 0,
    });

    expect(toSnapshot(scripted(NESTED_WIN)).winningLine).toEqual({
      kind: 'concentric',
      cells: [4, 4, 4],
      sizes: ['small', 'medium', 'large'],
      seat: 0,
    });
  });

  it('reports a finished game as finished', () => {
    const finished = scripted(NESTED_WIN);
    const snap = rules.snapshot(finished);
    expect(rules.isFinished(finished)).toBe(true);
    expect(snap.phase).toBe('finished');
    expect(snap.winner).toBe(0);
    expect(snap.isDraw).toBe(false);
  });
});

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
    const finished = scripted(NESTED_WIN);
    const after = withdrawSeat(finished, 1);
    expect(after.status).toBe('won');
    expect(after.result?.seat).toBe(0);
    expect(after.config.withdrawnSeats).toEqual([1]);
    expect(rules.snapshot(after).forfeitedSeats).toEqual([1]);
  });

  it('is reachable through the adapter and shows up on the wire', () => {
    const after = rules.withdraw(rules.createGame(3), 1);
    expect(rules.snapshot(after).forfeitedSeats).toEqual([1]);
    expect(rules.legalMoves(after, 1)).toEqual([]);
    expect(rules.applyMove(after, 1, { cell: 0, size: 'small' })).toEqual({
      ok: false,
      reason: 'not your turn',
    });
  });
});

/**
 * Every `.ts` file in this directory, read through Vite's glob rather than
 * `node:fs` so the test needs no Node globals (the app tsconfig's `types` list
 * deliberately omits `node`). Comments are blanked out first, so a specimen
 * import inside a doc comment is not mistaken for a real one.
 */
const SOURCES = import.meta.glob('./*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function engineSources(includeTests: boolean): [string, string][] {
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return Object.entries(SOURCES)
    .filter(([path]) => includeTests || !path.includes('.test.'))
    .map(([path, source]) => [path.replace('./', ''), strip(source)] as [string, string]);
}

describe('module hygiene', () => {
  /**
   * The Node server loads `src/game/index.ts` with `--experimental-strip-types`
   * and a bare `await import()`. Node's ESM resolver does not guess
   * extensions, so an extensionless relative import throws
   * ERR_MODULE_NOT_FOUND — which `server/src/rules.ts` deliberately treats as
   * "file does not exist" and swallows. The server would then refuse to boot
   * with a message that points nowhere near the real cause. Hence this test.
   */
  it('uses explicit .ts extensions on every intra-engine import', () => {
    const offenders: string[] = [];
    for (const [file, source] of engineSources(true)) {
      for (const match of source.matchAll(/from\s+'(\.[^']*)'/g)) {
        if (!match[1].endsWith('.ts')) offenders.push(`${file}: ${match[1]}`);
      }
    }
    // `../net/protocol` is exempt: it is an `import type`, fully erased before
    // Node ever sees it, and it follows the net layer's own convention.
    expect(offenders.filter((o) => !o.includes('../net/'))).toEqual([]);
  });

  it('keeps the engine free of runtime dependencies outside src/game', () => {
    const leaks: string[] = [];
    for (const [file, source] of engineSources(false)) {
      // A value import (no leading `type`) that escapes this directory.
      for (const match of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)) {
        const spec = match[1];
        if (spec.startsWith('./')) continue;
        leaks.push(`${file}: ${spec}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
