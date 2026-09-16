/**
 * Board.tsx — the Otrio board: a cross/plus-shaped bamboo slab with 21 recessed
 * three-slot spaces machined into it.
 *
 * ============================================================================
 * WHAT THIS FILE IS
 * ============================================================================
 *
 * This is the geometry authority for the whole 3D scene. Every other agent's
 * code that needs to know *where something goes* should import a constant or a
 * helper from here rather than re-deriving it. In particular:
 *
 *   - `SLOTS`         piece radii, per size. The Piece agent builds to these.
 *   - `PIECE_HEIGHT`  piece thickness. Same.
 *   - `SEAT_Y`        the Y a seated piece's *bottom face* rests at.
 *   - `slotTransform` position of any (space, size) slot in board-local space.
 *   - `SPACES`        all 21 spaces, playing and storage, with their positions.
 *   - `boardYawForSeat` the per-seat rotation (see Scene.tsx / CameraRig.tsx).
 *
 * ============================================================================
 * FIDELITY — where these numbers come from (docs/RULES.md)
 * ============================================================================
 *
 * §1.1  The board is a 5x5 grid minus the four corners: 21 spaces. The central
 *       3x3 is the playing area; the 12 outer spaces are storage, 3 per arm,
 *       one arm per colour. They have no gameplay function but they are how
 *       everyone reads, at a glance, what each player has left — so we render
 *       them for real, with real recesses, not as a side tray.
 *
 * §1.3  Every space — storage included, since setup fills each storage space
 *       with one nested set — has exactly three concentric recesses: an outer
 *       annular one for LARGE, an intermediate one for MEDIUM, a central
 *       circular pocket for SMALL. 21 x 3 = 63 modelled recesses.
 *
 * §2.3  LARGE and MEDIUM are open rings; SMALL is a solid peg. Not three tori.
 *
 * §2.4  Seating, from the official setup artwork:
 *         purple NORTH, red EAST, green SOUTH, blue WEST.
 *
 * §9    "Carbonized bamboo board with recessed circular inlays". Pieces sit
 *       *into* the board. Product footprint 15 1/3" (389 mm) square.
 *       Proportions are explicitly NOT to be taken from the artwork — the sheet
 *       disclaims its own scale — so they are derived geometrically below.
 *
 * ============================================================================
 * THE PROPORTION DERIVATION (RULES.md §9 asks for exactly this)
 * ============================================================================
 *
 * One scene unit = one space pitch. Two free parameters:
 *
 *     NEST_GAP  = 0.045   radial clearance between any two nested parts, and
 *                         between the large ring and the edge of its space
 *     RING_WALL = 0.120   wall thickness, equal for large and medium (§9:
 *                         "roughly equal for large and medium")
 *
 * Everything else falls out, working inward from the space edge:
 *
 *     large.outer  = 0.5          - NEST_GAP  = 0.455
 *     large.inner  = large.outer  - RING_WALL = 0.335
 *     medium.outer = large.inner  - NEST_GAP  = 0.290
 *     medium.inner = medium.outer - RING_WALL = 0.170
 *     small.outer  = medium.inner - NEST_GAP  = 0.125
 *
 * Consequences worth stating, because they are the design:
 *   - Adjacent spaces' large rings are 2 x NEST_GAP = 0.09 pitch apart. They
 *     visibly never touch, which was the brief's hard requirement.
 *   - Every clearance in the nest is identical (0.045), so a filled space is a
 *     regular tricolour bullseye with even bands — the §9 "defining tactile
 *     fact" reads correctly.
 *   - The board's 5.40-unit footprint maps to the real 389 mm product at
 *     1 unit = 72 mm, which makes the large ring 65.5 mm across, the peg
 *     18 mm, the slab 18.7 mm thick and the pieces 9.4 mm tall. All plausible.
 *
 * ============================================================================
 * ONE DELIBERATE DEPARTURE FROM A STRICT 5x5 LATTICE
 * ============================================================================
 *
 * The storage arms are pushed out to |g| = 2.12 rather than 2.0. On a strict
 * lattice the playing area and the arms would be separated by 0.028 of board —
 * a 2 mm web — which leaves no room to draw the "playing area!" outline that
 * §1.1 says is printed on the real board, and makes the arms read as part of
 * the grid. The 0.12 of extra breathing room buys a real, visible boundary and
 * costs 2% of screen. Set `armOffset` back to 2 if you disagree.
 *
 * ============================================================================
 * CONSTRUCTION — how the recesses are actually built
 * ============================================================================
 *
 * There is no CSG here and no boolean subtraction. The board is two meshes:
 *
 *   1. The slab: one ExtrudeGeometry of the rounded plus outline, chamfered
 *      top and bottom. 860 triangles. This is the shadow caster.
 *   2. The pocket field: all 21 machined targets, generated as surfaces of
 *      revolution and merged into ONE BufferGeometry — 30k triangles at 40
 *      radial segments, 48k at 64, in a single 1.7-2.6 MB buffer and a single
 *      draw call. That is the bulk of the scene's geometry and it is worth it:
 *      63 real recesses are the whole reason the board reads as an object.
 *      Each target sits POCKET_LIFT (0.4 mm, sub-pixel on any screen) above the slab top with
 *      its outer edge chamfered down into the slab, so no two surfaces in the
 *      scene are ever coplanar and z-fighting is structurally impossible.
 *      Same material and same UV projection as the slab, so the bamboo grain
 *      runs continuously across the join and the seam is invisible.
 *
 * The revolution surfaces are generated by hand rather than with LatheGeometry
 * because Lathe smooth-shades along the profile, which would round off every
 * machined edge. Here each profile segment gets its own ring pair, so every
 * crease is hard — the board reads as milled, which is the point.
 *
 * Recess depth is carried by baked vertex-colour ambient occlusion rather than
 * by the shadow map. A 4 mm groove is below the resolution of any shadow map a
 * phone can afford, and trying would produce acne, not depth. The AO ramp is
 * free, stable at every distance, and it is what actually makes the recesses
 * read at a glance. Shadow mapping is reserved for what it is good at: pieces
 * casting onto the board and the board casting onto the table.
 */

