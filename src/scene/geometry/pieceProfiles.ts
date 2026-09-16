/**
 * pieceProfiles.ts — the cross-sections of an Otrio piece.
 *
 * SHAPES (docs/RULES.md §2.3)
 * --------------------------
 *   LARGE   open ring / annulus
 *   MEDIUM  smaller open ring / annulus
 *   SMALL   a SOLID peg — no hole. This is not a small ring.
 *
 * PROPORTIONS — SET BY THE BOARD, NOT BY US
 * -----------------------------------------
 * No source publishes piece diameters and the official sheet disclaims its own
 * artwork as not to scale (docs/RULES.md §9), so the proportions are derived
 * geometrically — and that derivation belongs to `../Board.tsx`, which has to
 * machine matching recesses. Its `SLOTS` export is the contract; these numbers
 * restate it so the geometry layer stays free of React and three.js component
 * code, and `Piece.tsx` asserts in development that the two have not drifted.
 *
 * Board's derivation, working inward from the edge of a space, with
 * NEST_GAP 0.045 and RING_WALL 0.120 in units of one space pitch:
 *
 *     LARGE   ring, inner 0.335, outer 0.455   (outer diameter 0.910 pitch)
 *     MEDIUM  ring, inner 0.170, outer 0.290   (outer diameter 0.580 pitch)
 *     SMALL   peg,  radius 0.125               (diameter        0.250 pitch)
 *     height  0.130, all three
 *
 * Board also fixes the real-world scale: 1 unit = 72 mm, making the large ring
 * 65.5 mm across, the peg 18 mm, and every piece 9.4 mm thick. The moulding
 * features below are sized in millimetres against that, which is why they are
 * absolute rather than proportional — a parting line is the same hairline on a
 * big part and a small one, and scaling it is exactly what makes a set of CG
 * objects look like one object at three sizes.
 *
 * READABILITY AT 360px
 * --------------------
 * The board's bounding box is 5.4 pitches, so a phone showing all of it gives a
 * pitch near 67 CSS px; a typical portrait framing that lets the storage arms
 * run off the top and bottom gives 75-95. At 80px the three sizes are 73 / 46 /
 * 20 px across, ratios of 1.57 and 2.32 — larger steps than a 3-size set needs,
 * and they hold up when the far row is foreshortened.
 *
 * Two cues carry size, not one:
 *   1. outer diameter, above;
 *   2. shape class — the small piece is a solid disc and the other two are
 *      rings. A filled centre versus an empty one is categorical rather than a
 *      judgement of degree, so it survives at any size and at any angle. This
 *      is what carries the peg, which at 20 px is the piece with the least
 *      diameter to spend.
 *
 * The peg gets a rounder crown than the rings for the same reason: a solid disc
 * with a single bright round highlight is unmistakable next to a ring with a
 * highlight that runs around a hole, even when both are barely 20 px.
 *
 * MOULDING DETAIL
 * ---------------
 * Every profile carries the features that make an object read as made rather
 * than computed, at the size they would really be on a 9.4 mm part:
 *   - a 0.5 mm chamfer around the base, so the piece meets its recess on a
 *     crisp line instead of a shading gradient;
 *   - a parting line: the outer wall is widest at 0.4 of the height and drafts
 *     away above and below it, with a 0.2 mm fin at the seam. It catches a
 *     bright specular line that runs right round the piece;
 *   - 1.5-2 degrees of draft on the bore and both outer faces;
 *   - unequal top fillets (outer softer than inner) over a flat land, which is
 *     what gives a moulded ring its distinctive rolled outer edge;
 *   - a 0.3 mm sink on the peg's top face. Thick solid mouldings always dish
 *     slightly as they cool, and on a part with no other features it is the
 *     single most convincing tell.
 *
 * All lengths are in pitch units; multiply by the board's space pitch.
 */

import { filletArc, type LathePoint } from './lathe';

export type PieceSize = 'small' | 'medium' | 'large';

/** Iteration order: smallest first, matching slot order from the centre out. */
export const PIECE_SIZES: readonly PieceSize[] = ['small', 'medium', 'large'] as const;

/* -------------------------------------------------------------------------- *
 * Proportions — mirror of ../Board.tsx `SLOTS` and `PIECE_HEIGHT`
 * -------------------------------------------------------------------------- */

/** Radial clearance between any two nested parts. Board's `NEST_GAP`. */
export const NEST_GAP = 0.045;

/** Ring wall thickness, equal for large and medium (§9). Board's `RING_WALL`. */
export const RING_WALL = 0.12;

/**
 * Piece thickness, all three sizes. Board's `PIECE_HEIGHT`.
 * 9.4 mm at the board's 1 unit = 72 mm — flat rings and a short peg, not towers.
 */
