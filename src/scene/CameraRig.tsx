/**
 * CameraRig.tsx — the camera. There is no OrbitControls here, on purpose.
 *
 * ============================================================================
 * THE DECISION, AND THE ARGUMENT FOR IT
 * ============================================================================
 *
 * Fixed pitch, fixed azimuth, no user-controllable orbit. The board turns to
 * face each player; the camera never moves.
 *
 * 1. FREE ORBIT IS A BUG IN THIS GAME, NOT A FEATURE.
 *
 *    Otrio is won by reading 8 lines across a 3x3 grid, plus the concentric
 *    win. Every one of those reads is a *spatial* judgement made in under a
 *    second. An orbit control lets a player put the board at 8 degrees of
 *    elevation where the far row hides behind the near one, or at 45 degrees of
 *    azimuth where rows and columns become two indistinguishable sets of
 *    diagonals. Worse, it lets them do it by accident mid-move, on a
 *    touchscreen, with the same finger they place pieces with. There is no
 *    state of the orbit control that is better for the player than the framing
 *    we can compute for them, and many that are much worse.
 *
 * 2. THE BOARD ROTATES, NOT THE CAMERA.
 *
 *    RULES.md §2.4 fixes the seating from the official setup artwork: purple
 *    north, red east, green south, blue west. Each player should see their own
 *    arm nearest them, exactly as at a real table. There are two ways to do it
 *    and only one is right.
 *
 *    If the camera orbited to the player's side, the key light would stay put
 *    in world space, so the player at north would get a backlit board with its
 *    shadows pointing at them and its specular highlights on the far edge. Four
 *    players would be looking at four differently-lit boards, and one of them
 *    would be looking at the worst one.
 *
 *    Rotating the board instead (Scene.tsx does this, via
 *    `boardYawForSeat`) keeps the camera and every light fixed, so all four
 *    players get pixel-identical framing and pixel-identical lighting. The
 *    board is 4-fold symmetric, so nothing is lost. This is also what actually
 *    happens at a table: you do not walk around the board, someone spins it.
 *
 * 3. AZIMUTH 0, NOT A CORNER THREE-QUARTER.
 *
 *    A 45-degree corner view is the prettier product shot, and it is the wrong
 *    call here. It turns the rows and columns into diagonals, so reading a line
 *    means reading a diagonal, and it inscribes a diamond in a rectangular
 *    viewport, which throws away roughly 30% of the screen on a device that has
 *    360 CSS pixels to give. Straight-on keeps rows horizontal and columns
 *    vertical, keeps the board's silhouette rectangular, and stays symmetric —
 *    which matters when four people are comparing the same position. The
 *    "three-quarter" character comes from the vertical tilt, and from the
 *    parallax below, not from yaw.
 *
 * 4. THE PITCH IS DERIVED FROM THE VIEWPORT, NOT PICKED.
 *
 *    The board's footprint is square. Seen from elevation p it projects to a
 *    rectangle of aspect 1/sin(p). So the elevation that exactly fills a
 *    viewport of aspect A is asin(1/A) — and that is the formula, clamped to
 *    [34, 52] degrees. On a 16:9 landscape viewport it lands near 34 and the
 *    board fills the width; on a portrait phone it clamps at 52 and the board
 *    fills a band across the middle with the racks and status above and below.
 *    A single constant pitch cannot do both.
 *
 *    The clamps are load-bearing. Below ~34 the near row's pieces start
 *    occluding the row behind. Above ~52 the recesses stop reading and the
 *    thing looks like a flat graphic, which is the one outcome the brief
 *    forbids.
 *
 * 5. PARALLAX INSTEAD OF CONTROL.
 *
 *    What actually sells depth on a small screen is motion, not freedom. A
 *    bounded pointer parallax (+/- 3.5 degrees of yaw, +/- 2 of pitch, spring
 *    back to centre) gives that for free and cannot reach a bad angle. It is on
 *    for mouse pointers and OFF for touch by default, because on a touchscreen
 *    the only pointermove events are drags, and a drag is how you place a
 *    piece — the camera must not move under the finger that is aiming.
 *
 * ============================================================================
 * FITTING — how 360px to ultrawide all work
 * ============================================================================
 *
 * `computeFraming` is a pure function (exported, trivially testable) that
 * solves the exact fit: it takes the board's AABB, projects all 8 corners onto
 * the camera basis and solves for the smallest distance at which every corner
 * is inside both the horizontal and the vertical frustum. No bounding-sphere
 * approximation, so wide viewports do not waste half the screen.
 *
 * It also takes `insets` in CSS pixels. This is the important part of the API
 * for whoever owns the UI: tell the rig "I am covering the bottom 180 px with a
 * rack and the top 56 px with a status bar" and the board is fitted and centred
 * in what is left, rather than fitted to the whole canvas and then half hidden.
 * The rig offsets the camera along its own right/up axes to recentre, which is
 * a truck, not a pan, so the board's shape on screen is unchanged.
 */