import * as React from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { useSurfaceMaterial } from './textures';

/* ========================================================================== *
 * Sizes
 * ========================================================================== */

/** One space to the next, centre to centre. The unit of the whole scene. */
export const SPACE_PITCH = 1;

/** Radial clearance between nested parts, and from the large ring to the space edge. */
export const NEST_GAP = 0.045;

/** Ring wall thickness, equal for large and medium (RULES.md §9). */
export const RING_WALL = 0.12;

/** Slack between a piece and the recess that holds it. Snug — §9 asks for snug. */
export const SLOT_CLEARANCE = 0.004;

export type SlotSize = 'small' | 'medium' | 'large';

/** The three sizes, outermost first — the order they nest in. */
export const SLOT_SIZES: readonly SlotSize[] = ['large', 'medium', 'small'];

export interface SlotSpec {
  /** Inner radius. 0 for `small`, which is a solid peg (RULES.md §2.3). */
  inner: number;
  /** Outer radius. */
  outer: number;
  /** True for `small` only. */
  solid: boolean;
}

/**
 * Piece radii. The Piece agent should build directly to these numbers:
 *   large  — ring,  inner 0.335, outer 0.455
 *   medium — ring,  inner 0.170, outer 0.290
 *   small  — peg,   radius 0.125
 */
export const SLOTS: Readonly<Record<SlotSize, SlotSpec>> = {
  large: { inner: 0.5 - NEST_GAP - RING_WALL, outer: 0.5 - NEST_GAP, solid: false },
  medium: { inner: 0.5 - 2 * NEST_GAP - 2 * RING_WALL, outer: 0.5 - 2 * NEST_GAP - RING_WALL, solid: false },
  small: { inner: 0, outer: 0.5 - 3 * NEST_GAP - 2 * RING_WALL, solid: true },
};

/** Piece thickness. §9: "the pieces are flat rings and a short peg, not towers". */
export const PIECE_HEIGHT = 0.13;

/** Slab thickness. */
export const BOARD_THICKNESS = 0.26;

/** World Y of the board's flat top surface. The slab spans y = 0 .. this. */
export const BOARD_TOP_Y = BOARD_THICKNESS;

/** How deep the machined recesses are cut. */
export const RECESS_DEPTH = 0.055;

/** Sub-pixel lift of the pocket field above the slab. A z-fighting guard, nothing more. */
export const POCKET_LIFT = 0.006;

/**
 * World Y that a seated piece's BOTTOM FACE rests at.
 * A placed piece therefore stands PIECE_HEIGHT - (RECESS_DEPTH - POCKET_LIFT)
 * = 0.081 proud of the board — "into the board", low, reads flat from above and
 * reveals its depth as the camera drops. Exactly §9's brief.
 */
export const SEAT_Y = BOARD_TOP_Y + POCKET_LIFT - RECESS_DEPTH;

/** Outer radius of one machined target. Adjacent targets leave a 0.028 web of bamboo. */
export const TARGET_RADIUS = 0.486;

/** |grid coordinate| of the storage spaces. See "one deliberate departure" above. */
export const ARM_OFFSET = 2.12;

/** Half-width of an arm (and so of the whole cross's narrow dimension). */
export const ARM_HALF_WIDTH = 1.66;

/** Half-length of the cross along either axis. Board bounding box is 5.4 x 5.4. */
export const BOARD_HALF_LENGTH = 2.7;

export const BOARD_CORNER_RADIUS = 0.14;
export const BOARD_EDGE_BEVEL = 0.014;

/** Where the "playing area!" outline sits — midway between play and storage. */
export const PLAY_OUTLINE_RADIUS = 1.56;
export const PLAY_OUTLINE_WIDTH = 0.07;

/**
 * Light or dark. Declared here rather than in Lighting.tsx because Lighting
 * already imports from this module, and the board needs the type too — one
 * direction of dependency, no cycle.
 */
export type ThemeMode = 'light' | 'dark';

