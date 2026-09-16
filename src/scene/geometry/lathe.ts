/**
 * lathe.ts — a surface-of-revolution builder with creases, world-scaled UVs
 * and closed profiles.
 *
 * Why not `THREE.LatheGeometry`?
 *
 *  1. It smooths normals across the *whole* profile. A moulded part is defined
 *     by its creases — the chamfer at the base, the parting line left by the
 *     two mould halves, the crisp lip where a fillet meets a flat land. Smooth
 *     everything and you get a blob that reads as "computed", not "made".
 *     Here every profile point carries a `sharp` flag; a sharp point splits the
 *     vertex ring so each adjacent band keeps its own face normal.
 *
 *  2. Its UVs are `(i / segments, j / points)` — parameter space, not surface
 *     space. That stretches the texture wherever the profile points bunch up,
 *     and gives a small object and a large object the same number of texture
 *     tiles, so the same plastic grain comes out 2.5x coarser on the big piece.
 *     Here `v` is cumulative arc length in world units and `u` is a whole
 *     number of wraps chosen from the real circumference, so one texel covers
 *     the same physical area on every piece in the set.
 *
 *  3. It cannot close a profile, so a solid of revolution needs a separate cap
 *     mesh with its own material group. A closed profile here is just a loop:
 *     the "bottom face" is one more band of the same surface.
 *
 * Conventions
 * -----------
 * The axis of revolution is +Y. A profile point is `(r, y)` with `r >= 0`.
 * Points must be authored so that the **interior of the solid is on the right**
 * of the direction of travel: start at the inner bottom edge, climb the bore,
 * roll over the crown, descend the outer wall, and (if closed) return across
 * the underside. Outward normals then fall out as `normalize(-dy, dr)`.
 *
 * Points at `r === 0` (poles, e.g. the centre of a solid peg's top face) are
 * fine: the ring collapses to a point, the degenerate triangles are never
 * rasterised, and the pole's normal comes from the adjacent band. Mark poles
 * `sharp` so they inherit the flat face normal rather than a blended one.
 */

import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Sphere, Vector3 } from 'three';

export interface LathePoint {
  /** Distance from the Y axis, in world units. Must be >= 0. */
  r: number;
  /** Height above the local origin, in world units. */
  y: number;
  /**
   * Crease the surface here. The vertex ring is duplicated so the band below
   * and the band above each keep their own face normal. Use for chamfers,
   * parting lines, and the lip where a fillet meets a flat.
   *
   * Leave it off wherever the profile is tangent-continuous (a fillet meeting
   * the wall it was filleted from), which is most of a well-made part.
   */
  sharp?: boolean;
}

export interface LatheOptions {
  /** Radial subdivisions around the axis. Drives the silhouette. Default 48. */
  segments?: number;
  /**
   * Treat the profile as a loop: an extra band joins the last point back to
   * the first. Required for a solid whose underside is part of the profile.
   * When closed, index 0 is always creased (it carries two different arc
   * lengths, so it cannot share a vertex ring).
   */
  closed?: boolean;
  /**
   * World units covered by one tile of the texture. Smaller = finer grain.
   * Both axes use it, so texel density is uniform and matches across pieces.
   */
  worldPerTile?: number;
  /**
   * Override the number of texture wraps around the circumference. By default
   * it is derived from the mean radius and rounded to a whole number so the
   * tiling closes seamlessly at the wrap seam.
   */
  uWraps?: number;
}

interface Row {
  r: number;
  y: number;
  /** 2D outward normal in the (r, y) half-plane; unit length. */
  nr: number;
  ny: number;
  /**
   * The same normal with creases averaged away. Shading uses `nr/ny`; an
   * offset shell (the piece outline) has to use this one, because pushing
   * along a creased normal splits the shell open along every chamfer.
   */
  snr: number;
  sny: number;
  /** Cumulative arc length along the profile, in world units. */
  v: number;
}

/**
 * Attribute carrying the crease-free normal, for extruding an outline shell.
 * Named rather than `normal2` so the shader patch that reads it is greppable.
 */
export const OUTLINE_NORMAL_ATTRIBUTE = 'outlineNormal';

const EPSILON = 1e-7;

/**
 * Build a surface of revolution from a 2D profile.
 *
 * The returned geometry is indexed and carries `position`, `normal`, `uv` and
 * `uv1` (a copy of `uv`, so an AO map — which three.js reads from channel 1 by
 * default — lines up without the caller having to think about it).
 */
