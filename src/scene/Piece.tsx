/**
 * Piece.tsx — the 36 playing pieces.
 *
 * WHAT A PIECE IS (docs/RULES.md §2.3)
 * ------------------------------------
 * Three sizes per colour, and they are NOT three rings. LARGE and MEDIUM are
 * open annuli; SMALL is a solid peg with no hole. The peg's filled centre is a
 * categorical difference rather than a difference of degree, which is why it
 * still reads at 30 pixels across when a judgement of "is that ring smaller?"
 * would not.
 *
 * They nest: peg inside medium inside large, all three flush in one recessed
 * space, making a tricolour bullseye once three players share it. Piece origins
 * sit on the underside, so a space places all three at the same Y.
 *
 * THREE CHANNELS OF IDENTITY, NOT ONE
 * -----------------------------------
 * Colour alone does not carry player identity here, and the numbers say so:
 * greyscale separation between the four rulebook hues is ~10 dE, and the scene
 * agent's sweep found no board tint that clears 3:1 against all four at once —
 * 2.24:1 is the ceiling. So a piece says who owns it three ways:
 *
 *   1. `players[i].base`  the hue, on `instanceColor`
 *   2. `players[i].rim`   an outline of fixed world width, derived and verified
 *                         per player to clear 3:1 against the board in both
 *                         themes. Drawn as an inverted hull; see
 *                         `materials/pieceMaterial.ts`.
 *   3. `PLAYERS[i].glyph` printed on the top face as ink, plus the gloss-to-
 *                         matte finish ladder in `materials/palette.ts`. These
 *                         are the two non-colour channels, and they are what
 *                         the 10 dE greyscale figure was accepted against.
 *
 * HOW IT DRAWS
 * ------------
 * 36 pieces, 6 draw calls: three for the pieces, three for their outline
 * shells. One material each; colour rides on `instanceColor`, and finish, glyph
 * placement and ink ride on per-instance attributes — none of which breaks the
 * batch.
 *
 *     <PieceField>
 *       <Piece player="red" size="large" position={[x, y, z]} />
 *       ...
 *     </PieceField>
 *
 * A `<Piece>` behaves like an ordinary Object3D — it has `position`,
 * `rotation`, `scale`, a ref, and pointer events — so animation code can drive
 * it exactly as it would a mesh, and never has to know it is instanced.
 *
 * Outside a `<PieceField>` a `<Piece>` silently falls back to a plain mesh with
 * its own material. That is one draw call per piece, which is right for a HUD
 * swatch or a hover ghost and wrong for the board.
 */

import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type Ref,
  type ReactNode,
} from 'react';
import { InstancedAttribute, createInstances } from '@react-three/drei';
import type { GroupProps } from '@react-three/fiber';
import type { Object3D } from 'three';

import { Color } from 'three';
import { useSceneTheme } from '../hooks/useTheme';
import type { PlayerColors } from '../styles/theme';
import { PIECE_HEIGHT, SLOTS } from './Board';
import {
  PIECE_METRICS,
  PIECE_SIZES,
  clonePieceGeometry,
  getPieceGeometry,
  markPlacement,
  pieceSetTriangleBudget,
  type Detail,
  type PieceSize,
} from './geometry';
import {
  DEFAULT_FINISH_VALUE,
  DEFAULT_INK_VALUE,
  DEFAULT_MARK_VALUE,
  boostFinish,
  finishToArray,
  getGlyphAtlas,
  getPieceOutlineMaterial,
  PLAYER_ORDER,
  paintForPlayer,
  setGlyphAtlas,
  setPieceMark,
  useSoloPieceMaterial,
  usePieceMaterial,
  type PieceFinish,
  type PieceQuality,
  type PlayerColorId,
} from './materials';

/* -------------------------------------------------------------------------- *
 * Instance channels
 * -------------------------------------------------------------------------- *
 *
 * One `createInstances()` pair per size, at module scope so the React contexts
 * are stable across renders. Three pairs = three InstancedMeshes = three draw
 * calls, which is the floor: the three sizes are genuinely different geometry
 * and cannot share a buffer.
 */

