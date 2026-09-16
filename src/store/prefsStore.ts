/**
 * Durable, device-local preferences.
 *
 * Persisted under `otrio.prefs.v1` -- *except the theme*, which this store only
 * mirrors.
 *
 * ## Theme is owned by `src/hooks/useTheme.ts`
 *
 * It persists under `THEME_STORAGE_KEY` as a bare string, and that matters for
 * one specific reason: the pre-paint script in `index.html` is the most
 * failure-sensitive code in the app -- it runs before any module, cannot
 * import, and must never throw. Reading a flat string is one `getItem` and one
 * comparison. Reading it out of this store's persisted bundle would couple
 * first paint to a zustand schema version *and* a partialise shape, so renaming
 * a field here would give dark-mode users a flash of white with nothing
 * failing loudly.
 *
 * So: `theme` below is a read-only mirror kept in step by `subscribeToTheme`,
 * and `setTheme` delegates. We subscribe rather than only write because the
 * preference also changes for reasons this store never sees -- the OS flipping
 * while on `system`, and another tab of the same game.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { sanitizeName } from '../net/protocol';
import {
  getThemeSnapshot,
  setThemePreference,
  subscribeToTheme,
} from '../hooks/useTheme';
import type { ThemeMode, ThemePreference } from '../hooks/useTheme';

export const PREFS_STORAGE_KEY = 'otrio.prefs.v1';

/** Re-exported so callers do not have to know where theme lives. */
export type ThemePref = ThemePreference;
export type MotionPref = 'system' | 'reduced';

export interface Prefs {
  /** Display name. Sanitised on write with the same rules the referee applies. */
  name: string;
  /**
   * Mirror of the theme preference. **Not persisted here** -- `useTheme.ts`
   * owns it. Writing this field directly does nothing; call `setTheme`.
   */
  theme: ThemePref;
  /** The resolved mode actually showing. Mirror; derived from `theme` + the OS. */
  mode: ThemeMode;
  /**
   * `system` honours `prefers-reduced-motion`. `reduced` forces the calm path
   * even on a device that has not opted in -- useful when the 3D board is
   * making someone queasy but they do not want to change an OS setting.
   */
  motion: MotionPref;
  sound: boolean;
  haptics: boolean;
  /**
   * Draw a size letter (S/M/L) on every ring and reserve pip, so the board is
   * readable without relying on ring diameter alone. Helps at small sizes, at
   * an angle across a table, and for low-vision players.
   */
  sizeLabels: boolean;
  /**
   * Keep the accessible text board permanently visible instead of revealing it
   * on focus. Some players just prefer it; some need it.
   */
  showTextBoard: boolean;
}

export interface PrefsStore extends Prefs {
  setName(name: string): void;
  setTheme(theme: ThemePref): void;
  setMotion(motion: MotionPref): void;
  toggle(key: 'sound' | 'haptics' | 'sizeLabels' | 'showTextBoard'): void;
  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void;
}

const DEFAULTS: Prefs = {
  name: '',
  // Seeded from the owner at module load, not guessed.
  theme: getThemeSnapshot().preference,
  mode: getThemeSnapshot().mode,
  motion: 'system',
  sound: true,
  haptics: true,
  sizeLabels: false,
  showTextBoard: false,
};

export const usePrefs = create<PrefsStore>()(
  persist(
    (setState) => ({
      ...DEFAULTS,

      setName: (name) => setState({ name: sanitizeName(name, '') }),
      // Delegate. The subscription below mirrors the result back, so we do not
      // setState here -- that would briefly show a value the owner might
      // normalise differently.
      setTheme: (theme) => setThemePreference(theme),
      setMotion: (motion) => setState({ motion }),
      toggle: (key) => setState((s) => ({ [key]: !s[key] }) as Partial<PrefsStore>),
      set: (key, value) => setState({ [key]: value } as Partial<PrefsStore>),
    }),
    {
      name: PREFS_STORAGE_KEY,
      // Only persist the data, never the action functions.
      // `theme` and `mode` are deliberately absent: they are mirrors of state
      // this store does not own, and persisting them would create a second
      // copy that goes stale the moment another tab changes the theme.
      partialize: (s): Omit<Prefs, 'theme' | 'mode'> => ({
        name: s.name,
        motion: s.motion,
        sound: s.sound,
        haptics: s.haptics,
        sizeLabels: s.sizeLabels,
        showTextBoard: s.showTextBoard,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // First run on this device: give them a name rather than an empty field.
        if (!state.name) state.name = suggestName();
        // Rehydration overwrites the seeded mirror with whatever was persisted
        // (nothing, now), so re-seed it from the owner.
        const snapshot = getThemeSnapshot();
        state.theme = snapshot.preference;
        state.mode = snapshot.mode;
      },
    },
  ),
);

/**
 * Keep the mirror in step with the owner.
 *
 * Called once at boot. `subscribeToTheme` fires for every cause -- an explicit
 * `setTheme`, the OS flipping while the preference is `system`, and another tab
 * changing it -- which is exactly why a mirroring store has to subscribe
 * instead of only writing. Without this, two tabs of the same game drift apart
 * and neither is wrong enough to notice.
 *
 * Returns an unsubscribe. It is not called on subscribe, so we seed once first.
 */
export function watchTheme(): () => void {
  const seed = getThemeSnapshot();
  usePrefs.setState({ theme: seed.preference, mode: seed.mode });
  return subscribeToTheme(({ preference, mode }) => {
    usePrefs.setState({ theme: preference, mode });
  });
}

/**
 * A first-run display name. Deliberately not "Player 1": around a table, four
 * identical placeholders are worse than four silly ones, because you cannot
 * tell whose phone dropped.
 */
const SUGGESTED_NAMES = [
  'Otter', 'Magpie', 'Badger', 'Heron', 'Fennec',
  'Marten', 'Ibis', 'Lynx', 'Puffin', 'Shrike',
];

export function suggestName(): string {
  return SUGGESTED_NAMES[Math.floor(Math.random() * SUGGESTED_NAMES.length)];
}
