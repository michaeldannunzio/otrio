/**
 * Everything the player can *do*, as plain imperative functions.
 *
 * Deliberately free of user-facing copy. These are called from two places with
 * different presentation needs -- React components in `src/ui`, and the 3D board
 * in `src/scene`, which has no toast system of its own -- so they return a
 * `CommandResult` and let the caller decide what to say. The one piece of
 * feedback that must not depend on the caller (a move the referee refused) is
 * handled centrally off the transport's `moveRejected` event.
 *
 * Safe to call from an event handler, a keyboard shortcut, or a raycast hit.
 */

import { runCommand, getTransport } from './transportStore';
import type { CommandResult } from './transportStore';
import { useUi } from './uiStore';
import { usePrefs } from './prefsStore';
import { interaction } from './interactionStore';
import { moveLog } from './moveLogStore';
import { defaultSize } from './selectors';
import { coloursOfSeat, reserveOfColour, turnColours } from './colours';

import type {
  CellIndex,
  CreateRoomOptions,
  Move,
  PieceSize,
  PlayerColor,
  RoomCode,
} from '../net/protocol';
import { normalizeRoomCode } from '../net/protocol';

/* -------------------------------------------------------------------------- *
 * Link
 * -------------------------------------------------------------------------- */

export function connect(): Promise<CommandResult<void>> {
  return runCommand((t) => t.connect());
}

export function resync(): Promise<CommandResult<void>> {
  return runCommand((t) => t.resync());
}

/* -------------------------------------------------------------------------- *
 * Rooms
 * -------------------------------------------------------------------------- */

export async function createRoom(options?: CreateRoomOptions): Promise<CommandResult<RoomCode>> {
  const result = await runCommand((t) => t.createRoom(options));
  if (result.ok) {
    useUi.getState().resetForNewRoom();
    useUi.getState().setEntry('home');
  }
  return result;
}

export async function joinRoom(
  code: string,
  options?: { asSpectator?: boolean },
): Promise<CommandResult<RoomCode>> {
  const normalized = normalizeRoomCode(code);
  const result = await runCommand((t) => t.joinRoom(normalized, options));
  if (result.ok) {
    useUi.getState().resetForNewRoom();
    useUi.getState().setEntry('home');
  }
  return result;
}

export async function leaveRoom(): Promise<CommandResult<void>> {
  const result = await runCommand((t) => t.leaveRoom());
  useUi.getState().resetForNewRoom();
  interaction.get().reset();
  moveLog.clear();
  return result;
}

export function setReady(ready: boolean): Promise<CommandResult<void>> {
  return runCommand((t) => t.setReady(ready));
}

export async function setName(name: string): Promise<CommandResult<void>> {
  // Update the local preference first so the field never appears to reject a
  // keystroke while a round trip is in flight. The referee sanitises
  // independently and its version wins in `RoomState`.
  usePrefs.getState().setName(name);
  return runCommand((t) => t.setName(name));
}

export function startGame(): Promise<CommandResult<void>> {
  return runCommand((t) => t.startGame());
}

export function requestRematch(accept: boolean): Promise<CommandResult<void>> {
  const result = runCommand((t) => t.requestRematch(accept));
  if (accept) {
    useUi.getState().setResultDismissed(false);
    useUi.getState().resetSizeChoice();
  }
  return result;
}

/* -------------------------------------------------------------------------- *
 * Playing
 * -------------------------------------------------------------------------- */

/** Arm a ring size. Idempotent; safe to call from the 3D tray. */
export function armSize(size: PieceSize): void {
  useUi.getState().selectSize(size, true);
}

/**
 * Choose which colour to place, for the only case where it is a choice:
 * a two-colour seat with strict alternation switched off.
 */
export function armColour(colour: PlayerColor): void {
  useUi.getState().selectColour(colour);
  // The new colour has its own tray, so the armed size may no longer exist.
  autoArmSize();
}

/**
 * Re-arm the largest ring the local seat still holds, unless the player has
 * already chosen one deliberately this game.
 *
 * Called when the turn changes. It is a convenience, not a rule: `selectSize`
 * with `manual: true` locks the choice until `resetSizeChoice()`.
 */
export function autoArmSize(): void {
  const transport = getTransport();
  const snap = transport?.getSnapshot();
  if (!snap || snap.seat === null) return;
  const colour = resolveColour(snap.room, snap.seat);
  if (colour === null) return;
  // The reserve belongs to the COLOUR being placed, not to the person. In the
  // two-player game those are different trays on alternate turns.
  const reserve = reserveOfColour(snap.room, colour);
  const ui = useUi.getState();
  if (ui.sizeChosenManually && reserve[ui.selectedSize] > 0) return;
  const next = defaultSize(reserve);
  if (next) ui.selectSize(next, false);
}