interface PieceInstanceProps {
  /** Per-instance finish: [roughnessMul, clearcoat, clearcoatRoughness, normalMul]. */
  aFinish?: [number, number, number, number];
  /** Glyph placement: [atlasRow, bandInner, bandOuter, mode]. */
  aMark?: [number, number, number, number];
  /** Glyph ink, linear RGB. */
  aInk?: [number, number, number];
}

const channels = {
  small: createInstances<PieceInstanceProps>(),
  medium: createInstances<PieceInstanceProps>(),
  large: createInstances<PieceInstanceProps>(),
} as const;

/**
 * A second set of channels for the outline shells. Three more instanced meshes,
 * three more draw calls, and the silhouette contrast the whole palette depends
 * on — no board tint clears 3:1 against all four player hues at once.
 */
const outlineChannels = {
  small: createInstances(),
  medium: createInstances(),
  large: createInstances(),
} as const;

/** sRGB hex -> linear RGB triple, which is what an instanced attribute wants. */
const scratchColor = /* @__PURE__ */ new Color();
function toLinear(hex: string): [number, number, number] {
  scratchColor.set(hex);
  return [scratchColor.r, scratchColor.g, scratchColor.b];
}

/**
 * The shell is decoration. Leaving it raycastable would put two hits on every
 * pointer event over a piece, and the second one belongs to an object no caller
 * has ever heard of.
 */
const noRaycast = () => null;

/* -------------------------------------------------------------------------- *
 * Field
 * -------------------------------------------------------------------------- */

interface FieldConfig {
  pitch: number;
  detail: Detail;
  quality: PieceQuality;
  accessibleFinish: number;
  /** Resolved for the active theme; indexed by player 0..3. */
  players: readonly PlayerColors[];
  /** Per-size mark placement, already scaled to the pitch. */
  marks: Record<PieceSize, [number, number, number, number]>;
}

const FieldContext = createContext<FieldConfig | null>(null);

export interface PieceFieldProps {
  /**
   * Board space pitch in world units. Every piece dimension is a fraction of
   * it, so this is the only number that has to agree with the board.
   */
  pitch?: number;
  /** Geometric detail. Drives fillet subdivision and silhouette segments. */
  detail?: Detail;
  /** Material tier. 'low' drops clear-coat, which is the expensive part. */
  quality?: PieceQuality;
  /**
   * Widen the per-player finish ladder, 0..1. A colour-blindness setting: at 1
   * the glossiest player is mirror-hard and the mattest is chalk, so the
   * highlight alone identifies the owner.
   */
  accessibleFinish?: number;
  /**
   * Instances reserved per size, per channel. A full 4-player set is 12 of each
   * size — 4 colours x 3 — whether they are on the board or waiting on a
   * storage arm, so 12 is the steady-state need and the default leaves headroom
   * over it.
   *
   * THIS IS A HARD CEILING, NOT A SOFT ONE. drei clamps the draw count, but the
   * per-instance attribute writes go through `BufferAttribute.set`, which
   * throws a RangeError rather than dropping the overflow — every frame, from
   * inside `useFrame`. So size it for the worst instant, not the average:
   * anything transient counts, including a piece still drawn in its storage
   * space while its copy animates onto the board, and a hover ghost rendered
   * through the field rather than standalone.
   *
   * The headroom is nearly free: ~120 bytes per instance per size.
   */
  limit?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  children?: ReactNode;
}

/**
 * Mount once, high in the scene. Everything inside it that renders a `<Piece>`
 * joins the batch, wherever it sits in the tree — board spaces, storage arms,
 * an animating piece in mid-air.
 *
 * The three `<Instances>` nest rather than sit as siblings because each one
 * provides its own React context and a `<Piece>` deeper in the tree has to be
 * able to reach all three. This is the same shape drei's own `<Merged>` uses.
 */
