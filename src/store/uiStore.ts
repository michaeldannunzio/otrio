/**
 * Ephemeral client state: things that are true about *this browser right now*
 * and that nobody else needs to know.
 *
 * The division of labour in this app is deliberate and worth stating once:
 *
 *   - `src/net/transport.ts` owns **server state**. It is already shaped for
 *     `useSyncExternalStore` and already derives `seat` / `isMyTurn` / `isHost`,
 *     so mirroring it into zustand would only create two copies that can drift.
 *     Components read it through the hooks in `transportStore.ts`.
 *   - This store owns **client state**: which sheet is open, which ring size is
 *     armed, what the live region should say, which toasts are on screen.
 *   - `prefsStore.ts` owns **durable** client state (theme, name, sound).
 *
 * Nothing here is persisted and nothing here is sent anywhere.
 */

import { create } from 'zustand';

import type { PieceSize, PlayerColor } from '../net/protocol';

/* -------------------------------------------------------------------------- *
 * Announcements
 * -------------------------------------------------------------------------- */

/**
 * A message destined for an ARIA live region.
 *
 * The `id` is not decoration. Screen readers announce a live region when its
 * *text content changes*; setting the same string twice is a no-op. In a game
 * where "Your turn" is genuinely the correct thing to say on four separate
 * occasions, that silence is a bug. Bumping `id` lets the renderer force a
 * change (it swaps between two sibling nodes), so repeats are announced.
 */
export interface Announcement {
  id: number;
  text: string;
}

/**
 * `polite` waits for a pause; `assertive` interrupts.
 *
 * We are strict about assertive. Interrupting someone mid-sentence is
 * justified for "it is your turn" and "the game is over" and essentially
 * nothing else -- certainly not for latency changes or someone else's toast,
 * which is how live regions become the thing users switch off.
 */
export type Urgency = 'polite' | 'assertive';

/* -------------------------------------------------------------------------- *
 * Toasts
 * -------------------------------------------------------------------------- */

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  detail?: string;
  /**
   * Developer-register detail, shown muted beneath `detail`. For the two error
   * codes whose message carries the only actionable information -- see
   * `describeWireError`. Never shown instead of `detail`.
   */
  technical?: string;
  /** ms before auto-dismiss, or `null` to require a deliberate dismissal. */
  timeout: number | null;
  /** Optional single action, e.g. "Try again". */
  action?: { label: string; run: () => void };
  /**
   * When set, a new toast with the same key replaces the existing one instead of
   * stacking. Stops "reconnecting" from producing a column of identical cards
   * on a flaky train connection.
   */
  key?: string;
}

/* -------------------------------------------------------------------------- *
 * Overlays
 * -------------------------------------------------------------------------- */

/**
 * At most one overlay at a time. A stack would be more general and would also
 * mean two focus traps fighting on a 360px screen; one is the right number.
 */
export type SheetId =
  | 'settings'
  | 'players'
  | 'room-info'
  | 'leave-confirm'
  | 'how-to-play'
  | 'move-log';

/**
 * Which pre-room screen the player is looking at.
 *
 * `'local'` is the setup step for a game on this one device: player count and a
 * name per seat. It is a sibling of `'create'` rather than a mode flag because
 * it is genuinely a different screen with different questions — a local game
 * asks for every player's name up front and has no room code, no spectators and
 * no lobby to wait in.
 */
export type EntryView = 'home' | 'join' | 'create' | 'local';

export interface UiState {
  entry: EntryView;
  /** Code pre-filled from a shared link, so the join field starts populated. */
  prefilledCode: string;

  sheet: SheetId | null;

  /**
   * The ring size armed for the next placement. The 3D scene reads this to know
   * what a tap on a space means, and writes it when the player picks a ring off
   * their tray in 3D instead. Low frequency -- it changes on a deliberate tap,
   * never per frame.
   */
  selectedSize: PieceSize;
  /**
   * Which colour to place, for the one case where the player has a choice: a
   * two-colour seat with strict alternation switched off. `null` means "no
   * deliberate choice", and the referee's `turnColors` decides.
   */
  selectedColour: PlayerColor | null;
  /**
   * True once the player has chosen a size by hand this turn. Until then the UI
   * is free to auto-arm the largest size they still hold, which is what people
   * reach for first and saves a tap on most turns.
   */
  sizeChosenManually: boolean;

  /**
   * Reveal the keyboard/screen-reader board. Normally it appears on focus and
   * hides again; this pins it open for the whole session.
   */
  textBoardOpen: boolean;

  polite: Announcement | null;
  assertive: Announcement | null;
  toasts: Toast[];

