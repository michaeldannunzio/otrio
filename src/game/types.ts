/**
 * Otrio — shared vocabulary.
 *
 * This module is the public API surface that every other part of the app
 * (3D scene, UI, networking, AI) imports. It is **pure data**: no classes, no
 * hidden state, nothing that fails `JSON.parse(JSON.stringify(x))`. Every type
 * here survives a round-trip over the wire unchanged.
 *
 * Rules authority: `docs/RULES.md`, which transcribes the Spin Master printed
 * instruction sheet. Section references below (§4.6, §6.2, …) point at it.
 *
 * ## The game in one paragraph
 *
 * A 3x3 playing grid. Each *colour* owns 9 pieces: 3 small pegs, 3 medium
 * rings, 3 large rings. Every space has three concentric slots (small / medium
 * / large); each slot holds at most one piece, of any colour. On your turn you
 * place exactly one piece into a free slot; placed pieces never move (§4.3).
 * You win — "Otrio!" — with three pieces of a **single** colour forming:
 *   1. three of the *same size* in a line (row, column or diagonal), or
 *   2. a line reading small-medium-large along it, either direction, or
 *   3. all three sizes nested in one space.
 * 49 distinct winning triples per colour: 24 + 16 + 9 (§5.6).
 *
 * ## Naming: `PlayerId` (colour) vs `SeatId` (participant)
 *
 * In a 3- or 4-player game these coincide and you can ignore the distinction:
 * seat *n* plays colour *n*.
 *
 * They diverge in the official 2-player game, where each participant controls
 * **two** colours on opposite sides of the board and must alternate between
 * them every turn (§4.6). There:
 *   - `PlayerId` is a **colour** — one set of 9 pieces. This is what sits on
 *     the board and what forms a winning triple. Colours are never combined
 *     for a win (§4.7).
 *   - `SeatId` is a **participant** — a human or bot taking turns.
 *
 * Render pieces by `PlayerId`. Show "whose turn" by `SeatId`. Award victory to
 * the `SeatId` that owns the winning `PlayerId`.
 *
 * ## Gotcha: `PlayerId` 0 is falsy
 *
 * An empty slot is `null`, and colour 0 (purple) is the number `0`. Always
 * write `cell.small !== null`, **never** `if (cell.small)`.
 */

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/**
 * A colour — one set of 9 pieces (3 small, 3 medium, 3 large).
 *
 * This is the identity that appears on the board and the identity that wins.
 * Numbered clockwise from the north arm of the physical board:
 * 0 purple (N), 1 red (E), 2 green (S), 3 blue (W) — see §2.4 / §4.8.
 */
export type PlayerId = 0 | 1 | 2 | 3;

/** A participant taking turns. Owns one colour (3-/4-player) or two (2-player). */
export type SeatId = 0 | 1 | 2 | 3;

/**
 * Colour names in `PlayerId` order, from the official instruction-sheet
 * artwork (§2.4). The scene layer owns the actual materials; this exists so
 * every agent labels colour 2 "green" rather than inventing its own mapping.
 */
export const PLAYER_COLOR_NAMES = ['purple', 'red', 'green', 'blue'] as const;
export type PlayerColorName = (typeof PLAYER_COLOR_NAMES)[number];

/**
 * The official 2-player colour pairs: opposite arms of the board (§3).
 * Seat 0 takes purple + green, seat 1 takes red + blue.
 */
export const TWO_PLAYER_COLOR_PAIRS = [
  [0, 2],
  [1, 3],
] as const satisfies readonly (readonly PlayerId[])[];

// ---------------------------------------------------------------------------
// Geometry & pieces
// ---------------------------------------------------------------------------

/**
 * Piece size. Ordered small < medium < large; see {@link SIZE_ORDER}.
 *
 * Physically the small is a solid peg and the other two are open rings
 * (§2.3) — a presentation detail, but the reason "ring" is avoided here.
 */
export type Size = 'small' | 'medium' | 'large';

/** All sizes, ascending. Iterate this rather than hand-writing the array. */
export const SIZES = ['small', 'medium', 'large'] as const satisfies readonly Size[];

/** Rank of each size, for the ordered-size win. */
export const SIZE_ORDER: Readonly<Record<Size, 0 | 1 | 2>> = Object.freeze({
  small: 0,
  medium: 1,
  large: 2,
});

