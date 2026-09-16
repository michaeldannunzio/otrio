import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { useNet, usePrefs, useUi } from '../../store';
import type { Insets } from '../../scene/CameraRig';
import { useMediaQuery, useScreenFocus } from '../lib/a11y';
import { IconButton } from '../components/primitives';
import { BoardStage } from '../components/BoardStage';
import { TurnBanner } from '../hud/TurnBanner';
import { PlayerRail } from '../hud/PlayerRail';
import { SizePicker } from '../hud/SizePicker';
import { TextBoard } from '../hud/TextBoard';
import { ResultOverlay } from './ResultOverlay';

/**
 * The playing screen, built on the shell in `src/styles/layout.css`.
 *
 * That shell inverts the obvious arrangement, and the inversion is the good
 * part: the canvas is `position: fixed` and full-bleed *underneath* everything,
 * and the interface is a `pointer-events: none` grid floating on top of it.
 * The board therefore always occupies the entire display -- the HUD costs it
 * nothing -- and the gaps between HUD elements are draggable board, so rotating
 * the camera does not require hunting for a clear patch.
 *
 * What goes where, and why:
 *   - `.app-hud-top`    whose turn it is, plus the menu. One glanceable line.
 *   - `.app-hud-bottom` the player rail and the size picker: everything you
 *     need to take a turn, in the bottom third, where a thumb reaches.
 *   - `.app-panel-start` from 1024px the rail moves into a docked column and
 *     the board is offset rather than covered.
 *
 * Phone landscape is handled entirely by the shell: below 500px tall the
 * top/bottom overlays become left/right rails, because on a sideways phone
 * height is the scarce axis, not width.
 *
 * Nothing here runs per frame. The only thing that ticks is the turn clock,
 * which writes to its own DOM node without going through React.
 */
export function GameScreen() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const openSheet = useUi((s) => s.openSheet);
  const roomCode = useNet((s) => s.room?.code ?? '');
  const phase = useNet((s) => s.room?.phase ?? 'playing');

  // Matches the breakpoint at which layout.css docks `.app-panel-start`, so the
  // rail is rendered in exactly one place and never in both.
  const panelDocked = useMediaQuery('(min-width: 1024px)');

  // The accessible board docks to the bottom edge when it is pinned open, so
  // the shell has to give up that space rather than let the two overlap.
  const textBoardPinned = usePrefs((s) => s.showTextBoard);
  const textBoardOpen = useUi((s) => s.textBoardOpen);

  useScreenFocus(headingRef, 'game');

  // How much of the canvas the interface is sitting on top of. The scene fits
  // the board into what is left, so the board is never centred behind the size
  // picker. Measured rather than guessed: the HUD's height depends on the
  // breakpoint, the safe-area insets, how many players there are and whether
  // the flat board is pinned open.
  const insets = useHudInsets(topRef, bottomRef, panelRef);

  return (
    <div
      className="o-game"
      data-phase={phase}
      data-textboard={textBoardPinned || textBoardOpen ? 'open' : 'closed'}
    >
      <h1 className="u-visually-hidden" ref={headingRef} tabIndex={-1}>
        Otrio — game in progress, room {roomCode}
      </h1>

      {/* Full-bleed, fixed, behind everything. */}
      <div className="app-canvas">
        <BoardStage insets={insets} />
      </div>

      <div className="app-shell">
        {panelDocked ? (
          <aside className="app-panel-start o-panel" aria-label="Players" ref={panelRef}>
            <PlayerRail />
          </aside>
        ) : null}

        <main className="app-stage">
          <div className="app-hud-top" ref={topRef}>
            <TurnBanner />
            <IconButton
              label="Game menu"
              className="o-game__menu"
              onClick={() => openSheet('settings')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="o-icon">
                <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
                <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
              </svg>
            </IconButton>
          </div>

          <div className="app-hud-bottom o-game__bottom" ref={bottomRef}>
            {!panelDocked ? <PlayerRail /> : null}
            <SizePicker />
          </div>
        </main>
      </div>

      {/*
        Always in the DOM and always in the tab order, revealed on focus. This is
        the keyboard and screen-reader route to the same game; see TextBoard.tsx.
      */}
      <TextBoard />

      <ResultOverlay />
    </div>
  );
}

/**
 * Measure what the HUD covers, in CSS pixels, for `SceneProps.insets`.
 *
 * A `ResizeObserver` rather than a resize listener, because most of what
 * changes here is not the window: a fourth player joining makes the rail
 * taller, pinning the flat board takes a strip off the bottom, and an on-screen
 * keyboard lifts the whole bottom bar.
 *
 * Values are rounded and compared before being committed to state, so
 * sub-pixel jitter during an animation cannot loop the scene through a
 * re-fit on every frame.
 */
function useHudInsets(
  topRef: RefObject<HTMLElement>,
  bottomRef: RefObject<HTMLElement>,
  panelRef: RefObject<HTMLElement>,
): Insets {
  const [insets, setInsets] = useState<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });

  const measure = useCallback(() => {
    const next: Insets = {
      top: Math.round(topRef.current?.getBoundingClientRect().height ?? 0),
      bottom: Math.round(bottomRef.current?.getBoundingClientRect().height ?? 0),
      left: Math.round(panelRef.current?.getBoundingClientRect().width ?? 0),
      right: 0,
    };
    setInsets((prev) =>
      prev.top === next.top &&
      prev.bottom === next.bottom &&
      prev.left === next.left &&
      prev.right === next.right
        ? prev
        : next,
    );
  }, [topRef, bottomRef, panelRef]);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    for (const ref of [topRef, bottomRef, panelRef]) {
      if (ref.current) observer.observe(ref.current);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, topRef, bottomRef, panelRef]);

  return insets;
}