/**
 * ===========================================================================
 * THE 3D BOARD'S TINT — canonical, and measured rather than picked
 * ===========================================================================
 *
 * These multiply the carbonized-bamboo albedo from textures.ts. They are NOT
 * the same thing as `styles/theme.ts`'s `scene.board.base`, and deliberately
 * so: that value is an absolute flat colour for the 2D chrome that depicts the
 * board (the text-board fallback, swatches, the CSS frame), whereas this is a
 * multiply over a real wood scan. Feeding a near-white #f0f3f8 into
 * `material.color` would bleach the bamboo into grey plastic and lose exactly
 * the physicality RULES.md §9 and the brief both require.
 *
 * Division of ownership, so there is one source of truth for each:
 *   - THIS is canonical for the 3D board material.
 *   - `styles/tokens.ts` `boardBase`/`boardLine` stay canonical for 2D chrome.
 *
 * WHY THESE VALUES. The constraint that sets them is the piece OUTLINE, not the
 * board. `Piece`/`materials` draw an inverted-hull rim in `players[i].rim` with
 * `toneMapped: false`, so the rim renders at a literal sRGB value while the
 * board is lit — and that rim is what makes a piece's silhouette perceivable.
 * Its floor is 3:1. That floor is an accessibility guarantee, not a preference,
 * so it is what caps how light this can go.
 *
 * The rim set is theme-independent (#be85f8 #fd7749 #81ac26 #67c8e6) and is no
 * longer derived against a board colour at all — it is derived against a
 * published limit, `RIM_BOARD_CEILING_LSTAR = 34` in `styles/tokens.ts`. That
 * indirection is the fix for a real bug: the previous rim set was derived
 * against `scene.board.base` #f0f3f8, a surface this scene has never rendered,
 * and silently sat at 1.31:1. Retint freely at or below L* 34; above it, ask
 * theming to re-derive rather than assuming the set degrades gracefully.
 *
 *     tint      L*     worst rim contrast
 *     #453626   23.8   4.35:1
 *     #584633   31.1   3.36:1   <- here. ~3 L* of margin left.
 *     #604d35   34.1   3.01:1   <- the published ceiling
 *     #665238   36.3   2.78:1   BELOW FLOOR
 *
 * Deliberately NOT at the ceiling. Hex-vs-hex contrast is optimistic here: the
 * rim is `toneMapped: false` so it renders at its literal sRGB value, while the
 * board is lit and tone-mapped and therefore renders lighter than its albedo.
 * The margin absorbs that. If a colour-picker on a real screenshot shows the
 * rendered board above L* 34 equivalent, that measurement beats this arithmetic
 * and theming re-derives against it.
 *
 * SAME VALUE IN BOTH THEMES, on purpose. The board is a wooden object; it does
 * not repaint when the 2D chrome does. What changes between themes is the light
 * on it — exposure, environment intensity, key intensity, fog and background
 * all move in Lighting.tsx — which is how a real object behaves and is enough
 * to read as a themed scene. The record stays keyed by theme so the knob is
 * there if a real screenshot says the dimmer rig needs a lift.
 */
export const BOARD_TINTS: Readonly<Record<ThemeMode, { base: string; line: string }>> = {
  //                                            L*     worst rim
  light: { base: '#584633', line: '#9c7b52' }, // 31.1   3.36:1
  dark: { base: '#584633', line: '#9c7b52' }, //  31.1   3.36:1
};

/**
 * Optional per-arm colour bar, in the strip of bare board between the outermost
 * storage target (|g| = 2.606) and the board edge (2.7).
 */
const ARM_BAR_OFFSET = (ARM_OFFSET + TARGET_RADIUS + BOARD_HALF_LENGTH) / 2;
const ARM_BAR_HALF_DEPTH = 0.024;

/**
 * Axis-aligned bounds of everything the board owns, pieces included.
 * Used as the camera's target and as a fallback fit volume.
 */
export const BOARD_BOUNDS = {
  center: [0, (SEAT_Y + PIECE_HEIGHT) / 2, 0] as [number, number, number],
  halfExtents: [
    BOARD_HALF_LENGTH + 0.02,
    (SEAT_Y + PIECE_HEIGHT) / 2 + 0.01,
    BOARD_HALF_LENGTH + 0.02,
  ] as [number, number, number],
};

/**
 * The board's actual silhouette, as a point cloud: the 12 vertices of the cross
 * outline at table level and at the top of a placed piece.
 *
 * CameraRig fits to THIS rather than to `BOARD_BOUNDS`, and the difference is
 * not cosmetic. The bounding box has four corners the board does not — the
 * cross is a plus — and on a portrait phone the fit is width-bound at exactly
 * those phantom corners, which sit closer to the camera than any real geometry.
 * Fitting the real outline buys about 10% of board size on the smallest screen
 * we support, for free.
 */
/**
 * Just the 3x3 playing area and its outline, for narrow viewports.
 *
 * The 12 storage spaces have no gameplay function (RULES.md §1.1) and their
 * information — who has what left — is already in the 2D HUD, per colour AND
 * per size, as numerals and as screen-reader text. On a 360px phone, framing
 * the whole cross puts a playing space at ~59 CSS px; framing this puts it near
 * 100. Since a placement is permanent (§4.3), that difference is the difference
 * between aiming and hoping.
 *
 * The arms crop off the edges rather than disappearing, so the board still
 * reads as a cross bleeding out of frame.
 */
export const PLAY_FIT_POINTS: ReadonlyArray<readonly [number, number, number]> = (() => {
  const h = PLAY_OUTLINE_RADIUS + PLAY_OUTLINE_WIDTH / 2 + 0.03;
  const top = SEAT_Y + PIECE_HEIGHT + 0.01;
  const pts: Array<readonly [number, number, number]> = [];
  for (const sx of [-h, h]) for (const sz of [-h, h]) pts.push([sx, 0, sz], [sx, top, sz]);
  return pts;
})();

export const BOARD_FIT_POINTS: ReadonlyArray<readonly [number, number, number]> = (() => {
  const top = SEAT_Y + PIECE_HEIGHT + 0.01;
  const pts: Array<readonly [number, number, number]> = [];
  for (const [sx, sy] of crossOutline(ARM_HALF_WIDTH + 0.02, BOARD_HALF_LENGTH + 0.02)) {
    // Shape space (x, y) maps to world (x, -z); see extrudeSlab.
    pts.push([sx, 0, -sy], [sx, top, -sy]);
  }
  return pts;
})();

/* ========================================================================== *
 * Seating and spaces
 * ========================================================================== */

/**
 * Compass seats, in the order fixed by the official setup artwork (RULES.md §2.4):
 * purple NORTH, red EAST, green SOUTH, blue WEST.
 *
 * North is -Z, east is +X, south is +Z, west is -X: a normal map orientation
 * seen from above with +X to the right.
 */
export const NORTH = 0;
export const EAST = 1;
export const SOUTH = 2;
export const WEST = 3;
export type Seat = 0 | 1 | 2 | 3;

export const SEAT_NAMES: readonly ['north', 'east', 'south', 'west'] = [
  'north',
  'east',
  'south',
  'west',
];