export function PieceField({
  pitch = 1,
  detail = 'medium',
  quality = 'medium',
  accessibleFinish = 0,
  limit = 16,
  castShadow = true,
  receiveShadow = true,
  children,
}: PieceFieldProps) {
  const theme = useSceneTheme();
  const material = usePieceMaterial(quality);
  const outlineMaterial = useMemo(
    () => getPieceOutlineMaterial(theme.piece.rimWidth * pitch),
    [theme.piece.rimWidth, pitch],
  );

  // The identity glyph. Rasterised once from the theme's own shapes; see
  // materials/glyphAtlas.ts for why it is drawn rather than typeset.
  useEffect(() => {
    setGlyphAtlas(material, getGlyphAtlas(theme.players));
  }, [material, theme.players]);

  // Cloned, not shared: drei's <InstancedAttribute> attaches its buffer to
  // `geometry.attributes.aFinish` and deletes it on unmount. Two fields on one
  // cached geometry would fight over that slot. The outline shells need their
  // own copies for the same reason.
  const geometry = useMemo(
    () => ({
      small: clonePieceGeometry('small', detail, pitch),
      medium: clonePieceGeometry('medium', detail, pitch),
      large: clonePieceGeometry('large', detail, pitch),
      outlineSmall: clonePieceGeometry('small', detail, pitch),
      outlineMedium: clonePieceGeometry('medium', detail, pitch),
      outlineLarge: clonePieceGeometry('large', detail, pitch),
    }),
    [detail, pitch],
  );

  // Dispose only a *superseded* set, never the live one. React StrictMode
  // mounts, tears down and remounts every effect in development; a cleanup that
  // disposed the current geometry would hand the second mount three dead
  // buffers. Three geometries totalling ~60 KB outlive the last field until the
  // GL context goes, which for a single-page game is when the tab closes.
  const previous = useRef(geometry);
  useEffect(() => {
    if (IS_DEV) assertMatchesBoard();
    if (previous.current !== geometry) {
      for (const g of Object.values(previous.current)) g.dispose();
      previous.current = geometry;
    }
  }, [geometry]);

  const config = useMemo<FieldConfig>(() => {
    const marks = {} as Record<PieceSize, [number, number, number, number]>;
    for (const size of PIECE_SIZES) {
      const m = markPlacement(size);
      // Row is filled in per piece; the rest is a property of the shape.
      marks[size] = [0, m.inner * pitch, m.outer * pitch, m.mode];
    }
    return { pitch, detail, quality, accessibleFinish, players: theme.players, marks };
  }, [pitch, detail, quality, accessibleFinish, theme.players]);

  const [LargeInstances] = channels.large;
  const [MediumInstances] = channels.medium;
  const [SmallInstances] = channels.small;
  const [LargeOutlines] = outlineChannels.large;
  const [MediumOutlines] = outlineChannels.medium;
  const [SmallOutlines] = outlineChannels.small;

  // Instances are scattered over the whole board, so a single piece's bounding
  // sphere would cull the batch the moment the camera looked past one space.
  const shared = {
    limit,
    material,
    castShadow,
    receiveShadow,
    frustumCulled: false,
  } as const;

  // The shell must not cast: it is a fattened copy of the piece, and letting it
  // into the shadow map would thicken every shadow on the board by the rim
  // width for no reason.
  const sharedOutline = {
    limit,
    material: outlineMaterial,
    castShadow: false,
    receiveShadow: false,
    frustumCulled: false,
  } as const;

  return (
    <FieldContext.Provider value={config}>
      {/*
        Keyed on the geometry identity: drei's <InstancedAttribute> binds itself
        to `geometry.attributes` once, in a layout effect that does not re-run
        when the geometry prop changes. Remounting on a pitch or detail change
        is the honest fix, and both are session-level settings.
      */}
      <group name="otrio-pieces" key={`${detail}|${pitch}`}>
        <LargeOutlines {...sharedOutline} geometry={geometry.outlineLarge}>
          <MediumOutlines {...sharedOutline} geometry={geometry.outlineMedium}>
            <SmallOutlines {...sharedOutline} geometry={geometry.outlineSmall}>
              <LargeInstances {...shared} geometry={geometry.large}>
                <InstancedAttribute name="aFinish" defaultValue={DEFAULT_FINISH_VALUE} />
                <InstancedAttribute name="aMark" defaultValue={DEFAULT_MARK_VALUE} />
                <InstancedAttribute name="aInk" defaultValue={DEFAULT_INK_VALUE} />
                <MediumInstances {...shared} geometry={geometry.medium}>
                  <InstancedAttribute name="aFinish" defaultValue={DEFAULT_FINISH_VALUE} />
                  <InstancedAttribute name="aMark" defaultValue={DEFAULT_MARK_VALUE} />
                  <InstancedAttribute name="aInk" defaultValue={DEFAULT_INK_VALUE} />
                  <SmallInstances {...shared} geometry={geometry.small}>
                    <InstancedAttribute name="aFinish" defaultValue={DEFAULT_FINISH_VALUE} />
                    <InstancedAttribute name="aMark" defaultValue={DEFAULT_MARK_VALUE} />
                    <InstancedAttribute name="aInk" defaultValue={DEFAULT_INK_VALUE} />
                    {children}
                  </SmallInstances>
                </MediumInstances>
              </LargeInstances>
            </SmallOutlines>
          </MediumOutlines>
        </LargeOutlines>
      </group>
    </FieldContext.Provider>
  );
}

