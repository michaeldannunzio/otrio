/**
 * Scene.tsx — the react-three-fiber canvas root.
 *
 * ============================================================================
 * FOR EVERY OTHER AGENT: THE THREE THINGS YOU NEED FROM THIS FILE
 * ============================================================================
 *
 * 1. WHERE YOUR PIECES GO.
 *
 *    `<Scene>{children}</Scene>` renders children inside the board frame — the
 *    group that carries the per-seat yaw. So you place pieces in BOARD-LOCAL
 *    coordinates and never think about which player is looking:
 *
 *        import { slotTransform, playSpace } from './Board';
 *        const { position } = slotTransform(playSpace(1, 1), 'large');
 *        <Piece position={position} ... />
 *
 *    Board.tsx is the geometry authority. `SLOTS`, `PIECE_HEIGHT` and `SEAT_Y`
 *    are the contract for piece dimensions; `slotTransform` is the contract for
 *    placement. A piece's local origin is the centre of its bottom face, and it
 *    should span y = 0 .. PIECE_HEIGHT.
 *
 *    Use `worldChildren` instead for anything that must NOT rotate with the
 *    board (a screen-anchored 3D affordance, for instance).
 *
 * 2. THE RENDER-ON-DEMAND CONTRACT. THIS ONE MATTERS.
 *
 *    The scene runs `frameloop="demand"` by default. Nothing renders unless
 *    somebody asks. Four phones sitting on a finished position draw zero
 *    frames, and that is the difference between a game you can play for an
 *    evening and one that empties a battery in ten minutes.
 *
 *    The cost is that `useFrame` does not tick on its own. If you animate:
 *
 *      (a) Preferred — drive it and keep asking for frames:
 *
 *            const invalidate = useInvalidate();
 *            useFrame(() => { ...advance...; if (stillMoving) invalidate(); });
 *
 *          Call invalidate() once to start it, and once per frame while it
 *          runs. It self-terminates. CameraRig.tsx does exactly this for its
 *          intro and parallax; copy that shape.
 *
 *          The animation module already does this — `animation/AnimationDriver`
 *          owns the only useFrame in that system and pumps invalidate() itself.
 *          Mount it through the `frameDriver` prop so it lands first:
 *
 *            <Scene frameDriver={<AnimationDriver />} ... />
 *
 *      (b) If some other animation system cannot cooperate, flip the whole
 *          scene to continuous while it runs:
 *
 *            <Scene animating={store.isAnimating} />
 *
 *          That is a one-line escape hatch, and it is honest: continuous only
 *          while something is actually moving.
 *
 *      (c) `<Scene frameloop="always" />` opts out globally. Please do not.
 *
 *    Pointer events work normally under demand. Board.tsx invalidates on every
 *    pointer callback it fires, so hover highlights update without any help.
 *
 * 3. THEMING.
 *
 *    No file in this directory reads theme state. Pass `theme="light" |
 *    "dark"`; every individual lighting value can be overridden through
 *    `lighting={...}`. `LIGHTING_PRESETS` (Lighting.tsx) exports the colours we
 *    chose, including `background`, which the CSS around the canvas usually
 *    wants to match.
 *
 * ============================================================================
 * PERFORMANCE BUDGET
 * ============================================================================
 *
 * Target: four mid-range phones, 60 fps while a piece is in motion, 0 fps and
 * 0 GPU work when idle.
 *
 *   Draw calls (this module's contribution)      4
 *     table cloth, board slab, all 21 machined targets (merged into a single
 *     mesh), playing-area outline. Arm colour bars add 4 when enabled. The 21
 *     pointer targets add ZERO — their material is `visible: false`, so the
 *     renderer skips them entirely while the raycaster still sees them.
 *   Triangles                                    32k low tier / 50k high tier,
 *                                                all static, no skinning; the
 *                                                machined recesses are ~95% of
 *                                                it and are one buffer
 *   Buffer memory                                1.7 MB low / 2.6 MB high
 *   Shadow casters                               1 mesh (the slab) + pieces
 *   Shadow-mapped lights                         1
 *   Texture memory                               3 surfaces x 3 maps, 512px on
 *                                                the low tier (textures.ts)
 *   Post-processing                              none
 *   Environment map                              baked once, ~5ms, no network
 *
 * The two levers that actually decide phone battery life are the frame loop
 * (above) and the device pixel ratio. We cap DPR at 1.4 on coarse-pointer
 * devices rather than the usual 2, and spend the savings on MSAA instead:
 * shading cost goes as dpr squared, so 1.4 + antialias costs about half of 2.0
 * without antialias, and looks better on this scene specifically because it is
 * full of thin concentric rings and long straight chamfers — exactly the
 * content MSAA handles well and supersampling handles expensively.
 *
 * There is deliberately no <PerformanceMonitor>. It measures frame deltas, and
 * under frameloop="demand" the deltas are meaningless (seconds long when idle),
 * so it would conclude the device is on fire and drop to minimum quality on a
 * perfectly healthy phone.
 */