/** Canonical colour per seat (RULES.md §2.4). Cosmetic — the theming agent may restyle. */
export const SEAT_COLOUR_NAMES: readonly ['purple', 'red', 'green', 'blue'] = [
  'purple',
  'red',
  'green',
  'blue',
];

/**
 * Yaw (radians, about +Y) to apply to the BOARD so that `seat`'s arm is the one
 * nearest the camera.
 *
 * The camera never moves around the board — see CameraRig.tsx for why. The
 * board turns instead, exactly as if you walked round a real table and someone
 * spun it to face you. South is the identity because the camera sits on +Z.
 */
export function boardYawForSeat(seat: Seat): number {
  return ((seat - SOUTH) * Math.PI) / 2;
}

/**
 * Where each arm points, as an angle about +Y measured from +Z (south) toward
 * +X (east). Indexed by seat: [north, east, south, west] = [pi, pi/2, 0, -pi/2].
 *
 * This is the NEGATIVE of `boardYawForSeat`, and the distinction matters:
 * `boardYawForSeat` is the rotation that brings an arm TO the camera, this is
 * the direction the arm points FROM the centre. They agree only for south.
 *
 * With `ARM_OFFSET` as the radius, the centre of an arm is at
 * `(sin(ARM_ANGLES[seat]) * ARM_OFFSET, BOARD_TOP_Y, cos(ARM_ANGLES[seat]) * ARM_OFFSET)`
 * — which is exactly what `storageSpace(seat, 1)` already gives you, so prefer
 * that unless you specifically need the polar form (the animation runner's
 * `setSceneLayout` does).
 */
export const ARM_ANGLES: readonly [number, number, number, number] = [
  Math.PI, // north, -Z
  Math.PI / 2, // east, +X
  0, // south, +Z
  -Math.PI / 2, // west, -X
];

/** Radius of an arm's centre space from the board centre. Alias of ARM_OFFSET. */
export const ARM_RADIUS = ARM_OFFSET;

export type SpaceKind = 'play' | 'storage';

export interface SpaceDef {
  /** Stable id: 'play:r,c' or 'store:north,0'. */
  id: string;
  kind: SpaceKind;
  /** Board-local centre, X and Z. Y is always BOARD_TOP_Y. */
  x: number;
  z: number;
  /** Playing spaces only: RULES.md §1.2 coordinates, row 0 = north, col 0 = west. */
  row: number | null;
  col: number | null;
  /** Playing spaces only: row * 3 + col, 0..8. */
  index: number | null;
  /** Storage spaces only: which arm. */
  arm: Seat | null;
  /**
   * Storage spaces only, 0..2. Ordered along +X for the north/south arms and
   * along +Z for the east/west arms — i.e. in board-local axis order, NOT in
   * the seated player's left-to-right. Map it in the UI if you care.
   */
  armSlot: number | null;
}

function buildSpaces(): SpaceDef[] {
  const out: SpaceDef[] = [];

  // Playing area: the central 3x3. RULES.md §1.2 — r top-to-bottom (north to
  // south), c left-to-right (west to east).
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out.push({
        id: `play:${row},${col}`,
        kind: 'play',
        x: (col - 1) * SPACE_PITCH,
        z: (row - 1) * SPACE_PITCH,
        row,
        col,
        index: row * 3 + col,
        arm: null,
        armSlot: null,
      });
    }
  }

  // Storage: three per arm.
  const arms: Array<{ arm: Seat; axis: 'x' | 'z'; sign: number }> = [
    { arm: NORTH, axis: 'z', sign: -1 },
    { arm: EAST, axis: 'x', sign: +1 },
    { arm: SOUTH, axis: 'z', sign: +1 },
    { arm: WEST, axis: 'x', sign: -1 },
  ];
  for (const { arm, axis, sign } of arms) {
    for (let slot = 0; slot < 3; slot++) {
      const along = (slot - 1) * SPACE_PITCH;
      const out_ = sign * ARM_OFFSET;
      out.push({
        id: `store:${SEAT_NAMES[arm]},${slot}`,
        kind: 'storage',
        x: axis === 'z' ? along : out_,
        z: axis === 'z' ? out_ : along,
        row: null,
        col: null,
        index: null,
        arm,
        armSlot: slot,
      });
    }
  }

  return out;
}

/** All 21 spaces. */
export const SPACES: readonly SpaceDef[] = buildSpaces();

/** The 9 playing spaces, in index order (row-major, north-west first). */
export const PLAY_SPACES: readonly SpaceDef[] = SPACES.filter((s) => s.kind === 'play').sort(
  (a, b) => (a.index ?? 0) - (b.index ?? 0),
);

/** The 12 storage spaces. */
export const STORAGE_SPACES: readonly SpaceDef[] = SPACES.filter((s) => s.kind === 'storage');

const SPACE_BY_ID = new Map(SPACES.map((s) => [s.id, s]));

export function getSpace(id: string): SpaceDef | undefined {
  return SPACE_BY_ID.get(id);
}

/** Playing space by RULES.md §1.2 coordinates. */
export function playSpace(row: number, col: number): SpaceDef {
  return PLAY_SPACES[row * 3 + col];
}

/** Playing space by 0..8 index. */
export function playSpaceAt(index: number): SpaceDef {
  return PLAY_SPACES[index];
}

export function storageSpace(arm: Seat, armSlot: number): SpaceDef {
  return SPACES.find((s) => s.arm === arm && s.armSlot === armSlot)!;
}

/**
 * Board-local transform of one slot. This is where a piece of `size` goes when
 * it is seated in `space`.
 *
 * `position` is the centre of the piece's BOTTOM FACE, which is the local
 * origin convention the Piece agent should use: build the ring/peg spanning
 * y = 0 .. PIECE_HEIGHT and place it here unmodified.
 */
