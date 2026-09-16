/**
 * Win detection and move legality, checked against docs/RULES.md §4 and §5.
 */

import { describe, expect, it } from 'vitest';
import { LINES, LINE_ORIENTATIONS, isBoardFull, piecesOnBoard, remainingPieces } from './board.ts';
import { applyMove, createGame, tryApplyMove } from './engine.ts';
import { WIN_PATTERNS } from './patterns.ts';
import {
  checkBoardWin,
  checkWin,
  colorHasLegalMove,
  createMove,
  hasWon,
  isLegal,
  isSlotBanned,
  legalMoves,
  moveError,
  nobodyCanMove,
  playableSlotCount,
  seatOf,
  winningLinesFor,
} from './rules.ts';
import { buildBoard, positionWith, type PieceSpec } from './test-helpers.ts';
import {
  SIZES,
  SLOT_COUNT,
  SPACES,
  type Line,
  type Move,
  type PlayerId,
  type Size,
  type SpaceIndex,
} from './types.ts';

const ME: PlayerId = 0;
const FOE: PlayerId = 1;

// ---------------------------------------------------------------------------
// The win table (§5.6)
// ---------------------------------------------------------------------------

describe('win table', () => {
  it('has exactly 49 triples per colour: 24 same-size + 16 ordered + 9 concentric', () => {
    expect(WIN_PATTERNS).toHaveLength(49);
    expect(WIN_PATTERNS.filter((p) => p.condition === 'same-size')).toHaveLength(24);
    expect(WIN_PATTERNS.filter((p) => p.condition === 'sequence')).toHaveLength(16);
    expect(WIN_PATTERNS.filter((p) => p.condition === 'nested')).toHaveLength(9);
  });

  it('has 8 lines: 3 rows, 3 columns, 2 diagonals', () => {
    expect(LINES).toHaveLength(8);
    expect(LINE_ORIENTATIONS.filter((o) => o === 'row')).toHaveLength(3);
    expect(LINE_ORIENTATIONS.filter((o) => o === 'column')).toHaveLength(3);
    expect(LINE_ORIENTATIONS.filter((o) => o === 'diagonal')).toHaveLength(1);
    expect(LINE_ORIENTATIONS.filter((o) => o === 'anti-diagonal')).toHaveLength(1);
  });

  it('every triple uses three distinct slots', () => {
    for (const p of WIN_PATTERNS) {
      const keys = p.slots.map((s) => `${s.space}:${s.size}`);
      expect(new Set(keys).size, `${p.condition} ${keys.join(' ')}`).toBe(3);
    }
  });

  it('every triple is distinct from every other', () => {
    const keys = WIN_PATTERNS.map((p) =>
      p.slots
        .map((s) => `${s.space}:${s.size}`)
        .slice()
        .sort()
        .join('|'),
    );
    expect(new Set(keys).size).toBe(49);
  });

  it('orders sequence triples small, medium, large and puts the medium in the middle space', () => {
    for (const p of WIN_PATTERNS.filter((x) => x.condition === 'sequence')) {
      expect(p.slots.map((s) => s.size)).toEqual(['small', 'medium', 'large']);
      const line = LINES[p.line as number];
      expect(p.slots[1].space).toBe(line[1]);
    }
  });

  it('is exhaustive: every 3-slot monochrome set the rules call a win is in the table', () => {
    // Independently re-derive the rules from RULES.md §5.3-§5.5 and compare.
    const expected = new Set<string>();
    const key = (slots: [SpaceIndex, Size][]): string =>
      slots
        .map(([space, size]) => `${space}:${size}`)
        .sort()
        .join('|');

    for (const line of LINES as readonly Line[]) {
      for (const size of SIZES) expected.add(key(line.map((s) => [s, size])));
      expected.add(key([[line[0], 'small'], [line[1], 'medium'], [line[2], 'large']]));
      expected.add(key([[line[0], 'large'], [line[1], 'medium'], [line[2], 'small']]));
    }
    for (const space of SPACES) {
      expected.add(key([[space, 'small'], [space, 'medium'], [space, 'large']]));
    }

    const actual = new Set(
      WIN_PATTERNS.map((p) => key(p.slots.map((s) => [s.space, s.size] as [SpaceIndex, Size]))),
    );
    expect(actual).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// W1 — same size in a row (§5.3)
// ---------------------------------------------------------------------------

describe('W1: three same-sized pieces in a line', () => {
  for (let i = 0; i < LINES.length; i += 1) {
    const line = LINES[i];
    const orientation = LINE_ORIENTATIONS[i];
    for (const size of SIZES) {
      it(`wins on ${orientation} ${line.join('-')} with three ${size}`, () => {
        const board = buildBoard(line.map((space) => [space, size, ME] as PieceSpec));
        const wins = winningLinesFor(board, ME);
        expect(wins).toHaveLength(1);
        expect(wins[0].condition).toBe('same-size');
        expect(wins[0].orientation).toBe(orientation);
        expect(wins[0].player).toBe(ME);
        expect(wins[0].spaces).toEqual([...line]);
        expect(wins[0].pieces.map((p) => p.size)).toEqual([size, size, size]);
        expect(wins[0].sequenceDirection).toBeUndefined();
        expect(hasWon(board, ME)).toBe(true);
        expect(hasWon(board, FOE)).toBe(false);
      });
    }
  }

  it('does not care what else shares those spaces', () => {
    // My three smalls on the top row; the opponent owns every other slot there.
    const board = buildBoard([
      [0, 'small', ME],
      [1, 'small', ME],
      [2, 'small', ME],
      [0, 'medium', FOE],
      [0, 'large', FOE],
      [1, 'medium', FOE],
      [2, 'large', FOE],
    ]);
    expect(hasWon(board, ME)).toBe(true);
    expect(hasWon(board, FOE)).toBe(false);
  });

  it('does not fire for a mixed-colour line', () => {
    const board = buildBoard([
      [0, 'large', ME],
      [1, 'large', ME],
      [2, 'large', FOE],
    ]);
    expect(hasWon(board, ME)).toBe(false);
    expect(hasWon(board, FOE)).toBe(false);
  });

  it('does not fire for three of my pieces that are not collinear', () => {
    const board = buildBoard([
      [0, 'small', ME],
      [1, 'small', ME],
      [3, 'small', ME],
    ]);
    expect(hasWon(board, ME)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W2 — ascending / descending (§5.4)
// ---------------------------------------------------------------------------

describe('W2: three pieces in ascending or descending order', () => {
  for (let i = 0; i < LINES.length; i += 1) {
    const line = LINES[i];
    const orientation = LINE_ORIENTATIONS[i];

    it(`wins ascending along ${orientation} ${line.join('-')}`, () => {
      const board = buildBoard([
        [line[0], 'small', ME],
        [line[1], 'medium', ME],
        [line[2], 'large', ME],
      ]);
      const wins = winningLinesFor(board, ME);
      expect(wins).toHaveLength(1);
      expect(wins[0].condition).toBe('sequence');
      expect(wins[0].sequenceDirection).toBe('ascending');
      expect(wins[0].orientation).toBe(orientation);
      expect(wins[0].spaces).toEqual([...line]);
      expect(wins[0].pieces.map((p) => p.size)).toEqual(['small', 'medium', 'large']);
    });

    it(`wins descending along ${orientation} ${line.join('-')}`, () => {
      const board = buildBoard([
        [line[0], 'large', ME],
        [line[1], 'medium', ME],
        [line[2], 'small', ME],
      ]);
      const wins = winningLinesFor(board, ME);
      expect(wins).toHaveLength(1);
      expect(wins[0].condition).toBe('sequence');
      expect(wins[0].sequenceDirection).toBe('descending');
      // Reported small-to-large, so the spaces run backwards along the line.
      expect(wins[0].spaces).toEqual([line[2], line[1], line[0]]);
      expect(wins[0].pieces.map((p) => p.size)).toEqual(['small', 'medium', 'large']);
    });
  }

  // §5.4: "Non-win examples worth writing a test for."
  const nonMonotonic: [string, [Size, Size, Size]][] = [
    ['medium, small, large', ['medium', 'small', 'large']],
    ['small, large, medium', ['small', 'large', 'medium']],
    ['large, small, medium', ['large', 'small', 'medium']],
    ['medium, large, small', ['medium', 'large', 'small']],
  ];
  for (const [label, sizes] of nonMonotonic) {
    it(`does not win on the non-monotonic line ${label}`, () => {
      const board = buildBoard([
        [0, sizes[0], ME],
        [1, sizes[1], ME],
        [2, sizes[2], ME],
      ]);
      expect(hasWon(board, ME)).toBe(false);
    });
  }

  it('does not win on small, small, large', () => {
    const board = buildBoard([
      [0, 'small', ME],
      [1, 'small', ME],
      [2, 'large', ME],
    ]);
    expect(hasWon(board, ME)).toBe(false);
  });

  it('does not win on a monotonic triple that is not single-coloured', () => {
    const board = buildBoard([
      [0, 'small', ME],
      [1, 'medium', FOE],
      [2, 'large', ME],
    ]);
    expect(hasWon(board, ME)).toBe(false);
    expect(hasWon(board, FOE)).toBe(false);
  });

  it('reports both readings when one line carries an ascending and a descending run', () => {
    // Ends hold both a small and a large; the middle holds the medium.
    const board = buildBoard([
      [0, 'small', ME],
      [0, 'large', ME],
      [1, 'medium', ME],
      [2, 'small', ME],
      [2, 'large', ME],
    ]);
    const wins = winningLinesFor(board, ME).filter((w) => w.condition === 'sequence');
    expect(wins.map((w) => w.sequenceDirection).sort()).toEqual(['ascending', 'descending']);
  });
});

// ---------------------------------------------------------------------------
// W3 — concentric (§5.5)
// ---------------------------------------------------------------------------

describe('W3: three concentric pieces in one space', () => {
  for (const space of SPACES) {
    it(`wins with all three sizes nested in space ${space}`, () => {
      const board = buildBoard(SIZES.map((size) => [space, size, ME] as PieceSpec));
      const wins = winningLinesFor(board, ME);
      expect(wins).toHaveLength(1);
      expect(wins[0].condition).toBe('nested');
      expect(wins[0].orientation).toBe('nested');
      expect(wins[0].spaces).toEqual([space, space, space]);
      expect(wins[0].pieces.map((p) => p.size)).toEqual(['small', 'medium', 'large']);
    });
  }

  it('does not fire when one of the three rings is an opponent block', () => {
    const board = buildBoard([
      [4, 'small', ME],
      [4, 'medium', FOE],
      [4, 'large', ME],
    ]);
    expect(hasWon(board, ME)).toBe(false);
    expect(hasWon(board, FOE)).toBe(false);
  });

  it('does not fire with only two of the three sizes', () => {
    const board = buildBoard([
      [4, 'small', ME],
      [4, 'large', ME],
    ]);
    expect(hasWon(board, ME)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multiple simultaneous wins for one player (§6.1)
// ---------------------------------------------------------------------------

describe('one placement completing several Otrios at once', () => {
  it('reports every completed triple', () => {
    // Space 4 gets my small and large; row 3-4-5 has my mediums at 3 and 5;
    // placing medium at 4 completes the middle row AND nests space 4.
    const before = buildBoard([
      [4, 'small', ME],
      [4, 'large', ME],
      [3, 'medium', ME],
      [5, 'medium', ME],
    ]);
    expect(hasWon(before, ME)).toBe(false);

    const state = positionWith(before, { players: 4, toMove: ME });
    const after = applyMove(state, { player: ME, space: 4, size: 'medium' });

    expect(after.status).toBe('won');
    expect(after.result?.player).toBe(ME);
    const conditions = after.result!.lines.map((l) => l.condition).sort();
    expect(conditions).toEqual(['nested', 'same-size']);
    expect(after.result!.condition).toBe(after.result!.lines[0].condition);
  });

  it('can complete a same-size line and a sequence on different lines', () => {
    const before = buildBoard([
      // Column 0-3-6, all large, missing 6.
      [0, 'large', ME],
      [3, 'large', ME],
      // Anti-diagonal 2-4-6 ascending from 2: small@2, medium@4, large@6.
      [2, 'small', ME],
      [4, 'medium', ME],
    ]);
    const state = positionWith(before, { players: 4, toMove: ME });
    const after = applyMove(state, { player: ME, space: 6, size: 'large' });
    expect(after.status).toBe('won');
    const conditions = after.result!.lines.map((l) => l.condition).sort();
    expect(conditions).toEqual(['same-size', 'sequence']);
  });
});

// ---------------------------------------------------------------------------
// checkWin / checkBoardWin
// ---------------------------------------------------------------------------

describe('checkWin', () => {
  it('returns null for an empty board', () => {
    expect(checkWin(createGame())).toBeNull();
  });

  it('names the winning seat, not just the colour', () => {
    // Official 2-player: colour 2 (green) belongs to seat 0.
    const board = buildBoard([
      [0, 'small', 2],
      [1, 'small', 2],
      [2, 'small', 2],
    ]);
    const state = positionWith(board, { players: 2, twoPlayerMode: 'official' });
    const result = checkWin(state);
    expect(result?.player).toBe(2);
    expect(result?.seat).toBe(0);
    expect(seatOf(state.config, 2)).toBe(0);
  });

  it('leaves `contested` empty in every reachable position', () => {
    const board = buildBoard([
      [0, 'small', ME],
      [1, 'small', ME],
      [2, 'small', ME],
    ]);
    expect(checkWin(positionWith(board))?.contested).toEqual([]);
  });

  it('flags a hand-built impossible position rather than hiding it', () => {
    // Two colours each holding an Otrio cannot arise in play (RULES.md §6.1);
    // if it ever appears, the engine must be deterministic and must say so.
    const board = buildBoard([
      [0, 'small', ME],
      [1, 'small', ME],
      [2, 'small', ME],
      [3, 'large', FOE],
      [4, 'large', FOE],
      [5, 'large', FOE],
    ]);
    const found = checkBoardWin(board, [0, 1, 2, 3]);
    expect(found?.player).toBe(ME); // first in the given order, no arbitration
    expect(found?.contested).toEqual([FOE]);
    // Same answer from every client, whatever order they scan the same list in.
    expect(checkBoardWin(board, [0, 1, 2, 3])?.player).toBe(ME);
    expect(checkBoardWin(board, [1, 0, 2, 3])?.player).toBe(FOE);
  });
});

// ---------------------------------------------------------------------------
// Legality (§4.2)
// ---------------------------------------------------------------------------

describe('move legality', () => {
  it('offers 27 placements on an empty board — 9 spaces x 3 sizes', () => {
    const state = createGame({ players: 4, firstPlayer: 0 });
    const moves = legalMoves(state);
    expect(moves).toHaveLength(SLOT_COUNT);
    expect(moves.every((m) => isLegal(state, m))).toBe(true);
  });

  it('rejects a slot that already holds a piece of that size, whoever owns it', () => {
    const state = positionWith(buildBoard([[4, 'medium', FOE]]), { toMove: ME });
    expect(moveError(state, { player: ME, space: 4, size: 'medium' })).toBe('slot-occupied');
    // The other two slots of the same space stay open — this is how blocking works.
    expect(isLegal(state, { player: ME, space: 4, size: 'small' })).toBe(true);
    expect(isLegal(state, { player: ME, space: 4, size: 'large' })).toBe(true);
  });

  it("rejects a move by a colour that is not on turn", () => {
    const state = createGame({ players: 4, firstPlayer: 0 });
    expect(moveError(state, { player: 1, space: 0, size: 'small' })).toBe('not-your-turn');
  });

  it('rejects a colour that is not in the game', () => {
    const state = createGame({ players: 3, firstPlayer: 0 });
    expect(moveError(state, { player: 3, space: 0, size: 'small' })).toBe('unknown-player');
  });

  it('rejects malformed spaces and sizes', () => {
    const state = createGame({ players: 4, firstPlayer: 0 });
    expect(moveError(state, { player: 0, space: 9 as unknown as SpaceIndex, size: 'small' })).toBe('bad-space');
    expect(moveError(state, { player: 0, space: -1 as unknown as SpaceIndex, size: 'small' })).toBe('bad-space');
    expect(moveError(state, { player: 0, space: 0, size: 'huge' as unknown as Size })).toBe('bad-size');
  });

  it('rejects any move once the game is over', () => {
    const board = buildBoard([
      [0, 'small', ME],
      [1, 'small', ME],
    ]);
    const state = positionWith(board, { toMove: ME });
    const won = applyMove(state, { player: ME, space: 2, size: 'small' });
    expect(won.status).toBe('won');
    expect(moveError(won, { player: 1, space: 8, size: 'large' })).toBe('game-over');
    expect(tryApplyMove(won, { player: 1, space: 8, size: 'large' })).toEqual({
      ok: false,
      reason: 'game-over',
    });
  });

  it('rejects a fourth piece of a size once the reserve is empty', () => {
    // Three of my smalls already down, deliberately not in a line.
    const board = buildBoard([
      [0, 'small', ME],
      [1, 'small', ME],
      [3, 'small', ME],
    ]);
    const state = positionWith(board, { toMove: ME });
    expect(remainingPieces(board, ME)).toEqual({ small: 0, medium: 3, large: 3 });
    expect(moveError(state, { player: ME, space: 8, size: 'small' })).toBe('no-pieces-left');
    expect(isLegal(state, { player: ME, space: 8, size: 'medium' })).toBe(true);
    expect(legalMoves(state).some((m) => m.size === 'small')).toBe(false);
  });

  it('createMove validates loosely-typed input', () => {
    expect(createMove(2, 5, 'large')).toEqual({ player: 2, space: 5, size: 'large' });
    expect(() => createMove(4, 0, 'small')).toThrow(RangeError);
    expect(() => createMove(0, 9, 'small')).toThrow(RangeError);
    expect(() => createMove(0, 0, 'tiny')).toThrow(RangeError);
  });

  it('legalMoves(state, colour) ignores turn order; legalMoves(state) does not', () => {
    const state = createGame({ players: 4, firstPlayer: 0 });
    expect(legalMoves(state, 2)).toHaveLength(SLOT_COUNT);
    expect(legalMoves(state, 2).every((m) => isLegal(state, m))).toBe(false);
    expect(legalMoves(state).every((m) => m.player === 0)).toBe(true);
  });

  it('returns no moves at all once the game is over', () => {
    const state = positionWith(buildBoard([[0, 'small', ME], [1, 'small', ME]]), { toMove: ME });
    const won = applyMove(state, { player: ME, space: 2, size: 'small' });
    expect(legalMoves(won)).toEqual([]);
    expect(legalMoves(won, 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Piece exhaustion and the stuck test (§4.5)
// ---------------------------------------------------------------------------

describe('piece exhaustion', () => {
  it('starts every colour with 3 of each size', () => {
    const state = createGame({ players: 4 });
    for (const color of state.config.colorsInPlay) {
      expect(remainingPieces(state.board, color)).toEqual({ small: 3, medium: 3, large: 3 });
    }
  });

  it('is stuck exactly when every size it still holds has no empty slot', () => {
    const config = createGame({ players: 4 }).config;
    // Every large slot filled by other colours; I hold only larges.
    const pieces: PieceSpec[] = SPACES.map((space, i) => [
      space,
      'large',
      ((i % 3) + 1) as PlayerId,
    ]);
    // Spend my smalls and mediums elsewhere, off any line.
    pieces.push([0, 'small', ME], [1, 'small', ME], [3, 'small', ME]);
    pieces.push([0, 'medium', ME], [1, 'medium', ME], [3, 'medium', ME]);
    const board = buildBoard(pieces);

    expect(remainingPieces(board, ME)).toEqual({ small: 0, medium: 0, large: 3 });
    expect(colorHasLegalMove(config, board, ME)).toBe(false);
    // ...but a colour with a medium left is fine, because medium slots remain.
    expect(colorHasLegalMove(config, board, 2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Optional centre-medium handicap (§8.2)
// ---------------------------------------------------------------------------

describe('centre-medium handicap', () => {
  it('is off by default', () => {
    const state = createGame({ players: 2 });
    expect(state.config.bannedSlots).toEqual([]);
    expect(playableSlotCount(state.config)).toBe(27);
    expect(isSlotBanned(state.config, 4, 'medium')).toBe(false);
  });

  it('removes exactly the medium slot of the centre space when enabled', () => {
    const state = createGame({ players: 2, banCenterMedium: true, firstPlayer: 0 });
    expect(playableSlotCount(state.config)).toBe(26);
    expect(moveError(state, { player: 0, space: 4, size: 'medium' })).toBe('slot-banned');
    expect(isLegal(state, { player: 0, space: 4, size: 'small' })).toBe(true);
    expect(isLegal(state, { player: 0, space: 4, size: 'large' })).toBe(true);
    expect(isLegal(state, { player: 0, space: 3, size: 'medium' })).toBe(true);
    expect(legalMoves(state)).toHaveLength(26);
  });
});

// ---------------------------------------------------------------------------
// Board bookkeeping
// ---------------------------------------------------------------------------

describe('board helpers', () => {
  it('counts pieces and detects a full board', () => {
    const empty = createGame().board;
    expect(piecesOnBoard(empty)).toBe(0);
    expect(isBoardFull(empty)).toBe(false);

    const pieces: PieceSpec[] = [];
    for (const space of SPACES) {
      for (let i = 0; i < SIZES.length; i += 1) {
        pieces.push([space, SIZES[i], ((space + i) % 3) as PlayerId]);
      }
    }
    const full = buildBoard(pieces);
    expect(piecesOnBoard(full)).toBe(SLOT_COUNT);
    expect(isBoardFull(full)).toBe(true);
    const config = createGame({ players: 3 }).config;
    expect(nobodyCanMove(config, full)).toBe(true);
  });

  it('rejects placing into an occupied slot at the board level', () => {
    const board = buildBoard([[0, 'small', ME]]);
    expect(() => buildBoard([[0, 'small', ME], [0, 'small', FOE]])).toThrow();
    expect(board[0].small).toBe(ME);
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('applyMove leaves the previous state untouched', () => {
    const before = createGame({ players: 4, firstPlayer: 0 });
    const snapshot = JSON.stringify(before);
    const move: Move = { player: 0, space: 4, size: 'large' };
    const after = applyMove(before, move);

    expect(JSON.stringify(before)).toBe(snapshot);
    expect(before.board[4].large).toBeNull();
    expect(after.board[4].large).toBe(0);
    expect(after).not.toBe(before);
    expect(after.board).not.toBe(before.board);
    // Untouched cells are shared, not copied.
    expect(after.board[0]).toBe(before.board[0]);
  });

  it('freezes the board so stray mutation throws instead of corrupting a game', () => {
    const state = createGame();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.board)).toBe(true);
    expect(Object.isFrozen(state.board[0])).toBe(true);
    expect(() => {
      (state.board as unknown as { 0: unknown })[0] = null;
    }).toThrow();
  });
});
