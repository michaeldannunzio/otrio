/**
 * Colours, and the fact that a colour is not a seat.
 *
 * `PlayerColor` (0-3: purple, red, green, blue — the board's clockwise arms) is
 * what owns a piece. `Seat` is a person. They coincide in 3- and 4-player games
 * and diverge in the official 2-player game, where each person holds two
 * opposite colours and must alternate between them every turn
 * (docs/RULES.md §4.6).
 *
 * This module exists because the difference is invisible to the type checker.
 * `Seat` and `PlayerColor` are both numbers, so `reserves[seat]` compiles
 * perfectly and renders the wrong player's pieces in exactly one configuration:
 * a two-player game, which is the configuration most likely to be tested last.
 * Everything that touches a colour goes through here so the mistake has one
 * place to not happen.
 *
 * Three rules worth keeping in your head:
 *
 *  - `GameSnapshot.reserves` is **length 4, indexed by colour**, never by seat.
 *    Colours not in play read `{0,0,0}`. Iterate `colorsInPlay`.
 *  - `PlayerView.colors` is **empty during the lobby**, because how many
 *    colours a seat gets depends on the final player count. A lobby must not
 *    show game colours at all.
 *  - Colour `0` is purple and is falsy. Always `slot !== null`.
 */

import { TWO_PLAYER_COLOR_PAIRS } from '../game/types';
import { ALL_COLORS, MIN_PLAYERS, PLAYER_COLORS } from '../net/protocol';
import type {
  GameSnapshot,
  PlayerColor,
  PlayerView,
  Reserve,
  RoomState,
  Seat,
} from '../net/protocol';

export type { PlayerColor };
export { ALL_COLORS, PLAYER_COLORS };

const EMPTY_RESERVE: Reserve = Object.freeze({ small: 0, medium: 0, large: 0 });

/** Display name for a colour: "Purple", "Red", "Green", "Blue". */
export function colourLabel(colour: PlayerColor | null | undefined): string {
  if (colour === null || colour === undefined) return 'No colour';
  const name = PLAYER_COLORS[colour];
  return name ? name[0].toUpperCase() + name.slice(1) : 'No colour';
}

/**
 * The colour a seat starts on, knowable before the game begins.
 *
 * `buildShape` in engine.ts is deterministic and `referee.ts` never passes a
 * custom `colors` array, so seat N always starts on colour N -- including in
 * the two-player game, where the pairs are [0,2] and [1,3] and seat 0 still
 * leads with purple.
 *
 * This is the one colour fact a lobby may state outright. Everything else about
 * a seat's colours depends on the final player count.
 */
export function firstColourOfSeat(seat: Seat): PlayerColor | null {
  return isPlayerColour(seat) ? seat : null;
}

/**
 * The second colour a seat picks up **if the game starts with exactly two
 * players**, or `null` for a seat that would not exist in that game.
 *
 * Also deterministic: `TWO_PLAYER_COLOR_PAIRS` is fixed by the rulebook artwork
 * (purple+green against red+blue) and the engine never varies it. So a lobby
 * can name this colour rather than hedging with a count -- "+ green if only two
 * play" rather than "+1", which next to a seat number reads as a score anyway.
 */
export function secondColourIfTwoPlay(seat: Seat): PlayerColor | null {
  const pair = TWO_PLAYER_COLOR_PAIRS[seat] as readonly number[] | undefined;
  const second = pair?.[1];
  return isPlayerColour(second) ? second : null;
}

/**
 * How many players must start for this seat to hold its own colour.
 *
 * An empty lobby row is the awkward case: a 4-player room with two people in it
 * can still *start* with two, and then colours 2 and 3 are absorbed as the
 * seated players' second colours rather than belonging to seats 3 and 4. So an
 * empty row must not present its colour as waiting for an occupant -- it is
 * only that seat's colour if enough people play.
 */
export function playersNeededForSeat(seat: Seat): number {
  return seat + 1;
}

/** How many people are seated. */
export function seatedCount(room: RoomState | null): number {
  return room?.players.length ?? 0;
}

/**
 * True when this is the official two-player, four-colour game.
 *
 * Derived from the *authoritative* colour assignment rather than the head
 * count, so it is only ever true once the referee has actually dealt two
 * colours to a seat.
 */
export function isTwoPlayerVariant(room: RoomState | null): boolean {
  if (!room?.game) return seatedCount(room) === MIN_PLAYERS;
  return room.players.some((p) => p.colors.length > 1);
}

/** Colours actually in this game, ascending. Empty outside a running game. */
export function coloursInPlay(room: RoomState | null): PlayerColor[] {
  return room?.game?.colorsInPlay ?? [];
}

/**
 * The colours a seat plays.
 *
 * Empty in the lobby — that is the protocol's answer, not a gap, and callers
 * must render something that is not a game colour (a seat number, an avatar)
 * rather than guessing. Seat 1 is red in a three-player game and red+blue in a
 * two-player one, so a lobby that guesses will be wrong half the time.
 */
export function coloursOfSeat(room: RoomState | null, seat: Seat): PlayerColor[] {
  return room?.players.find((p) => p.seat === seat)?.colors ?? [];
}

/** True once the referee has dealt colours. Lobby UIs check this. */
export function coloursAssigned(room: RoomState | null): boolean {
  return (room?.players ?? []).some((p) => p.colors.length > 0);
}

/** The person who plays a colour. */
export function seatOfColour(room: RoomState | null, colour: PlayerColor): PlayerView | null {
  return room?.players.find((p) => p.colors.includes(colour)) ?? null;
}