import * as React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { BOARD_BOUNDS, BOARD_FIT_POINTS } from './Board';

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export interface FramingOptions {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /** UI-occluded margins in CSS pixels. The board is fitted to what is left. */
  insets: Insets;
  /** Where the camera aims, and the origin the fit is measured from. */
  center: readonly [number, number, number];
  /** Fallback fit volume, used when `points` is not supplied. */
  halfExtents: readonly [number, number, number];
  /**
   * The exact silhouette to frame, in the same space as `center`. Preferred —
   * an AABB over a cross-shaped board wastes screen on corners that are not
   * there. See Board.tsx's BOARD_FIT_POINTS.
   */
  points?: ReadonlyArray<readonly [number, number, number]>;
  /**
   * Horizontal half-angle the *inset rect* should subtend, in degrees.
   * This is the perspective-strength dial: bigger is a wider lens and a more
   * dramatic board, smaller is flatter and more diagrammatic. 18 is a mild
   * product-shot lens.
   */
  baseHalfAngleDeg: number;
  /** Clamps on the inset rect's vertical field of view. */
  minInsetFovDeg: number;
  maxInsetFovDeg: number;
  minPitchDeg: number;
  maxPitchDeg: number;
  /** Override the derived pitch entirely. */
  pitchDeg?: number;
  azimuthDeg: number;
  /** Fraction of slack around the board. 0.06 = 6% breathing room. */
  padding: number;
  /** >1 pushes in (and will crop). 1 fits the whole board. */
  zoom: number;
  minDistance: number;
  maxDistance: number;
}

export interface Framing {
  /** Vertical field of view for the FULL canvas, in degrees. */
  fovDeg: number;
  pitchDeg: number;
  azimuthDeg: number;
  distance: number;
  target: [number, number, number];
  position: [number, number, number];
  /** Half-tangents of the inset rect. Exposed for tests. */
  tanHalfInsetH: number;
  tanHalfInsetV: number;
  /** Pixel offsets used to recentre into the inset rect. */
  offsetPxX: number;
  offsetPxY: number;
  /** World units per CSS pixel per unit of camera distance, at the target plane. */
  unitsPerPxPerDistance: number;
}

/**
 * Basis vectors for a camera at `azimuth`/`pitch` looking at a target.
 * `dir` points FROM the target TOWARD the camera.
 */
function basis(pitchDeg: number, azimuthDeg: number) {
  const p = pitchDeg * DEG;
  const a = azimuthDeg * DEG;
  const cp = Math.cos(p);
  const dir = new THREE.Vector3(Math.sin(a) * cp, Math.sin(p), Math.cos(a) * cp).normalize();

  const right = new THREE.Vector3(dir.z, 0, -dir.x);
  if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
  right.normalize();

  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  return { dir, right, up };
}

