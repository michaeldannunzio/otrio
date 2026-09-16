/**
 * Table.tsx — the surface the board sits on.
 *
 * A single large felt-topped slab whose edges are dissolved by the scene fog
 * rather than framed. That is a deliberate choice, not laziness:
 *
 *   - On a tall phone the camera's vertical field of view is wide (the board
 *     occupies a band in the middle and the UI takes the rest), so the frustum
 *     reaches roughly 20 units of ground behind the board. Any table small
 *     enough to read as furniture would show its far edge, a horizon, and then
 *     nothing — which looks like a bug, not like a room.
 *   - Modelling a room instead would cost geometry, another texture set and a
 *     lot of lighting work for something nobody looks at.
 *   - Fogging the surface into the background colour is one line, costs zero
 *     draw calls, gives depth cueing for free, and keeps the whole frame in one
 *     colour family in both themes.
 *
 * The slab is real geometry with real thickness and a chamfered edge, so if
 * anyone later wants a visible table edge they just pass a smaller `size` and
 * raise `Lighting`'s fog distances.
 *
 * Scale: Board.tsx puts one scene unit at ~72 mm (RULES.md §9's 389 mm board
 * across 5.4 units). `DEFAULT_SIZE = 40` is therefore about 2.9 m of cloth.
 * The felt repeat is derived from `size` so the weave stays the same physical
 * size if you change it — textures.ts documents its `repeat: 12` default as
 * "assumes a table plane around 1.5 m", which is 8 tiles per metre.
 */

import * as React from 'react';
import * as THREE from 'three';
import { useSurfaceMaterial } from './textures';
import type { ThemeMode } from './Board';

/**
 * Baize tint per theme.
 *
 * Two reasons this exists rather than letting textures.ts's default through.
 *
 * 1. It was the last thing in the scene that ignored `theme` entirely. The
 *    cloth is most of the frame on anything wider than a phone, so a table that
 *    does not move between light and dark meant the scene barely moved either.
 *
 * 2. It is now load-bearing for the board's silhouette. When the board sat at
 *    L* 23.8 the stock baize (#2c6647, L* 38.7) gave 1.71:1 and the slab read
 *    as a dark object on a mid cloth. Lightening the board to L* 31.1 collapsed
 *    that to 1.32:1 — board and cloth within a whisker of the same luminance,
 *    which is where a large object stops having an edge. So the cloth had to
 *    move too: light goes lighter (2.16:1), dark goes darker (1.52:1, carried
 *    the rest of the way by hue, the chamfered edge and the slab's own cast
 *    shadow).
 *
 * The HUE is not mine to choose. Green is also a player colour, so a saturated
 * green cloth sits next to the green player's identity — flagged to UX, not
 * acted on. Change `color` (or these values) and nothing else in the scene
 * cares; the felt scan is near-neutral and takes any tint cleanly.
 */
export const TABLE_TINTS: Readonly<Record<ThemeMode, string>> = {
  light: '#3d8b60', // L* 52.2, board reads at 2.16:1
  dark: '#153327', //  L* 18.7, board reads at 1.52:1
};

/** Metres per scene unit, from Board.tsx's derivation. */
const METRES_PER_UNIT = 0.072;

/** textures.ts's felt density: 12 tiles across ~1.5 m. */
const FELT_TILES_PER_METRE = 8;

const DEFAULT_SIZE = 40;

export interface TableProps {
  /** Width and depth of the slab, in scene units. */
  size?: number;
  /** Thickness. Only the chamfered edge of this is ever visible, and only if you shrink `size`. */
  thickness?: number;
  /** Selects the baize tint from TABLE_TINTS. Threaded from Scene's `theme`. */
  theme?: ThemeMode;
  /** Overrides the baize tint for this theme. Multiplies the felt albedo. */
  color?: string;
  /**
   * Felt tiling override. Leave it alone unless you want a different weave
   * scale — the default keeps the fibres physically constant across any `size`.
   */
  repeat?: number;
  /** Subdivision of the top face. 1 is correct; raise it only for vertex-lit experiments. */
  segments?: number;
  /**
   * Render the slab's body so the table has a visible edge. Pointless (and one
   * wasted draw call) at the default size, where the fog eats the edge long
   * before it is in frame, so it defaults on only for small tables.
   */
  edge?: boolean;
}

export function Table({
  size = DEFAULT_SIZE,
  thickness = 0.22,
  theme = 'light',
  color,
  repeat,
  segments = 1,
  edge,
}: TableProps) {
  const showEdge = edge ?? size <= 24;
  const feltRepeat = repeat ?? Math.round(size * METRES_PER_UNIT * FELT_TILES_PER_METRE);

  const felt = useSurfaceMaterial('table', {
    repeat: feltRepeat,
    color: color ?? TABLE_TINTS[theme] ?? TABLE_TINTS.light,
  });

  // Top face and body are separate so the top can carry a clean 0..1 UV set
  // (which is what textures.ts's repeat convention assumes) without the side
  // walls smearing it. The body is a plain box tucked underneath; with the
  // default `size` it is never in frame at all.
  const topGeo = React.useMemo(() => {
    const g = new THREE.PlaneGeometry(size, size, segments, segments);
    g.rotateX(-Math.PI / 2);
    return g;
  }, [size, segments]);

  const bodyGeo = React.useMemo(
    () => new THREE.BoxGeometry(size, thickness, size),
    [size, thickness],
  );

  React.useEffect(() => () => topGeo.dispose(), [topGeo]);
  React.useEffect(() => () => bodyGeo.dispose(), [bodyGeo]);

  return (
    <group name="otrio-table">
      {/*
        The board's underside sits at y = 0, so the cloth is at y = 0 too. They
        are coplanar only where the board covers the cloth, which is exactly
        where the board's own shadow is darkest, so nothing shows through.
      */}
      <mesh geometry={topGeo} receiveShadow name="table-top">
        <meshStandardMaterial {...felt} />
      </mesh>
      {showEdge && (
        <mesh geometry={bodyGeo} position={[0, -thickness / 2 - 0.001, 0]} name="table-body">
          <meshStandardMaterial {...felt} />
        </mesh>
      )}
    </group>
  );
}

export default Table;
