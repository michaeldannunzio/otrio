/**
 * pieceGeometry.ts — built, cached piece geometry.
 *
 * Three geometries exist for the whole game: one large ring, one medium ring,
 * one small peg. Thirty-six pieces are twelve instances of each. They are
 * cached by (size, detail, pitch) because the board only ever has one pitch and
 * one detail level at a time, so in practice the cache holds exactly three
 * entries for the life of the session.
 *
 * Origin: the local origin sits at the centre of the piece's underside, on the
 * axis, and the geometry spans y = 0 .. PIECE_HEIGHT. That is what
 * `Board.slotTransform()` hands back a position for, so a piece is placed at
 * that position unmodified and the recess depth stays the board's business.
 */

import type { BufferGeometry } from 'three';
import { buildLatheGeometry, estimateTriangles } from './lathe';
import {
  PIECE_METRICS,
  PIECE_SIZES,
  RADIAL_SEGMENTS,
  pieceProfile,
  type Detail,
  type PieceSize,
} from './pieceProfiles';

/**
 * World units of surface covered by one tile of the plastic texture, in pitch
 * units. At a typical phone framing this puts roughly 23 screen pixels per
 * tile on every piece regardless of size, which is about where a scanned
 * mould texture stops being a blur and starts being a surface.
 */
export const PIECE_TEXTURE_TILE = 0.3;

const cache = new Map<string, BufferGeometry>();

function key(size: PieceSize, detail: Detail, pitch: number): string {
  return `${size}|${detail}|${pitch}`;
}

/**
 * Get (building on first use) the geometry for one piece size.
 *
 * @param pitch  board space pitch in world units; all metrics scale with it.
 */
export function getPieceGeometry(
  size: PieceSize,
  detail: Detail = 'medium',
  pitch = 1,
): BufferGeometry {
  const k = key(size, detail, pitch);
  const hit = cache.get(k);
  if (hit) return hit;

  const { points, closed } = pieceProfile(size, detail);
  const scaled = points.map((p) => ({ r: p.r * pitch, y: p.y * pitch, sharp: p.sharp }));

  const geometry = buildLatheGeometry(scaled, {
    segments: RADIAL_SEGMENTS[detail][size],
    closed,
    worldPerTile: PIECE_TEXTURE_TILE * pitch,
  });
  geometry.name = `otrio-piece-${size}-${detail}`;

  cache.set(k, geometry);
  return geometry;
}

/**
 * A fresh, independent copy. Use this when something will mutate the geometry
 * — notably drei's `<InstancedAttribute>`, which attaches its buffer to
 * `geometry.attributes` and removes it on unmount. Two `<PieceField>`s sharing
 * one cached geometry would fight over that slot.
 */
export function clonePieceGeometry(
  size: PieceSize,
  detail: Detail = 'medium',
  pitch = 1,
): BufferGeometry {
  const copy = getPieceGeometry(size, detail, pitch).clone();
  copy.name = `${copy.name}-instanced`;
  return copy;
}

/** Release every cached geometry. Call on teardown if you care about VRAM. */
export function disposePieceGeometries(): void {
  for (const geometry of cache.values()) geometry.dispose();
  cache.clear();
}

/**
 * Triangle count for a full 4-player set (36 pieces), without building
 * anything. Useful for a perf HUD or for choosing a detail level.
 */
export function pieceSetTriangleBudget(detail: Detail = 'medium'): {
  perSize: Record<PieceSize, number>;
  unique: number;
  /** 4 colours x 3 pieces = 12 instances of each geometry. */
  drawn: number;
} {
  const perSize = {} as Record<PieceSize, number>;
  let unique = 0;
  for (const size of PIECE_SIZES) {
    const { points, closed } = pieceProfile(size, detail);
    const tris = estimateTriangles(points, RADIAL_SEGMENTS[detail][size], closed);
    perSize[size] = tris;
    unique += tris;
  }
  return { perSize, unique, drawn: unique * 12 };
}

export { PIECE_METRICS, PIECE_SIZES };
export type { Detail, PieceSize };
