/**
 * Custom geometry for the Otrio scene.
 *
 * Everything here is built at runtime from a lathed cross-section — there is
 * no mesh file to load and nothing is extruded from an outline. See
 * `pieceProfiles.ts` for the shapes and where their proportions come from.
 */

export { buildLatheGeometry, filletArc, estimateTriangles } from './lathe';
export type { LathePoint, LatheOptions } from './lathe';

export {
  PIECE_SIZES,
  PIECE_METRICS,
  PIECE_HEIGHT,
  NEST_GAP,
  RING_WALL,
  RADIAL_SEGMENTS,
  pieceProfile,
  ringProfile,
  pegProfile,
} from './pieceProfiles';
export type { PieceSize, PieceMetrics, Detail } from './pieceProfiles';

export {
  PIECE_TEXTURE_TILE,
  getPieceGeometry,
  clonePieceGeometry,
  disposePieceGeometries,
  pieceSetTriangleBudget,
} from './pieceGeometry';
