import { Component, Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { PIECE_SIZES, isLocalRoomCode } from '../../net/protocol';
import type { CellIndex, GameSnapshot, PieceSize, PlayerColor } from '../../net/protocol';
import {
  ARM_ANGLES,
  ARM_RADIUS,
  BOARD_TOP_Y,
  PLAY_SPACES,
  SOUTH,
  SPACE_PITCH,
  STORAGE_SPACES,
  slotTransform,
} from '../../scene/Board';
import type { SpacePointerInfo } from '../../scene/Board';
import type { Insets } from '../../scene/CameraRig';
import { AnimationDriver, useGameAnimations } from '../../scene/animation';
import type { AnimatableGame } from '../../scene/animation';
import { setSceneLayout } from '../../scene/animation/core/layout';
import { Piece, PieceField } from '../../scene/Piece';
import { getSceneTheme } from '../../styles/theme';
import { coloursOfSeat, interaction, placePiece, useNet, usePrefs, useUi } from '../../store';

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

/*
 * Tell the animation runner where the board actually is.
 *
 * Module scope rather than an effect: this writes a plain module-level object
 * with no DOM or GL dependency, and it has to be true before the first frame
 * rather than after the first commit.
 *
 * Every value here currently equals the runner's own default, so this is a
 * no-op today — which is exactly the point. The defaults are a second copy of
 * numbers that Board.tsx owns, and a copy that agrees today is a copy that
 * disagrees the first time the board changes. Sourcing them from the board
 * makes the agreement structural.
 *
 * `surfaceY` is the board's flat top, not `SEAT_Y` (where a piece's underside
 * rests inside its recess) — the two differ by ~0.05 world units. The runner's
 * own default is 0.26, which is `BOARD_TOP_Y`, so that is the reading its
 * author intended.
 */
setSceneLayout({
  spacePitch: SPACE_PITCH,
  surfaceY: BOARD_TOP_Y,
  armAngle: [...ARM_ANGLES] as [number, number, number, number],
  armRadius: ARM_RADIUS,
});

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
  const onOneDevice = useNet((s) => (s.room === null ? false : isLocalRoomCode(s.room.code)));
  // The resolved mode, mirrored from the theme owner. Not recomputed from the
  // preference plus a media query: that is a second implementation of
  // `system`, and the two can disagree for a frame after an OS flip.
  const theme = usePrefs((s) => s.mode);
  const armedSize = useUi((s) => s.selectedSize);
  // Changes only when a snapshot arrives, so the piece layer re-renders exactly
  // when the position actually changed.
  const game = useNet((s) => s.room?.game ?? null);

  useEffect(() => {
    setSupported(hasWebGL());
  }, []);

  if (!supported) return <BoardFallback reason="no-webgl" />;

  /*
   * The three.js half of the theme.
   *
   * `getSceneTheme(mode)` rather than the `useSceneTheme()` hook: we already
   * hold the resolved mode from the prefs mirror, so a second subscription to
   * the same source would only add a render. It is the same lookup and returns
   * a stable object per mode.
   */
  const scene = getSceneTheme(theme);

  return (
    <SceneBoundary>
      <Suspense fallback={<BoardLoading />}>
        <LazyScene
          /*
           * The board turns so this seat's arm is nearest the camera. This one
           * really is a SEAT, not a colour -- it is about where the local player
           * is sitting, not what they play. Narrowed inline because the protocol
           * types a seat as a bare `number` and the scene wants `0 | 1 | 2 | 3`;
           * spectators (null) get the north view.
           *
           * ON ONE DEVICE THE BOARD IS PINNED AND DOES NOT TURN.
           * ----------------------------------------------------
           * Arthur's decision (docs/UX.md, "Offline mode" 2). Note this is a
           * rotation being switched *off*, not one being added: `s.seat` is the
           * *active* seat in hot seat, so left alone this line snaps the board
           * 90 degrees on every handoff, instantly -- `Scene.tsx` applies
           * `rotation={[0, yaw, 0]}` straight from `boardYawForSeat` with no
           * interpolation, so `prefers-reduced-motion` would not catch it
           * either. Doing nothing here was never the neutral option.
           *
           * Online the rotation models "you walked round the table" -- the
           * phone moved relative to the board. Here the phone did not move, and
           * the pass itself already tells you whose turn it is. What it would
           * cost is the thing hot seat is uniquely good at: everyone watches
           * the same screen all game and builds a reading of the position while
           * waiting, and Otrio lines are read by orientation.
           *
           * `SOUTH`, not seat 0: `boardYawForSeat(SOUTH)` is exactly 0 (SOUTH
           * is 2), so this is the unrotated board and also `Scene`'s own
           * documented default, and no seat gets a privileged view of a device
           * nobody owns. Verified at both ends 2026-09-24.
           *
           * LOAD-BEARING BY ACCIDENT, so it is written down: the arm diagram in
           * `ColourReveal.tsx` draws colour 0 top, 1 right, 2 bottom, 3 left,
           * which describes the screen *only* because this pins to SOUTH.
           * Nobody designed that agreement. Pin anywhere else and that diagram
           * silently stops being true and nothing fails.
           */
          seat={
            onOneDevice ? SOUTH : seat === 0 || seat === 1 || seat === 2 || seat === 3 ? seat : 0
          }
          theme={theme}
          // What the HUD is covering, so the board is fitted into what is left
          // rather than centred behind the size picker. Measured in GameScreen.
          insets={insets}
          // Clear colour and fog straight from the token layer, so the canvas
          // edge cannot seam against the page background. Both presets already
          // mirror `sceneBg`, but passing it makes the match structural rather
          // than a standing agreement between two files.
          lighting={{ background: scene.background, fog: scene.fog }}
          /*
           * The four storage arms, in seat order [north, east, south, west] --
           * which is also `players` index order (0 purple/N, 1 red/E, 2 green/S,
           * 3 blue/W). Arm accents are off by default, which leaves an *empty*
           * arm with no colour identity at all; since the arms are how players
           * find their own side before a piece is placed, that loses the
           * information exactly when it matters most.
           *
           * `rim`, NOT `base` — `BoardProps.armColors` is explicit about this
           * and I had it wrong. The bar is inlaid in the slab, so its backdrop
           * is the board itself and it has no outline to fall back on, which is
           * the case the `rim` set exists to survive: it is the only player role
           * carrying a contrast guarantee against the board. `base` is an
           * identity fill and carries none, so passing it silently opted this
           * call site out of a guarantee that existed.
           *
           * Measured figures deliberately not repeated here — they belong to
           * the theming and board layers and would rot the first time either
           * changes a colour, leaving a confident wrong number in a file
           * nobody would think to check. `BoardProps.armColors` and
           * `PLAYER_ROLES` in tokens.ts hold the numbers and the guarantee.
           *
           * Written out rather than `.map`ped because the prop is a
           * fixed-length tuple and `map` returns `string[]`.
           */
          armColors={[
            scene.players[0].rim,
            scene.players[1].rim,
            scene.players[2].rim,
            scene.players[3].rim,
          ]}
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
          /*
           * The animation runner's frame hook. It has to be the *first* child
           * of the scene graph and has to keep `useFrame` priority 0 -- any
           * non-zero priority flips r3f into manual render mode and blanks the
           * canvas. `Scene` has a dedicated `frameDriver` slot precisely so
           * this lands first regardless of how the rest of the tree is built.
           */
          frameDriver={<AnimationDriver />}
        >
          {/*
           * Board-local, so pieces turn with the board. `worldChildren` is the
           * slot for things that must NOT turn.
           *
           * Until this existed, `BoardStage` passed no children at all -- which
           * meant `PieceField`, `Piece`, every material, every piece geometry
           * and the whole animation stack were dead code at runtime. The board
           * drew; no piece ever did.
           */}
          <BoardPieces game={game} />
        </LazyScene>
      </Suspense>
    </SceneBoundary>
  );
}