export const PIECE_HEIGHT = 0.13;

export interface PieceMetrics {
  size: PieceSize;
  /** true for LARGE and MEDIUM, false for the solid SMALL peg. */
  annular: boolean;
  /** Outer radius at the parting line — the widest point of the piece. */
  outerRadius: number;
  /** Bore radius at the base. 0 for the peg. */
  innerRadius: number;
  /** Wall thickness (outer - inner). Equals outerRadius for the peg. */
  wall: number;
  /** Overall height from the underside to the crown. */
  height: number;
}

function metrics(
  size: PieceSize,
  outerRadius: number,
  innerRadius: number,
  height: number,
): PieceMetrics {
  return {
    size,
    annular: innerRadius > 0,
    outerRadius,
    innerRadius,
    wall: outerRadius - innerRadius,
    height,
  };
}

export const PIECE_METRICS: Record<PieceSize, PieceMetrics> = {
  large: metrics('large', 0.5 - NEST_GAP, 0.5 - NEST_GAP - RING_WALL, PIECE_HEIGHT),
  medium: metrics(
    'medium',
    0.5 - 2 * NEST_GAP - RING_WALL,
    0.5 - 2 * NEST_GAP - 2 * RING_WALL,
    PIECE_HEIGHT,
  ),
  small: metrics('small', 0.5 - 3 * NEST_GAP - 2 * RING_WALL, 0, PIECE_HEIGHT),
};

/* -------------------------------------------------------------------------- *
 * Moulding features
 * -------------------------------------------------------------------------- */

interface Moulding {
  /** 45-degree chamfer around the base edge(s). */
  baseChamfer: number;
  /** How proud the parting-line fin stands from the wall. */
  partingFin: number;
  /** Half-height of the fin, i.e. how far the wall runs straight either side. */
  partingRun: number;
  /** Fraction of the height at which the widest point (the parting line) sits. */
  partingAt: number;
  /** Bore draft: the hole opens out towards the top by this much. */
  boreDraft: number;
  /** Outer draft above the parting line. */
  draftUp: number;
  /** Outer draft below the parting line. */
  draftDown: number;
  /** Fillet radius where the top land meets the bore. */
  filletInner: number;
  /** Fillet radius where the top land meets the outer wall. Softer. */
  filletOuter: number;
}

/**
 * Sized in millimetres against the board's 1 unit = 72 mm, then converted.
 * They are absolute, not proportional: the three sizes came out of three
 * cavities in the same tool, so they share a chamfer and a parting line rather
 * than scaled versions of one.
 */
const MM = 1 / 72;

const MOULDING: Moulding = {
  baseChamfer: 0.5 * MM,
  partingFin: 0.2 * MM,
  partingRun: 0.5 * MM,
  partingAt: 0.4,
  boreDraft: 0.22 * MM, // ~1.6 degrees over the 7.6 mm bore
  draftUp: 0.25 * MM, // ~2 degrees
  draftDown: 0.22 * MM,
  filletInner: 1.44 * MM,
  filletOuter: 2.16 * MM,
};

/** Fillet subdivisions. More steps = rounder highlight roll-off, more triangles. */
export type Detail = 'low' | 'medium' | 'high';

const FILLET_STEPS: Record<Detail, number> = { low: 2, medium: 4, high: 6 };

/** Radial subdivisions per size and detail level, tuned to on-screen arc length. */
export const RADIAL_SEGMENTS: Record<Detail, Record<PieceSize, number>> = {
  low: { small: 20, medium: 28, large: 32 },
  medium: { small: 32, medium: 40, large: 48 },
  high: { small: 44, medium: 56, large: 64 },
};

/* -------------------------------------------------------------------------- *
 * Profiles
 * -------------------------------------------------------------------------- */

/**
 * An open ring: bore, crown, outer wall, underside — a closed loop, so the
 * underside is part of the same surface and needs no separate cap.
 *
 * Travel order is inner-bottom -> up the bore -> over the crown -> down the
 * outer wall -> back across the underside, which puts the material on the
 * right throughout, as `buildLatheGeometry` requires.
 */