/** Pure. Given a viewport and a box, produce the camera pose that frames it. */
export function computeFraming(o: FramingOptions): Framing {
  const W = Math.max(1, o.width);
  const H = Math.max(1, o.height);

  // Guard against a UI that claims more than the viewport.
  const maxInsetX = W * 0.75;
  const maxInsetY = H * 0.75;
  const scaleX = Math.min(1, maxInsetX / Math.max(1e-6, o.insets.left + o.insets.right));
  const scaleY = Math.min(1, maxInsetY / Math.max(1e-6, o.insets.top + o.insets.bottom));
  const l = Math.max(0, o.insets.left) * scaleX;
  const r = Math.max(0, o.insets.right) * scaleX;
  const t = Math.max(0, o.insets.top) * scaleY;
  const b = Math.max(0, o.insets.bottom) * scaleY;

  const Wi = Math.max(1, W - l - r);
  const Hi = Math.max(1, H - t - b);
  const aspectInset = Wi / Hi;

  // Pitch: the elevation whose foreshortening matches the viewport's shape.
  // A square board seen from elevation p projects to aspect 1 / sin(p).
  const foreshorten = clamp(1 / aspectInset, 0, 1);
  const idealPitch = Number.isFinite(foreshorten)
    ? Math.asin(foreshorten) / DEG
    : o.maxPitchDeg;
  const pitchDeg =
    o.pitchDeg !== undefined ? o.pitchDeg : clamp(idealPitch, o.minPitchDeg, o.maxPitchDeg);

  // Field of view: hold the inset rect's horizontal angle roughly constant so
  // perspective strength feels the same on every device, then clamp vertically.
  let tanV = Math.tan(o.baseHalfAngleDeg * DEG) / aspectInset;
  tanV = clamp(
    tanV,
    Math.tan((o.minInsetFovDeg / 2) * DEG),
    Math.tan((o.maxInsetFovDeg / 2) * DEG),
  );
  const tanH = tanV * aspectInset;
  const fovDeg = (2 * Math.atan((tanV * H) / Hi)) / DEG;

  const { dir, right, up } = basis(pitchDeg, o.azimuthDeg);

  // Exact fit: every point must sit inside both frustum planes. Solving each
  // point for the distance that just contains it and taking the max is exact —
  // no bounding-sphere slack, so wide viewports are not half empty.
  const pad = 1 / (1 + Math.max(0, o.padding));
  const th = tanH * pad;
  const tv = tanV * pad;
  let distance = 0;
  const v = new THREE.Vector3();

  const consider = () => {
    const x = Math.abs(v.dot(right));
    const y = Math.abs(v.dot(up));
    const z = v.dot(dir);
    const needH = z + x / th;
    const needV = z + y / tv;
    if (needH > distance) distance = needH;
    if (needV > distance) distance = needV;
  };

  if (o.points && o.points.length > 0) {
    for (const p of o.points) {
      v.set(p[0] - o.center[0], p[1] - o.center[1], p[2] - o.center[2]);
      consider();
    }
  } else {
    const [hx, hy, hz] = o.halfExtents;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz);
      consider();
    }
  }

  distance = clamp(distance / Math.max(0.05, o.zoom), o.minDistance, o.maxDistance);

  // Recentre into the inset rect by trucking the camera and its target together.
  const offsetPxX = (l - r) / 2;
  const offsetPxY = (t - b) / 2;
  const unitsPerPxPerDistance = (2 * tanV) / Hi;
  const upp = distance * unitsPerPxPerDistance;

  const target = new THREE.Vector3(o.center[0], o.center[1], o.center[2])
    .addScaledVector(right, -offsetPxX * upp)
    .addScaledVector(up, offsetPxY * upp);

  const position = target.clone().addScaledVector(dir, distance);

  return {
    fovDeg,
    pitchDeg,
    azimuthDeg: o.azimuthDeg,
    distance,
    target: [target.x, target.y, target.z],
    position: [position.x, position.y, position.z],
    tanHalfInsetH: tanH,
    tanHalfInsetV: tanV,
    offsetPxX,
    offsetPxY,
    unitsPerPxPerDistance,
  };
}

/* ========================================================================== *
 * Defaults
 * ========================================================================== */

export const CAMERA_DEFAULTS = {
  baseHalfAngleDeg: 18,
  minInsetFovDeg: 30,
  maxInsetFovDeg: 58,
  minPitchDeg: 34,
  maxPitchDeg: 52,
  azimuthDeg: 0,
  padding: 0.06,
  zoom: 1,
  minDistance: 3,
  maxDistance: 40,
  near: 0.8,
  far: 220,
  /** Max parallax excursion, degrees. */
  parallaxYawDeg: 3.5,
  parallaxPitchDeg: 2,
  introMs: 720,
} as const;