export function slotTransform(
  space: SpaceDef | string,
  size: SlotSize,
): { position: [number, number, number]; radius: SlotSpec } {
  const s = typeof space === 'string' ? SPACE_BY_ID.get(space)! : space;
  return { position: [s.x, SEAT_Y, s.z], radius: SLOTS[size] };
}

/**
 * Which nested slot a point at radius `r` from a space centre is nearest.
 * Boundaries are the midpoints of the empty bands, so the answer always matches
 * what you can see.
 *
 * READ THIS BEFORE USING IT FOR INPUT. On a 360 px phone the whole board is
 * ~340 px, a space is ~63 px and the medium band is ~9 px wide. Radial hit
 * testing is a mouse affordance, not a touch one. The intended flow is the
 * physical one: pick a piece up from your arm (or from a size control), then
 * tap a space — the space is a comfortable 63 px target. `ring` is supplied as
 * a hint so pointer devices can shortcut; treat it as advisory.
 */
export function slotFromRadius(r: number): SlotSize {
  const smallMedium = (SLOTS.small.outer + SLOTS.medium.inner) / 2;
  const mediumLarge = (SLOTS.medium.outer + SLOTS.large.inner) / 2;
  if (r < smallMedium) return 'small';
  if (r < mediumLarge) return 'medium';
  return 'large';
}

/* ========================================================================== *
 * Shape helpers
 * ========================================================================== */

/**
 * Rounds every corner of a polygon with a quadratic fillet. Works for convex
 * and reflex corners alike, which is what the plus outline needs — it has eight
 * convex corners and four reflex ones.
 */
function roundedPolygon<T extends THREE.Path>(
  points: ReadonlyArray<readonly number[]>,
  radius: number,
  path: T,
): T {
  const n = points.length;
  const lerpTo = (a: readonly number[], b: readonly number[], d: number) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const t = Math.min(d, len * 0.5) / len;
    return [a[0] + dx * t, a[1] + dy * t] as const;
  };

  const first = lerpTo(points[0], points[1], radius);
  path.moveTo(first[0], first[1]);

  for (let i = 1; i <= n; i++) {
    const prev = points[(i - 1) % n];
    const corner = points[i % n];
    const next = points[(i + 1) % n];
    const inA = lerpTo(corner, prev, radius);
    const inB = lerpTo(corner, next, radius);
    path.lineTo(inA[0], inA[1]);
    path.quadraticCurveTo(corner[0], corner[1], inB[0], inB[1]);
  }

  path.closePath();
  return path;
}

/** The board's plus outline, in shape space (x, y) where shape y maps to world -z. */
function crossOutline(armHalf: number, half: number): ReadonlyArray<readonly [number, number]> {
  const a = armHalf;
  const b = half;
  return [
    [-a, -b],
    [a, -b],
    [a, -a],
    [b, -a],
    [b, a],
    [a, a],
    [a, b],
    [-a, b],
    [-a, a],
    [-b, a],
    [-b, -a],
    [-a, -a],
  ];
}

/**
 * Extrudes a flat shape into a slab lying in the XZ plane, spanning y = 0..height,
 * with a chamfer of `bevel` top and bottom.
 */
function extrudeSlab(
  shape: THREE.Shape,
  height: number,
  bevel: number,
  curveSegments = 5,
): THREE.BufferGeometry {
  const depth = Math.max(1e-4, height - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    curveSegments,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 2,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel, 0);
  return geo;
}

/**
 * Box-projects UVs from world position, choosing the projection plane per
 * vertex from its dominant normal. Top faces get a clean planar projection of
 * the bamboo grain; the slab's edges get the same grain running along them
 * rather than the infinite vertical smear a single planar projection gives.
 *
 * Normalised so that u,v = 0..1 spans the board's footprint, which is the
 * convention textures.ts assumes (its board `repeat: [1, 1]` is documented as
 * "the full 1024px across the board").
 */
function applyBoxUVs(geo: THREE.BufferGeometry, size: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  const half = size / 2;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));

    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      u = x;
      v = -z;
    } else if (nx >= nz) {
      u = z;
      v = y;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = (u + half) / size;
    uv[i * 2 + 1] = (v + half) / size;
  }

  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/* ========================================================================== *
 * The machined pocket field
 * ========================================================================== */

/**
 * Radial profile of one space, as (radius, y) with y relative to the top of the
 * pocket field. Traversed outward; each consecutive pair becomes one ring of
 * hard-edged revolution surface.
 *
 * Read it as a cross-section of the milled target:
 *
 *   0.000 .. 0.129   SMALL pocket floor      (peg r = 0.125, + clearance)
 *   0.129 .. 0.166   land, chamfered both sides
 *   0.166 .. 0.294   MEDIUM channel floor    (ring 0.170 .. 0.290, + clearance)
 *   0.294 .. 0.331   land
 *   0.331 .. 0.459   LARGE channel floor     (ring 0.335 .. 0.455, + clearance)
 *   0.459 .. 0.486   outer land, then the edge chamfers down into the slab
 */
const CHAMFER = 0.006;

