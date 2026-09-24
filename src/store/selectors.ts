/**
 * Pure derivations over `RoomState`.
 *
 * These are plain functions, not hooks, on purpose. `RoomState` is replaced
 * wholesale whenever a snapshot arrives off the wire and is otherwise
 * referentially stable -- notably it does *not* change when `quality` refreshes
 * on the ping timer. So a component can select `room` once and derive freely
 * during render, and it will re-render exactly when the room actually changed.
 */

import { BOARD_CELLS, MIN_PLAYERS, PIECE_SIZES, isLocalRoomCode } from '../net/protocol';
import type {
  CellIndex,
  CellState,
  GameSnapshot,
  PieceSize,
  PlayerColor,
  PlayerId,
  PlayerView,
  Reserve,
  RoomState,
  Seat,
  WinningLine,
} from '../net/protocol';
import type { TransportSnapshot } from '../net/transport';

/* -------------------------------------------------------------------------- *
 * Routing
 * -------------------------------------------------------------------------- */

export type Route = 'home' | 'lobby' | 'game';

/**
 * Which screen to show.
 *
 * `paused` and `finished` both stay on the game screen: the board is the thing
 * the player wants to look at while waiting for someone to reconnect, and the
 * end-of-game state is an overlay *on* the final position, not a replacement
 * for it.
 */
export function routeOf(snapshot: TransportSnapshot): Route {
  const room = snapshot.room;
  if (!room) return 'home';
  /*
   * A local room never shows a lobby, and that is stated here rather than left
   * to timing.
   *
   * The decision is Bob's (2026-09-24): `createRoom` seats and readies every
   * player from the config and the caller invokes `startGame()` immediately.
   * But "immediately" is two `await`s apart in `startLocalGame`, with a store
   * notification between them, so `phase: 'lobby'` is a state React genuinely
   * can render -- and it would render a ready-up screen for a game with nobody
   * to wait for, on the way into every single local game.
   *
   * Relying on those two calls being fast would make the absence of that flash
   * a side effect nobody chose. One line here makes it a property.
   *
   * `isLocalRoomCode(room.code)`, never `capabilities.kind`: `kind` is
   * documented diagnostics-only and the room code is the supported feature
   * test (Homer, 2026-09-24).
   */
  if (room.phase === 'lobby') return isLocalRoomCode(room.code) ? 'game' : 'lobby';
  return 'game';
}

/* -------------------------------------------------------------------------- *
 * The hot seat
 * -------------------------------------------------------------------------- */

/**
 * The seat the device must be handed to before play can continue, or `null`
 * when nobody is waiting.
 *
 * A derivation, not a flag. `deviceHeldBy` records how far the people in the
 * room have caught up with the referee; `game.turn` is the truth. Pending-ness
 * is the gap between them, so it cannot be left stuck raised by a component
 * that unmounted mid-handoff, and it needs no event to stay correct.
 *
 * WHY THE GATE EXISTS AT ALL, since it costs a tap a turn
 * ------------------------------------------------------
 * `docs/RULES.md` 4.3 is `[OFFICIAL]` and absolute: once a piece is placed it
 * cannot be moved. No capture, no undo. (`engine.ts` does export an `undo`, and
 * says in as many words that it is for reconciliation and not for players.) So
 * on one device the *outgoing* player, still holding the phone, is one tap away
 * from making an irreversible move on behalf of the *incoming* one, and neither
 * the rules nor the code has a recovery path. That failure has no online
 * analogue, and it is the whole justification. (Arthur, docs/UX.md.)
 *
 * `null` for `deviceHeldBy` means "no turn has settled yet" and produces no
 * gate: the opening turn is not a handoff, and `ColourReveal` already names the
 * opener. A rematch *does* gate, because the reveal plays only once per room
 * and the gate is then the only thing that says who opens the new game.
 */
export function handoffPendingFor(
  room: RoomState | null,
  deviceHeldBy: Seat | null,
): Seat | null {
  // `isLocalRoomCode(room.code)`, never `capabilities.kind` (Homer).
  if (!room || !isLocalRoomCode(room.code)) return null;
  const game = room.game;
  if (!game || game.phase !== 'playing') return null;
  if (deviceHeldBy === null || deviceHeldBy === game.turn) return null;
  return game.turn;
}

