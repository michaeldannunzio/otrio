/**
 * Game lifecycle: create, apply, replay, roll back.
 *
 * Every function here is pure. `applyMove` returns a brand-new frozen
 * `GameState` and never touches the one it was given, so the network layer can
 * keep a history, re-apply a server-authoritative move list, or throw away an
 * optimistic local state without bookkeeping.
 *
 * Implements the state machine in RULES.md §7.
 */

import { emptyBoard, place } from './board.ts';
import { makeRng, randomInt } from './random.ts';
import {
  makeWinResult,
  moveError,
  seatOf,
  slotAt,
  slotHasLegalMove,
  winningLinesFor,
} from './rules.ts';
import {
  CENTER_SPACE,
  TWO_PLAYER_COLOR_PAIRS,
  type GameConfig,
  type GameState,
  type IllegalMoveReason,
  type Move,
  type MoveResult,
  type PlayerId,
  type Seat,
  type SeatId,
  type SlotRef,
  type TurnSlot,
} from './types.ts';

/** Thrown by {@link applyMove} when a move is rejected. Use `tryApplyMove` to avoid it. */
export class IllegalMoveError extends Error {
  readonly reason: IllegalMoveReason;
  readonly move: Move;

  constructor(reason: IllegalMoveReason, move: Move) {
    super(`Illegal move (${reason}): colour ${move.player} -> ${move.size} @ ${move.space}`);
    this.name = 'IllegalMoveError';
    this.reason = reason;
    this.move = move;
  }
}

/**
 * How a 2-player game divides the four colours.
 *
 * - `'official'` (default) — the printed rule (RULES.md §3, §4.6). Each
 *   participant takes two colours on opposite arms (seat 0: purple + green,
 *   seat 1: red + blue) and **must strictly alternate** between them on
 *   successive turns. All four colours are on the board, so 36 pieces compete
 *   for 27 slots.
 * - `'free-colors'` — same two-colour ownership, but alternation is dropped:
 *   each turn a seat plays whichever of its colours it likes. This is how the
 *   inventor's own site and several secondary sources describe the 2-player
 *   game; see RULES.md §10.1 for why the printed sheet wins by default. It
 *   roughly doubles the 2-player branching factor.
 * - `'one-color'` — the common digital simplification: one colour each, 9
 *   pieces each, 18 pieces for 27 slots. Not the printed rule; offered because
 *   it is what most players expect from a 2-player app.
 */
export type TwoPlayerMode = 'official' | 'free-colors' | 'one-color';

/** Options for {@link createGame}. All optional. */
export interface NewGameOptions {
  /**
   * Number of *participants*: 2, 3 or 4 (RULES.md §2.5). Defaults to 2.
   *
   * With 3, one colour sits the game out — colour 3 (blue) by default, which
   * is mechanically irrelevant since all four colours are symmetric (§3).
   * With 2, see {@link TwoPlayerMode}: the default puts four colours on the
   * board shared between two seats.
   */
  readonly players?: 2 | 3 | 4;
  /** Seed for opening-turn selection. Defaults to 1, so even an unseeded game replays. */
  readonly seed?: number;
  /**
   * Force the opening colour, bypassing the seed. Must be a colour in play. In
   * a 2-player `'official'` game this also fixes the alternation phase.
   */
  readonly firstPlayer?: PlayerId;
  /**
   * Force the opening turn by rotation index instead of by colour. Lower
   * precedence than `firstPlayer`, higher than `seed`. Used by `match.ts` to
   * rotate who starts between games (RULES.md §8.3).
   */
  readonly firstSlot?: number;
  /** Colour arrangement for a 2-player game. Ignored for 3 or 4. Defaults to `'official'`. */
  readonly twoPlayerMode?: TwoPlayerMode;
  /**
   * The official centre-medium handicap (§8.2): make the medium slot of the
   * centre space permanently off-limits to everyone, to blunt a first-player
   * advantage in a 2-player game. Off by default.
   */
  readonly banCenterMedium?: boolean;
  /** Display names, by seat index. Presentation only. */
  readonly names?: readonly string[];
  /** Colours in play, if you want something other than the default `0..players-1`. */
  readonly colors?: readonly PlayerId[];
}

/** Build one frozen seat, omitting `name` entirely when there isn't one. */
function makeSeat(id: SeatId, controls: readonly PlayerId[], name: string | undefined): Seat {
  const seat: { id: SeatId; controls: readonly PlayerId[]; name?: string } = {
    id,
    controls: Object.freeze([...controls]),
  };
  if (name !== undefined) seat.name = name;
  return Object.freeze(seat);
}

function makeSlot(seat: SeatId, colors: readonly PlayerId[]): TurnSlot {
  return Object.freeze({ seat, colors: Object.freeze([...colors]) });
}