/** Who to credit a ring on the board to. Falls back to the colour's own name. */
export function ownerNameOfColour(room: RoomState | null, colour: PlayerColor): string {
  return seatOfColour(room, colour)?.name ?? colourLabel(colour);
}

/**
 * How to describe the owner of a ring on the board, in words.
 *
 * Always names the **colour**, not just the person. In the official 2-player
 * game one person holds two colours, so "Ann" describes both of them
 * identically -- and since a win is always within a single colour and the two
 * never combine, a screen-reader user who cannot tell Ann's purple from Ann's
 * green cannot follow the game at all. They would hear "Ann, Ann, Ann" across a
 * line that is not a line.
 *
 * Colour first because that is the part that decides the game; the name is the
 * gloss. Reads as "purple, Ann" or just "purple" when nobody holds it.
 */
export function slotOwnerText(room: RoomState | null, colour: PlayerColor): string {
  const owner = seatOfColour(room, colour);
  const name = colourLabel(colour).toLowerCase();
  return owner ? `${name}, ${owner.name}` : name;
}

/**
 * The colours the seat to move may place this turn.
 *
 * Length 1 on every 3-/4-player turn and on every turn of the official
 * 2-player game, because strict alternation fixes which colour is due. Longer
 * only when alternation has been switched off.
 *
 * `readonly` and possibly **empty**, which is narrower than the wire type:
 * `GameSnapshot.turnColors` is a non-empty tuple, but this adds "no game, or
 * not playing" as a case and returns `[]` for it. Callers must handle the empty
 * case — `dueColour` below is the one that turns it into an explicit `null`.
 */
export function turnColours(room: RoomState | null): readonly PlayerColor[] {
  const game = room?.game;
  if (!game || game.phase !== 'playing') return [];
  return game.turnColors;
}

/**
 * The single colour due this turn, or `null` when the player genuinely has a
 * choice (alternation disabled) or there is no game.
 *
 * `null` means "ask", never "guess".
 */
export function dueColour(room: RoomState | null): PlayerColor | null {
  const colours = turnColours(room);
  return colours.length === 1 ? colours[0] : null;
}

/** True when this seat holds more than one colour and has to switch each turn. */
export function seatAlternates(room: RoomState | null, seat: Seat): boolean {
  return coloursOfSeat(room, seat).length > 1;
}

/** What this seat will be due next turn, when alternation makes that knowable. */
export function nextColourFor(room: RoomState | null, seat: Seat): PlayerColor | null {
  const held = coloursOfSeat(room, seat);
  const due = dueColour(room);
  if (held.length < 2 || due === null) return null;
  const i = held.indexOf(due);
  return i < 0 ? null : held[(i + 1) % held.length];
}

/**
 * Pieces a colour still holds.
 *
 * **Indexed by colour.** This is the one function that should ever touch
 * `reserves`, and it is why `reserveFor(room, seat)` no longer exists.
 */
export function reserveOfColour(room: RoomState | null, colour: PlayerColor): Reserve {
  return room?.game?.reserves[colour] ?? EMPTY_RESERVE;
}

/** Every tray a seat owns, paired with its colour. One entry, or two. */
export function reservesOfSeat(
  room: RoomState | null,
  seat: Seat,
): Array<{ colour: PlayerColor; reserve: Reserve }> {
  return coloursOfSeat(room, seat).map((colour) => ({
    colour,
    reserve: reserveOfColour(room, colour),
  }));
}

/** Total rings a seat still holds, across every colour they play. */
export function totalRemainingForSeat(room: RoomState | null, seat: Seat): number {
  return reservesOfSeat(room, seat).reduce(
    (sum, { reserve }) => sum + reserve.small + reserve.medium + reserve.large,
    0,
  );
}

/** The colour that won, when there was a win. */
export function winningColour(room: RoomState | null): PlayerColor | null {
  return room?.game?.winnerColor ?? null;
}

/**
 * Turns skipped on the way to the current one, phrased for a person.
 *
 * A real rule, not an error: a seat whose due colour has no legal placement is
 * passed over. Saying so out loud is the difference between "the game moved on
 * without me" and "oh, blue is out of larges".
 */
export function skippedNotes(room: RoomState | null): string[] {
  const skipped = room?.game?.skipped ?? [];
  return skipped.map((entry) => {
    const who = room?.players.find((p) => p.seat === entry.seat)?.name ?? 'A player';
    const colours = entry.colors.map((c) => colourLabel(c).toLowerCase()).join(' and ');
    return `${who} had no playable ${colours} piece and was skipped.`;
  });
}

/**
 * Why a player may be unable to place a ring they can plainly see a home for.
 *
 * Under strict alternation a two-colour player will regularly be holding a
 * winning placement they are not allowed to make this turn. Without this
 * sentence on screen that reads as a broken board, and they will tap the same
 * space repeatedly trying to make it work.
 */
export function alternationNote(room: RoomState | null, seat: Seat | null): string | null {
  if (seat === null || !seatAlternates(room, seat)) return null;
  const due = dueColour(room);
  if (due === null) return 'You play two colours. Choose which one to place.';
  return `You must switch colours every turn, so only ${colourLabel(due).toLowerCase()} can move now.`;
}

/** Narrow an unknown number to a `PlayerColor`. */
export function isPlayerColour(value: unknown): value is PlayerColor {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/** Convenience for the board: who owns a slot, as a colour. */
export function ownerOfSlot(
  game: GameSnapshot | null | undefined,
  cell: number,
  size: 'small' | 'medium' | 'large',
): PlayerColor | null {
  // `!== null` rather than a truthiness test: colour 0 is purple.
  const owner = game?.board[cell]?.[size];
  return owner === null || owner === undefined ? null : owner;
}
