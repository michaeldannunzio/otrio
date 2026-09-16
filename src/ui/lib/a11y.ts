import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Focus-management primitives.
 *
 * The 3D board is the part of this app that cannot be made accessible in place
 * -- a WebGL canvas has no DOM and therefore no roles, names or focus order.
 * `src/ui/hud/TextBoard.tsx` answers that with a parallel control surface.
 * Everything in the 2D layer, though, is expected to be fully operable from a
 * keyboard and legible to a screen reader, and these hooks are what make that
 * cheap enough to do consistently rather than occasionally.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

export function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // offsetParent is null for display:none; also covers visibility:hidden
    // ancestors well enough for our purposes and is cheap.
    return el.offsetParent !== null || el === document.activeElement;
  });
}

export interface FocusTrapOptions {
  active: boolean;
  /** Called on Escape. Omit to let Escape through. */
  onEscape?: () => void;
  /** Focus this on activation instead of the first focusable child. */
  initialFocus?: RefObject<HTMLElement>;
  /** Restore focus to whatever had it before the trap opened. Default true. */
  returnFocus?: boolean;
}

/**
 * Traps Tab inside `containerRef` while `active`. Used by every dialog and by
 * the game-over overlay: on a phone with a Bluetooth keyboard, or on a laptop,
 * tabbing out of a modal into the 3D canvas behind it is genuinely disorienting
 * because the canvas gives no visible focus feedback.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement>,
  { active, onEscape, initialFocus, returnFocus = true }: FocusTrapOptions,
): void {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;

    const node = containerRef.current;
    // Defer a frame: on mount the children may not be laid out yet, and
    // offsetParent checks would reject them.
    const raf = requestAnimationFrame(() => {
      const target =
        initialFocus?.current ?? getFocusable(containerRef.current)[0] ?? containerRef.current;
      target?.focus({ preventScroll: true });
    });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && onEscape) {
        event.stopPropagation();
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = getFocusable(containerRef.current);
      if (items.length === 0) {
        event.preventDefault();
        containerRef.current?.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (activeEl === first || !node?.contains(activeEl)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (activeEl === last || !node?.contains(activeEl)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      if (returnFocus) {
        const back = restoreRef.current;
        if (back && document.contains(back)) back.focus({ preventScroll: true });
      }
    };
    // containerRef/initialFocus are stable refs; onEscape is read fresh each run.
  }, [active, containerRef, initialFocus, onEscape, returnFocus]);
}

/**
 * Moves focus to a screen's heading whenever the screen changes. Without this a
 * single-page app leaves focus on the button that navigated -- which no longer
 * exists -- and the screen reader's reading position silently resets to the top
 * of the document.
 *
 * The target should be a heading with tabIndex={-1}.
 */
export function useScreenFocus(
  ref: RefObject<HTMLElement>,
  screenKey: string | number,
): void {
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      ref.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [ref, screenKey]);
}

/** Matches a media query reactively without paying for a resize listener storm. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Honour the OS "reduce motion" switch. Consumed by every transition we run. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