/* -------------------------------------------------------------------------- *
 * People
 * -------------------------------------------------------------------------- */

/** Seated players in seat order. `RoomState` promises this, but be explicit. */
export function playersBySeat(room: RoomState | null): PlayerView[] {
  if (!room) return [];
  return [...room.players].sort((a, b) => a.seat - b.seat);
}

export function playerById(room: RoomState | null, playerId: PlayerId): PlayerView | null {
  return room?.players.find((p) => p.playerId === playerId) ?? null;
}

export function playerBySeat(room: RoomState | null, seat: Seat | null): PlayerView | null {
  if (seat === null) return null;
  return room?.players.find((p) => p.seat === seat) ?? null;
}

/** The player whose turn it is, or `null` outside an active game. */
export function playerToMove(room: RoomState | null): PlayerView | null {
  if (!room || !room.game || room.game.phase !== 'playing') return null;
  return playerBySeat(room, room.game.turn);
}

/** Empty seats still open for joiners. */
export function openSeatCount(room: RoomState | null): number {
  if (!room) return 0;
  return Math.max(0, room.maxPlayers - room.players.length);
}

/** Anyone the referee currently considers away. */
export function disconnectedPlayers(room: RoomState | null): PlayerView[] {
  if (!room) return [];
  return room.players.filter((p) => p.connection !== 'online' && !p.forfeited);
}

/* -------------------------------------------------------------------------- *
 * Reserves and legality
 *
 * `reserves` is indexed by COLOUR, not by seat, so every reserve accessor lives
 * in `colours.ts`. There is deliberately no `reserveFor(room, seat)` here: it
 * compiled fine and returned the wrong tray in exactly the two-player game.
 * -------------------------------------------------------------------------- */

export function totalReserve(reserve: Reserve): number {
  return reserve.small + reserve.medium + reserve.large;
}

/** Sizes this colour can still place at all. */
export function availableSizes(reserve: Reserve): PieceSize[] {
  return PIECE_SIZES.filter((size) => reserve[size] > 0);
}

/**
 * The size to arm by default: the largest still held.
 *
 * Large rings are the ones that get blocked first and the ones people reach for
 * first, so defaulting to large saves a tap on most turns. It is only a default
 * -- `sizeChosenManually` in the UI store stops it overriding a real choice.
 */
export function defaultSize(reserve: Reserve): PieceSize | null {
  if (reserve.large > 0) return 'large';
  if (reserve.medium > 0) return 'medium';
  if (reserve.small > 0) return 'small';
  return null;
}

/** Is this exact slot free? Ownership and turn are not checked. */
export function isSlotFree(
  game: GameSnapshot | null,
  cell: CellIndex,
  size: PieceSize,
): boolean {
  if (!game) return false;
  const state: CellState | undefined = game.board[cell];
  // `!== null` rather than truthiness: colour 0 is purple.
  return !!state && state[size] === null;
}

/**
 * Every legal placement for one COLOUR, for the keyboard board and for hinting.
 * Takes a colour because a reserve belongs to a colour, not to a person.
 */