/* ========================================================================== *
 * Component
 * ========================================================================== */

export interface CameraRigProps {
  /** UI-occluded margins in CSS pixels. See the header — this is the main knob. */
  insets?: Partial<Insets>;
  /** What to aim at. Defaults to the centre of the board plus piece height. */
  center?: readonly [number, number, number];
  /** Fallback fit volume when `fitPoints` is cleared. */
  halfExtents?: readonly [number, number, number];
  /**
   * The silhouette to frame. Defaults to the board's real cross outline; pass
   * your own (or `[]` to fall back to the AABB) if you are framing something
   * else entirely.
   */
  fitPoints?: ReadonlyArray<readonly [number, number, number]>;

  /** Force a pitch instead of deriving it from the viewport. Degrees above the table. */
  pitchDeg?: number;
  /** Yaw. 0 (straight on) is the default, and the header argues for keeping it. */
  azimuthDeg?: number;

  /** >1 pushes in and crops the storage arms. Animate it for a "focus on play" mode. */
  zoom?: number;
  padding?: number;
  baseHalfAngleDeg?: number;
  minPitchDeg?: number;
  maxPitchDeg?: number;
  minDistance?: number;
  maxDistance?: number;
  near?: number;
  far?: number;

  /**
   * Pointer parallax strength, 0..1. 'auto' is 1 for fine pointers and 0 for
   * coarse ones — on touch the only pointermove is a drag, and a drag is how a
   * piece gets placed.
   */
  parallax?: number | 'auto';

  /** Ease the camera in on mount. Set false if the app has its own transition. */
  intro?: boolean;
  introMs?: number;

  /** Fires whenever the framing is recomputed. Useful for debug overlays. */
  onFraming?: (framing: Framing) => void;
}

