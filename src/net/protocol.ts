/**
 * Otrio wire protocol — shared vocabulary for every networking backend.
 * ============================================================================
 *
 * This module is the ONE place where the shapes that travel between machines
 * are defined. It is imported by:
 *
 *   - `src/net/wsTransport.ts`  (client, hosted backend)
 *   - `src/net/rtcTransport.ts` (client, peer-to-peer backend)
 *   - `server/src/**`           (Node, hosted backend's authoritative referee)
 *
 * RULES FOR THIS FILE
 * -------------------
 * 1. **Zero imports.** It must be loadable from a browser bundle, from Node's
 *    type-stripping loader, and from a Web Worker, with no resolution games.
 * 2. **Types and plain constants only.** No `enum`, no `namespace`, no
 *    `declare`, no runtime classes. Node runs `server/**` through
 *    `--experimental-strip-types`, which *erases* types but cannot *transform*
 *    syntax. An `enum` here would break the server at startup.
 * 3. **Everything must survive `JSON.stringify` → `JSON.parse` unchanged.** No
 *    `Date`, `Map`, `Set`, `undefined`-as-meaningful, `bigint`, or class
 *    instances on the wire. Timestamps are epoch milliseconds as `number`.
 * 4. **Additive changes only** within a protocol version. Adding an optional
 *    field is free; renaming or removing one is a `PROTOCOL_VERSION` bump.
 *
 * WHY A FULL SNAPSHOT INSTEAD OF DELTAS
 * -------------------------------------
 * An Otrio board is nine cells, each holding at most three rings. A complete
 * authoritative snapshot of a room serialises to well under a kilobyte. There
 * is therefore no reason to implement delta encoding, state reconciliation, or
 * rollback. Every state-changing message carries a *whole* `RoomState` with a
 * monotonically increasing `seq`. Clients apply the snapshot verbatim if its
 * `seq` is greater than the last one they applied, and discard it otherwise.
 *
 * That decision is what makes two independent backends viable: the peer-to-peer
 * implementation does not have to reimplement a netcode stack, only elect a
 * peer to produce the snapshots.
 */

/* ========================================================================== *
 * Versioning
 * ========================================================================== */

/**
 * Bumped whenever an existing field changes meaning, type, or name, or when a
 * message type is removed. Adding optional fields or new message types does
 * NOT require a bump.
 *
 * Both sides compare this on handshake. A mismatch is fatal and surfaces to the
 * UI as `PROTOCOL_MISMATCH` — the usual cause is a stale browser tab against a
 * freshly deployed server, and the fix is a reload.
 */
export const PROTOCOL_VERSION = 1;

/* ========================================================================== *
 * Identity
 * ========================================================================== */

/**
 * A stable, client-generated identifier for a human. Public: it appears in
 * `RoomState` and every other participant sees it.
 *
 * It is minted once by the client (see `newPlayerId`) and persisted in
 * `localStorage`. It is deliberately NOT server-assigned, because the
 * peer-to-peer backend has no server to assign anything, and both backends must
 * behave identically.
 */
export type PlayerId = string;

/**
 * The private half of a player's identity. Generated alongside the `PlayerId`,
 * persisted next to it, and sent ONLY in the handshake — never broadcast, never
 * present in `RoomState`.
 *
 * Reconnecting to a held seat requires presenting both halves. This stops a
 * spectator who can read another player's `PlayerId` out of the room state from
 * claiming their seat. It is a bearer credential, not an account: anyone who
 * copies a browser's `localStorage` becomes that player. For a party game with
 * no stakes that is the right trade. The upgrade path, if it ever matters, is
 * for the server to mint a signed token in `Welcome` and for clients to treat
 * `sessionSecret` as opaque — the wire shape would not change.
 */
export type SessionSecret = string;

/**
 * The human-readable room identifier a player types in to join.
 *
 * **Treat it as opaque.** Normalise to upper case before display or comparison,
 * but do not assume a length or an alphabet — the hosted backend mints short
 * codes from a server-side registry, while a peer-to-peer backend may need to
 * pack signalling information into the code, making it longer. Any UI that
 * hard-codes "six characters" will break one of the two backends.
 */
export type RoomCode = string;

/**
 * Where a participant sits, `0`-based, assigned in join order and stable for
 * the lifetime of the room.
 *
 * A seat is a *person*. It is not what owns a piece — see `PlayerColor`.
 *
 * **Narrow on purpose, and narrow to the same shape as `PlayerColor`.** This
 * used to be `number` while `PlayerColor` was `0|1|2|3`, and that asymmetry was
 * not harmless: it meant a seat could be passed anywhere a colour was wanted
 * with nothing to stop it. A piece prop documented as "a seat index" quietly
 * carried a colour instead, and the compiler had no way to tell the two apart,
 * so the pieces painted in the wrong player's colour and nothing threw.
 *
 * Making both literal unions costs no branding machinery and makes them
 * non-interchangeable in the one direction that matters. It does mean an index
 * has to be narrowed before it can become a seat — use `toSeat`, and do not
 * reach for `as Seat`, which is the cast-instead-of-check that this change
 * exists to remove.
 */
export type Seat = 0 | 1 | 2 | 3;

/** Every seat, in order. Iterate this rather than counting to `MAX_PLAYERS`. */
export const ALL_SEATS: readonly Seat[] = [0, 1, 2, 3];

