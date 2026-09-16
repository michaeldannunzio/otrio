/**
 * The rules: what you may play, and what wins.
 *
 * Pure functions over `GameState` / `BoardState`. No mutation, no randomness,
 * no clock. Turn advancement and draw detection live in `engine.ts`.
 */

import { isSlotEmpty, remainingOfSize } from './board.ts';
import { WIN_PATTERNS } from './patterns.ts';
import {
  SIZES,
  SPACES,
  isPlayerId,
  isSize,
  isSpaceIndex,
  type BoardState,
  type GameConfig,
  type GameState,
  type IllegalMoveReason,
  type Move,
  type PlacedPiece,
  type PlayerId,
  type SeatId,
  type Size,
  type SpaceIndex,
  type TurnSlot,
  type WinResult,
  type WinningLine,
} from './types.ts';

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/**
 * The seat that controls a colour.
 *
 * In 3-/4-player games this is the identity function. In the official
 * 2-player game colours 0 (purple) and 2 (green) belong to seat 0, and
 * colours 1 (red) and 3 (blue) to seat 1 (RULES.md §3).
 */
export function seatOf(config: GameConfig, player: PlayerId): SeatId {
  for (const seat of config.seats) {
    if (seat.controls.includes(player)) return seat.id;
  }
  throw new Error(`No seat controls colour ${player}`);
}

/** Every colour a seat controls. */
export function colorsOf(config: GameConfig, seat: SeatId): readonly PlayerId[] {
  const found = config.seats.find((s) => s.id === seat);
  if (!found) throw new Error(`No such seat: ${seat}`);
  return found.controls;
}

/** The turn slot at a rotation index (wraps). */
export function slotAt(config: GameConfig, turnIndex: number): TurnSlot {
  const n = config.rotation.length;
  return config.rotation[((turnIndex % n) + n) % n];
}

// ---------------------------------------------------------------------------
// Move construction
// ---------------------------------------------------------------------------

/**
 * Build a `Move` from loosely-typed inputs — a click handler's `number`, a
 * network payload's `string`. Throws on anything malformed, so a `Move` that
 * exists is always structurally valid. Whether it is *legal* is a separate
 * question for {@link isLegal}.
 */
export function createMove(player: number, space: number, size: string): Move {
  if (!isPlayerId(player)) throw new RangeError(`Not a colour: ${player}`);
  if (!isSpaceIndex(space)) throw new RangeError(`Not a board space: ${space}`);
  if (!isSize(size)) throw new RangeError(`Not a piece size: ${size}`);
  return Object.freeze({ player, space, size });
}

// ---------------------------------------------------------------------------
// Slot availability
// ---------------------------------------------------------------------------

/**
 * Whether the optional centre-medium handicap (RULES.md §8.2) has taken this
 * slot out of play. Normally `bannedSlots` is empty and this is `false`.
 */
export function isSlotBanned(config: GameConfig, space: SpaceIndex, size: Size): boolean {
  for (const banned of config.bannedSlots) {
    if (banned.space === space && banned.size === size) return true;
  }
  return false;
}

/** A slot is playable when it is empty and not banned by a handicap. */
export function isSlotPlayable(
  config: GameConfig,
  board: BoardState,
  space: SpaceIndex,
  size: Size,
): boolean {
  return isSlotEmpty(board, space, size) && !isSlotBanned(config, space, size);
}

/** Number of slots this configuration ever allows a piece into: 27 minus any banned. */
export function playableSlotCount(config: GameConfig): number {
  return SPACES.length * SIZES.length - config.bannedSlots.length;
}

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

/**
 * Why `move` cannot be played in `state`, or `null` if it can (RULES.md §4.2).
 *
 * Checked in a fixed order so every client reports the same reason: game over,
 * unknown colour, malformed space/size, wrong turn, banned slot, occupied
 * slot, exhausted reserve.
 */