interface Shape {
  seats: Seat[];
  rotation: TurnSlot[];
  colorsInPlay: PlayerId[];
  strictAlternation: boolean;
}

/**
 * Seats, turn cycle and colours for a player count.
 *
 * The 2-player `'official'` row is the interesting one. Walking the four
 * colours in board order — purple(seat 0), red(seat 1), green(seat 0),
 * blue(seat 1) — makes the seats alternate *and* makes each seat alternate its
 * own two colours, which is exactly §4.6 with no extra state to carry.
 *
 * ### Invented rule, flagged
 *
 * §4.6 says a player "freely chooses" which of their two colours to open with,
 * then alternates. A fixed rotation instead derives the second seat's opening
 * colour from the first seat's. That loses nothing: §3 establishes that all
 * four colours are symmetric with respect to every rule, so a seat's two
 * colours are interchangeable labels, and the two choices produce isomorphic
 * games. `firstPlayer` still lets a caller pick which colour opens.
 */
function buildShape(
  players: 2 | 3 | 4,
  mode: TwoPlayerMode,
  colors: readonly PlayerId[],
  names: readonly string[] | undefined,
): Shape {
  const named = (id: number): string | undefined => names?.[id];

  if (players === 2 && mode !== 'one-color') {
    const [pairA, pairB] = TWO_PLAYER_COLOR_PAIRS;
    const seats = [makeSeat(0, pairA, named(0)), makeSeat(1, pairB, named(1))];
    const colorsInPlay: PlayerId[] = [0, 1, 2, 3];
    if (mode === 'official') {
      return {
        seats,
        colorsInPlay,
        strictAlternation: true,
        // purple(s0) -> red(s1) -> green(s0) -> blue(s1) -> ...
        rotation: [makeSlot(0, [pairA[0]]), makeSlot(1, [pairB[0]]), makeSlot(0, [pairA[1]]), makeSlot(1, [pairB[1]])],
      };
    }
    return {
      seats,
      colorsInPlay,
      strictAlternation: false,
      rotation: [makeSlot(0, pairA), makeSlot(1, pairB)],
    };
  }

  const inPlay = colors.slice(0, players);
  return {
    seats: inPlay.map((color, i) => makeSeat(i as SeatId, [color], named(i))),
    rotation: inPlay.map((color, i) => makeSlot(i as SeatId, [color])),
    colorsInPlay: [...inPlay].sort((a, b) => a - b),
    // Vacuously true: with one colour per seat there is nothing to alternate.
    strictAlternation: true,
  };
}

/** Assemble a frozen `GameConfig` without starting a game. Exposed for {@link replay}. */
export function createConfig(options: NewGameOptions = {}): GameConfig {
  const players = options.players ?? 2;
  if (players !== 2 && players !== 3 && players !== 4) {
    throw new RangeError(`Otrio is for 2-4 players, not ${players}`);
  }
  const seed = options.seed ?? 1;
  if (!Number.isFinite(seed)) throw new RangeError(`Seed must be a finite number, got ${seed}`);

  const colors = options.colors ?? ([0, 1, 2, 3] as PlayerId[]);
  if (colors.length < players) {
    throw new RangeError(`Need at least ${players} colours, got ${colors.length}`);
  }
  if (new Set(colors).size !== colors.length) throw new RangeError('Duplicate colour');

  const shape = buildShape(players, options.twoPlayerMode ?? 'official', colors, options.names);

  const bannedSlots: SlotRef[] = options.banCenterMedium
    ? [Object.freeze({ space: CENTER_SPACE, size: 'medium' as const })]
    : [];

  let firstSlot: number;
  if (options.firstPlayer !== undefined) {
    firstSlot = shape.rotation.findIndex((s) => s.colors.includes(options.firstPlayer as PlayerId));
    if (firstSlot < 0) throw new RangeError(`firstPlayer ${options.firstPlayer} is not in this game`);
  } else if (options.firstSlot !== undefined) {
    if (
      !Number.isInteger(options.firstSlot) ||
      options.firstSlot < 0 ||
      options.firstSlot >= shape.rotation.length
    ) {
      throw new RangeError(`firstSlot ${options.firstSlot} is outside the turn cycle`);
    }
    firstSlot = options.firstSlot;
  } else {
    // The printed rule is "the youngest player goes first" (§4.8), which has no
    // digital equivalent; a seed does, and keeps every client in agreement.
    // The sheet's own Tip says to rotate who starts between games — see
    // `nextGameOptions` in `match.ts`.
    firstSlot = randomInt(makeRng(seed >>> 0), shape.rotation.length);
  }

  const config: GameConfig = {
    seats: Object.freeze(shape.seats),
    rotation: Object.freeze(shape.rotation),
    colorsInPlay: Object.freeze(shape.colorsInPlay),
    firstSlot,
    seed,
    bannedSlots: Object.freeze(bannedSlots),
    withdrawnSeats: Object.freeze([]),
    strictAlternation: shape.strictAlternation,
  };
  return Object.freeze(config);
}

