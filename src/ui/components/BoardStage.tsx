import { Component, Suspense, lazy, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SpacePointerInfo } from '../../scene/Board';
import type { Insets } from '../../scene/CameraRig';
import { interaction, placePiece, useNet, usePrefs, useUi } from '../../store';
import { useMediaQuery } from '../lib/a11y';
import { seatTokenIndex } from './Ring';
import { Button, Spinner } from './primitives';

/**
 * The frame around the 3D board.
 *
 * The canvas is the star, so this component's whole job is to hand the scene the
 * largest uninterrupted rectangle on the screen, tell it what the 2D layer is
 * covering, turn its clicks into moves, and then get out of the way.
 *
 * It also owns the two failure modes the scene should not have to:
 *
 *  1. **No WebGL.** Old phones, blocklisted drivers, hardware acceleration
 *     switched off in settings. Not hypothetical, and not a crash.
 *  2. **A scene that throws.** A lost context after a tab is backgrounded is an
 *     ordinary event on a phone.
 *
 * In both cases the game is still completely playable through the accessible
 * text board -- same state, same action -- so the fallback promotes that rather
 * than showing a dead screen.
 */

/*
 * A literal specifier, so Vite follows it: it emits the scene and three.js as a
 * real chunk and rewrites the path.
 *
 * This was briefly a variable specifier marked `@vite-ignore`, while `src/scene`
 * had no entry point to import. That is a trap worth naming, because the build
 * stays green while the app breaks: `@vite-ignore` tells the bundler not to
 * follow the import, so three.js is never bundled at all, the request 404s at
 * runtime, and the `catch` below quietly turns a completely broken 3D game into
 * a fallback board. A static import that fails loudly is recoverable; one the
 * bundler never saw is not.
 */
const LazyScene = lazy(() => import('../../scene/Scene'));

/** Cheap capability probe. Cached: creating contexts is not free. */
let webglSupported: boolean | null = null;
function hasWebGL(): boolean {
  if (webglSupported !== null) return webglSupported;
  try {
    const canvas = document.createElement('canvas');
    webglSupported = Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    webglSupported = false;
  }
  return webglSupported;
}

export function BoardStage({ insets }: { insets?: Partial<Insets> }) {
  const [supported, setSupported] = useState(true);

  const seat = useNet((s) => s.seat);
  const isMyTurn = useNet((s) => s.isMyTurn);
  const themePref = usePrefs((s) => s.theme);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const armedSize = useUi((s) => s.selectedSize);

  useEffect(() => {
    setSupported(hasWebGL());
  }, []);

  if (!supported) return <BoardFallback reason="no-webgl" />;

  const theme = themePref === 'system' ? (systemDark ? 'dark' : 'light') : themePref;

  return (
    <SceneBoundary>
      <Suspense fallback={<BoardLoading />}>
        <LazyScene
          // The board turns so this seat's arm is nearest the camera. Narrowed
          // because the protocol types a seat as a bare `number` while the scene
          // wants `0 | 1 | 2 | 3`; spectators (null) get the north view.
          seat={seatTokenIndex(seat) ?? 0}
          theme={theme}
          // What the HUD is covering, so the board is fitted into what is left
          // rather than centred behind the size picker. Measured in GameScreen.
          insets={insets}
          onSpaceClick={(info: SpacePointerInfo) => {
            // Storage spaces have a null index; only the 3x3 playing area is a
            // move. `info.slot` is documented as advisory, so the ring size
            // comes from the armed size in the HUD instead -- that is the
            // contract the size picker advertises, and a radial guess that
            // silently places the wrong ring is worse than a predictable one.
            const cell = info.space.index;
            if (cell === null) return;
            void placePiece(cell, armedSize);
          }}
          onSpacePointerOver={(info: SpacePointerInfo) => {
            const cell = info.space.index;
            if (cell === null) return;
            // Vanilla store: writing this does not schedule a React render.
            interaction.get().setHover({ cell, size: armedSize }, 'pointer');
          }}
          onSpacePointerOut={() => interaction.get().setHover(null)}
          // The board stays rotatable and inspectable out of turn; only picking
          // is switched off, so a stray tap cannot look like a refused move.
          interactive
          pickable={isMyTurn ? 'play' : 'none'}
        />
      </Suspense>
    </SceneBoundary>
  );
}

function BoardLoading() {
  return (
    <div className="o-stage__state" role="status">
      <Spinner />
      <p>Setting up the board…</p>
    </div>
  );
}

/**
 * What to show when the board cannot draw.
 *
 * Note what this does *not* say: nothing about errors, nothing red, no stack
 * trace. The game is still fully playable, so the message says so and offers
 * the one button that might help.
 */
function BoardFallback({ reason }: { reason: 'no-webgl' | 'crashed' }) {
  const setTextBoardOpen = useUi((s) => s.setTextBoardOpen);
  const setPref = usePrefs((s) => s.set);

  useEffect(() => {
    // Promote the accessible board automatically: without the canvas it is the
    // only way to see the position, so it should not need to be found.
    setTextBoardOpen(true);
    setPref('showTextBoard', true);
  }, [setTextBoardOpen, setPref]);

  return (
    <div className="o-stage__state o-stage__state--fallback" role="status">
      <h2 className="o-stage__stateTitle">
        {reason === 'no-webgl' ? 'This device can’t draw the 3D board' : 'The 3D board stopped'}
      </h2>
      <p>
        {reason === 'no-webgl'
          ? '3D graphics are unavailable here — often because hardware acceleration is switched off in the browser settings.'
          : 'Something went wrong with the graphics. Your game is fine and nothing has been lost.'}
      </p>
      <p>The flat board below shows the same position and plays the same game, so you can carry on.</p>
      {reason === 'crashed' ? (
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      ) : null}
    </div>
  );
}

interface BoundaryState {
  failed: boolean;
}

/**
 * Keeps a scene failure inside the canvas frame.
 *
 * Without this, one bad draw call unmounts the whole app -- including the HUD
 * that would have told the player their game is still running, and the text
 * board they could have kept playing on. A chunk that fails to load lands here
 * too, which is exactly the signal `@vite-ignore` used to swallow.
 */
class SceneBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error('[otrio] the 3D board failed to render', error);
  }

  override render() {
    if (this.state.failed) return <BoardFallback reason="crashed" />;
    return this.props.children;
  }
}