export function ringProfile(m: PieceMetrics, detail: Detail = 'medium'): LathePoint[] {
  const f = MOULDING;
  const steps = FILLET_STEPS[detail];
  const h = m.height;

  // Clamp features so an unusually small or short piece degrades rather than
  // turning itself inside out.
  const chamfer = Math.min(f.baseChamfer, m.wall * 0.2, h * 0.2);
  const partY = h * f.partingAt;
  const run = Math.min(f.partingRun, (partY - chamfer) * 0.6);
  const filletOuter = Math.min(f.filletOuter, m.wall * 0.3, (h - partY - run) * 0.8);
  const filletInner = Math.min(f.filletInner, m.wall * 0.22);

  // Radii.
  const wallR = m.outerRadius - f.partingFin; // outer wall at the parting line
  const topR = wallR - f.draftUp; // outer wall where the crown fillet starts
  const baseR = wallR - f.draftDown; // outer wall at the base chamfer
  const boreTopR = m.innerRadius + f.boreDraft; // bore where the crown fillet starts

  const landInner = boreTopR + filletInner;
  const landOuter = topR - filletOuter;

  const out: LathePoint[] = [];

  // Underside inner edge -> bore. Two creases make a crisp 45-degree chamfer.
  out.push({ r: m.innerRadius + chamfer, y: 0, sharp: true });
  out.push({ r: m.innerRadius, y: chamfer, sharp: true });

  // Bore, drafting open towards the top.
  out.push({ r: boreTopR, y: h - filletInner });

  // Crown: inner fillet, flat land, outer fillet. Tangent-continuous, so the
  // highlight rolls across the top instead of breaking at each junction.
  out.push(
    ...filletArc(
      { r: landInner, y: h - filletInner },
      { r: boreTopR, y: h - filletInner },
      { r: landInner, y: h },
      steps,
    ).slice(1),
  );
  if (landOuter > landInner) out.push({ r: landOuter, y: h });
  out.push(
    ...filletArc(
      { r: landOuter, y: h - filletOuter },
      { r: landOuter, y: h },
      { r: topR, y: h - filletOuter },
      steps,
    ).slice(1),
  );

  // Outer wall down to the parting line, then the fin, then down to the base.
  out.push({ r: wallR, y: partY + run });
  out.push({ r: m.outerRadius, y: partY, sharp: true });
  out.push({ r: wallR, y: partY - run, sharp: true });
  out.push({ r: baseR, y: chamfer, sharp: true });
  out.push({ r: baseR - chamfer, y: 0, sharp: true });

  // The loop closes back to the first point across the underside.
  return out;
}

/**
 * A solid peg. Same manufacturing language as the rings — base chamfer,
 * parting line, drafted wall, rolled top edge — plus the shallow sink that a
 * thick solid moulding always gets as it cools.
 *
 * Open profile running pole -> out across the top -> down the wall -> in
 * across the underside -> pole. The two poles are creased so they take the
 * flat face normal rather than a blend.
 */
export function pegProfile(m: PieceMetrics, detail: Detail = 'medium'): LathePoint[] {
  const f = MOULDING;
  const steps = FILLET_STEPS[detail];
  const h = m.height;
  const r = m.outerRadius;

  const chamfer = Math.min(f.baseChamfer, r * 0.12, h * 0.15);
  const partY = h * f.partingAt;
  const run = Math.min(f.partingRun, (partY - chamfer) * 0.6);
  // The peg's crown is softer than a ring's: there is no inner wall to balance
  // it, and a harder edge here reads as a machined slug rather than a moulding.
  const filletTop = Math.min(f.filletOuter * 1.15, r * 0.2, (h - partY - run) * 0.8);

  const wallR = r - f.partingFin;
  const topR = wallR - f.draftUp;
  const baseR = wallR - f.draftDown;
  const landOuter = topR - filletTop;

  // Sink: a dish a few tenths of a millimetre deep at part scale, flat across
  // the middle so the pole keeps an exactly vertical normal.
  const sink = Math.min(0.0045, h * 0.07);
  const sinkFlat = Math.min(0.030, landOuter * 0.25);

  const out: LathePoint[] = [];

  out.push({ r: 0, y: h - sink, sharp: true });
  out.push({ r: sinkFlat, y: h - sink });
  out.push({ r: landOuter, y: h });

  out.push(
    ...filletArc(
      { r: landOuter, y: h - filletTop },
      { r: landOuter, y: h },
      { r: topR, y: h - filletTop },
      steps,
    ).slice(1),
  );

  out.push({ r: wallR, y: partY + run });
  out.push({ r: r, y: partY, sharp: true });
  out.push({ r: wallR, y: partY - run, sharp: true });
  out.push({ r: baseR, y: chamfer, sharp: true });
  out.push({ r: baseR - chamfer, y: 0, sharp: true });
  out.push({ r: 0, y: 0, sharp: true });

  return out;
}

/** The profile for a size, plus whether it closes into a loop. */
export function pieceProfile(
  size: PieceSize,
  detail: Detail = 'medium',
): { points: LathePoint[]; closed: boolean } {
  const m = PIECE_METRICS[size];
  return m.annular
    ? { points: ringProfile(m, detail), closed: true }
    : { points: pegProfile(m, detail), closed: false };
}