/** The opening position for a config: empty playing area, `firstSlot` to move. */
export function initialState(config: GameConfig): GameState {
  const slot = slotAt(config, config.firstSlot);
  const state: GameState = {
    config,
    board: emptyBoard(),
    turnIndex: config.firstSlot,
    currentSeat: slot.seat,
    currentPlayer: slot.colors[0],
    playableColors: slot.colors,
    status: 'playing',
    result: null,
    moveNumber: 0,
    history: Object.freeze([]),
    lastMove: null,
    skipped: Object.freeze([]),
  };
  return Object.freeze(state);
}

/** A new game. */
export function createGame(options: NewGameOptions = {}): GameState {
  return initialState(createConfig(options));
}

/**
 * Apply a legal move and return the resulting state.
 *
 * Never mutates `state`. Throws {@link IllegalMoveError} if the move is not
 * legal — a server should treat that as a protocol violation. Use
 * {@link tryApplyMove} where you would rather branch than catch.
 *
 * After placing the piece it:
 *  1. checks the mover's colour for an Otrio and, if found, ends the game
 *     immediately (§5.7) — only the mover's colour can have changed (§6.1);
 *  2. otherwise advances round the turn cycle to the next slot that has a
 *     legal placement, recording every slot skipped on the way
 *     ("if you can't play a piece, you skip your turn", §4.5);
 *  3. and if *no* slot in the whole cycle can place, ends the game as a draw
 *     (§6.2).
 *
 * ### Skipping and 2-player alternation — an invented rule, flagged
 *
 * §10.2 of RULES.md records a genuine gap: in the official 2-player game, what
 * happens when the colour you are due has no legal move but your other colour
 * does? No source answers it. This engine takes reading (A): the turn is
 * skipped, and the alternation keeps advancing, so on your next turn you are
 * due your other colour — which falls out of skipping one entry in the fixed
 * rotation. That is the literal reading of "alternating between your two
 * colours" plus "if you can't play a piece, you skip your turn" applied in
 * order, and it keeps the cycle a pure function of the turn index. With
 * `twoPlayerMode: 'free-colors'` the question disappears, because a slot then
 * offers both colours at once.
 */
export function applyMove(state: GameState, move: Move): GameState {
  const reason = moveError(state, move);
  if (reason !== null) throw new IllegalMoveError(reason, move);

  const normalised: Move = Object.freeze({ player: move.player, space: move.space, size: move.size });
  const board = place(state.board, normalised.space, normalised.size, normalised.player);
  const history = Object.freeze([...state.history, normalised]);

  const base = {
    config: state.config,
    board,
    moveNumber: state.moveNumber + 1,
    history,
    lastMove: normalised,
  } as const;

  // 1. Did that win? Only the colour just placed can have completed anything
  //    new (§6.1), so this is a single-colour scan of the 49-entry table.
  const lines = winningLinesFor(board, normalised.player);
  if (lines.length > 0) {
    const won: GameState = {
      ...base,
      turnIndex: state.turnIndex,
      currentSeat: seatOf(state.config, normalised.player),
      currentPlayer: normalised.player,
      playableColors: state.playableColors,
      status: 'won',
      result: makeWinResult(state.config, normalised.player, lines),
      skipped: Object.freeze([]),
    };
    return Object.freeze(won);
  }

  // 2. Advance round the cycle, skipping slots with nothing to place. The loop
  //    runs a full lap, so the slot that just moved is itself the last
  //    candidate: in a game where only one seat still has pieces, it keeps
  //    playing rather than the game hanging.
  const cycle = state.config.rotation.length;
  const skipped: TurnSlot[] = [];
  let nextIndex: number | null = null;
  for (let step = 1; step <= cycle; step += 1) {
    const index = (state.turnIndex + step) % cycle;
    const slot = state.config.rotation[index];
    if (slotHasLegalMove(state.config, board, slot)) {
      nextIndex = index;
      break;
    }
    skipped.push(slot);
  }

  // 3. Nobody anywhere in the cycle can move: a tie (§6.2). The sheet's own
  //    words are "You all win!" — the UI may say so, but the machine-readable
  //    result is a draw with no winner.
  if (nextIndex === null) {
    const drawn: GameState = {
      ...base,
      turnIndex: state.turnIndex,
      currentSeat: state.currentSeat,
      currentPlayer: normalised.player,
      playableColors: state.playableColors,
      status: 'draw',
      result: null,
      skipped: Object.freeze(skipped),
    };
    return Object.freeze(drawn);
  }

  const next = state.config.rotation[nextIndex];
  const advanced: GameState = {
    ...base,
    turnIndex: nextIndex,
    currentSeat: next.seat,
    currentPlayer: next.colors[0],
    playableColors: next.colors,
    status: 'playing',
    result: null,
    skipped: Object.freeze(skipped),
  };
  return Object.freeze(advanced);
}