/** Pieces of each size per colour. Always 3 (§2.1). */
export const PIECES_PER_SIZE = 3;

/** Total pieces per colour: 3 sizes x 3. */
export const PIECES_PER_PLAYER = PIECES_PER_SIZE * SIZES.length;

/**
 * A space of the 3x3 playing area, row-major:
 * ```
 *   0 1 2      (0,0) (0,1) (0,2)
 *   3 4 5   =  (1,0) (1,1) (1,2)
 *   6 7 8      (2,0) (2,1) (2,2)
 * ```
 * The physical board's 12 storage spaces are deliberately not modelled — they
 * have no gameplay function (§1.1). Show remaining pieces with
 * `remainingPieces()` instead.
 *
 * Use {@link SPACES} to iterate (it is typed, so `map` callbacks get a
 * `SpaceIndex` rather than a bare `number`), or {@link toSpaceIndex} to
 * validate a number from a click handler or the network.
 */
export type SpaceIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** All nine playing spaces in row-major order. */
export const SPACES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const satisfies readonly SpaceIndex[];

/** Number of spaces in the playing area. */
export const SPACE_COUNT = SPACES.length;

/** Total slots: 9 spaces x 3 sizes = 27 (§1.3). */
export const SLOT_COUNT = SPACE_COUNT * SIZES.length;

/** The centre space, `(1,1)`. Named because the optional handicap targets it (§8.2). */
export const CENTER_SPACE: SpaceIndex = 4;

/** A slot on the board, independent of what (if anything) occupies it. */
export interface SlotRef {
  readonly space: SpaceIndex;
  readonly size: Size;
}