export function CameraRig({
  insets,
  center = BOARD_BOUNDS.center,
  halfExtents = BOARD_BOUNDS.halfExtents,
  fitPoints = BOARD_FIT_POINTS,
  pitchDeg,
  azimuthDeg = CAMERA_DEFAULTS.azimuthDeg,
  zoom = CAMERA_DEFAULTS.zoom,
  padding = CAMERA_DEFAULTS.padding,
  baseHalfAngleDeg = CAMERA_DEFAULTS.baseHalfAngleDeg,
  minPitchDeg = CAMERA_DEFAULTS.minPitchDeg,
  maxPitchDeg = CAMERA_DEFAULTS.maxPitchDeg,
  minDistance = CAMERA_DEFAULTS.minDistance,
  maxDistance = CAMERA_DEFAULTS.maxDistance,
  near = CAMERA_DEFAULTS.near,
  far = CAMERA_DEFAULTS.far,
  parallax = 'auto',
  intro = true,
  introMs = CAMERA_DEFAULTS.introMs,
  onFraming,
}: CameraRigProps) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);

  const parallaxStrength = React.useMemo(() => {
    if (typeof parallax === 'number') return clamp(parallax, 0, 1);
    if (typeof window === 'undefined' || !window.matchMedia) return 0;
    return window.matchMedia('(pointer: fine)').matches ? 1 : 0;
  }, [parallax]);

  const framing = React.useMemo(
    () =>
      computeFraming({
        width: size.width,
        height: size.height,
        insets: { ...NO_INSETS, ...insets },
        center,
        halfExtents,
        points: fitPoints,
        baseHalfAngleDeg,
        minInsetFovDeg: CAMERA_DEFAULTS.minInsetFovDeg,
        maxInsetFovDeg: CAMERA_DEFAULTS.maxInsetFovDeg,
        minPitchDeg,
        maxPitchDeg,
        pitchDeg,
        azimuthDeg,
        padding,
        zoom,
        minDistance,
        maxDistance,
      }),
    [
      size.width,
      size.height,
      insets?.top,
      insets?.right,
      insets?.bottom,
      insets?.left,
      center,
      halfExtents,
      fitPoints,
      baseHalfAngleDeg,
      minPitchDeg,
      maxPitchDeg,
      pitchDeg,
      azimuthDeg,
      padding,
      zoom,
      minDistance,
      maxDistance,
    ],
  );

  /* ---- animated state (never triggers a React render) ------------------- */

  const anim = React.useRef({
    yaw: 0,
    pitch: 0,
    yawTarget: 0,
    pitchTarget: 0,
    introStart: 0,
    introDone: !intro,
  });

  const scratch = React.useRef({
    target: new THREE.Vector3(),
    position: new THREE.Vector3(),
  });

  const apply = React.useCallback(
    (f: Framing, yawOffset: number, pitchOffset: number, distanceScale: number) => {
      const { dir, right, up } = basis(f.pitchDeg + pitchOffset, f.azimuthDeg + yawOffset);
      const distance = f.distance * distanceScale;
      const upp = distance * f.unitsPerPxPerDistance;

      const target = scratch.current.target
        .set(center[0], center[1], center[2])
        .addScaledVector(right, -f.offsetPxX * upp)
        .addScaledVector(up, f.offsetPxY * upp);

      const position = scratch.current.position.copy(target).addScaledVector(dir, distance);

      camera.position.copy(position);
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
      camera.fov = f.fovDeg;
      camera.aspect = Math.max(1e-6, size.width / Math.max(1, size.height));
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    },
    [camera, center, size.width, size.height, near, far],
  );

  // Place the camera synchronously before the first paint so there is never a
  // frame at the default pose.
  React.useLayoutEffect(() => {
    const a = anim.current;
    if (intro && !a.introDone && a.introStart === 0) {
      a.introStart = performance.now();
    }
    apply(framing, a.yaw, a.pitch, a.introDone ? 1 : 1.14);
    onFraming?.(framing);
    invalidate();
  }, [framing, apply, invalidate, onFraming, intro]);

  /* ---- parallax --------------------------------------------------------- */

  React.useEffect(() => {
    if (parallaxStrength <= 0) return;
    const el = gl.domElement;

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const nx = clamp(((e.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
      const ny = clamp(((e.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
      // Pointer right -> board yaws as if you leaned right.
      anim.current.yawTarget = -nx * CAMERA_DEFAULTS.parallaxYawDeg * parallaxStrength;
      anim.current.pitchTarget = -ny * CAMERA_DEFAULTS.parallaxPitchDeg * parallaxStrength;
      invalidate();
    };
    const onLeave = () => {
      anim.current.yawTarget = 0;
      anim.current.pitchTarget = 0;
      invalidate();
    };

    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave, { passive: true });
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      onLeave();
    };
  }, [gl, parallaxStrength, invalidate]);

  /* ---- the settle loop -------------------------------------------------- */

  /*
   * Under frameloop="demand" useFrame only runs on frames somebody asked for.
   * So each tick damps a little and, if it has not arrived yet, asks for one
   * more. The loop is self-terminating: when the camera reaches its target and
   * the intro is over, nothing invalidates and the renderer goes idle at zero
   * cost until the next input. This is the single biggest battery decision in
   * the scene.
   */
  useFrame((_, delta) => {
    const a = anim.current;
    let changed = false;

    let distanceScale = 1;
    if (!a.introDone) {
      const t = clamp((performance.now() - a.introStart) / Math.max(1, introMs), 0, 1);
      const e = 1 - Math.pow(1 - t, 3);
      distanceScale = 1.14 + (1 - 1.14) * e;
      if (t >= 1) a.introDone = true;
      changed = true;
    }

    if (a.yaw !== a.yawTarget || a.pitch !== a.pitchTarget) {
      // Frame-rate independent exponential damping.
      const k = 1 - Math.exp(-Math.min(delta, 0.1) * 9);
      a.yaw += (a.yawTarget - a.yaw) * k;
      a.pitch += (a.pitchTarget - a.pitch) * k;
      if (Math.abs(a.yawTarget - a.yaw) < 0.01 && Math.abs(a.pitchTarget - a.pitch) < 0.01) {
        a.yaw = a.yawTarget;
        a.pitch = a.pitchTarget;
      }
      changed = true;
    }

    if (changed) {
      apply(framing, a.yaw, a.pitch, distanceScale);
      // Ask for the frame that will show what we just applied. When nothing
      // changes this is not reached and the renderer goes idle.
      invalidate();
    }
  });

  return null;
}

export default CameraRig;
