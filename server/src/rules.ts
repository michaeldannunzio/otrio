/**
 * The referee's binding to the shared rules engine in `src/game/**`.
 *
 * WHY THIS IS A PLAIN TYPED IMPORT
 * --------------------------------
 * An earlier version of this file discovered the engine at runtime: it probed
 * export names and then calibrated by trying argument orders until one
 * successfully placed a piece. That was the wrong instinct. The engine is a
 * sibling module in the same repository, compiled by the same `tsc`, shipped in
 * the same bundle — there is no version skew to defend against. Runtime probing
 * bought nothing and cost the compiler's help: a shape mismatch surfaced as a
 * `RulesBindingError` when the container started, instead of as a type error
 * when someone built it.
 *
 * So: import the real functions, against the real signatures. If `src/game`
 * changes incompatibly, this file stops compiling, which is exactly what should
 * happen.
 *
 * SEATS AND COLOURS
 * -----------------
 * The one genuinely subtle thing here. The engine separates:
 *
 *   - `PlayerId` — a **colour**, one set of nine pieces. What sits on the board
 *     and what forms a winning triple.
 *   - `SeatId`   — a **participant**. What takes turns and what wins the game.
 *
 * They coincide for 3 and 4 players. They diverge in the **official 2-player
 * game**, where each participant controls two colours on opposite arms of the
 * board and alternates between them every turn (a printed rule, not a variant).
 * The engine expresses this entirely in `GameConfig.rotation` — for 2 players it
 * is `{0,[0]} {1,[1]} {0,[2]} {1,[3]}`, so walking the four colours clockwise
 * *is* the strict alternation, with no extra state to track.
 *
 * The wire protocol mirrors that model rather than inventing a parallel one:
 * `CellState` slots hold a colour, `GameSnapshot.reserves` is indexed by colour,
 * and `PlayerView.colors` maps a person to their colours. This module is the
 * translation layer, and it is the only place the two vocabularies meet.
 *
 * SYNTAX CONSTRAINT
 * -----------------
 * Node runs this directory through type *stripping*, so no `enum`, no
 * `namespace`, no parameter properties, and relative imports carry an explicit
 * `.ts` extension. `tsconfig.server.json` enforces this with
 * `erasableSyntaxOnly`.
 */

import {
  colorsOf,
  createGame as engineCreateGame,
  isGameOver as engineIsGameOver,
  legalMoves as engineLegalMoves,
  remainingPieces,
  seatOf,
  seedFromString,
  tryApplyMove,
  withdrawSeat,
} from '../../src/game/index.ts';
import type {
  GameState,
  PlayerId,
  SeatId,
  SpaceIndex,
  WinResult,
} from '../../src/game/index.ts';

import { ALL_COLORS, BOARD_CELLS } from '../../src/net/protocol.ts';
import type {
  GameSnapshot,
  Move,
  PlayerColor,
  Reserve,
  Seat,
  WinningLine,
} from '../../src/net/protocol.ts';

/** The engine's state object. The room holds one and never inspects it. */
export type EngineGame = GameState;

/** Outcome of submitting a move. Rejection is a value, never an exception. */
export type ApplyResult =
  | { ok: true; game: EngineGame }
  | { ok: false; reason: string };

/** Empty reserve, for a colour that is not in play. */
const NO_PIECES: Reserve = { small: 0, medium: 0, large: 0 };

/**
 * Start a game for `playerCount` participants.
 *
 * `twoPlayerMode: 'official'` is deliberate and load-bearing: it is the printed
 * two-player rule, four colours shared between two seats with strict
 * alternation. The engine also offers `'one-color'`, which is simpler and which
 * an earlier version of this server used because the wire format could not
 * express anything else. The wire format was fixed instead.
 */