/* -------------------------------------------------------------------------- *
 * Pieces
 * -------------------------------------------------------------------------- */

/**
 * Every ring currently on the board, plus every ring still in storage.
 *
 * One `<PieceField>` wraps the lot: it batches into three instanced meshes (one
 * per size) and every `<Piece>` below it joins that batch wherever it sits in
 * the tree, so 36 rings cost three draw calls rather than 36.
 *
 * Keys are `cell-size` and `colour-slot-size` -- stable identities, so a piece
 * that stays put keeps its instance across re-renders and only genuinely new
 * pieces mount. That is what lets the animation layer attach to a piece's
 * arrival rather than seeing the whole field replaced on every snapshot.
 */
function BoardPieces({ game }: { game: GameSnapshot | null }) {
  useBoardAnimations(game);
  if (!game) return null;
  return (
    <PieceField pitch={SPACE_PITCH}>
      <PlayedPieces game={game} />
      <StoredPieces game={game} />
    </PieceField>
  );
}

/**
 * Drive the animation layer from the wire snapshot.
 *
 * `AnimatableGame` is a structural view type that exists precisely so this
 * mapping needs no fabrication: the client never has an engine `GameState` and
 * must not invent a `config` or a `history` to satisfy one. `board` is passed
 * straight through -- `CellState` already satisfies `AnimatableCell`.
 *
 * The hook must be called unconditionally, so it sits above the `!game` guard
 * and takes `null` while there is no game.
 */
