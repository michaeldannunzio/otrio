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
import { defaultSize, reserveFor } from './selectors';

import type { CellIndex, CreateRoomOptions, PieceSize, RoomCode } from '../net/protocol';
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
  const ui = useUi.getState();
  if (ui.sizeChosenManually) {
    // Keep their choice, unless they have run out of that size.
    const reserve = reserveFor(snap.room, snap.seat);
    if (reserve[ui.selectedSize] > 0) return;
  }
  const next = defaultSize(reserveFor(snap.room, snap.seat));
  if (next) ui.selectSize(next, false);
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
  if (snap.seat !== null && (game.reserves[snap.seat]?.[chosen] ?? 0) <= 0) {
    return {
      ok: false,
      error: { code: 'ILLEGAL_MOVE', message: `No ${chosen} rings left.`, retryable: false },
    };
  }
  if (game.board[cell]?.[chosen] !== null) {
    return {
      ok: false,
      error: { code: 'ILLEGAL_MOVE', message: 'That ring slot is taken.', retryable: false },
    };
  }

  buzz(12);
  const result = await runCommand((t) => t.sendMove({ cell, size: chosen }));
  if (result.ok) {
    useUi.getState().resetSizeChoice();
    interaction.get().setHover(null);
  }
  return result;
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