/* -------------------------------------------------------------------------- *
 * Piece
 * -------------------------------------------------------------------------- */

export interface PieceProps extends Omit<GroupProps, 'color' | 'ref' | 'args'> {
  /**
   * Who owns this piece: a colour name, or a **colour** index 0..3 in the order
   * purple, red, green, blue — the same quantity as the engine's `PlayerColor`
   * and the wire's, and NOT a seat.
   *
   * The two are not interchangeable. In the official 2-player game one person
   * holds two colours (purple+green against red+blue), so a seat index passed
   * here would paint pieces in someone else's colour and nothing would throw.
   * Pieces on the board belong to a colour; turns and forfeits belong to a seat.
   */
  player: PlayerColorId | number;
  size: PieceSize;
  /**
   * Override the player's finish — for a highlighted or dimmed piece.
   * Ignored by the standalone fallback, which shares one material per player.
   */
  finish?: PieceFinish;
  /**
   * Board pitch, for a piece rendered outside a `<PieceField>`. Inside one,
   * the field's pitch wins and this is ignored.
   */
  pitch?: number;
}

type Extras = { forwardedRef: Ref<Object3D> };

/**
 * One playing piece.
 *
 * Forwards its ref to the underlying Object3D. Animate `position`, `rotation`
 * and `scale` on it like any other object; the instance matrix is rebuilt from
 * the world transform every frame.
 */
export const Piece = forwardRef<Object3D, PieceProps>(function Piece(props, ref) {
  const field = useContext(FieldContext);
  return field ? (
    <InstancedPiece {...props} field={field} forwardedRef={ref} />
  ) : (
    <SoloPiece {...props} forwardedRef={ref} />
  );
});

/** Colour index 0..3, whichever way the caller named it. Never a seat. */
function playerIndex(player: PlayerColorId | number): number {
  if (typeof player === 'number') {
    return ((player % PLAYER_ORDER.length) + PLAYER_ORDER.length) % PLAYER_ORDER.length;
  }
  return Math.max(0, PLAYER_ORDER.indexOf(player));
}

function InstancedPiece({
  player,
  size,
  finish,
  pitch: _pitch,
  field,
  forwardedRef,
  children,
  ...rest
}: PieceProps & Extras & { field: FieldConfig }) {
  const paint = paintForPlayer(player);
  const index = playerIndex(player);
  const colors = field.players[index];
  const [, Instance] = channels[size];
  const [, Outline] = outlineChannels[size];

  const value = useMemo(() => {
    const base = finish ?? paint.finish;
    return finishToArray(
      field.accessibleFinish > 0 ? boostFinish(base, field.accessibleFinish) : base,
    );
  }, [finish, paint.finish, field.accessibleFinish]);

  const mark = useMemo<[number, number, number, number]>(() => {
    const [, inner, outer, mode] = field.marks[size];
    return [index, inner, outer, mode];
  }, [field.marks, size, index]);

  const ink = useMemo(() => toLinear(colors?.on ?? '#000000'), [colors?.on]);

  return (
    // drei types the instance ref as its own PositionMesh subclass; callers
    // only ever need the Object3D surface of it, so the ref is widened here
    // rather than leaking drei's type through our public API.
    <Instance
      ref={forwardedRef as never}
      color={colors?.base ?? paint.hex}
      aFinish={value}
      aMark={mark}
      aInk={ink}
      {...(rest as unknown as Record<string, never>)}
    >
      {/*
        The outline shell rides as a child, so it inherits this piece's world
        transform for free and anything animating the piece moves both. It sits
        at identity locally; the fattening happens in the shell's vertex shader.
      */}
      <Outline color={colors?.rim ?? paint.hex} raycast={noRaycast} />
      {children}
    </Instance>
  );
}

