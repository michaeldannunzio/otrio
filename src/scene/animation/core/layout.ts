/**
 * Scene geometry the animation layer needs but does not own.
 *
 * The board, its cross arms and the piece proportions belong to the scene and
 * pieces agents. Hard-coding world units here would guarantee a mismatch the
 * first time someone resizes the board, so instead the scene registers its
 * geometry once and every spatial token in `timing.ts` is interpreted as a
 * FRACTION OF A GRID SPACE PITCH.
 *
 * A drop height of `0.42` therefore means "42% of one space", which stays
 * correct at any board scale, on any screen, forever.
 */

export interface SceneLayout {
  /**
   * Centre-to-centre distance between two adjacent playing spaces, in world
   * units. This is the master scale for every animation amplitude.
   */
  spacePitch: number;

  /**
   * Y of the board's top surface. Animations that drop a piece in aim at
   * `restingY` supplied per piece; this is only used for board-level effects
   * like impact rings and sweeps, which must sit just proud of the surface.
   */
  surfaceY: number;

  /**
   * Angle of each colour's storage arm, in radians, indexed by colour.
   *
   * The convention is `theta = Math.atan2(armX, armZ)`, i.e. theta = 0 points
   * at +Z and rotates toward +X. So the arm centre is at
   * `(sin(theta) * armRadius, cos(theta) * armRadius)`, which is exactly how
   * `playPlacement` reconstructs it when flying a remote player's piece in.
   *
   * `scene/Board.tsx` places the arms at NORTH = -Z, EAST = +X, SOUTH = +Z,
   * WEST = -X, and colours are numbered purple(N) red(E) green(S) blue(W), so
   * the correct values are [PI, PI/2, 0, -PI/2]. Note that north is PI, not 0 —
   * getting this backwards silently sends every remote piece in from the wrong
   * side of the table, which still looks plausible and is therefore easy to
   * miss.
   */
  armAngle: [number, number, number, number];

  /** Radius from board centre to the middle of a storage arm. */
  armRadius: number;
}

/**
 * Defaults mirroring the published constants in `scene/Board.tsx`
 * (`SPACE_PITCH`, `BOARD_TOP_Y`, `ARM_OFFSET`) as of the board's current
 * geometry.
 *
 * They are duplicated rather than imported on purpose: importing the board
 * module would pull React and its geometry builders into every file that wants
 * to know how big a space is, including ones that run before the canvas exists.
 * The scene owns the truth and should call `setSceneLayout` at mount; these
 * values only make the system correct in the window before it does, and if the
 * board is ever rescaled only that one call has to change.
 *
 * The arm angles are North, East, South, West, which is exactly `PlayerId`
 * order — purple(N), red(E), green(S), blue(W) — per RULES.md §4.8, resolved
 * against Board.tsx's actual axes (north is -Z).
 */
const DEFAULT: SceneLayout = {
  spacePitch: 1,
  surfaceY: 0.26,
  armAngle: [Math.PI, Math.PI / 2, 0, -Math.PI / 2],
  armRadius: 2.12,
};

export const LAYOUT: SceneLayout = { ...DEFAULT };

/**
 * Called once by the scene when the board is built, and again if it rescales.
 * Partial so the scene can supply what it knows and let the rest default.
 */
export function setSceneLayout(patch: Partial<SceneLayout>): void {
  if (patch.spacePitch !== undefined && patch.spacePitch > 0) LAYOUT.spacePitch = patch.spacePitch;
  if (patch.surfaceY !== undefined) LAYOUT.surfaceY = patch.surfaceY;
  if (patch.armRadius !== undefined) LAYOUT.armRadius = patch.armRadius;
  if (patch.armAngle) LAYOUT.armAngle = [...patch.armAngle] as SceneLayout['armAngle'];
}

/** Convert a space-pitch fraction into world units. */
export function u(fraction: number): number {
  return fraction * LAYOUT.spacePitch;
}

/** Arm angle for a colour, in radians. */
export function armAngleOf(player: number): number {
  return LAYOUT.armAngle[player] ?? 0;
}

/**
 * Shortest signed angular delta from `a` to `b`, in radians (-PI..PI].
 *
 * The turn sweep uses this so it always takes the short way round the board.
 * Sweeping 270 degrees to reach the player on your left looks like the game
 * lost track of whose turn it was.
 */
export function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