export function createGame(playerCount: number, seed = 1): EngineGame {
  if (playerCount !== 2 && playerCount !== 3 && playerCount !== 4) {
    throw new RangeError(`Otrio is for 2-4 players, not ${playerCount}`);
  }
  return engineCreateGame({ players: playerCount, twoPlayerMode: 'official', seed });
}

/**
 * Turn a room code into a game seed.
 *
 * The rules have the opening turn chosen at random (§8.3), and the engine
 * obliges — but its default seed is a constant, so every room in the world
 * would open on the same colour. Seeding from the room code makes openings vary
 * between rooms while staying reproducible *from the room code*, which is what
 * turns "it went wrong in room QK7M2" into something anyone can replay.
 *
 * `offset` advances it between games of a match, so a rematch does not replay
 * the same opening.
 */
export function seedForRoom(code: string, offset = 0): number {
  return (seedFromString(code) + offset) >>> 0;
}

/** The participant to move. */
export function currentSeat(game: EngineGame): Seat {
  return game.currentSeat;
}

/**
 * The colours the seat to move may place this turn.
 *
 * Length 1 under every default configuration, including the official 2-player
 * game — strict alternation is what makes it exactly one rather than two.
 * Empty once the game is over.
 */
export function turnColors(game: EngineGame): PlayerColor[] {
  if (game.status !== 'playing') return [];
  return [...game.playableColors] as PlayerColor[];
}

/** Every colour a participant controls, whether or not it is their turn. */
export function colorsForSeat(game: EngineGame, seat: Seat): PlayerColor[] {
  try {
    return [...colorsOf(game.config, seat as SeatId)] as PlayerColor[];
  } catch {
    // Seat is not in this game (a spectator, or a stale index).
    return [];
  }
}

/** True once someone has won or nobody can move. */
export function isFinished(game: EngineGame): boolean {
  return engineIsGameOver(game);
}

/**
 * Validate and apply a move.
 *
 * `seat` comes from the authenticated connection — never from the message — and
 * is checked against the engine's own idea of whose turn it is before anything
 * else. The colour is then resolved from `playableColors`, so a client cannot
 * place a colour it does not control even by asking for one explicitly.
 *
 * Never mutates `game`; the engine is purely functional.
 */
export function applyMove(game: EngineGame, seat: Seat, move: Move): ApplyResult {
  if (game.status !== 'playing') return { ok: false, reason: 'the game is already over' };
  if (game.currentSeat !== seat) return { ok: false, reason: 'it is not your turn' };
  if (!Number.isInteger(move.cell) || move.cell < 0 || move.cell >= BOARD_CELLS) {
    return { ok: false, reason: `no such cell: ${String(move.cell)}` };
  }

  const playable = game.playableColors;
  let color: PlayerId;

  if (move.color !== undefined) {
    if (!playable.includes(move.color as PlayerId)) {
      // Either not this seat's colour at all, or the wrong half of an
      // alternating pair. Both are "not your turn" from the player's side.
      return { ok: false, reason: 'that colour is not due to play this turn' };
    }
    color = move.color as PlayerId;
  } else if (playable.length === 1) {
    color = playable[0];
  } else {
    // Only reachable with strict alternation disabled, which this server never
    // requests. Refuse rather than pick for the player.
    return { ok: false, reason: 'ambiguous colour: specify move.color' };
  }

  const result = tryApplyMove(game, {
    player: color,
    space: move.cell as SpaceIndex,
    size: move.size,
  });

  if (result.ok) return { ok: true, game: result.state };
  return { ok: false, reason: result.reason };
}

/**
 * Placements the seat could legally make right now, in the engine's own order.
 *
 * Used to auto-play for an absent seat, so it must be exactly what a present
 * player could have done — hence asking the engine rather than enumerating
 * empty slots here.
 */
export function legalMoves(game: EngineGame, seat: Seat): Move[] {
  if (game.status !== 'playing') return [];
  const colors = game.currentSeat === seat ? game.playableColors : colorsForSeat(game, seat);

  const moves: Move[] = [];
  for (const color of colors) {
    for (const m of engineLegalMoves(game, color as PlayerId)) {
      moves.push({ cell: m.space, size: m.size, color: m.player as PlayerColor });
    }
  }
  return moves;
}