function buildProfile(): ReadonlyArray<readonly [number, number]> {
  const d = -RECESS_DEPTH;
  const c = -CHAMFER;
  const k = CHAMFER;

  const sOut = SLOTS.small.outer + SLOT_CLEARANCE; // 0.129
  const mIn = SLOTS.medium.inner - SLOT_CLEARANCE; // 0.166
  const mOut = SLOTS.medium.outer + SLOT_CLEARANCE; // 0.294
  const lIn = SLOTS.large.inner - SLOT_CLEARANCE; // 0.331
  const lOut = SLOTS.large.outer + SLOT_CLEARANCE; // 0.459

  return [
    [0, d],
    [sOut, d],
    [sOut, c],
    [sOut + k, 0],
    [mIn - k, 0],
    [mIn, c],
    [mIn, d],
    [mOut, d],
    [mOut, c],
    [mOut + k, 0],
    [lIn - k, 0],
    [lIn, c],
    [lIn, d],
    [lOut, d],
    [lOut, c],
    [lOut + k, 0],
    [TARGET_RADIUS - k, 0],
    [TARGET_RADIUS, c],
    // Skirt, buried inside the slab. Never visible; exists so the pocket's
    // outer edge has somewhere to go that is not coplanar with the slab top.
    [TARGET_RADIUS, -POCKET_LIFT - 0.03],
  ] as const;
}

const PROFILE = buildProfile();

/** Baked AO. Floors go dark, walls ramp back to full by the top of the chamfer. */
const AO_FLOOR = 0.34;
function pocketAO(y: number): number {
  const t = THREE.MathUtils.smoothstep(y, -RECESS_DEPTH, -RECESS_DEPTH * 0.08);
  return AO_FLOOR + (1 - AO_FLOOR) * t;
}

/**
 * Generates all 21 machined targets as a single merged BufferGeometry: one draw
 * call, one buffer, vertex-colour AO baked in, and UVs box-projected in the
 * board's own space so the grain lines up with the slab underneath.
 */
