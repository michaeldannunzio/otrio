/**
 * Durable, device-local preferences.
 *
 * Persisted under `otrio.prefs.v1`. The theme half of this is read by an inline
 * script in `index.html` *before React boots*, so the first paint is already the
 * right colour -- if you rename the key, the partialised shape, or the
 * `data-theme` attribute, change it there too.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { sanitizeName } from '../net/protocol';
import { applyThemeAttributes } from '../styles/theme';

export const PREFS_STORAGE_KEY = 'otrio.prefs.v1';

export type ThemePref = 'system' | 'light' | 'dark';
export type MotionPref = 'system' | 'reduced';

export interface Prefs {
  /** Display name. Sanitised on write with the same rules the referee applies. */
  name: string;
  theme: ThemePref;
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
  theme: 'system',
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
      setTheme: (theme) => {
        setState({ theme });
        applyTheme(theme);
      },
      setMotion: (motion) => setState({ motion }),
      toggle: (key) => setState((s) => ({ [key]: !s[key] }) as Partial<PrefsStore>),
      set: (key, value) => setState({ [key]: value } as Partial<PrefsStore>),
    }),
    {
      name: PREFS_STORAGE_KEY,
      // Only persist the data, never the action functions.
      partialize: (s): Prefs => ({
        name: s.name,
        theme: s.theme,
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
        applyTheme(state.theme);
      },
    },
  ),
);

/**
 * Resolve the preference and hand it to the styles layer.
 *
 * `applyThemeAttributes` (src/styles/theme.ts) is the only thing that writes
 * `data-theme`: it also sets `color-scheme`, which is what makes form controls,
 * scrollbars and the browser's own UI follow the theme, and it updates the
 * `theme-color` meta tag so a phone's status bar matches. Duplicating any of
 * that here would give us two writers racing over one attribute.
 *
 * What this adds is `data-theme-pref`, which keeps the *unresolved* choice so
 * the settings UI can show which of the three options is selected -- `system`
 * is not recoverable from `data-theme` alone.
 */
export function applyTheme(theme: ThemePref): void {
  if (typeof document === 'undefined') return;
  const resolved: 'light' | 'dark' =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  applyThemeAttributes(resolved);
  document.documentElement.setAttribute('data-theme-pref', theme);
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

/**
 * Keep `data-theme` in sync while the preference is `system` and the OS flips
 * (sunset, focus mode, someone toggling it mid-game). Call once at boot;
 * returns an unsubscribe.
 */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (usePrefs.getState().theme === 'system') applyTheme('system');
  };
  mql.addEventListener('change', onChange);
  applyTheme(usePrefs.getState().theme);
  return () => mql.removeEventListener('change', onChange);
}
