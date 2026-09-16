/**
 * Otrio Extreme — the one official alternative version (RULES.md §8.1), plus
 * the official tip about rotating who starts (§8.3).
 *
 * > *"Grab a pad of paper and grant one point to the winner of each game. Want
 * > to make things extra hard? Deduct one point for the player who failed to
 * > block the winner! First player to get to five points wins!"*
 *
 * Entirely optional: a base game never touches this module. Pure and
 * serialisable like the rest of the engine.
 */

import type { NewGameOptions } from './engine.ts';
import { seatOf } from './rules.ts';
import type { GameState, SeatId, WinCondition } from './types.ts';

/** Points needed to win a match. The sheet says five. */
export const DEFAULT_MATCH_TARGET = 5;

export interface MatchConfig {
  /** How many participants — matches `NewGameOptions.players`. */
  readonly seatCount: number;
  /** Points to win. Defaults to {@link DEFAULT_MATCH_TARGET}. */
  readonly target: number;
  /**
   * The optional "extra hard" layer: deduct a point from whoever failed to
   * block the winner.
   *
   * ### Substitution, flagged
   *
   * The sheet's phrasing is judgement-based — *the player who failed to block*
   * — which no engine can adjudicate. RULES.md §8.1 resolves this to the
   * mechanical reading used by secondary sources: **the seat that took the
   * turn immediately before the winning move**. Where that is the winner
   * themselves (possible when every other seat was skipped), nobody is
   * penalised. Surface the substitution in the UI.
   */
  readonly blockPenalty: boolean;
  /** Options each game in the match is created with. */
  readonly baseOptions: NewGameOptions;
}

/** What one finished game contributed to the match. */
export interface GameSummary {
  /** Winning seat, or `null` for a draw. */
  readonly winner: SeatId | null;
  readonly condition: WinCondition | null;
  /** Seat that lost a point under {@link MatchConfig.blockPenalty}, if any. */
  readonly penalised: SeatId | null;
  readonly moves: number;
  /** Rotation index the game opened on, so the next game can advance it (§8.3). */
  readonly firstSlot: number;
  /** Length of that game's turn cycle, so the advance wraps correctly. */
  readonly rotationLength: number;
}

export interface MatchState {
  readonly config: MatchConfig;
  /** Running score, indexed by `SeatId`. May go negative under the penalty rule. */
  readonly scores: readonly number[];
  readonly games: readonly GameSummary[];
  readonly status: 'playing' | 'complete';
  /** Set exactly when `status === 'complete'`. */
  readonly winner: SeatId | null;
}

export interface NewMatchOptions {
  readonly target?: number;
  readonly blockPenalty?: boolean;
  readonly baseOptions?: NewGameOptions;
}

/** Start a match. `baseOptions.players` decides the seat count (default 2). */
export function createMatch(options: NewMatchOptions = {}): MatchState {
  const baseOptions = options.baseOptions ?? {};
  const seatCount = baseOptions.players ?? 2;
  const target = options.target ?? DEFAULT_MATCH_TARGET;
  if (!Number.isInteger(target) || target < 1) throw new RangeError(`Bad match target: ${target}`);

  const config: MatchConfig = {
    seatCount,
    target,
    blockPenalty: options.blockPenalty ?? false,
    baseOptions: Object.freeze({ ...baseOptions }),
  };
  const match: MatchState = {
    config: Object.freeze(config),
    scores: Object.freeze(new Array<number>(seatCount).fill(0)),
    games: Object.freeze([]),
    status: 'playing',
    winner: null,
  };
  return Object.freeze(match);
}

/**
 * The seat that moved immediately before the winning move, or `null` if that
 * was the winner themselves (or there was no earlier move).
 */
function seatBeforeWinner(finished: GameState): SeatId | null {
  const history = finished.history;
  if (history.length < 2 || finished.result === null) return null;
  const previous = history[history.length - 2];
  const seat = seatOf(finished.config, previous.player);
  return seat === finished.result.seat ? null : seat;
}

/**
 * Fold a finished game into the match.
 *
 * A draw scores nothing for anyone and the match continues — the sheet says a
 * tie means "you all win, play again", and it never says what a drawn game is
 * worth, so RULES.md §10.3 chooses 0 rather than let a draw end a match.
 * Flagged there as our decision, not a found rule.
 */
export function recordGame(match: MatchState, finished: GameState): MatchState {
  if (match.status !== 'playing') return match;
  if (finished.status === 'playing') {
    throw new Error('Cannot record a game that is still in progress');
  }

  const scores = [...match.scores];
  const winner = finished.result?.seat ?? null;
  let penalised: SeatId | null = null;

  if (winner !== null) {
    scores[winner] = (scores[winner] ?? 0) + 1;
    if (match.config.blockPenalty) {
      penalised = seatBeforeWinner(finished);
      if (penalised !== null) scores[penalised] = (scores[penalised] ?? 0) - 1;
    }
  }

  const summary: GameSummary = Object.freeze({
    winner,
    condition: finished.result?.condition ?? null,
    penalised,
    moves: finished.moveNumber,
    firstSlot: finished.config.firstSlot,
    rotationLength: finished.config.rotation.length,
  });

  // The winner is whoever first reaches the target; a game awards at most one
  // point, so at most one seat can cross it on any given game.
  const reached = scores.findIndex((score) => score >= match.config.target);
  const next: MatchState = {
    config: match.config,
    scores: Object.freeze(scores),
    games: Object.freeze([...match.games, summary]),
    status: reached >= 0 ? 'complete' : 'playing',
    winner: reached >= 0 ? (reached as SeatId) : null,
  };
  return Object.freeze(next);
}

/**
 * Options for the next game of a match, with the opening turn advanced one
 * step round the cycle — the sheet's *"Be sure to alternate which player goes
 * first!"* (§8.3).
 *
 * Before the first game this is just the base options. Afterwards it pins
 * `firstSlot` to one past the previous game's, so who starts truly rotates
 * instead of being re-rolled. Pass the result straight to `createGame`.
 */
export function nextGameOptions(match: MatchState): NewGameOptions {
  const base = match.config.baseOptions;
  const last = match.games[match.games.length - 1];
  if (!last) return Object.freeze({ ...base });

  const { firstPlayer: _ignored, ...rest } = base;
  // `firstPlayer` is dropped: it would override `firstSlot` and defeat the rotation.
  const next: NewGameOptions = {
    ...rest,
    firstSlot: (last.firstSlot + 1) % last.rotationLength,
  };
  return Object.freeze(next);
}
