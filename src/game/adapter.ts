/**
 * The referee adapter the networking layer binds to.
 *
 * `server/src/rules.ts` declares an interface (`OtrioRules`) and asks the
 * engine to export an object matching it as `rules`, so that the authoritative
 * referee and every client run *the same* code rather than two implementations
 * that can drift. This is that object. `src/net/rtcTransport.ts` uses the same
 * engine directly when a browser is acting as host.
 *
 * Everything here is a thin projection over `engine.ts` / `rules.ts` — it adds
 * no rules of its own. It exists because the wire vocabulary in
 * `src/net/protocol.ts` and the engine vocabulary in `types.ts` name the same
 * things differently:
 *
 * | wire (`protocol.ts`)   | engine (`types.ts`)                  |
 * |------------------------|--------------------------------------|
 * | `Seat` (number)        | `SeatId` — participant               |
 * | owner in `CellState`   | `PlayerId` — colour                   |
 * | `CellIndex` 0..8       | `SpaceIndex` 0..8                    |
 * | `Move {cell, size}`    | `Move {player, space, size}`         |
 * | `'ascending'`          | `'sequence'`                         |
 * | `'concentric'`         | `'nested'`                           |
 *
 * The protocol import is **type-only**, so this file has no runtime dependency
 * on the net layer and the engine stays standalone. (It matters: the server
 * loads `src/game/index.ts` through Node's type-stripping loader, where a
 * runtime import of `src/net` would drag the whole client layer in.)
 *
 * ## One deliberate rules divergence, flagged
 *
 * `GameSnapshot.reserves` is indexed by seat, one reserve per seat. The
 * official 2-player game is two seats sharing four colours (RULES.md §4.6), so
 * it has four reserves for two seats and does not fit that shape. Rather than
 * misreport it, `rules.createGame(2)` builds a **one colour per seat** game
 * (`twoPlayerMode: 'one-color'`), which is the common digital simplification
 * and the only 2-player arrangement the current wire format can represent
 * faithfully.
 *
 * So: networked 2-player games are *not* the printed 2-player rules. Local
 * 2-player play can still be fully official by calling
 * `createGame({ players: 2 })` directly — that is the engine default. Making
 * the networked game official too needs `GameSnapshot.reserves` to become
 * per-colour, which is the protocol owner's call.
 */

import { createGame as createEngineGame, tryApplyMove, withdrawSeat } from './engine.ts';
import { legalMoves, seatOf } from './rules.ts';
import { remainingPieces } from './board.ts';
import {
  SPACES,
  isSize,
  isSpaceIndex,
  type GameState,
  type PlayerId,
  type SeatId,
  type WinCondition,
  type WinningLine,
} from './types.ts';

import type {
  CellIndex,
  CellState,
  GameSnapshot,
  Move as WireMove,
  Reserve,
  Seat,
  WinningLine as WireWinningLine,
} from '../net/protocol';

/** What the server hands back and forth. Opaque to it; a `GameState` to us. */
export type RefereeGame = GameState;

/** Mirror of `ApplyResult` in `server/src/rules.ts`. */
export type RefereeApplyResult =
  | { readonly ok: true; readonly game: RefereeGame }
  | { readonly ok: false; readonly reason: string };

/** Wire spelling of a win condition. */
function wireKind(condition: WinCondition): WireWinningLine['kind'] {
  if (condition === 'same-size') return 'same-size';
  if (condition === 'sequence') return 'ascending';
  return 'concentric';
}

/** Project one engine winning triple onto the wire shape. */
function toWireLine(line: WinningLine, seat: Seat): WireWinningLine {
  return {
    kind: wireKind(line.condition),
    cells: line.pieces.map((p) => p.space as CellIndex),
    sizes: line.pieces.map((p) => p.size),
    seat,
  };
}

/** The colour a seat should play right now, or `null` if it is not its turn. */
function dueColorFor(game: GameState, seat: Seat): PlayerId | null {
  if (game.status !== 'playing') return null;
  if (game.currentSeat !== seat) return null;
  return game.playableColors[0] ?? null;
}

/** `remainingPieces` for a seat: the sum over the colours it controls. */
function reserveFor(game: GameState, seat: SeatId): Reserve {
  const total: Reserve = { small: 0, medium: 0, large: 0 };
  const found = game.config.seats.find((s) => s.id === seat);
  for (const color of found?.controls ?? []) {
    const left = remainingPieces(game.board, color);
    total.small += left.small;
    total.medium += left.medium;
    total.large += left.large;
  }
  return total;
}