/**
 * Remove a seat from the turn rotation after its player abandoned the game.
 *
 * Their pieces stay on the board as blockers. Throws if asked to remove the
 * last seat, which the room prevents by ending the game first.
 */
export function withdraw(game: EngineGame, seat: Seat): EngineGame {
  return withdrawSeat(game, seat as SeatId);
}

/** Map the engine's win description onto the wire shape. */
function toWinningLine(result: WinResult): WinningLine | null {
  const line = result.lines[0];
  if (!line) return null;

  // The engine names the conditions 'same-size' | 'sequence' | 'nested'; the
  // wire calls them 'same-size' | 'ascending' | 'concentric'.
  const kind: WinningLine['kind'] =
    line.condition === 'nested'
      ? 'concentric'
      : line.condition === 'sequence'
        ? 'ascending'
        : 'same-size';

  return {
    kind,
    cells: [...line.spaces],
    sizes: line.pieces.map((p) => p.size),
    color: result.player as PlayerColor,
    seat: result.seat,
  };
}

/**
 * Project engine state onto the wire snapshot.
 *
 * `reserves` is always four entries indexed by colour, including colours not in
 * play (which read `{0,0,0}`). Fixed length keeps `reserves[color]` a safe
 * index; consumers iterate `colorsInPlay` to decide what to draw. An earlier
 * version made this per-seat and a four-seat assumption leaked into two-player
 * games, so the shape is now the thing that prevents the bug rather than a
 * comment asking people not to write it.
 */
export function snapshot(game: EngineGame): GameSnapshot {
  const colorsInPlay = [...game.config.colorsInPlay] as PlayerColor[];
  const inPlay = new Set<number>(colorsInPlay);

  const reserves: Reserve[] = ALL_COLORS.map((color) => {
    if (!inPlay.has(color)) return { ...NO_PIECES };
    const left = remainingPieces(game.board, color as PlayerId);
    return { small: left.small, medium: left.medium, large: left.large };
  });

  const board = game.board.map((cell) => ({
    small: cell.small as PlayerColor | null,
    medium: cell.medium as PlayerColor | null,
    large: cell.large as PlayerColor | null,
  }));

  const lastMove = game.lastMove;

  return {
    board,
    reserves,
    colorsInPlay,
    turn: game.currentSeat,
    turnColors: turnColors(game),
    phase: game.status === 'playing' ? 'playing' : 'finished',
    winner: game.result ? game.result.seat : null,
    winnerColor: game.result ? (game.result.player as PlayerColor) : null,
    isDraw: game.status === 'draw',
    winningLine: game.result ? toWinningLine(game.result) : null,
    moveCount: game.moveNumber,
    lastMove: lastMove
      ? {
          seat: seatOf(game.config, lastMove.player),
          color: lastMove.player as PlayerColor,
          move: {
            cell: lastMove.space,
            size: lastMove.size,
            color: lastMove.player as PlayerColor,
          },
        }
      : null,
    forfeitedSeats: [...game.config.withdrawnSeats],
    skipped: game.skipped.map((slot) => ({
      seat: slot.seat,
      colors: [...slot.colors] as PlayerColor[],
    })),
  };
}

/**
 * Everything the room needs from the rules, as one object.
 *
 * Grouped so `rooms.ts` takes a single collaborator it can be handed a stub for
 * in a test, without the indirection implying that the binding is dynamic. It
 * is not: these are direct references, resolved at compile time.
 */
export const rules = {
  createGame,
  seedForRoom,
  currentSeat,
  turnColors,
  colorsForSeat,
  isFinished,
  applyMove,
  legalMoves,
  withdraw,
  snapshot,
};

export type OtrioRules = typeof rules;