export function moveError(state: GameState, move: Move): IllegalMoveReason | null {
  if (state.status !== 'playing') return 'game-over';
  if (!isPlayerId(move.player) || !state.config.colorsInPlay.includes(move.player)) {
    return 'unknown-player';
  }
  if (!isSpaceIndex(move.space)) return 'bad-space';
  if (!isSize(move.size)) return 'bad-size';
  if (!state.playableColors.includes(move.player)) return 'not-your-turn';
  if (isSlotBanned(state.config, move.space, move.size)) return 'slot-banned';
  if (!isSlotEmpty(state.board, move.space, move.size)) return 'slot-occupied';
  if (remainingOfSize(state.board, move.player, move.size) <= 0) return 'no-pieces-left';
  return null;
}

/** True when `move` may be played right now. */
export function isLegal(state: GameState, move: Move): boolean {
  return moveError(state, move) === null;
}

/**
 * The moves available.
 *
 * - `legalMoves(state)` — every move that is legal **this instant**, i.e. for
 *   every colour in `state.playableColors`. Each one satisfies
 *   {@link isLegal}. This is what a UI or an AI wants.
 * - `legalMoves(state, colour)` — every placement that *colour* could make,
 *   ignoring whose turn it is. This is what skip detection and look-ahead
 *   want.
 *
 * Deterministic order: colour (as given in `playableColors`), then space 0..8,
 * then small / medium / large. Empty once the game is over.
 */
export function legalMoves(state: GameState, player?: PlayerId): Move[] {
  if (state.status !== 'playing') return [];
  const colors = player === undefined ? state.playableColors : [player];

  const moves: Move[] = [];
  for (const color of colors) {
    if (!state.config.colorsInPlay.includes(color)) continue;
    const left = {
      small: remainingOfSize(state.board, color, 'small'),
      medium: remainingOfSize(state.board, color, 'medium'),
      large: remainingOfSize(state.board, color, 'large'),
    };
    for (const space of SPACES) {
      for (const size of SIZES) {
        if (left[size] > 0 && isSlotPlayable(state.config, state.board, space, size)) {
          moves.push(Object.freeze({ player: color, space, size }));
        }
      }
    }
  }
  return moves;
}

/**
 * Whether `player`'s colour has any placement available — the "if you can't
 * play a piece, you skip your turn" test (§4.5). Cheaper than
 * `legalMoves(...).length`.
 */
export function hasLegalMove(state: GameState, player: PlayerId): boolean {
  return colorHasLegalMove(state.config, state.board, player);
}

/** Board-level form of {@link hasLegalMove}; ignores game status. */
export function colorHasLegalMove(
  config: GameConfig,
  board: BoardState,
  player: PlayerId,
): boolean {
  for (const size of SIZES) {
    if (remainingOfSize(board, player, size) <= 0) continue;
    for (const space of SPACES) {
      if (isSlotPlayable(config, board, space, size)) return true;
    }
  }
  return false;
}

/** Whether the seat taking `slot` can place any of that slot's colours. */
export function slotHasLegalMove(config: GameConfig, board: BoardState, slot: TurnSlot): boolean {
  return slot.colors.some((color) => colorHasLegalMove(config, board, color));
}

/**
 * The general draw test (RULES.md §6.2): nobody, on any turn of the cycle, has
 * a legal placement. Checked against the whole rotation rather than just "is
 * the board full", because a 2- or 4-player game can deadlock with slots still
 * free once every remaining empty slot is a size nobody still holds.
 */
export function nobodyCanMove(config: GameConfig, board: BoardState): boolean {
  return !config.rotation.some((slot) => slotHasLegalMove(config, board, slot));
}

// ---------------------------------------------------------------------------
// Win detection
// ---------------------------------------------------------------------------

function piece(space: SpaceIndex, size: Size, player: PlayerId): PlacedPiece {
  return Object.freeze({ space, size, player });
}