function SoloPiece({
  player,
  size,
  finish: _finish,
  pitch = 1,
  forwardedRef,
  children,
  ...rest
}: PieceProps & Extras) {
  const theme = useSceneTheme();
  const paint = paintForPlayer(player);
  const index = playerIndex(player);
  const colors = theme.players[index];

  const material = useSoloPieceMaterial(paint.id);
  const geometry = useMemo(() => getPieceGeometry(size, 'medium', pitch), [size, pitch]);
  const outlineMaterial = useMemo(
    () => getPieceOutlineMaterial(theme.piece.rimWidth * pitch, colors?.rim ?? paint.hex),
    [theme.piece.rimWidth, pitch, colors?.rim, paint.hex],
  );

  // A solo material is shared per player, so the mark and the atlas are set
  // here rather than baked in at construction — a HUD swatch and a hover ghost
  // of the same colour differ only by which size they are showing.
  useEffect(() => {
    const m = markPlacement(size);
    setPieceMark(
      material,
      [index, m.inner * pitch, m.outer * pitch, m.mode],
      colors?.on ?? '#000000',
    );
    setGlyphAtlas(material, getGlyphAtlas(theme.players));
  }, [material, size, index, pitch, colors?.on, theme.players]);

  return (
    <group ref={forwardedRef as never} {...(rest as unknown as GroupProps)}>
      <mesh geometry={geometry} material={material} castShadow receiveShadow />
      <mesh geometry={geometry} material={outlineMaterial} raycast={noRaycast} />
      {children}
    </group>
  );
}

/* -------------------------------------------------------------------------- *
 * Placement
 * -------------------------------------------------------------------------- *
 *
 * A piece's origin sits at the centre of its underside, and its geometry spans
 * y = 0 .. PIECE_HEIGHT. That is exactly what `Board.slotTransform()` expects,
 * so placement is:
 *
 *     const { position } = slotTransform(space, size);
 *     <Piece player={p} size={size} position={position} />
 *
 * Nothing here needs to know the recess depth; the board owns it.
 *
 * -------------------------------------------------------------------------- *
 * Contract check
 * -------------------------------------------------------------------------- *
 *
 * The geometry layer restates Board's `SLOTS` rather than importing it, so that
 * it stays free of React and three component code and can run in a test or a
 * worker. Restated constants drift, so this catches it on the first render in
 * development and says which number moved.
 */
let boardChecked = false;

function assertMatchesBoard(): void {
  if (boardChecked) return;
  boardChecked = true;

  const tolerance = 1e-9;
  const problems: string[] = [];

  for (const size of PIECE_SIZES) {
    const mine = PIECE_METRICS[size];
    const theirs = SLOTS[size];
    if (Math.abs(mine.outerRadius - theirs.outer) > tolerance) {
      problems.push(`${size}.outer: piece ${mine.outerRadius} vs board ${theirs.outer}`);
    }
    if (Math.abs(mine.innerRadius - theirs.inner) > tolerance) {
      problems.push(`${size}.inner: piece ${mine.innerRadius} vs board ${theirs.inner}`);
    }
    if (mine.annular === theirs.solid) {
      problems.push(`${size}: piece annular=${mine.annular} vs board solid=${theirs.solid}`);
    }
    if (Math.abs(mine.height - PIECE_HEIGHT) > tolerance) {
      problems.push(`${size}.height: piece ${mine.height} vs board ${PIECE_HEIGHT}`);
    }
  }

  if (problems.length > 0) {
    console.error(
      '[Piece] geometry has drifted from Board.SLOTS — pieces will not fit their recesses:\n  ' +
        problems.join('\n  '),
    );
  }
}

/**
 * Resolved without depending on `vite/client` being in the tsconfig, and run
 * from an effect rather than at module scope so it cannot fire before Board's
 * own module body has evaluated.
 */
const IS_DEV = Boolean(
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
);

export { PIECE_METRICS, PIECE_SIZES, pieceSetTriangleBudget };
export type { PieceSize, Detail, PieceQuality, PlayerColorId, PieceFinish };