import * as React from 'react';
import * as THREE from 'three';
import { Canvas, useThree, type RootState } from '@react-three/fiber';
import {
  Board,
  BOARD_BOUNDS,
  boardYawForSeat,
  SOUTH,
  type BoardProps,
  type Seat,
  type SpacePointerInfo,
} from './Board';
import { CameraRig, type CameraRigProps, type Framing, type Insets } from './CameraRig';
import { Lighting, type LightingProps, type ThemeMode } from './Lighting';
import { Table, type TableProps } from './Table';
import { configureTextures, useTextureLoadState } from './textures';

export type { Seat, SpacePointerInfo, ThemeMode, Framing, Insets };

/* ========================================================================== *
 * Quality
 * ========================================================================== */

export type QualityTier = 'high' | 'low';

interface QualitySettings {
  maxDpr: number;
  shadowMapSize: number;
  /** Radial subdivision of each machined target. */
  radialSegments: number;
  maxAnisotropy: number;
}

const QUALITY: Record<QualityTier, QualitySettings> = {
  high: { maxDpr: 2, shadowMapSize: 1024, radialSegments: 64, maxAnisotropy: 8 },
  low: { maxDpr: 1.4, shadowMapSize: 512, radialSegments: 40, maxAnisotropy: 4 },
};

/**
 * Coarse pointer, few cores or little memory all point the same way. This runs
 * once, before the canvas exists — it is a starting tier, not a live monitor.
 */
function detectQuality(): QualityTier {
  if (typeof window === 'undefined') return 'high';
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const fewCores = (nav.hardwareConcurrency ?? 8) <= 4;
  const lowMemory = (nav.deviceMemory ?? 8) <= 4;
  return coarse || fewCores || lowMemory ? 'low' : 'high';
}

/* ========================================================================== *
 * Context
 * ========================================================================== */

export interface BoardFrame {
  /** The seat whose arm is nearest the camera. */
  seat: Seat;
  /** Yaw applied to the board group, radians. */
  yaw: number;
  quality: QualityTier;
}

const BoardFrameContext = React.createContext<BoardFrame>({
  seat: SOUTH,
  yaw: 0,
  quality: 'high',
});

/** Which way the board is turned, for anything that needs to counter-rotate (labels, say). */
export function useBoardFrame(): BoardFrame {
  return React.useContext(BoardFrameContext);
}

/**
 * The render-on-demand handle. Call the returned function whenever you change
 * something that should be visible. Safe to call as often as you like — it
 * coalesces into a single frame.
 */
export function useInvalidate(): () => void {
  return useThree((s) => s.invalidate);
}

/* ========================================================================== *
 * Props
 * ========================================================================== */

export interface SceneProps {
  /**
   * Which seat the local player occupies. The BOARD turns so this arm is
   * nearest the camera; the camera and every light stay fixed, so all four
   * players see identical framing and identical lighting. See CameraRig.tsx.
   *
   * Seats are compass positions and the colours are fixed by RULES.md §2.4:
   * 0 = north/purple, 1 = east/red, 2 = south/green, 3 = west/blue.
   */
  seat?: Seat;

  theme?: ThemeMode;

  /**
   * CSS pixels of the canvas that UI covers. The board is fitted and centred in
   * what is left rather than in the whole canvas. If you put a rack across the
   * bottom, tell the rig about it.
   */
  insets?: Partial<Insets>;

  /** >1 pushes in past the storage arms. Animate it for a "focus on play" mode. */
  zoom?: number;

  /**
   * What the camera frames. 'auto' (default) keeps the whole cross while a
   * playing space stays at least 72 CSS px across, and drops to the 3x3 playing
   * area below that — which is every phone in portrait, and nothing else.
   *
   * It clips horizontally only, so every player keeps their own arm and their
   * opposite's in full; the two side arms show their inner edge. The 2D rail
   * carries every reserve count legibly anyway, so the arms are scenery here
   * rather than a readout. CameraRig.tsx has the full argument and the numbers.
   *
   * ENABLED ON MEASUREMENT, NOT OBSERVATION — nobody had seen this render on a
   * phone when it was turned on. If a real frame disagrees, the frame wins:
   * `framing="board"` restores the previous behaviour in one prop.
   *
   * `onFraming` reports the distance and `pxPerUnit` actually chosen.
   */
  framing?: 'board' | 'play' | 'auto';