export function buildLatheGeometry(
  profile: readonly LathePoint[],
  options: LatheOptions = {},
): BufferGeometry {
  const segments = Math.max(3, Math.floor(options.segments ?? 48));
  const closed = options.closed ?? false;
  const worldPerTile = options.worldPerTile ?? 0.25;

  // ---- 1. Drop coincident points -----------------------------------------
  // A duplicated point produces a zero-length segment, whose normal is
  // undefined. Authoring code that derives points from arcs hits this
  // whenever a fillet radius collapses to zero, so filter rather than throw.
  const pts: LathePoint[] = [];
  for (const p of profile) {
    const prev = pts[pts.length - 1];
    if (prev && Math.abs(prev.r - p.r) < EPSILON && Math.abs(prev.y - p.y) < EPSILON) {
      // Keep the stronger crease flag.
      if (p.sharp) prev.sharp = true;
      continue;
    }
    pts.push({ r: Math.max(0, p.r), y: p.y, sharp: p.sharp });
  }
  if (closed) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first && last && Math.abs(first.r - last.r) < EPSILON && Math.abs(first.y - last.y) < EPSILON) {
      pts.pop();
    }
  }

  const n = pts.length;
  if (n < 2) {
    throw new Error(`buildLatheGeometry: need at least 2 distinct profile points, got ${n}`);
  }

  // A closed profile's seam point carries arc length 0 on one side and the
  // full perimeter on the other, so it can never share a vertex ring.
  if (closed) pts[0].sharp = true;

  const segCount = closed ? n : n - 1;

  // ---- 2. Per-segment geometry -------------------------------------------
  const segNR = new Float64Array(segCount);
  const segNY = new Float64Array(segCount);
  const segLen = new Float64Array(segCount);

  for (let s = 0; s < segCount; s++) {
    const a = pts[s];
    const b = pts[(s + 1) % n];
    const dr = b.r - a.r;
    const dy = b.y - a.y;
    const len = Math.hypot(dr, dy);
    segLen[s] = len;
    if (len < EPSILON) {
      segNR[s] = 0;
      segNY[s] = 1;
    } else {
      // Interior on the right of travel => outward normal is (-dy, dr).
      segNR[s] = -dy / len;
      segNY[s] = dr / len;
    }
  }

  // Cumulative arc length at the *start* of each segment.
  const cumulative = new Float64Array(segCount + 1);
  for (let s = 0; s < segCount; s++) cumulative[s + 1] = cumulative[s] + segLen[s];

  // ---- 3. Rows -----------------------------------------------------------
  // A smooth point contributes one row shared by both adjacent bands; a sharp
  // point contributes one row per adjacent band.
  const rows: Row[] = [];
  const smoothRowOf = new Int32Array(n).fill(-1);

  const previousSegmentOf = (point: number): number =>
    closed ? (point - 1 + segCount) % segCount : point - 1;

  const smoothNormalAt = (point: number): [number, number] => {
    const prev = previousSegmentOf(point);
    const next = point < segCount ? point : -1;

    let nr = 0;
    let ny = 0;
    if (prev >= 0) {
      nr += segNR[prev];
      ny += segNY[prev];
    }
    if (next >= 0) {
      nr += segNR[next];
      ny += segNY[next];
    }
    const len = Math.hypot(nr, ny);
    if (len < EPSILON) {
      // 180-degree reversal (a zero-thickness fin). Fall back to the outgoing
      // face rather than emitting a NaN normal.
      const fallback = next >= 0 ? next : prev;
      return [segNR[fallback], segNY[fallback]];
    }
    return [nr / len, ny / len];
  };

  const rowForSmooth = (point: number): number => {
    const cached = smoothRowOf[point];
    if (cached >= 0) return cached;

    const [nr, ny] = smoothNormalAt(point);
    rows.push({
      r: pts[point].r,
      y: pts[point].y,
      nr,
      ny,
      snr: nr,
      sny: ny,
      v: cumulative[point],
    });
    smoothRowOf[point] = rows.length - 1;
    return smoothRowOf[point];
  };

  const rowForSharp = (point: number, segment: number, v: number): number => {
    const [snr, sny] = smoothNormalAt(point);
    rows.push({
      r: pts[point].r,
      y: pts[point].y,
      nr: segNR[segment],
      ny: segNY[segment],
      snr,
      sny,
      v,
    });
    return rows.length - 1;
  };

  const bands: Array<[number, number]> = [];
  for (let s = 0; s < segCount; s++) {
    if (segLen[s] < EPSILON) continue;
    const startPoint = s;
    const endPoint = (s + 1) % n;

    const start = pts[startPoint].sharp
      ? rowForSharp(startPoint, s, cumulative[s])
      : rowForSmooth(startPoint);
    const end = pts[endPoint].sharp
      ? rowForSharp(endPoint, s, cumulative[s + 1])
      : rowForSmooth(endPoint);

    bands.push([start, end]);
  }

  // ---- 4. Texture wraps --------------------------------------------------
  let maxR = 0;
  for (const p of pts) {
    if (p.r > maxR) maxR = p.r;
  }
  // Derived from the *widest* radius, not the mean: that is the part of the
  // surface you actually look at, and matching texel density there is what
  // makes a small piece and a large piece look like they came out of the same
  // mould. Rounded to a whole number so the tiling closes at the wrap seam.
  const uWraps =
    options.uWraps ?? Math.max(1, Math.round((2 * Math.PI * maxR) / Math.max(EPSILON, worldPerTile)));

  // ---- 5. Emit -----------------------------------------------------------
  const ringSize = segments + 1; // duplicated seam column so u can reach uWraps
  const vertexCount = rows.length * ringSize;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const outlineNormals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const phi = t * Math.PI * 2;
    const sin = Math.sin(phi);
    const cos = Math.cos(phi);
    const u = t * uWraps;

    for (let k = 0; k < rows.length; k++) {
      const row = rows[k];
      const idx = k * ringSize + i;

      positions[idx * 3 + 0] = row.r * sin;
      positions[idx * 3 + 1] = row.y;
      positions[idx * 3 + 2] = row.r * cos;

      // (nr, ny) is unit, so (nr*sin, ny, nr*cos) is too — no renormalise.
      normals[idx * 3 + 0] = row.nr * sin;
      normals[idx * 3 + 1] = row.ny;
      normals[idx * 3 + 2] = row.nr * cos;

      outlineNormals[idx * 3 + 0] = row.snr * sin;
      outlineNormals[idx * 3 + 1] = row.sny;
      outlineNormals[idx * 3 + 2] = row.snr * cos;

      uvs[idx * 2 + 0] = u;
      uvs[idx * 2 + 1] = row.v / worldPerTile;
    }
  }

  const indexCount = bands.length * segments * 6;
  const indices =
    vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

  let w = 0;
  for (const [a, b] of bands) {
    const baseA = a * ringSize;
    const baseB = b * ringSize;
    for (let i = 0; i < segments; i++) {
      const a0 = baseA + i;
      const a1 = a0 + 1;
      const b0 = baseB + i;
      const b1 = b0 + 1;
      // Winding chosen so that a profile travelling "interior on the right"
      // produces front faces pointing along the outward normal.
      indices[w++] = a0;
      indices[w++] = b0;
      indices[w++] = b1;
      indices[w++] = a0;
      indices[w++] = b1;
      indices[w++] = a1;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute(
    OUTLINE_NORMAL_ATTRIBUTE,
    new Float32BufferAttribute(outlineNormals, 3),
  );
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  // three.js reads `aoMap` from UV channel 1 by default; same layout.
  geometry.setAttribute('uv1', new Float32BufferAttribute(uvs.slice(), 2));

  // Exact bounds are cheap here and let the renderer cull and size shadows
  // correctly without walking every vertex.
  let top = -Infinity;
  let bottom = Infinity;
  for (const p of pts) {
    if (p.y > top) top = p.y;
    if (p.y < bottom) bottom = p.y;
  }
  const midY = (top + bottom) * 0.5;
  geometry.boundingSphere = new Sphere(
    new Vector3(0, midY, 0),
    Math.hypot(maxR, Math.max(top - midY, midY - bottom)),
  );

  return geometry;
}

/**
 * Sample a circular fillet arc into profile points.
 *
 * `from` and `to` are the tangent points; `centre` is the arc centre. The arc
 * is swept the short way round, which is what a fillet always is.
 *
 * The endpoints are tangent-continuous with the surfaces they join, so they
 * are emitted smooth — that is the entire purpose of a fillet, and creasing
 * them would produce the faceted look this module exists to avoid.
 */
export function filletArc(
  centre: { r: number; y: number },
  from: { r: number; y: number },
  to: { r: number; y: number },
  steps: number,
): LathePoint[] {
  const radius = Math.hypot(from.r - centre.r, from.y - centre.y);
  const a0 = Math.atan2(from.y - centre.y, from.r - centre.r);
  let a1 = Math.atan2(to.y - centre.y, to.r - centre.r);

  // Shortest sweep.
  while (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
  while (a1 - a0 < -Math.PI) a1 += Math.PI * 2;

  const out: LathePoint[] = [];
  const count = Math.max(1, Math.floor(steps));
  for (let i = 0; i <= count; i++) {
    const a = a0 + ((a1 - a0) * i) / count;
    out.push({ r: centre.r + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius });
  }
  return out;
}

/** Triangle count a profile will produce, without building it. */
export function estimateTriangles(profile: readonly LathePoint[], segments: number, closed: boolean): number {
  const bands = closed ? profile.length : profile.length - 1;
  return bands * segments * 2;
}
