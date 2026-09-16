/**
 * Otrio rules engine — public entry point.
 *
 * Import from `src/game` (this file), not from the individual modules; the
 * internal file layout is not part of the contract.
 *
 * ```ts
 * import { createGame, applyMove, legalMoves, type GameState } from '../game';
 *
 * // Official 2-player game: four colours, two seats, strict alternation.
 * let state = createGame({ players: 2, seed: 20260915 });
 * state = applyMove(state, { player: state.currentPlayer, space: 4, size: 'medium' });
 * if (state.status === 'won') highlight(state.result!.lines);
 * ```
 *
 * Everything is pure, immutable, deterministic and JSON-serialisable. See
 * `types.ts` for the vocabulary and the `PlayerId` (colour) / `SeatId`
 * (participant) distinction, and `docs/RULES.md` for the rules themselves.
 */

export * from './types.ts';

export {
  LINES,
  LINE_ORIENTATIONS,
  boardFromJSON,
  colOf,
  emptyBoard,
  isBoardFull,
  isSlotEmpty,
  pieceAt,
  piecesOf,
  piecesOnBoard,
  place,
  remainingOfSize,
  remainingPieces,
  rowOf,
  spaceAt,
  totalRemaining,
} from './board.ts';

export { WIN_PATTERNS, WIN_PATTERN_COUNT, type WinPattern } from './patterns.ts';

export {
  checkBoardWin,
  checkWin,
  colorHasLegalMove,
  colorsOf,
  createMove,
  hasLegalMove,
  hasWon,
  isLegal,
  isSlotBanned,
  isSlotPlayable,
  legalMoves,
  makeWinResult,
  moveError,
  nobodyCanMove,
  playableSlotCount,
  seatOf,
  slotAt,
  slotHasLegalMove,
  winningLinesFor,
} from './rules.ts';

export {
  IllegalMoveError,
  applyMove,
  applyMoves,
  createConfig,
  createGame,
  initialState,
  isGameOver,
  replay,
  rollbackTo,
  tryApplyMove,
  undo,
  withdrawSeat,
  type NewGameOptions,
  type TwoPlayerMode,
} from './engine.ts';

export {
  DEFAULT_MATCH_TARGET,
  createMatch,
  nextGameOptions,
  recordGame,
  type GameSummary,
  type MatchConfig,
  type MatchState,
  type NewMatchOptions,
} from './match.ts';

export { makeRng, pick, randomInt, seedFromString } from './random.ts';

/**
 * The referee adapter `server/src/rules.ts` binds to at startup, so the server
 * and every client referee the same rules. See `adapter.ts` for the wire
 * vocabulary mapping and for the one deliberate 2-player divergence.
 */
export {
  referee,
  rules,
  toSnapshot,
  type RefereeApplyResult,
  type RefereeGame,
} from './adapter.ts';
