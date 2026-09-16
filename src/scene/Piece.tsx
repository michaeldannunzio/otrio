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
 * HOW IT DRAWS
 * ------------
 * 36 pieces, 3 draw calls. One material for all of them; colour rides on
 * `instanceColor` and finish on a per-instance `vec4`, both of which three.js
 * and drei feed to the shader without breaking the batch.
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
import type { GroupProps, MeshProps } from '@react-three/fiber';
import type { Object3D } from 'three';

import { PIECE_HEIGHT, SLOTS } from './Board';
import {
  PIECE_METRICS,
  PIECE_SIZES,
  clonePieceGeometry,
  getPieceGeometry,
  pieceSetTriangleBudget,
  type Detail,
  type PieceSize,
} from './geometry';
import {
  DEFAULT_FINISH_VALUE,
  boostFinish,
  finishToArray,
  paintForPlayer,
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
}

const channels = {
  small: createInstances<PieceInstanceProps>(),
  medium: createInstances<PieceInstanceProps>(),
  large: createInstances<PieceInstanceProps>(),
} as const;

/* -------------------------------------------------------------------------- *
 * Field
 * -------------------------------------------------------------------------- */

interface FieldConfig {
  pitch: number;
  detail: Detail;
  quality: PieceQuality;
  accessibleFinish: number;
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
  /** Instances reserved per size. 12 is a full 4-player set. */
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
  limit = 12,
  castShadow = true,
  receiveShadow = true,
  children,
}: PieceFieldProps) {
  const material = usePieceMaterial(quality);

  // Cloned, not shared: drei's <InstancedAttribute> attaches its buffer to
  // `geometry.attributes.aFinish` and deletes it on unmount. Two fields on one
  // cached geometry would fight over that slot.
  const geometry = useMemo(
    () => ({
      small: clonePieceGeometry('small', detail, pitch),
      medium: clonePieceGeometry('medium', detail, pitch),
      large: clonePieceGeometry('large', detail, pitch),
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

  const config = useMemo<FieldConfig>(
    () => ({ pitch, detail, quality, accessibleFinish }),
    [pitch, detail, quality, accessibleFinish],
  );

  const [LargeInstances] = channels.large;
  const [MediumInstances] = channels.medium;
  const [SmallInstances] = channels.small;

  // Instances are scattered over the whole board, so a single piece's bounding
  // sphere would cull the batch the moment the camera looked past one space.
  const shared = {
    limit,
    material,
    castShadow,
    receiveShadow,
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
        <LargeInstances {...shared} geometry={geometry.large}>
          <InstancedAttribute name="aFinish" defaultValue={DEFAULT_FINISH_VALUE} />
          <MediumInstances {...shared} geometry={geometry.medium}>
            <InstancedAttribute name="aFinish" defaultValue={DEFAULT_FINISH_VALUE} />
            <SmallInstances {...shared} geometry={geometry.small}>
              <InstancedAttribute name="aFinish" defaultValue={DEFAULT_FINISH_VALUE} />
              {children}
            </SmallInstances>
          </MediumInstances>
        </LargeInstances>
      </group>
    </FieldContext.Provider>
  );
}

/* -------------------------------------------------------------------------- *
 * Piece
 * -------------------------------------------------------------------------- */

export interface PieceProps extends Omit<GroupProps, 'color' | 'ref' | 'args'> {
  /** Colour id, or a seat index 0..3 in the order purple, red, green, blue. */
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

function InstancedPiece({
  player,
  size,
  finish,
  pitch: _pitch,
  field,
  forwardedRef,
  ...rest
}: PieceProps & Extras & { field: FieldConfig }) {
  const paint = paintForPlayer(player);
  const [, Instance] = channels[size];

  const value = useMemo(() => {
    const base = finish ?? paint.finish;
    return finishToArray(
      field.accessibleFinish > 0 ? boostFinish(base, field.accessibleFinish) : base,
    );
  }, [finish, paint.finish, field.accessibleFinish]);

  return (
    // drei types the instance ref as its own PositionMesh subclass; callers
    // only ever need the Object3D surface of it, so the ref is widened here
    // rather than leaking drei's type through our public API.
    <Instance
      ref={forwardedRef as never}
      color={paint.hex}
      aFinish={value}
      {...(rest as unknown as Record<string, never>)}
    />
  );
}

function SoloPiece({
  player,
  size,
  finish: _finish,
  pitch = 1,
  forwardedRef,
  ...rest
}: PieceProps & Extras) {
  const paint = paintForPlayer(player);
  const material = useSoloPieceMaterial(paint.id);
  const geometry = useMemo(() => getPieceGeometry(size, 'medium', pitch), [size, pitch]);

  return (
    <mesh
      ref={forwardedRef as never}
      geometry={geometry}
      material={material}
      castShadow
      receiveShadow
      {...(rest as unknown as MeshProps)}
    />
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