export function createPocketFieldGeometry(
  segments = 56,
  spaces: readonly SpaceDef[] = SPACES,
  boardSize = BOARD_HALF_LENGTH * 2,
): THREE.BufferGeometry {
  const rings = PROFILE.length - 1;
  const ringVerts = segments + 1;
  const vertsPerSpace = rings * 2 * ringVerts;
  const trisPerSpace = rings * segments * 2;
  const n = spaces.length;

  const positions = new Float32Array(n * vertsPerSpace * 3);
  const normals = new Float32Array(n * vertsPerSpace * 3);
  const uvs = new Float32Array(n * vertsPerSpace * 2);
  const colors = new Float32Array(n * vertsPerSpace * 3);
  const indices = new Uint32Array(n * trisPerSpace * 3);

  const cos = new Float64Array(ringVerts);
  const sin = new Float64Array(ringVerts);
  for (let i = 0; i < ringVerts; i++) {
    const a = (i / segments) * Math.PI * 2;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }

  const half = boardSize / 2;
  let v = 0;
  let t = 0;

  for (let s = 0; s < n; s++) {
    const cx = spaces[s].x;
    const cz = spaces[s].z;

    for (let p = 0; p < rings; p++) {
      const [r0, y0] = PROFILE[p];
      const [r1, y1] = PROFILE[p + 1];
      const dr = r1 - r0;
      const dy = y1 - y0;
      const len = Math.hypot(dr, dy) || 1;
      // Outward-facing normal of a profile traversed outward.
      const nr = -dy / len;
      const ny = dr / len;

      const base = v;
      for (let k = 0; k < 2; k++) {
        const r = k === 0 ? r0 : r1;
        const y = k === 0 ? y0 : y1;
        const ao = pocketAO(y);
        for (let i = 0; i < ringVerts; i++) {
          const x = cx + r * cos[i];
          const z = cz + r * sin[i];
          const i3 = v * 3;
          positions[i3] = x;
          positions[i3 + 1] = y;
          positions[i3 + 2] = z;
          normals[i3] = nr * cos[i];
          normals[i3 + 1] = ny;
          normals[i3 + 2] = nr * sin[i];
          uvs[v * 2] = (x + half) / boardSize;
          uvs[v * 2 + 1] = (-z + half) / boardSize;
          colors[i3] = ao;
          colors[i3 + 1] = ao;
          colors[i3 + 2] = ao;
          v++;
        }
      }

      for (let i = 0; i < segments; i++) {
        const a = base + i;
        const b = base + i + 1;
        const c = base + ringVerts + i;
        const d = base + ringVerts + i + 1;
        indices[t++] = a;
        indices[t++] = b;
        indices[t++] = d;
        indices[t++] = a;
        indices[t++] = d;
        indices[t++] = c;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

/* ========================================================================== *
 * Public geometry factories
 * ========================================================================== *
 *
 * The Board component memoises and disposes these for you. They are exported
 * because the shapes are useful elsewhere — a thumbnail, a 2D overlay, a
 * physics proxy — and because a pure factory is testable without a renderer.
 * If you call one yourself, you own disposing it.
 */

/** The cross-shaped bamboo slab, chamfered, spanning y = 0 .. BOARD_THICKNESS. */
export function createBoardSlabGeometry(
  boardSize = BOARD_HALF_LENGTH * 2,
): THREE.BufferGeometry {
  const shape = roundedPolygon(
    crossOutline(ARM_HALF_WIDTH, BOARD_HALF_LENGTH),
    BOARD_CORNER_RADIUS,
    new THREE.Shape(),
  );
  const geo = extrudeSlab(shape, BOARD_THICKNESS, BOARD_EDGE_BEVEL);
  applyBoxUVs(geo, boardSize);
  return geo;
}

/** The square frame marking the 3x3 playing area (RULES.md §1.1). */
export function createPlayOutlineGeometry(
  boardSize = BOARD_HALF_LENGTH * 2,
): THREE.BufferGeometry {
  const o = PLAY_OUTLINE_RADIUS + PLAY_OUTLINE_WIDTH / 2;
  const i = PLAY_OUTLINE_RADIUS - PLAY_OUTLINE_WIDTH / 2;
  const shape = roundedPolygon(
    [
      [-o, -o],
      [o, -o],
      [o, o],
      [-o, o],
    ],
    0.1,
    new THREE.Shape(),
  );
  shape.holes.push(
    roundedPolygon(
      [
        [-i, -i],
        [i, -i],
        [i, i],
        [-i, i],
      ],
      0.07,
      new THREE.Path(),
    ),
  );
  const geo = extrudeSlab(shape, 0.012, 0.003);
  applyBoxUVs(geo, boardSize);
  return geo;
}

/* ========================================================================== *
 * Disposal
 * ========================================================================== */

function useGeometry(
  factory: () => THREE.BufferGeometry,
  deps: React.DependencyList,
): THREE.BufferGeometry {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geo = React.useMemo(factory, deps);
  React.useEffect(() => () => geo.dispose(), [geo]);
  return geo;
}

/* ========================================================================== *
 * Events
 * ========================================================================== */

export type BoardPointerEvent = ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>;

export interface SpacePointerInfo {
  space: SpaceDef;
  /** Radial distance from the space centre, in board units (0 .. ~0.71). */
  radius: number;
  /**
   * Which nested slot the pointer is over. ADVISORY — see `slotFromRadius`.
   * Null when the pointer is outside the outermost recess, i.e. on the web
   * between spaces.
   */
  slot: SlotSize | null;
  /** Offset from the space centre in board-local (x, z). */
  local: THREE.Vector2;
  event: BoardPointerEvent;
}

export interface BoardProps {
  /**
   * Radial subdivision of each machined target.
   * 64 is smooth on a desktop; 40 is indistinguishable at phone scale and cuts
   * the board's triangle count by 38%. Scene.tsx picks this from `quality`.
   */
  radialSegments?: number;

  /**
   * Selects the board tint from BOARD_TINTS. The board does not read theme
   * state — Scene threads this down from its own `theme` prop.
   */
  theme?: ThemeMode;

  /**
   * Overrides the bamboo tint for this theme. Multiplies the albedo map, so a
   * near-white value bleaches the wood; see BOARD_TINTS before reaching for it.
   */
  color?: string;

  /**
   * Colour per arm, in seat order [north, east, south, west]. When supplied, a
   * small inlaid bar is rendered at each arm tip so a player can find their own
   * side even before any piece is placed. Off by default — the palette belongs
   * to the theming agent, not to me.
   */
  armColors?: readonly [string, string, string, string] | null;

  /** Overrides the "playing area" outline tint for this theme. */
  outlineColor?: string;

  /** Render the outline around the 3x3 playing area (RULES.md §1.1). */
  showPlayOutline?: boolean;

  /** Master switch for pointer handling on the board. */
  interactive?: boolean;

  /**
   * Which spaces raise pointer events.
   * 'play' is the default and matches the rules — nothing may be placed in
   * storage (§1.1) — but the arms are exposed too for UIs that want the
   * physical "pick a piece up off your arm" gesture.
   */
  pickable?: 'play' | 'all' | 'none';

  onSpacePointerDown?: (info: SpacePointerInfo) => void;
  onSpacePointerUp?: (info: SpacePointerInfo) => void;
  /** Fires on tap/click. This is the one most consumers want. */
  onSpaceClick?: (info: SpacePointerInfo) => void;
  /** Fires continuously while the pointer is over a space. */
  onSpacePointerMove?: (info: SpacePointerInfo) => void;
  /** Fires when the pointer enters a space — per space, not per board. */
  onSpacePointerOver?: (info: SpacePointerInfo) => void;
  /** Fires when the pointer leaves a space. `space` is the one being left. */
  onSpacePointerOut?: (space: SpaceDef | null, event: ThreeEvent<PointerEvent>) => void;

  /** Rendered as children of the board group, i.e. in board-local space. */
  children?: React.ReactNode;
}

/* ========================================================================== *
 * Component
 * ========================================================================== */

const HIT_PLANE = new THREE.PlaneGeometry(1, 1);
const _localPoint = new THREE.Vector3();

export function Board({
  radialSegments = 56,
  theme = 'light',
  color,
  armColors = null,
  outlineColor,
  showPlayOutline = true,
  interactive = true,
  pickable = 'play',
  onSpacePointerDown,
  onSpacePointerUp,
  onSpaceClick,
  onSpacePointerMove,
  onSpacePointerOver,
  onSpacePointerOut,
  children,
}: BoardProps) {
  const invalidate = useThree((s) => s.invalidate);
  const boardSize = BOARD_HALF_LENGTH * 2;

  const tints = BOARD_TINTS[theme] ?? BOARD_TINTS.light;
  const bamboo = useSurfaceMaterial('board', { color: color ?? tints.base });
  const engraved = useSurfaceMaterial('board', { color: outlineColor ?? tints.line });

  const slabGeo = useGeometry(() => createBoardSlabGeometry(boardSize), [boardSize]);

  const pocketGeo = useGeometry(
    () => createPocketFieldGeometry(radialSegments, SPACES, boardSize),
    [radialSegments, boardSize],
  );

  const outlineGeo = useGeometry(() => createPlayOutlineGeometry(boardSize), [boardSize]);

  const armBarGeo = useGeometry(() => {
    const geo = extrudeSlab(
      roundedPolygon(
        [
          [-0.62, -ARM_BAR_HALF_DEPTH],
          [0.62, -ARM_BAR_HALF_DEPTH],
          [0.62, ARM_BAR_HALF_DEPTH],
          [-0.62, ARM_BAR_HALF_DEPTH],
        ],
        0.02,
        new THREE.Shape(),
      ),
      0.012,
      0.003,
      3,
    );
    applyBoxUVs(geo, boardSize);
    return geo;
  }, [boardSize]);

  /* ---- pointer plumbing ------------------------------------------------- */

  const hitSpaces = React.useMemo(() => {
    if (!interactive || pickable === 'none') return [];
    return pickable === 'all' ? SPACES : PLAY_SPACES;
  }, [interactive, pickable]);

  const describe = React.useCallback((event: BoardPointerEvent): SpacePointerInfo | null => {
    const space = event.object.userData.space as SpaceDef | undefined;
    if (!space) return null;
    // event.point is in world space, and the board group is yawed per seat, so
    // go through the hit mesh's own inverse transform rather than assuming any
    // particular orientation.
    _localPoint.copy(event.point);
    event.object.worldToLocal(_localPoint);
    // The hit plane is a unit quad in its own XY, laid flat by a -90 deg X
    // rotation, so local (x, y) maps to board-local (x, -z).
    const dx = _localPoint.x;
    const dz = -_localPoint.y;
    const radius = Math.hypot(dx, dz);
    return {
      space,
      radius,
      slot: radius <= SLOTS.large.outer + SLOT_CLEARANCE ? slotFromRadius(radius) : null,
      local: new THREE.Vector2(dx, dz),
      event,
    };
  }, []);

  /*
   * One memoised handler set, shared by all 21 pointer targets. Attaching per
   * mesh rather than to the parent group is deliberate: r3f keys hover state
   * by the object that OWNS the handler, so a single group-level handler would
   * fire pointerOver once when the pointer entered the board and never again as
   * it crossed between spaces — which is exactly the event a hover highlight
   * needs. Raycast cost is identical either way (the same 21 quads get tested),
   * and sharing the function references means no re-registration churn.
   */
  const handlers = React.useMemo(() => {
    const wrap =
      (fn: (info: SpacePointerInfo) => void) =>
      (event: BoardPointerEvent) => {
        const info = describe(event);
        if (!info) return;
        fn(info);
        invalidate();
      };

    return {
      ...(onSpacePointerDown ? { onPointerDown: wrap(onSpacePointerDown) } : null),
      ...(onSpacePointerUp ? { onPointerUp: wrap(onSpacePointerUp) } : null),
      ...(onSpaceClick ? { onClick: wrap(onSpaceClick) } : null),
      ...(onSpacePointerMove ? { onPointerMove: wrap(onSpacePointerMove) } : null),
      ...(onSpacePointerOver ? { onPointerOver: wrap(onSpacePointerOver) } : null),
      ...(onSpacePointerOut
        ? {
            onPointerOut: (event: ThreeEvent<PointerEvent>) => {
              onSpacePointerOut(
                (event.object?.userData?.space as SpaceDef | undefined) ?? null,
                event,
              );
              invalidate();
            },
          }
        : null),
    };
  }, [
    describe,
    invalidate,
    onSpacePointerDown,
    onSpacePointerUp,
    onSpaceClick,
    onSpacePointerMove,
    onSpacePointerOver,
    onSpacePointerOut,
  ]);

  return (
    <group name="otrio-board">
      {/* The slab. The only part of the board that casts. */}
      <mesh geometry={slabGeo} castShadow receiveShadow name="board-slab">
        <meshStandardMaterial {...bamboo} />
      </mesh>

      {/*
        All 21 machined targets, one draw call. Does not cast: a 4 mm groove is
        far below any affordable shadow map's resolution, so casting would buy
        acne rather than depth. Depth comes from the baked vertex AO. It does
        receive, so pieces drop real shadows into their recesses.
      */}
      <mesh
        geometry={pocketGeo}
        position={[0, BOARD_TOP_Y + POCKET_LIFT, 0]}
        receiveShadow
        name="board-pockets"
      >
        <meshStandardMaterial {...bamboo} vertexColors />
      </mesh>

      {showPlayOutline && (
        <mesh
          geometry={outlineGeo}
          position={[0, BOARD_TOP_Y - 0.004, 0]}
          receiveShadow
          name="board-play-outline"
        >
          <meshStandardMaterial {...engraved} />
        </mesh>
      )}

      {armColors &&
        ([NORTH, EAST, SOUTH, WEST] as Seat[]).map((seat) => {
          const along = ARM_BAR_OFFSET;
          const vertical = seat === NORTH || seat === SOUTH;
          const sign = seat === NORTH || seat === WEST ? -1 : 1;
          return (
            <mesh
              key={seat}
              geometry={armBarGeo}
              position={[vertical ? 0 : sign * along, BOARD_TOP_Y - 0.004, vertical ? sign * along : 0]}
              rotation={[0, vertical ? 0 : Math.PI / 2, 0]}
              receiveShadow
              name={`board-arm-${SEAT_NAMES[seat]}`}
            >
              <meshStandardMaterial
                color={armColors[seat]}
                roughness={0.45}
                metalness={0}
                envMapIntensity={0.8}
              />
            </mesh>
          );
        })}

      {/*
        Pointer targets. One handler set on the group — events bubble, so the
        r3f event system only tracks a single interaction object while
        `event.object` still identifies the exact space that was hit.

        `material.visible = false` (not `mesh.visible = false`): the renderer
        skips the draw entirely, so these cost zero draw calls, while the
        raycaster still sees them. Setting the object invisible instead would
        cost the same nothing and break picking.
      */}
      {hitSpaces.length > 0 && (
        <group name="board-hit">
          {hitSpaces.map((space) => (
            <mesh
              key={space.id}
              {...handlers}
              geometry={HIT_PLANE}
              position={[space.x, BOARD_TOP_Y + 0.02, space.z]}
              rotation={[-Math.PI / 2, 0, 0]}
              userData={{ space }}
              name={`hit-${space.id}`}
            >
              <meshBasicMaterial visible={false} />
            </mesh>
          ))}
        </group>
      )}

      {children}
    </group>
  );
}

export default Board;