/**
 * Which colour this seat is placing right now.
 *
 * Normally the referee has already decided: `turnColors` has exactly one entry
 * on every 3-/4-player turn and on every turn of the official 2-player game,
 * because strict alternation fixes it. It is longer only when alternation has
 * been switched off, and then the player picks -- we honour their pick if it is
 * actually playable and otherwise fall back to the first offered colour rather
 * than sending something the referee will reject.
 */
export function resolveColour(
  room: Parameters<typeof turnColours>[0],
  seat: number,
): PlayerColor | null {
  const offered = turnColours(room);
  if (offered.length === 1) return offered[0];
  if (offered.length === 0) return null;
  const chosen = useUi.getState().selectedColour;
  if (chosen !== null && offered.includes(chosen)) return chosen;
  // Prefer one this seat actually holds, in case `turnColors` ever widens.
  const held = coloursOfSeat(room, seat);
  return offered.find((c) => held.includes(c)) ?? offered[0];
}

/**
 * Place a ring.
 *
 * `size` defaults to the armed size, which is what a tap on the 3D board means.
 * Fails fast and locally on the cases the player can see for themselves (not
 * your turn, slot taken, none of that size left) so the board feels immediate,
 * and lets the referee be authoritative about everything else.
 */
export async function placePiece(
  cell: CellIndex,
  size?: PieceSize,
): Promise<CommandResult<void>> {
  const transport = getTransport();
  const snap = transport?.getSnapshot();
  const chosen = size ?? useUi.getState().selectedSize;

  if (!transport || !snap) {
    return {
      ok: false,
      error: { code: 'NETWORK_UNAVAILABLE', message: 'Not connected.', retryable: false },
    };
  }
  if (!snap.isMyTurn) {
    return {
      ok: false,
      error: { code: 'NOT_YOUR_TURN', message: 'It is not your turn.', retryable: false },
    };
  }
  if (snap.pendingMove) {
    return {
      ok: false,
      error: { code: 'NOT_YOUR_TURN', message: 'Your last move is still being confirmed.', retryable: false },
    };
  }
  const game = snap.room?.game;
  if (!game || game.phase !== 'playing') {
    return {
      ok: false,
      error: { code: 'GAME_NOT_ACTIVE', message: 'The game is not running.', retryable: false },
    };
  }
  const colour = snap.seat === null ? null : resolveColour(snap.room, snap.seat);
  if (colour === null) {
    return {
      ok: false,
      error: { code: 'NOT_YOUR_TURN', message: 'No colour is due for you.', retryable: false },
    };
  }
  // Reserves are indexed by colour. Indexing them by seat compiles and returns
  // the wrong tray in a two-player game -- see colours.ts.
  if (reserveOfColour(snap.room, colour)[chosen] <= 0) {
    return {
      ok: false,
      error: { code: 'ILLEGAL_MOVE', message: `No ${chosen} rings left.`, retryable: false },
    };
  }
  // `!== null` rather than truthiness: colour 0 is purple and is falsy.
  if (game.board[cell]?.[chosen] !== null) {
    return {
      ok: false,
      error: { code: 'ILLEGAL_MOVE', message: 'That ring slot is taken.', retryable: false },
    };
  }

  buzz(12);
  // `color` is sent only when the referee left a genuine choice. Sending it
  // when exactly one colour is playable is redundant, and sending one that is
  // not in `turnColors` is rejected.
  const move: Move = { cell, size: chosen };
  if (turnColours(snap.room).length > 1) move.color = colour;
  const result = await runCommand((t) => t.sendMove(move));
  if (result.ok) {
    useUi.getState().resetSizeChoice();
    interaction.get().setHover(null);
  }
  return result;
}

/* -------------------------------------------------------------------------- *
 * Backend
 * -------------------------------------------------------------------------- */

/**
 * Switch to the hosted backend and start again.
 *
 * Offered when a peer-to-peer connection cannot be established. The common
 * cause is that no TURN relay is configured, which is a deployment problem the
 * player cannot fix and retrying will never resolve -- so the only useful thing
 * to offer is a route that does not need one.
 *
 * Reloads rather than hot-swapping the transport. The transport is built once
 * at boot, and this only ever fires from the home screen with no room to lose,
 * so a reload is the honest implementation: it cannot leave a half-disposed
 * instance behind, and `rememberTransportKind` makes the choice stick.
 */
export async function switchToHostedBackend(): Promise<void> {
  const { rememberTransportKind } = await import('../net');
  rememberTransportKind('hosted');
  window.location.reload();
}

/* -------------------------------------------------------------------------- *
 * Device feedback
 * -------------------------------------------------------------------------- */

/**
 * A short haptic tick, honoured only if the player has not turned it off.
 *
 * Around a table each phone is silent and face-up; a 12ms tick is what tells
 * you your tap registered without making a noise everyone else has to hear.
 * `navigator.vibrate` is absent on iOS Safari, so this is additive feedback
 * only -- nothing depends on it.
 */
export function buzz(pattern: number | number[]): void {
  if (!usePrefs.getState().haptics) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported; nothing is lost */
  }
}