/**
 * Every winning triple `player` currently holds on `board`, as a scan of the
 * 49-entry win table (RULES.md §5.6).
 *
 * The result order is the table's order: per line 0..7, same-size (small,
 * medium, large) then sequence (ascending, descending); then the nested spaces
 * 0..8. A player can hold several at once — a placement that completes both a
 * row and a diagonal, say — so the caller gets the whole list and can
 * highlight all of it (§6.1).
 *
 * A winning piece only has to own *its slot*; the same space may hold other
 * colours in the other two slots. That is the physical game, and it is why
 * blocking works.
 */
export function winningLinesFor(board: BoardState, player: PlayerId): WinningLine[] {
  const wins: WinningLine[] = [];
  for (const p of WIN_PATTERNS) {
    const [s0, s1, s2] = p.slots;
    if (
      board[s0.space][s0.size] !== player ||
      board[s1.space][s1.size] !== player ||
      board[s2.space][s2.size] !== player
    ) {
      continue;
    }
    const pieces: [PlacedPiece, PlacedPiece, PlacedPiece] = [
      piece(s0.space, s0.size, player),
      piece(s1.space, s1.size, player),
      piece(s2.space, s2.size, player),
    ];
    const line: WinningLine = {
      condition: p.condition,
      player,
      pieces: Object.freeze(pieces),
      spaces: p.spaces,
      orientation: p.orientation,
      ...(p.sequenceDirection === undefined ? {} : { sequenceDirection: p.sequenceDirection }),
    };
    wins.push(Object.freeze(line));
  }
  return wins;
}

/** True when `player` holds at least one winning triple. */
export function hasWon(board: BoardState, player: PlayerId): boolean {
  for (const p of WIN_PATTERNS) {
    const [s0, s1, s2] = p.slots;
    if (
      board[s0.space][s0.size] === player &&
      board[s1.space][s1.size] === player &&
      board[s2.space][s2.size] === player
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Board-level win check across a set of colours.
 *
 * ## There is no tie-break here, because there is nothing to break
 *
 * RULES.md §6.1 proves that two players cannot win at once. Every win
 * condition is monochromatic; a turn adds exactly one piece of one colour;
 * pieces are never moved or removed; and the game halts on the first Otrio.
 * So any triple that comes into existence belongs to the colour that just
 * moved, and no earlier win can be lying around unnoticed. `applyMove`
 * therefore only ever needs to check the mover's colour.
 *
 * This function still scans every colour, because it is also the entry point
 * for hand-built positions — test fixtures, a save file, a hostile client. It
 * takes the first winner in `players` order (no preference, no arbitration)
 * and reports any others in `contested` so the caller can see that the
 * position is impossible rather than have that fact hidden.
 */
export function checkBoardWin(
  board: BoardState,
  players: readonly PlayerId[],
): { player: PlayerId; lines: WinningLine[]; contested: PlayerId[] } | null {
  let winner: { player: PlayerId; lines: WinningLine[] } | null = null;
  const contested: PlayerId[] = [];

  for (const player of players) {
    const lines = winningLinesFor(board, player);
    if (lines.length === 0) continue;
    if (winner === null) winner = { player, lines };
    else contested.push(player);
  }

  if (winner === null) return null;
  return { player: winner.player, lines: winner.lines, contested };
}

/** Assemble a frozen `WinResult` from a colour's winning lines. */
export function makeWinResult(
  config: GameConfig,
  player: PlayerId,
  lines: readonly WinningLine[],
  contested: readonly PlayerId[] = [],
): WinResult {
  const result: WinResult = {
    player,
    seat: seatOf(config, player),
    condition: lines[0].condition,
    lines: Object.freeze([...lines]),
    contested: Object.freeze([...contested]),
  };
  return Object.freeze(result);
}

/**
 * Has anybody won this position?
 *
 * Reports which condition won and which pieces form it, so the animation layer
 * can highlight the exact slots. Returns `null` for a position with no win,
 * including a drawn one — `GameState.status` distinguishes those.
 */
export function checkWin(state: GameState): WinResult | null {
  const found = checkBoardWin(state.board, state.config.colorsInPlay);
  if (!found) return null;
  return makeWinResult(state.config, found.player, found.lines, found.contested);
}