/** {@link applyMove} without exceptions — returns the reason on failure. */
export function tryApplyMove(state: GameState, move: Move): MoveResult {
  const reason = moveError(state, move);
  if (reason !== null) return { ok: false, reason };
  return { ok: true, state: applyMove(state, move) };
}

/** Apply several moves in order. Throws on the first illegal one. */
export function applyMoves(state: GameState, moves: readonly Move[]): GameState {
  return moves.reduce(applyMove, state);
}

/**
 * Rebuild a game from its config and move list — the point of keeping the
 * engine pure. Use it to catch a late joiner up, or to verify a client's
 * claimed state on the server.
 */
export function replay(config: GameConfig, moves: readonly Move[]): GameState {
  return applyMoves(initialState(config), moves);
}

/**
 * The position as it stood after `moveNumber` moves. `rollbackTo(state, 0)` is
 * the opening position. For undo, and for reconciling against a server that
 * rejected an optimistic move.
 *
 * Note this is a client-side affordance, not a rule: the printed rules have no
 * undo and a placement is final (§4.3).
 */
export function rollbackTo(state: GameState, moveNumber: number): GameState {
  if (!Number.isInteger(moveNumber) || moveNumber < 0 || moveNumber > state.history.length) {
    throw new RangeError(`Cannot roll back to move ${moveNumber} of ${state.history.length}`);
  }
  return replay(state.config, state.history.slice(0, moveNumber));
}

/** Undo the most recent move. Returns the same state when there is nothing to undo. */
export function undo(state: GameState): GameState {
  if (state.history.length === 0) return state;
  return rollbackTo(state, state.history.length - 1);
}

/** `true` once the game is decided, either way. */
export function isGameOver(state: GameState): boolean {
  return state.status !== 'playing';
}

/**
 * Remove a seat from the turn cycle, leaving its pieces on the board.
 *
 * For a player who abandons a networked game. **This is not a rule** — the
 * instruction sheet has nothing to say about someone walking away (RULES.md
 * §6.5) — it is a product affordance, and it is modelled the way the physical
 * situation would be: the pieces already placed stay where they are and keep
 * blocking, and the seat simply stops getting turns.
 *
 * The seat stays in `config.seats` (so `seatOf` still resolves its colours for
 * the UI and for `WinResult`) and is listed in `config.withdrawnSeats`. Only
 * `config.rotation` shrinks.
 *
 * If it was the withdrawing seat's turn, play moves on to the next seat that
 * can place; if that leaves nobody able to move, the game is drawn.
 *
 * Note that `state.history` is no longer replayable against the new config
 * once a seat has withdrawn — the withdrawn seat's own moves were legal under
 * the old rotation. Keep the pre-withdrawal state if you need to replay.
 */
export function withdrawSeat(state: GameState, seat: SeatId): GameState {
  const oldRotation = state.config.rotation;
  const rotation = oldRotation.filter((slot) => slot.seat !== seat);
  if (rotation.length === oldRotation.length) return state; // not in the cycle
  if (rotation.length === 0) throw new RangeError('Cannot withdraw the last seat');

  const config: GameConfig = Object.freeze({
    ...state.config,
    rotation: Object.freeze(rotation),
    withdrawnSeats: Object.freeze([...state.config.withdrawnSeats, seat]),
  });

  if (state.status !== 'playing') return Object.freeze({ ...state, config });

  // Resume at the earliest surviving slot at or after the current turn, so the
  // cycle carries on from where it was rather than jumping back to the top.
  let resume = 0;
  for (let step = 0; step < oldRotation.length; step += 1) {
    const slot = oldRotation[(state.turnIndex + step) % oldRotation.length];
    const index = rotation.indexOf(slot);
    if (index >= 0) {
      resume = index;
      break;
    }
  }

  const skipped: TurnSlot[] = [];
  let nextIndex: number | null = null;
  for (let step = 0; step < rotation.length; step += 1) {
    const index = (resume + step) % rotation.length;
    if (slotHasLegalMove(config, state.board, rotation[index])) {
      nextIndex = index;
      break;
    }
    skipped.push(rotation[index]);
  }

  if (nextIndex === null) {
    return Object.freeze({
      ...state,
      config,
      status: 'draw',
      result: null,
      skipped: Object.freeze(skipped),
    });
  }

  const next = rotation[nextIndex];
  return Object.freeze({
    ...state,
    config,
    turnIndex: nextIndex,
    currentSeat: next.seat,
    currentPlayer: next.colors[0],
    playableColors: next.colors,
    skipped: Object.freeze(skipped),
  });
}