/** True if `v` is a valid seat index. */
export function isSeat(v: unknown): v is Seat {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

/**
 * Narrow an arbitrary index to a `Seat`, or `null` when it is out of range.
 *
 * Returning `null` rather than asserting is the point: an index that is not a
 * seat is a bug somewhere upstream, and a cast would carry it silently into the
 * rendering layer as a wrong-coloured piece. Callers that know the index is in
 * range should still go through here and say *why* it is in range at the call
 * site, which is cheaper to check later than a bare `as`.
 */
export function toSeat(n: number): Seat | null {
  return isSeat(n) ? n : null;
}

/**
 * A colour: one set of nine pieces (three of each size).
 *
 * **This, not `Seat`, is what sits on the board and what wins.** The engine
 * (`src/game/types.ts`) calls it `PlayerId`; the name is different here only
 * because `PlayerId` already means a person on the wire.
 *
 * WHY THE WIRE DISTINGUISHES COLOUR FROM SEAT
 * -------------------------------------------
 * In a 3- or 4-player game the two coincide and you can ignore the difference:
 * seat *n* plays colour *n*. They diverge in the **official 2-player game**,
 * where each participant controls two colours on opposite arms of the board and
 * must alternate between them every turn. That is a printed rule, not a
 * variant, so the protocol has to be able to say it.
 *
 * Practical consequences, all of which the UI must respect:
 *   - `CellState` slots hold a colour.
 *   - `GameSnapshot.reserves` is indexed by colour, not by seat.
 *   - A winning line is always within a *single* colour; two colours held by
 *     the same person never combine.
 *   - `PlayerView.colors` maps a person to the colours they play.
 */
export type PlayerColor = 0 | 1 | 2 | 3;

/**
 * Colour names in `PlayerColor` order, matching the engine's
 * `PLAYER_COLOR_NAMES` and the physical board's clockwise arms (purple north,
 * red east, green south, blue west).
 *
 * Kept identical to the engine's array on purpose: two different colour orders
 * in one codebase is a bug that renders as "my piece is the wrong colour".
 */
export const PLAYER_COLORS = ['purple', 'red', 'green', 'blue'] as const;
export type PlayerColorName = (typeof PLAYER_COLORS)[number];

/** All four colours, for iteration. Use `GameSnapshot.colorsInPlay` in a game. */
export const ALL_COLORS: readonly PlayerColor[] = [0, 1, 2, 3];

/** Hard ceiling from the physical game: four colours of nine pieces. */
export const MAX_PLAYERS = 4;
/** A game cannot start below this. */
export const MIN_PLAYERS = 2;

/* ========================================================================== *
 * Game vocabulary
 * ========================================================================== */

/** The three concentric ring sizes, small to large. */
export const PIECE_SIZES = ['small', 'medium', 'large'] as const;
export type PieceSize = (typeof PIECE_SIZES)[number];

/**
 * Board position, `0`–`8`, in reading order:
 *
 * ```
 *   0 1 2
 *   3 4 5
 *   6 7 8
 * ```
 *
 * `row = Math.floor(cell / 3)`, `col = cell % 3`.
 */
export type CellIndex = number;

/** Total cells on an Otrio board. */
export const BOARD_CELLS = 9;
/** Pieces of each size, per player. */
export const PIECES_PER_SIZE = 3;

/**
 * A single placement: put one ring of `size` into `cell`.
 *
 * This is the *entire* action vocabulary of Otrio. There is no pass, no
 * capture, no move of an already-placed piece. Keeping the move type this small
 * is why move validation can be fully authoritative with no client hints.
 */
export interface Move {
  cell: CellIndex;
  size: PieceSize;
  /**
   * Which colour to place.
   *
   * Optional, and normally omitted: whenever the seat to move has exactly one
   * playable colour — every 3- and 4-player turn, and every turn of the
   * official 2-player game, where strict alternation forces the colour — the
   * referee derives it from `GameSnapshot.turnColors`.
   *
   * Send it when you want to be explicit. The referee rejects a move whose
   * `color` is not in `turnColors`, and rejects an omitted `color` when more
   * than one colour is playable. It never trusts this field to decide *whose*
   * turn it is; that comes from the authenticated connection's seat.
   */
  color?: PlayerColor;
}

/**
 * What occupies one cell. Each ring slot holds the `Seat` of its owner, or
 * `null` if that ring is still unplaced. A cell can hold one ring of each size
 * simultaneously — that is the concentric "bullseye" the third win condition
 * looks for.
 */
export interface CellState {
  small: PlayerColor | null;
  medium: PlayerColor | null;
  large: PlayerColor | null;
}

/**
 * How many of each size one *colour* still holds. Counts start at `3`.
 *
 * Note `0` is a valid `PlayerColor` (purple) and an empty slot is `null`, so
 * always test `cell.small !== null`, never `if (cell.small)`.
 */
export interface Reserve {
  small: number;
  medium: number;
  large: number;
}

/**
 * Why a completed game is over — enough information for the UI to draw the
 * winning arrangement without re-deriving it, and for a replay to be checked.
 *
 * - `same-size`   — three equal rings along a line.
 * - `ascending`   — small → medium → large along a line (either direction; the
 *                   `cells` array is ordered to match `sizes`).
 * - `concentric`  — small, medium and large stacked in one cell. `cells` holds
 *                   that single index three times so consumers can treat all
 *                   three kinds uniformly.
 */
export interface WinningLine {
  kind: 'same-size' | 'ascending' | 'concentric';
  /** Exactly three entries, ordered to pair with `sizes`. */
  cells: CellIndex[];
  /** Exactly three entries, ordered to pair with `cells`. */
  sizes: PieceSize[];
  /**
   * The colour holding all three pieces.
   *
   * A win is always within one colour. In the official 2-player game a person
   * holds two colours, and they never combine — two purples and a green is not
   * an Otrio even when one player owns all three.
   */
  color: PlayerColor;
  /** The participant who owns `color`, and therefore wins the game. */
  seat: Seat;
}

/**
 * A complete, renderable picture of the game. Produced by whichever side is
 * acting as referee, consumed verbatim by every client.
 *
 * Note what is absent: no move history, no undo stack, no engine internals.
 * The referee's own state object may be richer; this is the projection that
 * crosses the wire, and the only thing a client is allowed to render from.
 */
export interface GameSnapshot {
  /** Exactly `BOARD_CELLS` entries, indexed by `CellIndex`. */
  board: CellState[];
  /**
   * Pieces remaining, **indexed by `PlayerColor`, not by seat**.
   *
   * Always exactly four entries, one per colour, even when fewer colours are in
   * play — a three-player game leaves blue at `{0,0,0}`. Fixed length keeps
   * `reserves[color]` a safe index; iterate `colorsInPlay` when rendering so
   * you do not draw a tray for a colour nobody has.
   *
   * Indexing this by seat is the mistake this shape exists to prevent: it is
   * only ever the same array in a 3- or 4-player game.
   */
  reserves: Reserve[];
  /** Colours actually in this game, ascending. Iterate this, not `0..n`. */
  colorsInPlay: PlayerColor[];
  /** Participant to move. Meaningless once `phase` is `finished`. */
  turn: Seat;
  /**
   * The colours the seat in `turn` may place this turn.
   *
   * One entry in every 3-/4-player game and on every turn of the official
   * 2-player game, where strict alternation fixes which of the seat's two
   * colours is due. Two only if alternation is ever switched off. The UI
   * renders the piece about to be placed from this, and a `Move` may omit
   * `color` exactly when this has one entry.
   *
   * **Never empty**, which is why the type is a union of non-empty tuples
   * rather than `PlayerColor[]`: `turnColors[0]` is always a real colour, and
   * the compiler will not let anyone forget the two-colour case — the
   * configuration where every bug in this project has lived. The guarantee
   * comes from the engine, where `playableColors` originates as a `TurnSlot`'s
   * `colors` (never empty) and is carried forward unchanged when the game ends.
   *
   * Once `phase` is `finished` it holds whatever the last mover was due and
   * means nothing; read `winnerColor` instead.
   *
   * On the wire this is still a JSON array — the tuple is a compile-time
   * constraint only, so nothing about the encoding changes.
   */
  turnColors: readonly [PlayerColor] | readonly [PlayerColor, PlayerColor];
  phase: 'playing' | 'finished';
  /** The participant who won, or `null` while playing or on a draw. */
  winner: Seat | null;
  /** The colour that won. Differs from `winner` only in the 2-player game. */
  winnerColor: PlayerColor | null;
  /** True when nobody can move and nobody has won. */
  isDraw: boolean;
  /** Present only when `winner` is non-null. */
  winningLine: WinningLine | null;
  /** Total placements applied. Useful as a cheap animation key. */
  moveCount: number;
  /** The placement that produced this snapshot, for move animation. */
  lastMove: { seat: Seat; color: PlayerColor; move: Move } | null;
  /**
   * Seats that have left permanently and been removed from the turn rotation.
   * Their pieces stay on the board as blockers. See `RoomState.endReason`.
   */
  forfeitedSeats: Seat[];
  /**
   * Turns skipped on the way to this one, because that seat had no legal
   * placement with the colour it was due to play — a real rule, not an error.
   * Lets the UI say "blue has no playable piece, skipped".
   */
  skipped: { seat: Seat; colors: PlayerColor[] }[];
}

/* ========================================================================== *
 * Room state — the authoritative snapshot the UI renders
 * ========================================================================== */

/** Connectivity of one participant, as seen by the referee. */
export type ConnectionState =
  /** Link is up and responsive. */
  | 'online'
  /** Link dropped; the seat is being held until the grace period expires. */
  | 'reconnecting'
  /** Grace expired or the player left deliberately. */
  | 'offline';

/**
 * One seated player as everyone else sees them. Contains no secrets — this
 * object is broadcast to every participant including spectators.
 */
export interface PlayerView {
  playerId: PlayerId;
  seat: Seat;
  /** Display name, already trimmed and length-capped by the referee. */
  name: string;
  /**
   * The colours this participant plays.
   *
   * **Empty while `RoomState.phase` is `'lobby'`.** How many colours a seat
   * gets depends on the final player count — one each with three or four
   * players, *two* each in the official 2-player game — and the lobby does not
   * know that yet. A lobby UI must therefore show something other than a game
   * colour (a seat number, an avatar), and must not cache what it sees: seat 1
   * may be red in a three-player game and red+blue in a two-player one.
   *
   * Once play begins: one entry normally, **two** in the official 2-player
   * game, where a seat holds opposite arms of the board and alternates between
   * them every turn.
   *
   * Render a player's pieces from this, never from `seat` — seat 1 is not
   * necessarily colour 1.
   */
  colors: PlayerColor[];
  connection: ConnectionState;
  /** Lobby readiness. Forced to `true` once the game starts. */
  ready: boolean;
  /**
   * Whether this player holds the host role: they may start the game and adjust
   * room settings.
   *
   * On the hosted backend this is purely a *permission*; the actual referee is
   * the server. On a peer-to-peer backend the host player is additionally the
   * peer running the rules engine. The UI must not care about the difference.
   */
  isHost: boolean;
  /** Removed from the turn rotation after abandoning the game. */
  forfeited: boolean;
  /**
   * Last measured round-trip time in milliseconds, or `null` if unknown.
   * Populated for *every* player, not just the local one, so the UI can show a
   * per-opponent connection indicator.
   */
  rttMs: number | null;
  joinedAt: number;
}

/** A non-playing observer. Spectators may never send a `Move`. */
export interface SpectatorView {
  playerId: PlayerId;
  name: string;
  joinedAt: number;
}

/** Why a room stopped accepting play. */
export type GameEndReason =
  /** Someone met a win condition. */
  | 'win'
  /** Board exhausted, nobody won. */
  | 'draw'
  /** Enough players left that play could not continue. */
  | 'opponents-left'
  /** The host deliberately ended it. */
  | 'host-ended'
  /** The referee vanished and could not be replaced (peer-to-peer only). */
  | 'referee-lost';

/** Why play is temporarily suspended. */
export interface PauseState {
  reason: 'player-disconnected' | 'host-migrating';
  /** Players being waited on. */
  waitingFor: PlayerId[];
  /**
   * Epoch ms at which the referee will give up waiting and resolve the pause
   * (by forfeiting the missing player or ending the game). `null` means the
   * pause has no deadline. Clients render a countdown from this; they must not
   * run their own timer authoritatively.
   */
  resumesAt: number | null;
}

/** An in-flight rematch offer. */
export interface RematchState {
  requestedBy: PlayerId;
  /** Players who have agreed so far. Includes `requestedBy`. */
  accepted: PlayerId[];
  /** Epoch ms after which the offer lapses. */
  expiresAt: number;
}

/**
 * The complete authoritative state of a room.
 *
 * Every client holds exactly one of these and renders from it directly. It is
 * replaced wholesale, never mutated in place, and never merged field-by-field.
 */
export interface RoomState {
  code: RoomCode;
  /**
   * Monotonically increasing revision. **The single most important field in the
   * protocol.**
   *
   * A client MUST ignore any snapshot whose `seq` is less than or equal to the
   * one it has already applied. This is what makes the pipeline
   * reorder-tolerant and duplicate-tolerant, and it is what lets a replacement
   * peer-to-peer referee take over mid-game without clients rewinding: the new
   * referee resumes numbering from the highest `seq` it has observed plus one.
   *
   * It never resets for the lifetime of a room, not even across a rematch.
   */
  seq: number;
  phase: 'lobby' | 'playing' | 'paused' | 'finished';
  /** Player holding the host role. See `PlayerView.isHost`. */
  hostPlayerId: PlayerId;
  /** Seated players, ordered by `seat`. */
  players: PlayerView[];
  spectators: SpectatorView[];
  maxPlayers: number;
  allowSpectators: boolean;
  /** `null` until the game starts. */
  game: GameSnapshot | null;
  /**
   * Epoch ms by which the player to move must act, or `null` for untimed play.
   * Enforced by the referee; clients render it but never act on expiry.
   */
  turnDeadline: number | null;
  pause: PauseState | null;
  rematch: RematchState | null;
  endReason: GameEndReason | null;
  /** Referee clock at the moment this snapshot was produced. */
  updatedAt: number;
}

/* ========================================================================== *
 * Errors
 * ========================================================================== */

/**
 * Closed set of machine-readable failure reasons. The UI switches on these;
 * `message` is a developer-facing string and must never be parsed or shown
 * verbatim to a player without mapping it first.
 */
export type ErrorCode =
  /* ---- link ---- */
  /** The device has no usable network connection. */
  | 'NETWORK_UNAVAILABLE'
  /** Could not establish the link at all (server down, DNS, blocked port). */
  | 'CONNECT_FAILED'
  /** The link was established and then dropped. Usually transient. */
  | 'CONNECTION_LOST'
  /** A request was sent but no reply arrived in time. */
  | 'TIMEOUT'
  /** Handshake rejected: client and referee speak different protocol versions. */
  | 'PROTOCOL_MISMATCH'
  /** Too many messages too quickly. */
  | 'RATE_LIMITED'

  /* ---- rooms ---- */
  /** No room with that code exists (or it expired). */
  | 'ROOM_NOT_FOUND'
  /** The code is not well-formed. Checked before any network round trip. */
  | 'CODE_INVALID'
  /** Every seat is taken and spectating is disabled or also full. */
  | 'ROOM_FULL'
  /** The room ended while this client was in it. */
  | 'ROOM_CLOSED'
  /** Cannot join as a player because play is already underway. */
  | 'ALREADY_STARTED'
  /** The seat this client tried to resume is occupied by someone else. */
  | 'SEAT_TAKEN'
  /** The reconnect grace period elapsed; the seat is gone. */
  | 'RECONNECT_EXPIRED'

  /* ---- actions ---- */
  /** The action requires being in a room and this client is not. */
  | 'NOT_IN_ROOM'
  /** The action is host-only. */
  | 'NOT_HOST'
  /** A spectator attempted a player-only action. */
  | 'SPECTATOR_FORBIDDEN'
  /** Move submitted out of turn. */
  | 'NOT_YOUR_TURN'
  /** Move rejected by the rules engine (occupied ring, exhausted reserve…). */
  | 'ILLEGAL_MOVE'
  /** Move submitted while the game was not running. */
  | 'GAME_NOT_ACTIVE'
  /** Not enough players, or not everyone is ready. */
  | 'NOT_ENOUGH_PLAYERS'

  /* ---- peer-to-peer specific (hosted backend never emits these) ---- */
  /** The signalling rendezvous could not be reached. */
  | 'SIGNALING_FAILED'
  /** A direct peer connection could not be negotiated (symmetric NAT, no TURN). */
  | 'PEER_UNREACHABLE'
  /** The referee peer vanished and no replacement could take over. */
  | 'REFEREE_LOST'

  /* ---- catch-alls ---- */
  /** The backend does not implement this capability. */
  | 'UNSUPPORTED'
  /** Referee-side bug. Always a defect; never expected in normal play. */
  | 'INTERNAL';

/** An error as it crosses the wire. */
export interface WireError {
  code: ErrorCode;
  /** Developer-facing detail. Safe to log, not safe to show raw. */
  message: string;
  /**
   * Whether retrying the identical request could plausibly succeed. Lets the UI
   * offer "try again" without a per-code lookup table.
   */
  retryable: boolean;
}

/* ========================================================================== *
 * Client → referee messages
 * ========================================================================== */

/**
 * Correlates a request with its `Ack`. Client-generated, unique per connection.
 * Messages without a `rid` are fire-and-forget.
 */
export type RequestId = string;

/** Options accepted when opening a new room. */
export interface CreateRoomOptions {
  /** `MIN_PLAYERS`–`MAX_PLAYERS`. Clamped by the referee. */
  maxPlayers?: number;
  allowSpectators?: boolean;
  /**
   * Per-turn time limit in ms, or `0`/omitted for untimed play. The referee
   * enforces it; on expiry the turn is resolved per `TURN_TIMEOUT_POLICY`.
   */
  turnTimeoutMs?: number;
}

/**
 * First message on every connection. Nothing else is accepted until the referee
 * has answered with `Welcome`.
 */
export interface HelloMsg {
  t: 'hello';
  protocolVersion: number;
  playerId: PlayerId;
  sessionSecret: SessionSecret;
  /** Requested display name. The referee sanitises and may adjust it. */
  name: string;
  /** Free-form build identifier, logged for debugging. */
  clientVersion?: string;
}

export interface CreateRoomMsg {
  t: 'createRoom';
  rid: RequestId;
  options?: CreateRoomOptions;
}

export interface JoinRoomMsg {
  t: 'joinRoom';
  rid: RequestId;
  code: RoomCode;
  /** Join the gallery instead of taking a seat. */
  asSpectator?: boolean;
}

export interface LeaveRoomMsg {
  t: 'leaveRoom';
  rid: RequestId;
}

export interface SetReadyMsg {
  t: 'setReady';
  rid: RequestId;
  ready: boolean;
}

export interface SetNameMsg {
  t: 'setName';
  rid: RequestId;
  name: string;
}

/** Host-only. Fails with `NOT_ENOUGH_PLAYERS` if the lobby is not viable. */
export interface StartGameMsg {
  t: 'startGame';
  rid: RequestId;
}

export interface MoveMsg {
  t: 'move';
  rid: RequestId;
  move: Move;
  /**
   * The `RoomState.seq` the client believed was current when the player acted.
   *
   * Purely advisory: the referee uses it to detect and log races (two players
   * acting on the same stale view) and may reject with `NOT_YOUR_TURN` early.
   * The referee validates the move against its OWN state regardless, so a
   * client that lies or omits this gains nothing.
   */
  expectedSeq?: number;
}

/** Offer a rematch, or accept a pending one. `accept: false` declines. */
export interface RematchMsg {
  t: 'rematch';
  rid: RequestId;
  accept: boolean;
}

/**
 * Ask for the current `RoomState` unconditionally. Sent after a reconnect, or
 * when a client notices a `seq` gap it cannot explain.
 */
export interface ResyncMsg {
  t: 'resync';
  rid: RequestId;
}

/** Latency probe. Fire-and-forget; answered with `PongMsg`. */
export interface PingMsg {
  t: 'ping';
  /** Echoed back verbatim. */
  id: string;
  /** Client clock when sent. Echoed back so the client can compute RTT. */
  t0: number;
  /**
   * The client's own most recent RTT measurement, reported so the referee can
   * publish it in `PlayerView.rttMs` for everyone else to see.
   */
  rttMs?: number;
}

export type ClientMessage =
  | HelloMsg
  | CreateRoomMsg
  | JoinRoomMsg
  | LeaveRoomMsg
  | SetReadyMsg
  | SetNameMsg
  | StartGameMsg
  | MoveMsg
  | RematchMsg
  | ResyncMsg
  | PingMsg;

/* ========================================================================== *
 * Referee → client messages
 * ========================================================================== */

/** What a backend can actually do. Surfaced to the UI via the transport. */
export interface Capabilities {
  /**
   * Which implementation is answering. **For diagnostics and telemetry only.**
   * Branching game logic on this value is a bug — that is exactly the leak this
   * protocol exists to prevent. Feature-detect with the booleans below.
   *
   * `'local'` is pass-and-play on one device: no link, no remote participant,
   * the referee running in the same tab as the UI. It is listed here and
   * nowhere else — `TransportKind` in `transport.ts` is declared as
   * `Capabilities['kind']`, so this union is the one definition of the set of
   * backends. Adding a fourth means editing this line and nothing else.
   *
   * Two things a UI will want and must NOT get from this field: whether there
   * is a room code worth showing (use `isLocalRoomCode(room.code)`) and whether
   * a trust badge applies (use `impartialReferee`).
   */
  kind: 'hosted' | 'p2p' | 'local';
  /** Spectators may join. */
  spectators: boolean;
  /** Dropped players get a grace period in which their seat is held. */
  reconnect: boolean;
  /** Reconnect grace window in ms. `0` when `reconnect` is false. */
  reconnectGraceMs: number;
  /**
   * The referee role can move to another participant if the current one
   * vanishes. Always `false` for the hosted backend (the server does not
   * vanish); typically `true` for peer-to-peer.
   */
  hostMigration: boolean;
  /**
   * Whether an impartial referee validates moves. `true` for hosted. A
   * peer-to-peer backend reports `false`, which the UI may use to show a
   * "friendly game" badge — and for nothing else.
   */
  impartialReferee: boolean;
  maxPlayers: number;
}

/** Answer to `HelloMsg`. Always the first message the referee sends. */
export interface WelcomeMsg {
  t: 'welcome';
  protocolVersion: number;
  /** Referee clock, for estimating offset alongside `PongMsg`. */
  serverTime: number;
  /** Echoed back so the client can confirm which identity was accepted. */
  playerId: PlayerId;
  /** Name after sanitisation. May differ from what was requested. */
  name: string;
  capabilities: Capabilities;
  /**
   * If this connection resumed a seat that was being held, the room's current
   * state — the client is already back in the game and must not call
   * `joinRoom`. `null` when there was nothing to resume.
   */
  resumed: RoomState | null;
}

/** Reply to any request carrying a `rid`. Exactly one per request. */
export interface AckMsg {
  t: 'ack';
  rid: RequestId;
  ok: boolean;
  /** Present when `ok` is true. Shape depends on the request. */
  result?: AckResult;
  /** Present when `ok` is false. */
  error?: WireError;
}

/** Payloads an `AckMsg` can carry on success. */
export type AckResult =
  | { kind: 'room'; code: RoomCode; state: RoomState }
  | { kind: 'ok' };

/**
 * A new authoritative snapshot. The workhorse message: sent after every change,
 * to every participant.
 */
export interface StateMsg {
  t: 'state';
  state: RoomState;
}

/**
 * Something notable happened. Purely for presentation — sounds, toasts, the
 * piece-drop animation.
 *
 * **Events never carry state the UI needs to stay correct.** A client that
 * ignored every `EventMsg` would still render the right board, because a
 * `StateMsg` always accompanies the change. This split is deliberate: it means
 * dropping, reordering or duplicating events is harmless, and neither backend
 * has to guarantee event delivery.
 */
export type EventMsg =
  | { t: 'event'; kind: 'moveApplied'; seat: Seat; move: Move; seq: number }
  | { t: 'event'; kind: 'moveRejected'; move: Move; error: WireError }
  | { t: 'event'; kind: 'playerJoined'; player: PlayerView }
  | { t: 'event'; kind: 'playerLeft'; playerId: PlayerId; name: string; permanent: boolean }
  | { t: 'event'; kind: 'playerReconnected'; playerId: PlayerId; name: string }
  | { t: 'event'; kind: 'connectionChanged'; playerId: PlayerId; connection: ConnectionState }
  | { t: 'event'; kind: 'gameStarted'; seq: number }
  | { t: 'event'; kind: 'gameEnded'; reason: GameEndReason; winner: Seat | null; line: WinningLine | null }
  | { t: 'event'; kind: 'hostChanged'; playerId: PlayerId; name: string }
  | { t: 'event'; kind: 'roomClosed'; reason: string };

/** Latency probe reply. */
export interface PongMsg {
  t: 'pong';
  /** Echoed from `PingMsg.id`. */
  id: string;
  /** Echoed from `PingMsg.t0`. */
  t0: number;
  /** Referee clock when the pong was produced. */
  serverTime: number;
}

/**
 * An error not attributable to a specific request — a protocol violation, or a
 * room collapsing underneath the client.
 */
export interface ErrorMsg {
  t: 'error';
  error: WireError;
  /** When true, the link is being closed and will not recover on its own. */
  fatal: boolean;
}

export type ServerMessage =
  | WelcomeMsg
  | AckMsg
  | StateMsg
  | EventMsg
  | PongMsg
  | ErrorMsg;

/* ========================================================================== *
 * Shared constants and helpers
 * ========================================================================== */

/**
 * Tuning shared by both backends so they behave identically. A peer-to-peer
 * implementation should import these rather than pick its own numbers —
 * otherwise "the game paused for 45 seconds" becomes backend-dependent
 * behaviour the user will notice.
 */
export const TIMING = {
  /** How long a seat is held for a dropped player. */
  reconnectGraceMs: 45_000,
  /** Interval between latency probes. */
  pingIntervalMs: 3_000,
  /** No traffic for this long ⇒ treat the link as dead and reconnect. */
  idleTimeoutMs: 20_000,
  /** How long a request waits for its `Ack` before failing with `TIMEOUT`. */
  requestTimeoutMs: 10_000,
  /** Reconnect backoff: first delay, growth factor, ceiling, jitter fraction. */
  reconnectBaseMs: 500,
  reconnectFactor: 1.8,
  reconnectMaxMs: 15_000,
  reconnectJitter: 0.25,
  /** A rematch offer lapses after this. */
  rematchTtlMs: 60_000,
  /** An empty room is collected after this. */
  emptyRoomTtlMs: 120_000,
  /** Hard ceiling on a room's lifetime, idle or not. */
  roomMaxLifetimeMs: 6 * 60 * 60 * 1_000,
} as const;

/**
 * What happens when a turn clock runs out. Both backends must agree.
 *
 * Otrio has no legal "pass": a player always has a move available until their
 * reserve is exhausted. So the referee plays a move *for* the timed-out player,
 * choosing the first legal placement in a deterministic order (ascending cell,
 * then ascending size). Deterministic rather than random so that a replay of
 * the move log reproduces the game exactly, on either backend.
 */
export const TURN_TIMEOUT_POLICY = 'auto-play-first-legal' as const;

/**
 * Alphabet for hosted room codes: Crockford Base32.
 *
 * It drops `I`, `L`, `O` and `U`, keeping exactly one member of each visually
 * confusable pair so that `normalizeRoomCode` has somewhere to *map* the
 * discarded member. (Excluding both halves of a pair, which is the tempting
 * mistake, leaves a typed `O` with no valid destination.) Dropping `U` also
 * makes accidental profanity much less likely.
 */
export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Length of a hosted room code. Peer-to-peer codes may differ; see `RoomCode`. */
export const ROOM_CODE_LENGTH = 5;

/** Longest accepted display name, in code points. */
export const MAX_NAME_LENGTH = 16;

/**
 * Normalise a typed room code: strip whitespace and punctuation, upper-case,
 * then fold the four excluded look-alikes onto their canonical counterparts
 * (`I`/`L` → `1`, `O` → `0`, `U` → `V`), so a player who reads `0` off a screen
 * and types `O` still gets into the room.
 *
 * Call this on *every* code before comparing or sending, on both backends.
 * Idempotent: normalising an already-normalised code is a no-op.
 */
export function normalizeRoomCode(raw: string): RoomCode {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

/**
 * Cheap client-side well-formedness check, so an obviously bad code fails
 * instantly with `CODE_INVALID` instead of after a network round trip.
 *
 * Expects an already-normalised code. Length-tolerant on purpose: the hosted
 * backend mints `ROOM_CODE_LENGTH` characters, but a peer-to-peer backend may
 * need longer codes to carry signalling information. See `RoomCode`.
 */
export function isPlausibleRoomCode(code: string): boolean {
  if (code.length < 4 || code.length > 24) return false;
  for (const ch of code) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- *
 * Single-device room codes
 * -------------------------------------------------------------------------- */

/**
 * Prefix marking a room that exists only inside one browser tab: pass-and-play
 * on one device, served by `localTransport.ts`.
 *
 * WHY A LOCAL ROOM HAS A CODE AT ALL
 * ----------------------------------
 * Because it is not optional anywhere it matters. `RoomState.code` is a
 * required field, `PeerReferee.create(code, …)` takes a `RoomCode` as its first
 * argument, and the referee hashes it (see `newLocalRoomCode`). So the sentinel
 * is forced by those signatures, not chosen for tidiness — a local game has to
 * carry *something*.
 *
 * It is never shown and never typed: the local backend's `joinRoom` rejects
 * with `UNSUPPORTED`, so `createRoom` is the only way into a local room and the
 * code never has to survive a trip through a human.
 *
 * WHY THE PREFIX IS `LOCAL` SPECIFICALLY
 * --------------------------------------
 * `L` and `O` are two of the four characters `ROOM_CODE_ALPHABET` deliberately
 * drops, and both the hosted server (`server/src/util.ts`) and the
 * peer-to-peer backend (`rtcTransport.ts`) mint codes from that alphabet and
 * nothing else. A local code therefore cannot collide with a real one — not
 * improbably, but by construction — and `isPlausibleRoomCode` returns `false`
 * for it, so a local code pasted into an online join box fails locally with
 * `CODE_INVALID` and never reaches a server.
 *
 * **Never pass a local code through `normalizeRoomCode`.** It folds `L`→`1`
 * and `O`→`0`, so `'LOCAL'` comes back as `'10CA1'`: still well-formed, no
 * longer recognisable, and `isLocalRoomCode` would then be `false`.
 * Normalisation exists for codes a human typed, and nobody types this one.
 */
export const LOCAL_ROOM_CODE_PREFIX = 'LOCAL';

/** Random characters appended to `LOCAL_ROOM_CODE_PREFIX`. See `newLocalRoomCode`. */
export const LOCAL_ROOM_CODE_SUFFIX_LENGTH = 6;

/**
 * Mint a room code for a single-device game. A fresh one per game.
 *
 * **The random suffix is load-bearing, and not for collision resistance.** The
 * referee seeds the engine with `hashSeed(RoomState.code, RoomState.seq)`
 * (`referee.ts`), and the only thing that seed decides is who moves first —
 * `src/game/random.ts` says so in as many words: *"The only thing chance
 * decides in Otrio is who goes first."* Online, that is varied because room
 * codes are. On one device it would not be: `seq` at `startGame` counts the
 * lobby's own state bumps, a deterministic function of how the transport seats
 * the players with nothing random in it, so two games set up the same way get
 * the same `seq` — and with a fixed code, the same opener, every time.
 *
 * Measured against a fixed `'LOCAL'`, 2 players (rotation length 4):
 *
 *     seq  1 -> seed 3740452335 -> firstSlot 3
 *     seq  2 -> seed 2675871910 -> firstSlot 1
 *     seq  7 -> seed  883939577 -> firstSlot 0
 *
 * Each of those is stable, not a sample. The printed rules make a point of the
 * opposite — *"Be sure to alternate which player goes first!"* (`docs/RULES.md`
 * §4.8) — which is free online and has to be bought here, for six characters.
 *
 * `32^6 = 1_073_741_824` codes: far more than collision resistance needs, and
 * exactly what the seed wants. Drawn from `ROOM_CODE_ALPHABET`; `% 32` is
 * unbiased only because that alphabet has exactly 32 entries.
 */
export function newLocalRoomCode(): RoomCode {
  const bytes = new Uint8Array(LOCAL_ROOM_CODE_SUFFIX_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out: string = LOCAL_ROOM_CODE_PREFIX;
  for (const b of bytes) out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
  return out;
}

/**
 * True for a room that exists only on this device.
 *
 * The supported way for a UI to ask *"is there a code to share here?"* — which
 * is the question the room-code button, the invite sheet and the latency line
 * are all really asking. Branching on this rather than on `Capabilities.kind`
 * is what keeps the diagnostics-only rule on `kind` honest.
 */
export function isLocalRoomCode(code: RoomCode): boolean {
  return code.startsWith(LOCAL_ROOM_CODE_PREFIX);
}

/** Trim, collapse whitespace, cap length, and fall back to a default. */
export function sanitizeName(raw: string, fallback = 'Player'): string {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Cryptographically random identifier, hex encoded. Works in browsers, Workers
 * and Node 18+ without imports (`globalThis.crypto` is standard in all three).
 */
export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

/** Mint a fresh public identity. */
export function newPlayerId(): PlayerId {
  return randomId(12);
}

/** Mint a fresh private credential. Longer, because it is a bearer token. */
export function newSessionSecret(): SessionSecret {
  return randomId(24);
}

/** Build a `WireError`, defaulting `retryable` from the code. */
export function wireError(code: ErrorCode, message: string, retryable?: boolean): WireError {
  return {
    code,
    message,
    retryable: retryable ?? RETRYABLE_CODES.has(code),
  };
}

/** Codes for which an identical retry could plausibly succeed. */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'NETWORK_UNAVAILABLE',
  'CONNECT_FAILED',
  'CONNECTION_LOST',
  'TIMEOUT',
  'RATE_LIMITED',
  'SIGNALING_FAILED',
  'PEER_UNREACHABLE',
  'INTERNAL',
]);

/* -------------------------------------------------------------------------- *
 * Runtime shape checks
 *
 * The server calls these on everything a socket sends. They are intentionally
 * dumb structural checks rather than a schema library — `ws` is the only
 * dependency this project takes for networking, and nine cells of board state
 * do not justify a validator.
 * -------------------------------------------------------------------------- */

/** True if `v` is a finite integer within `[min, max]`. */
export function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** True if `v` is a non-empty string no longer than `max`. */
export function isShortString(v: unknown, max = 256): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/** True if `v` is a structurally valid `Move`. Says nothing about legality. */
export function isMove(v: unknown): v is Move {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  if (!isIntInRange(m.cell, 0, BOARD_CELLS - 1)) return false;
  if (typeof m.size !== 'string' || !(PIECE_SIZES as readonly string[]).includes(m.size)) {
    return false;
  }
  // `color` is optional, but if present it must be a real colour. Note `0` is
  // purple, so `undefined` is the only acceptable absence.
  if (m.color !== undefined && !isIntInRange(m.color, 0, 3)) return false;
  return true;
}

/** Empty board, used by both the server and a peer-to-peer referee. */
export function emptyBoard(): CellState[] {
  const board: CellState[] = [];
  for (let i = 0; i < BOARD_CELLS; i++) board.push({ small: null, medium: null, large: null });
  return board;
}

/** Full reserve for one player. */
export function fullReserve(): Reserve {
  return { small: PIECES_PER_SIZE, medium: PIECES_PER_SIZE, large: PIECES_PER_SIZE };
}
