/**
 * Client state — public entry point.
 *
 * Import from `src/store`, not from the files inside it.
 *
 * The split, once:
 *   - Server state lives in the transport (`src/net/transport.ts`) and is read
 *     through `useNet(selector)`. It is never copied into a store here.
 *   - Client state lives in zustand: `useUi` (ephemeral), `usePrefs` (durable),
 *     `interactionStore` (pointer, safe to write per frame).
 *   - `selectors.ts` derives from `RoomState` with plain functions.
 *   - `actions.ts` is everything the player can do.
 *
 * ## For the 3D scene
 *
 * ```ts
 * import { useNet, placePiece, armSize, interaction } from '../store';
 *
 * const board  = useNet((s) => s.room?.game?.board ?? null);
 * const myTurn = useNet((s) => s.isMyTurn);
 *
 * // per-frame: no React render
 * interaction.get().setHover({ cell, size });
 * // on click:
 * void placePiece(cell);
 * ```
 */

export { usePrefs, watchTheme, PREFS_STORAGE_KEY } from './prefsStore';
export type { Prefs, PrefsStore, ThemePref, MotionPref } from './prefsStore';

export { useUi, ui } from './uiStore';
export type {
  Announcement,
  EntryView,
  SheetId,
  Toast,
  ToastTone,
  UiState,
  UiStore,
  Urgency,
} from './uiStore';

export {
  getTransport,
  setTransport,
  setTransportBootError,
  retryConnection,
  runCommand,
  shallowEqual,
  useNet,
  useNetSnapshot,
  useTransportHolder,
} from './transportStore';
export type { CommandResult } from './transportStore';

export { interaction, interactionStore, useInteraction } from './interactionStore';
export type { InteractionState, Slot } from './interactionStore';

export * from './selectors';
export * from './colours';
export * from './variants';
export * from './actions';

export { toBoardState, toGamePlayerId } from './adapters';