  /** Force continuous rendering while something is moving. See the header. */
  animating?: boolean;
  /** Global override. 'demand' is the default and you should leave it alone. */
  frameloop?: 'always' | 'demand';

  quality?: QualityTier | 'auto';
  shadows?: boolean;

  /** Per-arm colours, in seat order [north, east, south, west]. Off when omitted. */
  armColors?: readonly [string, string, string, string] | null;

  interactive?: boolean;
  pickable?: BoardProps['pickable'];
  onSpaceClick?: (info: SpacePointerInfo) => void;
  onSpacePointerDown?: (info: SpacePointerInfo) => void;
  onSpacePointerUp?: (info: SpacePointerInfo) => void;
  onSpacePointerMove?: (info: SpacePointerInfo) => void;
  onSpacePointerOver?: (info: SpacePointerInfo) => void;
  onSpacePointerOut?: BoardProps['onSpacePointerOut'];

  /** Escape hatches. Anything here overrides what Scene computed. */
  lighting?: Partial<LightingProps>;
  camera?: Partial<CameraRigProps>;
  board?: Partial<BoardProps>;
  table?: Partial<TableProps>;

  /**
   * Mounted as the very first child of the canvas, before any light, camera or
   * geometry. This is where `<AnimationDriver />` goes: it documents that it
   * must be the first child so that its priority-0 useFrame subscribes before
   * anything that might read the transforms it writes.
   *
   *     <Scene frameDriver={<AnimationDriver />} ... />
   */
  frameDriver?: React.ReactNode;

  /** Pieces and anything else in board-local space. */
  children?: React.ReactNode;
  /** Anything that must NOT turn with the board. */
  worldChildren?: React.ReactNode;

  onFraming?: (framing: Framing) => void;
  onCreated?: (state: RootState) => void;

  className?: string;
  style?: React.CSSProperties;
}

/* ========================================================================== *
 * Inside the canvas
 * ========================================================================== */

function TextureSetup({ maxAnisotropy }: { maxAnisotropy: number }) {
  const gl = useThree((s) => s.gl);
  React.useEffect(() => {
    configureTextures({
      maxAnisotropy: Math.min(gl.capabilities.getMaxAnisotropy(), maxAnisotropy),
    });
  }, [gl, maxAnisotropy]);
  return null;
}

/**
 * textures.ts loads asynchronously and swaps maps in as they arrive without
 * suspending. Under frameloop="demand" nobody would ever see them, so we watch
 * the load state and ask for a frame each time it moves.
 */
function RepaintOnTextureLoad() {
  const invalidate = useThree((s) => s.invalidate);
  const state = useTextureLoadState();
  React.useEffect(() => {
    invalidate();
  }, [invalidate, state.loaded, state.total, state.status]);
  return null;
}

interface SceneContentsProps
  extends Omit<
    SceneProps,
    'seat' | 'theme' | 'zoom' | 'framing' | 'quality' | 'shadows' | 'frameloop' | 'animating' | 'className' | 'style' | 'onCreated'
  > {
  seat: Seat;
  theme: ThemeMode;
  zoom: number;
  framing: 'board' | 'play' | 'auto';
  quality: QualityTier;
  shadows: boolean;
}