/** A piece that is on the board (or about to be), fully identified. */
export interface PlacedPiece {
  readonly space: SpaceIndex;
  readonly size: Size;
  readonly player: PlayerId;
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/**
 * One space of the grid: three concentric slots. `null` means empty; otherwise
 * that colour's piece sits there. Different colours share a space freely —
 * only the *slot* is exclusive, and taking a slot in an opponent's space is the
 * core blocking move (§4.2).
 */
export interface Cell {
  readonly small: PlayerId | null;
  readonly medium: PlayerId | null;
  readonly large: PlayerId | null;
}

/** The nine spaces, row-major. Frozen at runtime; never mutate it. */
export type BoardState = readonly [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell];

/**
 * A straight line of three spaces (§5.2). Stored in increasing `SpaceIndex`
 * order, which is the canonical reading direction that
 * {@link WinningLine.sequenceDirection} is relative to.
 */
export type Line = readonly [SpaceIndex, SpaceIndex, SpaceIndex];

/** How a winning triple sits on the board — for the highlight animation. */
export type LineOrientation = 'row' | 'column' | 'diagonal' | 'anti-diagonal' | 'nested';

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/**
 * A single placement — the only action in Otrio (§4.1). There is no pass move:
 * placement is mandatory when possible (§4.4) and a participant who cannot
 * place is skipped automatically by the engine (§4.5, see
 * {@link GameState.skipped}).
 *
 * `player` is the *colour* being placed, which in a 2-player game is not the
 * same as the seat. Build these with `createMove()` from `rules.ts` if you
 * have plain `number`s from a click handler.
 */
export interface Move {
  readonly player: PlayerId;
  readonly space: SpaceIndex;
  readonly size: Size;
}

/** Why a move was rejected. Stable codes, safe to switch on or send over the wire. */
export type IllegalMoveReason =
  /** The game is already won or drawn. */
  | 'game-over'
  /** `move.player` is not a colour in this game. */
  | 'unknown-player'
  /** `move.space` is not 0..8. */
  | 'bad-space'
  /** `move.size` is not a `Size`. */
  | 'bad-size'
  /**
   * That colour may not be played this turn — either it belongs to another
   * seat, or (2-player, strict alternation, §4.6) it is the seat's other
   * colour and this turn is due the first one.
   */
  | 'not-your-turn'
  /** That space already holds a piece of that size, of some colour (§4.2). */
  | 'slot-occupied'
  /** That colour has placed all 3 pieces of that size (§4.2). */
  | 'no-pieces-left'
  /** The optional centre-medium handicap makes this slot permanently unplayable (§8.2). */
  | 'slot-banned';

/** Result of a guarded move application. See `tryApplyMove` in `engine.ts`. */
export type MoveResult =
  | { readonly ok: true; readonly state: GameState }
  | { readonly ok: false; readonly reason: IllegalMoveReason };

// ---------------------------------------------------------------------------
// Winning
// ---------------------------------------------------------------------------

/**
 * Which of the three official win conditions was met (§5.1).
 *
 * - `'same-size'` — three pieces of one size in a line (§5.3). 24 per colour.
 * - `'sequence'`  — a line reading small-medium-large (§5.4). The sheet calls
 *   this "ascending *or* descending order"; those are the same configuration
 *   read from opposite ends, so the engine reports one `'sequence'` and says
 *   which way it reads via {@link WinningLine.sequenceDirection}. 16 per colour.
 * - `'nested'`    — all three of your sizes concentric in one space (§5.5).
 *   9 per colour.
 */
export type WinCondition = 'same-size' | 'sequence' | 'nested';

/**
 * One completed winning triple. A single placement can complete more than one
 * at once (§6.1), so {@link WinResult.lines} is an array.
 */
export interface WinningLine {
  readonly condition: WinCondition;
  readonly player: PlayerId;
  /**
   * The three pieces that form the win, ordered for animation:
   * - `'same-size'`: increasing `SpaceIndex` along the line.
   * - `'sequence'`: small, then medium, then large.
   * - `'nested'`: small, then medium, then large, all in one space.
   */
  readonly pieces: readonly [PlacedPiece, PlacedPiece, PlacedPiece];
  /**
   * The spaces involved, in the same order as `pieces`. For `'nested'` this is
   * one space repeated, so `spaces.length` is always 3 and `spaces[i]` always
   * equals `pieces[i].space`.
   */
  readonly spaces: readonly [SpaceIndex, SpaceIndex, SpaceIndex];
  readonly orientation: LineOrientation;
  /**
   * For `'sequence'` only: whether sizes grow (`'ascending'`) or shrink
   * (`'descending'`) reading the line in increasing `SpaceIndex` order, i.e.
   * left-to-right and/or top-to-bottom. Both win; this is so the UI can say
   * which happened.
   */
  readonly sequenceDirection?: 'ascending' | 'descending';
}

/** The outcome of a won position. */
export interface WinResult {
  /** The winning colour. */
  readonly player: PlayerId;
  /** The participant who owns that colour, and therefore wins the game. */
  readonly seat: SeatId;
  /** Primary condition — always equal to `lines[0].condition`. */
  readonly condition: WinCondition;
  /**
   * Every winning triple `player` holds, in the fixed order of the win table:
   * per line 0..7, same-size (small, medium, large) then sequence (ascending,
   * descending); then the 9 nested spaces. Highlight all of them.
   */
  readonly lines: readonly WinningLine[];
  /**
   * Diagnostic. Any *other* colours that also hold a winning triple in this
   * position. **Always empty in a game played through this engine** — §6.1
   * proves a placement can only ever complete triples of the colour that moved,
   * and the game halts on the first Otrio, so two winners cannot coexist. It is
   * populated only for hand-built or corrupted positions, where surfacing the
   * anomaly beats silently picking one.
   */
  readonly contested: readonly PlayerId[];
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

/** `'playing'` until someone wins (§5.7) or nobody can move (§6.2). */
export type GameStatus = 'playing' | 'won' | 'draw';

/** A participant and the colour(s) they control. */
export interface Seat {
  readonly id: SeatId;
  /**
   * Colours this seat plays. Length 1 for 3-/4-player and for the simplified
   * 2-player mode; length 2 (opposite arms) for the official 2-player game.
   */
  readonly controls: readonly PlayerId[];
  /** Display name. Optional, presentation only. */
  readonly name?: string;
}

/**
 * One position in the turn cycle: a seat, and the colour(s) it may place on
 * that turn.
 *
 * This single structure expresses every player count and both 2-player modes:
 *
 * | Game                          | rotation                                |
 * |-------------------------------|-----------------------------------------|
 * | 4 players                     | `{0,[0]} {1,[1]} {2,[2]} {3,[3]}`       |
 * | 3 players                     | `{0,[0]} {1,[1]} {2,[2]}`               |
 * | 2 players, official (§4.6)    | `{0,[0]} {1,[1]} {0,[2]} {1,[3]}`       |
 * | 2 players, no alternation     | `{0,[0,2]} {1,[1,3]}`                   |
 * | 2 players, one colour each    | `{0,[0]} {1,[1]}`                       |
 *
 * The official row is what makes each seat "alternate between your two
 * colours" while seats still take turns clockwise: walking the four-colour
 * board rotation does both at once.
 */
export interface TurnSlot {
  readonly seat: SeatId;
  readonly colors: readonly PlayerId[];
}

/** Immutable setup. Fixed at `createGame` time and never changes. */
export interface GameConfig {
  /** Participants, in clockwise seating order. */
  readonly seats: readonly Seat[];
  /** The turn cycle. Turns advance through this list and wrap. */
  readonly rotation: readonly TurnSlot[];
  /** Every colour on the board, ascending. Used for win scanning and piece counts. */
  readonly colorsInPlay: readonly PlayerId[];
  /** Index into `rotation` for the opening turn. */
  readonly firstSlot: number;
  /** Seed that chose `firstSlot`. Recorded so a game is reproducible. */
  readonly seed: number;
  /**
   * Slots permanently unplayable by everyone. Empty by default; holds
   * `{space: 4, size: 'medium'}` when the official centre-medium handicap is
   * enabled (§8.2).
   */
  readonly bannedSlots: readonly SlotRef[];
  /**
   * Seats removed from the turn cycle mid-game because the player abandoned
   * the game. Empty in a normal game. Their pieces stay on the board as
   * blockers, exactly as they would if someone walked away from the table; the
   * rules have nothing to say about this (§6.5), so it is a product concern
   * that the engine merely records. See `withdrawSeat` in `engine.ts`.
   */
  readonly withdrawnSeats: readonly SeatId[];
  /**
   * Whether the official 2-player strict colour alternation (§4.6) is in
   * force. `true` for every non-2-player game (vacuously) and by default for
   * 2-player. Recorded because it roughly halves the 2-player branching
   * factor and materially changes the game — see RULES.md §10.1.
   */
  readonly strictAlternation: boolean;
}

/**
 * The complete game. Immutable and serialisable: `applyMove` returns a new
 * object and never touches the old one, which is what makes optimistic local
 * play, server reconciliation and rollback tractable.
 */
export interface GameState {
  readonly config: GameConfig;
  readonly board: BoardState;
  /** Index into `config.rotation` of the turn to be taken. */
  readonly turnIndex: number;
  /** The participant to move. Frozen at the last mover once the game ends. */
  readonly currentSeat: SeatId;
  /**
   * The colour due to move.
   *
   * Exact in every default configuration. In the opt-out 2-player mode without
   * strict alternation the seat may instead play its other colour, so check
   * {@link playableColors} if you support that mode.
   */
  readonly currentPlayer: PlayerId;
  /**
   * Colours the current seat may place this turn. Length 1 except in the
   * 2-player mode with alternation disabled.
   */
  readonly playableColors: readonly PlayerId[];
  readonly status: GameStatus;
  /** Set exactly when `status === 'won'`. */
  readonly result: WinResult | null;
  /** Pieces placed so far — also `history.length`. */
  readonly moveNumber: number;
  /** Every placement in order. Enough to replay the game from `config`. */
  readonly history: readonly Move[];
  /** The move that produced this state, or `null` for a fresh game. */
  readonly lastMove: Move | null;
  /**
   * Turns skipped on the way to this one, because the seat had no legal
   * placement with its due colour(s) (§4.5). In cycle order. The UI should
   * surface these ("blue has no playable piece — skipped").
   */
  readonly skipped: readonly TurnSlot[];
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

/** Type guard for a `SpaceIndex`. */
export function isSpaceIndex(value: unknown): value is SpaceIndex {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < SPACE_COUNT;
}

/** Type guard for a `Size`. */
export function isSize(value: unknown): value is Size {
  return value === 'small' || value === 'medium' || value === 'large';
}

/** Type guard for a `PlayerId`. */
export function isPlayerId(value: unknown): value is PlayerId {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3;
}

/** Narrow a `number` (array index, network payload) to a `SpaceIndex`, or throw. */
export function toSpaceIndex(value: number): SpaceIndex {
  if (!isSpaceIndex(value)) throw new RangeError(`Not a board space: ${value}`);
  return value;
}