/** Project the engine's board onto the wire's seat-owned cells. */
function toWireBoard(game: GameState): CellState[] {
  const ownerSeat = (color: PlayerId | null): Seat | null =>
    color === null ? null : seatOf(game.config, color);
  return SPACES.map((space) => {
    const cell = game.board[space];
    return {
      small: ownerSeat(cell.small),
      medium: ownerSeat(cell.medium),
      large: ownerSeat(cell.large),
    };
  });
}

/**
 * Project a game onto the wire snapshot.
 *
 * Note that cell ownership is reported by **seat**, not colour. In every
 * configuration the server creates these are the same thing; in a local
 * official 2-player game they are not, and the two colours of one seat would
 * collapse together here — another reason `createGame(2)` uses one colour per
 * seat.
 */
export function toSnapshot(game: GameState): GameSnapshot {
  const winner = game.result?.seat ?? null;
  const lastMove = game.lastMove;
  return {
    board: toWireBoard(game),
    reserves: game.config.seats.map((seat) => reserveFor(game, seat.id)),
    turn: game.currentSeat,
    phase: game.status === 'playing' ? 'playing' : 'finished',
    winner,
    isDraw: game.status === 'draw',
    winningLine:
      game.result && winner !== null ? toWireLine(game.result.lines[0], winner) : null,
    moveCount: game.moveNumber,
    lastMove:
      lastMove === null
        ? null
        : {
            seat: seatOf(game.config, lastMove.player),
            move: { cell: lastMove.space as CellIndex, size: lastMove.size },
          },
    forfeitedSeats: [...game.config.withdrawnSeats],
  };
}

/**
 * The referee surface. Bound by `server/src/rules.ts` at startup; see that
 * file's `OtrioRules` for the authoritative declaration of each method.
 *
 * `applyMove` rejects rather than throws, and never mutates its argument.
 */
export const rules = {
  /** Fresh game for `playerCount` seats, seat 0 to move. */
  createGame(playerCount: number): RefereeGame {
    if (playerCount !== 2 && playerCount !== 3 && playerCount !== 4) {
      throw new RangeError(`Otrio is for 2-4 players, not ${playerCount}`);
    }
    return createEngineGame({
      players: playerCount,
      // See the module doc: the wire's one-reserve-per-seat shape cannot carry
      // the official two-colours-per-seat 2-player game.
      twoPlayerMode: 'one-color',
      firstPlayer: 0,
    });
  },

  /** Seat whose turn it is. */
  currentSeat(game: RefereeGame): Seat {
    return game.currentSeat;
  },

  /** True once someone has won or nobody can move. */
  isFinished(game: RefereeGame): boolean {
    return game.status !== 'playing';
  },

  /** Validate and apply. Returns the next state; never mutates `game`. */
  applyMove(game: RefereeGame, seat: Seat, move: WireMove): RefereeApplyResult {
    if (game.status !== 'playing') return { ok: false, reason: 'game is already over' };
    if (!isSpaceIndex(move.cell)) return { ok: false, reason: `no such cell: ${move.cell}` };
    if (!isSize(move.size)) return { ok: false, reason: `no such size: ${String(move.size)}` };

    const color = dueColorFor(game, seat);
    if (color === null) return { ok: false, reason: 'not your turn' };

    const applied = tryApplyMove(game, { player: color, space: move.cell, size: move.size });
    if (!applied.ok) return { ok: false, reason: applied.reason };
    return { ok: true, game: applied.state };
  },

  /** Placements `seat` could legally make right now. Empty unless it is its turn. */
  legalMoves(game: RefereeGame, seat: Seat): WireMove[] {
    if (dueColorFor(game, seat) === null) return [];
    const seen = new Set<string>();
    const out: WireMove[] = [];
    for (const move of legalMoves(game)) {
      const key = `${move.space}:${move.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ cell: move.space as CellIndex, size: move.size });
    }
    return out;
  },

  /** Project to the wire format. */
  snapshot(game: RefereeGame): GameSnapshot {
    return toSnapshot(game);
  },

  /** Drop an abandoning seat from the rotation, leaving its pieces as blockers. */
  withdraw(game: RefereeGame, seat: Seat): RefereeGame {
    if (seat < 0 || seat > 3 || !Number.isInteger(seat)) return game;
    return withdrawSeat(game, seat as SeatId);
  },
};

/** Alias, because `server/src/rules.ts` probes `rules`, `referee` and `otrioRules`. */
export const referee = rules;