function useBoardAnimations(game: GameSnapshot | null): void {
  const seat = useNet((s) => s.seat);
  const room = useNet((s) => s.room);

  // Colours, not the seat. A seat in the official 2-player game owns two
  // colours on *opposite* arms, so a seat index here would fly remote pieces in
  // from the wrong side of the board and dim the wrong tray.
  const localColours = useMemo(
    () => (seat === null ? [] : coloursOfSeat(room, seat)),
    [room, seat],
  );

  const view = useMemo<AnimatableGame | null>(() => {
    if (!game) return null;
    const line = game.winningLine;
    return {
      board: game.board,
      colorsInPlay: game.colorsInPlay,
      currentColor: game.turnColors[0] ?? game.colorsInPlay[0] ?? 0,
      currentSeat: game.turn,
      moveCount: game.moveCount,
      status: game.phase === 'playing' ? 'playing' : game.isDraw ? 'draw' : 'won',
      // An array because one placement can complete more than one Otrio.
      win: line
        ? [
            {
              kind:
                line.kind === 'ascending'
                  ? 'sequence'
                  : line.kind === 'concentric'
                    ? 'nested'
                    : 'same-size',
              cells: line.cells,
              sizes: line.sizes,
              color: line.color,
            },
          ]
        : null,
      skipped: game.skipped,
    };
  }, [game]);

  useGameAnimations({
    state: view ?? EMPTY_GAME_VIEW,
    localPlayers: localColours,
    enabled: view !== null,
  });
}

/** Stand-in while there is no game, so the hook is never called conditionally. */
const EMPTY_GAME_VIEW: AnimatableGame = {
  board: Array.from({ length: 9 }, () => ({ small: null, medium: null, large: null })),
  colorsInPlay: [],
  currentColor: 0,
  currentSeat: 0,
  moveCount: 0,
  status: 'playing',
  win: null,
};

/** The rings in the central 3x3. */
function PlayedPieces({ game }: { game: GameSnapshot }) {
  const out: ReactElement[] = [];
  for (let cell = 0; cell < PLAY_SPACES.length; cell += 1) {
    const state = game.board[cell];
    if (!state) continue;
    for (const size of PIECE_SIZES) {
      const colour = state[size];
      // `=== null` rather than a truthiness test: colour 0 is purple, and is
      // falsy. This is the single most common bug in this codebase.
      if (colour === null || colour === undefined) continue;
      out.push(
        <PlacedPiece key={`${cell}-${size}`} cell={cell as CellIndex} size={size} colour={colour} />,
      );
    }
  }
  return <>{out}</>;
}

function PlacedPiece({
  cell,
  size,
  colour,
}: {
  cell: CellIndex;
  size: PieceSize;
  colour: PlayerColor;
}) {
  const space = PLAY_SPACES[cell];
  if (!space) return null;
  return <Piece player={colour} size={size} position={slotTransform(space, size).position} />;
}

/**
 * The rings still on the arms.
 *
 * Not decoration. The board is cross-shaped precisely so each colour's unplayed
 * pieces sit in the open where everyone can count them (RULES.md §1.1, §9), and
 * in Otrio "can that colour still play a large?" decides most turns. The 2D
 * reserve trays say the same thing in words; this is the version you read
 * without looking away from the board.
 *
 * Layout follows the physical setup: each arm holds three nested sets of three,
 * and a colour's arm index is its own index -- purple north, red east, green
 * south, blue west, fixed by the rulebook artwork. Pieces deplete from the
 * outermost storage space inward, so the arm visibly empties as the game runs.
 */
function StoredPieces({ game }: { game: GameSnapshot }) {
  const out: ReactElement[] = [];
  // `colorsInPlay`, never `0..n`: a three-player game leaves one colour out and
  // its reserve reads {0,0,0}.
  for (const colour of game.colorsInPlay) {
    const reserve = game.reserves[colour];
    if (!reserve) continue;
    const spaces = STORAGE_SPACES.filter((s) => s.arm === colour).sort(
      (a, b) => (a.armSlot ?? 0) - (b.armSlot ?? 0),
    );
    for (const size of PIECE_SIZES) {
      for (let n = 0; n < reserve[size]; n += 1) {
        const space = spaces[n];
        if (!space) continue;
        out.push(
          <Piece
            key={`store-${colour}-${size}-${n}`}
            player={colour}
            size={size}
            position={slotTransform(space, size).position}
          />,
        );
      }
    }
  }
  return <>{out}</>;
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
