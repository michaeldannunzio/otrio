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

import { runCommand, getTransport, setTransport, toWireError } from './transportStore';
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
  Seat,
} from '../net/protocol';
import { MAX_PLAYERS, MIN_PLAYERS, isLocalRoomCode, normalizeRoomCode } from '../net/protocol';
import { toLocalSeatNames } from '../net/transport';
import type { Transport } from '../net/transport';

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

/**
 * Leave the room.
 *
 * LEAVING A LOCAL GAME RELOADS THE PAGE (approved by Bob, 2026-09-24)
 * ------------------------------------------------------------------
 * Entering local mode replaces the installed transport, so on the way out the
 * app is still holding a single-device backend with no room in it — and both
 * home-screen buttons are then wrong in ways a player cannot see. "Start a new
 * game" would silently open *another* hot-seat room with the previous game's
 * seat names; "Join with a code" would reject `UNSUPPORTED`. A live dead end,
 * not a cosmetic one.
 *
 * A reload rather than rebuilding the default transport in place, for the same
 * reason `switchToHostedBackend` below reloads: the `connect()` effect in
 * `App.tsx` fires on every transport identity change, so an in-place rebuild
 * races that effect and can leave a half-disposed instance behind. A reload
 * cannot, it is instant, and it works with no network because the shell is
 * precached. `rememberTransportKind` is never given `'local'`, so the reload
 * comes back on the online default.
 *
 * The code is read *before* leaving, because `leaveRoom` clears `room` and
 * afterwards there is nothing left to test.
 */
export async function leaveRoom(): Promise<CommandResult<void>> {
  const code = getTransport()?.getSnapshot().room?.code;
  const wasOnOneDevice = code !== undefined && isLocalRoomCode(code);

  const result = await runCommand((t) => t.leaveRoom());
  useUi.getState().resetForNewRoom();
  interaction.get().reset();
  moveLog.clear();

  // Unconditional on the result: if the leave itself failed we are in a state
  // nobody designed, and a reload is the recovery for that too.
  if (wasOnOneDevice) window.location.reload();
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

/**
 * Start a pass-and-play game on this one device.
 *
 * Three steps that are deliberately not separable: build the single-device
 * backend, open its room, start the game. **There is no lobby in local mode**
 * (Bob, 2026-09-24) — `createRoom` seats and readies every player from
 * `seatNames`, and stopping between it and `startGame` would render a ready-up
 * screen with nobody to wait for. So they are one action, and the player sees
 * one button.
 *
 * `createRoom()` takes NO options here, and that is the point. The local
 * transport builds `{ maxPlayers: seatNames.length, allowSpectators: false,
 * turnTimeoutMs: LOCAL_TURN_TIMEOUT_MS }` itself, because `seatNames.length`
 * *is* the player count — passing a `maxPlayers` from this side would be a
 * second definition of one number, free to disagree with the first.
 *
 * Swapping the installed transport is what `setTransport` is for: the previous
 * instance is disposed and genuinely unreachable afterwards. Two consequences
 * worth stating rather than discovering:
 *
 *   - If `createRoom` or `startGame` fails *after* the swap, the local backend
 *     stays installed. Survivable only because this is reachable from the home
 *     screen alone, where there is no room to lose; the error is returned and
 *     the player is still on the setup screen.
 *   - The choice is deliberately NOT given to `rememberTransportKind`. A sticky
 *     `'local'` is read back at the next boot by a `defaultTransportKind` that
 *     has no seat names to hand it, and the local arm is required to reject
 *     rather than invent them. See `buildTransport` in `main.tsx`.
 *
 * Names are passed through unsanitised on purpose: the referee sanitises them,
 * exactly as it does online, so a hot-seat name and a networked name get
 * identical treatment. Substituting a *blank* field's default is the caller's
 * job and happens in the setup screen, where the seat's colour is known.
 */
export async function startLocalGame(
  names: readonly string[],
): Promise<CommandResult<RoomCode>> {
  // `toLocalSeatNames` narrows `string[]` to the 2-4 tuple union or returns
  // null. The length is checked here rather than asserted because this is the
  // boundary where a UI's growable array becomes a fixed-arity seat list.
  const seatNames = toLocalSeatNames(names);
  if (!seatNames) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED',
        message: `A game on one device needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`,
        retryable: false,
      },
    };
  }

  let transport: Transport;
  try {
    // Literal specifier, as everywhere else that reaches the backend barrel.
    const { createTransport } = await import('../net');
    transport = await createTransport('local', { seatNames });
  } catch (error) {
    // Reported, never substituted. Until `src/net/localTransport.ts` lands this
    // is the expected path: the factory throws `UNSUPPORTED` naming the missing
    // module, and that sentence is what the player sees. Handing back some
    // other backend here is the failure mode this whole arrangement exists to
    // avoid — an offline mode that quietly opens a socket.
    return { ok: false, error: toWireError(error) };
  }
  setTransport(transport);

  const opened = await createRoom();
  if (!opened.ok) return opened;
  const started = await startGame();
  if (!started.ok) return { ok: false, error: started.error };
  return opened;
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
  seat: Seat,
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
