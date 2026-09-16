/**
 * The colour model, and the one place that knows the official 2-player game is
 * not a 2-colour game.
 *
 * ## The rule (docs/RULES.md §2.4, §4.6)
 *
 * A 2-player game uses **all four colours**: each player takes two that sit
 * opposite each other on the board (purple+green, blue+red), and **must
 * alternate between their two colours on successive turns**. Colours never
 * combine for a win, so each player is really running two independent
 * three-in-a-row campaigns and is only allowed to advance one of them per turn.
 *
 * With the board's clockwise order (purple N, red E, green S, blue W) the two
 * opposite pairs are colours `{0, 2}` and `{1, 3}`, which makes the rule
 * palette-independent: **seat `s` controls colours `s` and `s + 2`**.
 *
 * ## The gap
 *
 * `src/net/protocol.ts` cannot currently express any of this. `CellState` holds
 * a `Seat | null` per slot, `GameSnapshot.reserves` is one `Reserve` per seat
 * (max 9 pieces), and `turn` is a `Seat`. A 2-player seat holds 18 pieces in two
 * colours, and which colour a placed ring belongs to is information the wire
 * format has nowhere to put. `src/game/types.ts` models it correctly
 * (`PlayerId` is a colour, `Seat.controls` is a list of them); the protocol has
 * not caught up.
 *
 * So this module is written against an **optional extension** to `GameSnapshot`
 * (`ColourAwareGame` below). When the referee sends those fields, the UI shows
 * the due colour, per-colour reserves, and the alternation state. When it does
 * not, the UI says truthfully that the seat holds two colours and that they
 * alternate, and **does not invent a due colour** -- a guessed marker that is
 * right half the time is worse than an honest absence, because a player who
 * follows it and gets `ILLEGAL_MOVE` will conclude the rules engine is broken.
 */

import { MIN_PLAYERS } from '../net/protocol';
import type { GameSnapshot, PieceSize, Reserve, RoomState, Seat } from '../net/protocol';

/** A colour, 0-3, in the board's clockwise order. Distinct from `Seat`. */
export type ColourId = 0 | 1 | 2 | 3;

/**
 * Fields the referee may add to `GameSnapshot` to describe colours properly.
 * Every one is optional; the UI degrades cleanly without them.
 *
 * Implementors: this is the contract. Add these to `GameSnapshot` in
 * `protocol.ts` and populate them and the 2-player variant renders correctly
 * with no further change here.
 */
export interface ColourAwareGame {
  /** Colours each seat controls, indexed by seat. Length 2 for 2-player seats. */
  seatColors?: ColourId[][];
  /** The colour due to be played this turn. Undefined on a seat's first move. */
  turnColor?: ColourId | null;
  /** Remaining pieces per *colour*, indexed by colour. Nine per colour. */
  colorReserves?: Reserve[];
  /** Per-slot colour ownership, parallel to `board`. */
  colorBoard?: Array<Record<PieceSize, ColourId | null>>;
  /** Whether `twoPlayerStrictAlternation` is in force for this game. */
  strictAlternation?: boolean;
}

type Game = GameSnapshot & ColourAwareGame;

/** How many people are seated. Drives the whole colour model. */
export function seatedCount(room: RoomState | null): number {
  return room?.players.length ?? 0;
}

/** True when this room is the official two-player, four-colour variant. */
export function isTwoPlayerVariant(room: RoomState | null): boolean {
  return seatedCount(room) === MIN_PLAYERS;
}

/**
 * The colours a seat controls.
 *
 * Prefers the referee's own answer. Falls back to the rulebook's geometry:
 * two players take opposite arms, everyone else takes one.
 */
export function coloursOfSeat(room: RoomState | null, seat: Seat): ColourId[] {
  const game = room?.game as Game | null | undefined;
  const declared = game?.seatColors?.[seat];
  if (declared && declared.length > 0) return declared;
  if (isTwoPlayerVariant(room)) {
    return [seat as ColourId, ((seat + 2) % 4) as ColourId];
  }
  return [seat as ColourId];
}

/** True when this seat has to alternate between two colours. */
export function seatAlternates(room: RoomState | null, seat: Seat): boolean {
  const game = room?.game as Game | null | undefined;
  if (game?.strictAlternation === false) return false;
  return coloursOfSeat(room, seat).length > 1;
}

/**
 * The colour due this turn, or `null` when we genuinely do not know.
 *
 * `null` has two distinct causes and the UI must handle both:
 *   - the seat controls one colour, so there is nothing to disambiguate
 *     (callers should use `coloursOfSeat(...)[0]`);
 *   - the referee has not told us, and we refuse to guess.
 */
export function dueColour(room: RoomState | null): ColourId | null {
  const game = room?.game as Game | null | undefined;
  if (!game || game.phase !== 'playing') return null;
  if (game.turnColor !== undefined && game.turnColor !== null) return game.turnColor;
  const colours = coloursOfSeat(room, game.turn);
  return colours.length === 1 ? colours[0] : null;
}

/** The colour that will be due next turn for the same seat, when known. */
export function nextColourFor(room: RoomState | null, seat: Seat): ColourId | null {
  const due = dueColour(room);
  const colours = coloursOfSeat(room, seat);
  if (colours.length < 2 || due === null) return null;
  const i = colours.indexOf(due);
  return i < 0 ? null : colours[(i + 1) % colours.length];
}

/**
 * Remaining pieces for one colour.
 *
 * Uses `colorReserves` when the referee sends it. Without it, the only reserve
 * we have is per seat, which for a 2-player seat is the *combined* figure and
 * cannot be split -- so we return it once for the seat and let the caller label
 * it as such rather than showing the same nine pieces twice.
 */
export function reserveOfColour(room: RoomState | null, colour: ColourId): Reserve | null {
  const game = room?.game as Game | null | undefined;
  return game?.colorReserves?.[colour] ?? null;
}

/** True when we can show reserves broken down by colour rather than by seat. */
export function hasColourReserves(room: RoomState | null): boolean {
  const game = room?.game as Game | null | undefined;
  return Array.isArray(game?.colorReserves) && game.colorReserves.length > 0;
}

/**
 * Why a player may be unable to place a ring they can plainly see a home for.
 *
 * This sentence exists because of a specific failure mode: under strict
 * alternation a 2-player player will regularly be holding a winning placement
 * they are not allowed to make this turn. Without an explanation on screen that
 * reads as a bug, not a rule -- and they will tap the board repeatedly trying
 * to make it work.
 */
export function alternationNote(room: RoomState | null, seat: Seat | null): string | null {
  if (seat === null || !seatAlternates(room, seat)) return null;
  const due = dueColour(room);
  if (due === null) {
    return 'You play two colours and must switch between them every turn.';
  }
  return 'You must switch colours every turn, so only one of your two colours can move now.';
}