  /** Set when the win overlay has been dismissed so the board can be studied. */
  resultDismissed: boolean;
  /**
   * Room code whose colour reveal has already played. Once per room, not once
   * per game: a rematch keeps seats and colours, so a second beat would teach
   * nothing and only delay the board.
   */
  revealShownFor: string | null;
}

export interface UiStore extends UiState {
  setEntry(entry: EntryView): void;
  setPrefilledCode(code: string): void;
  openSheet(sheet: SheetId): void;
  closeSheet(): void;

  selectSize(size: PieceSize, manual?: boolean): void;
  selectColour(colour: PlayerColor | null): void;
  resetSizeChoice(): void;
  setTextBoardOpen(open: boolean): void;

  announce(text: string, urgency?: Urgency): void;
  clearAnnouncements(): void;

  toast(toast: Omit<Toast, 'id'> & { id?: string }): string;
  dismissToast(id: string): void;
  clearToasts(): void;

  setResultDismissed(dismissed: boolean): void;
  setRevealShownFor(code: string | null): void;
  /** Back to a clean slate when leaving a room. */
  resetForNewRoom(): void;
}

let announcementSeq = 0;
let toastSeq = 0;

const INITIAL: UiState = {
  entry: 'home',
  prefilledCode: '',
  sheet: null,
  selectedSize: 'large',
  selectedColour: null,
  sizeChosenManually: false,
  textBoardOpen: false,
  polite: null,
  assertive: null,
  toasts: [],
  resultDismissed: false,
  revealShownFor: null,
};

/** Timers for auto-dismissing toasts, kept outside React. */
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useUi = create<UiStore>()((setState, getState) => ({
  ...INITIAL,

  setEntry: (entry) => setState({ entry }),
  setPrefilledCode: (prefilledCode) => setState({ prefilledCode }),

  openSheet: (sheet) => setState({ sheet }),
  closeSheet: () => setState({ sheet: null }),

  selectSize: (selectedSize, manual = true) =>
    setState((s) => ({
      selectedSize,
      sizeChosenManually: manual || s.sizeChosenManually,
    })),
  selectColour: (selectedColour) => setState({ selectedColour }),
  resetSizeChoice: () => setState({ sizeChosenManually: false, selectedColour: null }),
  setTextBoardOpen: (textBoardOpen) => setState({ textBoardOpen }),

  announce: (text, urgency = 'polite') => {
    if (!text) return;
    announcementSeq += 1;
    const message: Announcement = { id: announcementSeq, text };
    setState(urgency === 'assertive' ? { assertive: message } : { polite: message });
  },
  clearAnnouncements: () => setState({ polite: null, assertive: null }),

  toast: ({ id, key, timeout = 5000, ...rest }) => {
    toastSeq += 1;
    const toastId = id ?? `toast-${toastSeq}`;
    setState((s) => {
      // Replace rather than stack when a key is reused.
      const without = key ? s.toasts.filter((t) => t.key !== key) : s.toasts;
      if (key) {
        for (const t of s.toasts) {
          if (t.key === key) {
            const timer = toastTimers.get(t.id);
            if (timer) clearTimeout(timer);
            toastTimers.delete(t.id);
          }
        }
      }
      // Three is as many as fits above the thumb rail on a small phone.
      const next = [...without, { ...rest, key, timeout, id: toastId }].slice(-3);
      return { toasts: next };
    });
    if (timeout !== null) {
      const timer = setTimeout(() => getState().dismissToast(toastId), timeout);
      toastTimers.set(toastId, timer);
    }
    return toastId;
  },

  dismissToast: (id) => {
    const timer = toastTimers.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.delete(id);
    setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  clearToasts: () => {
    for (const timer of toastTimers.values()) clearTimeout(timer);
    toastTimers.clear();
    setState({ toasts: [] });
  },

  setResultDismissed: (resultDismissed) => setState({ resultDismissed }),
  setRevealShownFor: (revealShownFor) => setState({ revealShownFor }),

  resetForNewRoom: () => {
    for (const timer of toastTimers.values()) clearTimeout(timer);
    toastTimers.clear();
    setState({
      ...INITIAL,
      // Keep whatever the player was looking at before, and their pinned board.
      textBoardOpen: getState().textBoardOpen,
    });
  },
}));

/** Non-hook access, for event plumbing that runs outside React. */
export const ui = {
  announce: (text: string, urgency?: Urgency) => useUi.getState().announce(text, urgency),
  toast: (toast: Omit<Toast, 'id'> & { id?: string }) => useUi.getState().toast(toast),
};