function SceneContents({
  seat,
  theme,
  insets,
  zoom,
  framing,
  quality: tier,
  shadows,
  armColors,
  interactive,
  pickable,
  onSpaceClick,
  onSpacePointerDown,
  onSpacePointerUp,
  onSpacePointerMove,
  onSpacePointerOver,
  onSpacePointerOut,
  lighting,
  camera,
  board,
  table,
  frameDriver,
  children,
  worldChildren,
  onFraming,
}: SceneContentsProps) {
  const settings = QUALITY[tier];
  const yaw = boardYawForSeat(seat);

  const frame = React.useMemo<BoardFrame>(() => ({ seat, yaw, quality: tier }), [seat, yaw, tier]);

  return (
    <BoardFrameContext.Provider value={frame}>
      {/* First, before any useFrame of ours. See SceneProps.frameDriver. */}
      {frameDriver}

      <TextureSetup maxAnisotropy={settings.maxAnisotropy} />
      <RepaintOnTextureLoad />

      <Lighting
        theme={theme}
        shadows={shadows}
        shadowMapSize={settings.shadowMapSize}
        {...lighting}
      />

      <CameraRig
        insets={insets}
        zoom={zoom}
        framing={framing}
        center={BOARD_BOUNDS.center}
        halfExtents={BOARD_BOUNDS.halfExtents}
        onFraming={onFraming}
        {...camera}
      />

      <Table theme={theme} {...table} />

      {/*
        The board frame. Everything in here turns together so that the local
        player's arm is nearest the camera; lights and camera stay put, so the
        image is identical for all four seats. Piece positions from
        Board.tsx's helpers are already in this space — place them raw.
      */}
      <group name="board-frame" rotation={[0, yaw, 0]}>
        <Board
          radialSegments={settings.radialSegments}
          theme={theme}
          armColors={armColors}
          interactive={interactive}
          pickable={pickable}
          onSpaceClick={onSpaceClick}
          onSpacePointerDown={onSpacePointerDown}
          onSpacePointerUp={onSpacePointerUp}
          onSpacePointerMove={onSpacePointerMove}
          onSpacePointerOver={onSpacePointerOver}
          onSpacePointerOut={onSpacePointerOut}
          {...board}
        />
        {children}
      </group>

      {worldChildren}
    </BoardFrameContext.Provider>
  );
}

/* ========================================================================== *
 * Root
 * ========================================================================== */

export function Scene({
  seat = SOUTH,
  theme = 'light',
  insets,
  zoom = 1,
  framing = 'auto',
  animating = false,
  frameloop,
  quality = 'auto',
  shadows = true,
  armColors = null,
  interactive = true,
  pickable = 'play',
  onSpaceClick,
  onSpacePointerDown,
  onSpacePointerUp,
  onSpacePointerMove,
  onSpacePointerOver,
  onSpacePointerOut,
  lighting,
  camera,
  board,
  table,
  frameDriver,
  children,
  worldChildren,
  onFraming,
  onCreated,
  className,
  style,
}: SceneProps) {
  const tier = React.useMemo<QualityTier>(
    () => (quality === 'auto' ? detectQuality() : quality),
    [quality],
  );
  const settings = QUALITY[tier];

  // The WebGL context's alpha flag is fixed at creation, so a transparent
  // canvas has to be asked for up front. Reading it once on mount is
  // deliberate: flipping `lighting.background` between null and a colour later
  // changes the clear colour but cannot change the context.
  const wantsAlpha = React.useRef(lighting?.background === null).current;

  // `animating` wins: it is the dynamic signal, `frameloop` is the static
  // default. Setting frameloop="demand" and animating={true} still renders.
  const effectiveFrameloop: 'always' | 'demand' = animating ? 'always' : (frameloop ?? 'demand');

  return (
    <Canvas
      className={className}
      style={style}
      frameloop={effectiveFrameloop}
      dpr={[1, settings.maxDpr]}
      shadows={shadows ? 'soft' : false}
      flat={false}
      camera={{ fov: 40, near: 0.8, far: 220, position: [0, 8, 7] }}
      gl={{
        antialias: true,
        alpha: wantsAlpha,
        stencil: false,
        depth: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      }}
      onCreated={(state) => {
        // Colour management is on by default in r3f v8; being explicit costs
        // nothing and makes the intent greppable.
        THREE.ColorManagement.enabled = true;
        state.gl.outputColorSpace = THREE.SRGBColorSpace;
        onCreated?.(state);
      }}
    >
      <SceneContents
        seat={seat}
        theme={theme}
        insets={insets}
        zoom={zoom}
        framing={framing}
        quality={tier}
        shadows={shadows}
        armColors={armColors}
        interactive={interactive}
        pickable={pickable}
        onSpaceClick={onSpaceClick}
        onSpacePointerDown={onSpacePointerDown}
        onSpacePointerUp={onSpacePointerUp}
        onSpacePointerMove={onSpacePointerMove}
        onSpacePointerOver={onSpacePointerOver}
        onSpacePointerOut={onSpacePointerOut}
        lighting={lighting}
        camera={camera}
        board={board}
        table={table}
        frameDriver={frameDriver}
        worldChildren={worldChildren}
        onFraming={onFraming}
      >
        {children}
      </SceneContents>
    </Canvas>
  );
}

export default Scene;