export function legalPlacements(
  game: GameSnapshot | null,
  colour: PlayerColor,
): Array<{ cell: CellIndex; size: PieceSize }> {
  if (!game || game.phase !== 'playing') return [];
  const reserve = game.reserves[colour];
  if (!reserve) return [];
  const out: Array<{ cell: CellIndex; size: PieceSize }> = [];
  for (let cell = 0; cell < BOARD_CELLS; cell += 1) {
    for (const size of PIECE_SIZES) {
      if (reserve[size] > 0 && game.board[cell]?.[size] === null) out.push({ cell, size });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Lobby readiness
 * -------------------------------------------------------------------------- */

export interface StartCheck {
  canStart: boolean;
  /** Human-facing reasons, ready to render as a list. Empty when startable. */
  blockers: string[];
}

/**
 * Why the Start button is disabled.
 *
 * Deliberately verbose: a disabled button with no explanation is the single
 * most common way a lobby stalls, because the host is looking at their own
 * screen and the person who has not tapped Ready is looking at theirs.
 */
export function startCheck(room: RoomState | null, isHost: boolean): StartCheck {
  if (!room) return { canStart: false, blockers: ['Not in a room.'] };
  const blockers: string[] = [];

  if (!isHost) {
    const host = playerById(room, room.hostPlayerId);
    blockers.push(`Only ${host?.name ?? 'the host'} can start the game.`);
  }
  if (room.players.length < MIN_PLAYERS) {
    const missing = MIN_PLAYERS - room.players.length;
    blockers.push(`Waiting for ${missing} more player${missing === 1 ? '' : 's'}.`);
  }
  const notReady = room.players.filter((p) => !p.ready);
  if (notReady.length > 0) {
    blockers.push(
      notReady.length === 1
        ? `${notReady[0].name} is not ready yet.`
        : `${notReady.length} players are not ready yet.`,
    );
  }
  const away = disconnectedPlayers(room);
  if (away.length > 0) {
    blockers.push(
      away.length === 1
        ? `${away[0].name} is reconnecting.`
        : `${away.length} players are reconnecting.`,
    );
  }

  return { canStart: blockers.length === 0, blockers };
}

/* -------------------------------------------------------------------------- *
 * Endgame
 * -------------------------------------------------------------------------- */

export interface Outcome {
  kind: 'win' | 'draw' | 'abandoned' | 'none';
  /** The person who won. */
  winner: PlayerView | null;
  /**
   * The colour that won, which is what the pieces are drawn in. Differs from
   * the winner's seat only in the two-player game -- but that is precisely the
   * case where colouring the result by seat shows the wrong colour.
   */
  colour: PlayerColor | null;
  line: WinningLine | null;
  /** Every cell that should be highlighted. Empty for non-wins. */
  cells: CellIndex[];
}

export function outcomeOf(room: RoomState | null): Outcome {
  if (!room || room.phase !== 'finished') {
    return { kind: 'none', winner: null, colour: null, line: null, cells: [] };
  }
  const game = room.game;
  const line = game?.winningLine ?? null;
  if (game && game.winner !== null) {
    return {
      kind: 'win',
      winner: playerBySeat(room, game.winner),
      // Prefer the line's own colour; `winnerColor` is the same value and is
      // the fallback when a win somehow arrives without a line.
      colour: line?.color ?? game.winnerColor,
      line,
      cells: line ? dedupe(line.cells) : [],
    };
  }
  if (game?.isDraw || room.endReason === 'draw') {
    return { kind: 'draw', winner: null, colour: null, line: null, cells: [] };
  }
  return { kind: 'abandoned', winner: null, colour: null, line: null, cells: [] };
}

function dedupe(cells: CellIndex[]): CellIndex[] {
  return Array.from(new Set(cells));
}

/* -------------------------------------------------------------------------- *
 * Rematch
 * -------------------------------------------------------------------------- */

export interface RematchView {
  offered: boolean;
  /** True when this client has already agreed. */
  youAccepted: boolean;
  requestedBy: PlayerView | null;
  accepted: PlayerView[];
  waitingOn: PlayerView[];
  expiresAt: number | null;
}

export function rematchView(room: RoomState | null, playerId: PlayerId): RematchView {
  const offer = room?.rematch ?? null;
  if (!room || !offer) {
    return {
      offered: false,
      youAccepted: false,
      requestedBy: null,
      accepted: [],
      waitingOn: [],
      expiresAt: null,
    };
  }
  const accepted = offer.accepted
    .map((id) => playerById(room, id))
    .filter((p): p is PlayerView => p !== null);
  // Only wait on people who are actually there to answer.
  const waitingOn = room.players.filter(
    (p) => !offer.accepted.includes(p.playerId) && p.connection === 'online' && !p.forfeited,
  );
  return {
    offered: true,
    youAccepted: offer.accepted.includes(playerId),
    requestedBy: playerById(room, offer.requestedBy),
    accepted,
    waitingOn,
    expiresAt: offer.expiresAt,
  };
}

/* -------------------------------------------------------------------------- *
 * Clock
 * -------------------------------------------------------------------------- */

/**
 * Convert a referee timestamp into "ms from now on this device", correcting for
 * clock skew.
 *
 * Phones lie about the time -- a device a minute fast would otherwise render
 * every deadline as already expired. `quality.clockOffsetMs` is measured by the
 * transport; we add it to our own clock before comparing.
 */
export function msUntil(deadline: number | null, clockOffsetMs: number | null): number | null {
  if (deadline === null) return null;
  const now = Date.now() + (clockOffsetMs ?? 0);
  return Math.max(0, deadline - now);
}
