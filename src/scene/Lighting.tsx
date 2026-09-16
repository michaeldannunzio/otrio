/**
 * Lighting.tsx — environment, key, fill, rim, tone mapping and fog.
 *
 * ============================================================================
 * THEMING CONTRACT — read this if you own theming
 * ============================================================================
 *
 * This module never reads theme state. It takes a `theme` prop ('light' |
 * 'dark') which selects a preset, and every individual value in that preset can
 * be overridden by its own prop. So:
 *
 *     <Scene theme={myThemeStore.mode} />                      // normal case
 *     <Scene theme="dark" lighting={{ keyIntensity: 2.2 }} />  // tweak one knob
 *
 * `LIGHTING_PRESETS` is exported so the values here are inspectable rather than
 * buried. Ownership, so nothing ends up with two sources of truth:
 *
 *   - LIGHT RIG (intensities, colours, exposure, fog distances): ours. They are
 *     derived from this scene's camera distances, board scale and table size,
 *     which the theme layer has no way to know.
 *   - BACKGROUND / FOG COLOUR: `styles/tokens.ts` `sceneBg` is canonical. It is
 *     what the CSS behind the canvas paints, and a mismatch is a visible seam
 *     at the canvas edge. Our defaults mirror it; pass it explicitly to be sure.
 *   - BOARD TINT: `Board.tsx`'s `BOARD_TINTS`, which explains why it is not the
 *     theme's `scene.board.base`.
 *   - PLAYER COLOURS: the theme's `players[]`, always. Nothing here hardcodes
 *     one; `Scene`'s optional `armColors` prop takes them from the caller.
 *
 * ============================================================================
 * WHY THE ENVIRONMENT MAP IS BUILT HERE INSTEAD OF LOADED
 * ============================================================================
 *
 * PBR without an environment map looks like clay. drei's <Environment> can fetch
 * an HDRI or render a portal scene, but both are wrong here:
 *
 *   - `preset="..."` downloads a multi-megabyte HDRI from a CDN. That is a
 *     network dependency on the critical path, on phones, for a board game.
 *   - The portal form needs N actually-rendered frames to bake, and this scene
 *     runs `frameloop="demand"` — so the bake races the invalidation schedule.
 *
 * Instead we build a small studio (a softbox overhead, a cool panel on one
 * side, a warm one on the other, a floor bounce, a dim shell) and hand it to
 * PMREMGenerator.fromScene once, imperatively. That is synchronous, ~5 ms,
 * network-free, independent of the frame loop, and it is *art directed* — the
 * warm/cool split across the board's two sides is what stops the bamboo looking
 * like plastic, and the overhead softbox is what draws the specular streak
 * across the moulded pieces that RULES.md §9 asks for.
 *
 * ============================================================================
 * SHADOWS
 * ============================================================================
 *
 * Exactly one shadow-casting light. A second one would double the shadow pass
 * for a cue nobody can read on a 6" screen. The key is placed up-back-left so
 * shadows fall toward the viewer's lower right: short (the pieces are only 6 mm
 * proud), clearly visible, and never long enough to cross into a neighbouring
 * space and be mistaken for a piece.
 *
 * The shadow camera is clamped to the board rather than the table. 3.75 is not
 * a guess: it is the smallest half-extent that contains the cross's arm tips
 * AND the shadows they throw onto the cloth, measured in the key light's own
 * basis. (3.1 — roughly the board's half-diagonal — looks right and clips the
 * north and east arms.) At the default 1024 that is 7.5 units across 1024
 * texels, 0.53 mm per texel at the board's real scale, which resolves a piece's
 * contact edge cleanly. 512, the mobile default, is 1.05 mm and still fine
 * because the shadows in question are only ~4 mm long.
 *
 * Change `keyDirection` and you may need to change `shadowBounds` with it.
 */

import * as React from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { BOARD_TOP_Y, type ThemeMode } from './Board';

// Declared in Board.tsx (which this module already depends on) so there is one
// definition; re-exported here because this is where callers expect it.
export type { ThemeMode };

/* ========================================================================== *
 * Presets
 * ========================================================================== */

interface EnvPanel {
  /** Linear RGB. Values above 1 are intentional — this is an HDR probe. */
  rgb: [number, number, number];
  size: [number, number];
  position: [number, number, number];
}

export interface LightingPreset {
  /**
   * Canvas clear colour, and by default the fog colour too.
   *
   * These MIRROR `styles/tokens.ts`'s `sceneBg`, which is canonical — it is
   * what the CSS behind and around the canvas uses, and any disagreement shows
   * up as a hard seam at the canvas edge. We cannot import it (this directory
   * takes theme input as props and never reads theme state), so the safest
   * wiring is for the host to pass it explicitly and make the question moot:
   *
   *     const scene = useSceneTheme();
   *     <Scene lighting={{ background: scene.background, fog: scene.fog }} />
   *
   * Until it does, these defaults match tokens.ts as of writing.
   */
  background: string;
  exposure: number;
  environmentIntensity: number;
  keyIntensity: number;
  keyColor: string;
  fillSky: string;
  fillGround: string;
  fillIntensity: number;
  rimIntensity: number;
  rimColor: string;
  ambientIntensity: number;
  /** Linear RGB of the enclosing shell — the floor of the whole lighting range. */
  shellRgb: [number, number, number];
  /** Multiplier on every studio panel. */
  panelGain: number;
  fogNear: number;
  fogFar: number;
}

export const LIGHTING_PRESETS: Readonly<Record<ThemeMode, LightingPreset>> = {
  light: {
    background: '#cbd3e0', // = tokens.ts light.sceneBg
    exposure: 1.0,
    environmentIntensity: 1.0,
    keyIntensity: 2.5,
    keyColor: '#fff6e8',
    fillSky: '#cfe0f0',
    fillGround: '#6b6256',
    fillIntensity: 0.55,
    rimIntensity: 0.35,
    rimColor: '#dce8ff',
    ambientIntensity: 0.06,
    shellRgb: [0.17, 0.18, 0.2],
    panelGain: 1,
    fogNear: 14,
    fogFar: 28,
  },
  dark: {
    background: '#090c11', // = tokens.ts dark.sceneBg
    exposure: 0.98,
    environmentIntensity: 0.46,
    keyIntensity: 1.85,
    keyColor: '#ffeeda',
    fillSky: '#2b3a4a',
    fillGround: '#161412',
    fillIntensity: 0.3,
    rimIntensity: 0.6,
    rimColor: '#9fc4ff',
    ambientIntensity: 0.03,
    shellRgb: [0.022, 0.026, 0.032],
    panelGain: 0.72,
    fogNear: 12,
    fogFar: 24,
  },
};

/**
 * The studio. Positions are in scene units; the board is 5.4 across, so these
 * panels sit comfortably outside it and read as a room rather than as objects.
 */
const STUDIO_PANELS: readonly EnvPanel[] = [
  // Overhead softbox — the main source, and the one whose reflection you see
  // sweeping across the top of every ring.
  { rgb: [3.7, 3.6, 3.35], size: [9, 9], position: [0, 6.2, -0.6] },
  // Cool panel, viewer's left. Keeps the shadow side from going dead.
  { rgb: [1.15, 1.35, 1.75], size: [7, 6], position: [-6.2, 1.8, 2.4] },
  // Warm panel, viewer's right. The warm/cool split is what makes the bamboo
  // read as wood rather than as brown plastic.
  { rgb: [1.7, 1.42, 1.12], size: [6, 5], position: [6.4, 2.2, -1.4] },
  // Floor bounce.
  { rgb: [0.42, 0.4, 0.37], size: [12, 12], position: [0, -4.2, 0] },
];

/* ========================================================================== *
 * Environment
 * ========================================================================== */

function buildStudioScene(shellRgb: [number, number, number], gain: number): THREE.Scene {
  const scene = new THREE.Scene();

  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(24, 24, 24),
    new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      toneMapped: false,
      color: new THREE.Color().setRGB(
        shellRgb[0],
        shellRgb[1],
        shellRgb[2],
        THREE.LinearSRGBColorSpace,
      ),
    }),
  );
  scene.add(shell);

  for (const panel of STUDIO_PANELS) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(panel.size[0], panel.size[1]),
      new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        toneMapped: false,
        color: new THREE.Color().setRGB(
          panel.rgb[0] * gain,
          panel.rgb[1] * gain,
          panel.rgb[2] * gain,
          THREE.LinearSRGBColorSpace,
        ),
      }),
    );
    mesh.position.set(...panel.position);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  }

  return scene;
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

/**
 * Bakes the studio into `scene.environment`. Synchronous, once per theme.
 * Exported in case anything else wants the same probe.
 */
export function useStudioEnvironment(
  shellRgb: [number, number, number],
  panelGain: number,
  intensity: number,
  enabled = true,
) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);

  const key = `${shellRgb.join(',')}|${panelGain}`;

  React.useEffect(() => {
    if (!enabled) return;
    const pmrem = new THREE.PMREMGenerator(gl);
    const studio = buildStudioScene(shellRgb, panelGain);
    // sigma 0.02 softens the panel edges just enough that the specular streak
    // on a ring is a highlight rather than a visible rectangle, without
    // dissolving the softbox into flat ambience.
    const target = pmrem.fromScene(studio, 0.02, 0.1, 60);
    const previous = scene.environment;
    scene.environment = target.texture;
    disposeScene(studio);
    pmrem.dispose();
    invalidate();

    return () => {
      if (scene.environment === target.texture) scene.environment = previous;
      target.dispose();
      invalidate();
    };
    // shellRgb is an array literal from a preset; `key` collapses it to a
    // primitive so we do not rebake on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, invalidate, enabled, key]);

  React.useEffect(() => {
    scene.environmentIntensity = intensity;
    invalidate();
    return () => {
      scene.environmentIntensity = 1;
    };
  }, [scene, intensity, invalidate]);
}

/* ========================================================================== *
 * Component
 * ========================================================================== */

export interface LightingProps {
  /** Selects a preset. This module never reads theme state itself. */
  theme?: ThemeMode;

  /** Cast real shadows from the key light. */
  shadows?: boolean;
  /** Shadow map resolution. Scene.tsx drops this to 512 on coarse-pointer devices. */
  shadowMapSize?: number;
  /** Half-extent of the key light's orthographic shadow camera. Keep it tight to the board. */
  shadowBounds?: number;
  shadowBias?: number;
  shadowNormalBias?: number;

  /** Direction the key light comes FROM, as a unit-ish vector. Up-back-left by default. */
  keyDirection?: [number, number, number];

  /** Point everything looks at. Defaults to the centre of the board's top face. */
  target?: [number, number, number];

  /** Build and install the PMREM studio probe. Turn it off only to debug. */
  environment?: boolean;

  /** Per-value overrides of the preset. */
  environmentIntensity?: number;
  keyIntensity?: number;
  keyColor?: string;
  fillIntensity?: number;
  rimIntensity?: number;
  ambientIntensity?: number;
  exposure?: number;

  /**
   * Tone mapping. Defaults to THREE.NeutralToneMapping (Khronos PBR Neutral),
   * NOT ACES. ACES desaturates and hue-shifts saturated mid-to-bright colours,
   * and this game's entire readability rests on telling purple, red, green and
   * blue apart at a glance on a small screen. Neutral rolls off highlights
   * without touching hue.
   */
  toneMapping?: THREE.ToneMapping;

  /** Clear colour. `null` leaves the canvas transparent so CSS shows through. */
  background?: string | null;

  /** Linear fog. `false` disables it — the table's far edge will then be visible. */
  fog?: { near: number; far: number } | false;
  /** Fog colour. Defaults to `background`, which is what makes the table edge vanish. */
  fogColor?: string;
}

export function Lighting({
  theme = 'light',
  shadows = true,
  shadowMapSize = 1024,
  shadowBounds = 3.75,
  shadowBias = -0.0004,
  shadowNormalBias = 0.022,
  keyDirection = [-0.44, 0.79, -0.43],
  target = [0, BOARD_TOP_Y, 0],
  environment = true,
  environmentIntensity,
  keyIntensity,
  keyColor,
  fillIntensity,
  rimIntensity,
  ambientIntensity,
  exposure,
  toneMapping = THREE.NeutralToneMapping,
  background,
  fog,
  fogColor,
}: LightingProps) {
  const preset = LIGHTING_PRESETS[theme];
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);

  const bg = background === undefined ? preset.background : background;
  const fogOn = fog !== false;
  const fogNear = fog === undefined || fog === false ? preset.fogNear : fog.near;
  const fogFar = fog === undefined || fog === false ? preset.fogFar : fog.far;
  const fogHex = fogColor ?? preset.background;

  useStudioEnvironment(
    preset.shellRgb,
    preset.panelGain,
    environmentIntensity ?? preset.environmentIntensity,
    environment,
  );

  /* ---- renderer state --------------------------------------------------- */

  React.useEffect(() => {
    gl.toneMapping = toneMapping;
    gl.toneMappingExposure = exposure ?? preset.exposure;
    invalidate();
  }, [gl, toneMapping, exposure, preset.exposure, invalidate]);

  React.useEffect(() => {
    if (bg === null) {
      gl.setClearColor(0x000000, 0);
    } else {
      gl.setClearColor(new THREE.Color(bg), 1);
    }
    invalidate();
  }, [gl, bg, invalidate]);

  // Fog is set imperatively rather than as <fog attach="fog" />, because that
  // attaches to the nearest parent object and this component renders inside a
  // group. Fog belongs to the scene.
  React.useEffect(() => {
    if (!fogOn) {
      scene.fog = null;
      invalidate();
      return;
    }
    const f = new THREE.Fog(new THREE.Color(fogHex), fogNear, fogFar);
    scene.fog = f;
    invalidate();
    return () => {
      if (scene.fog === f) scene.fog = null;
      invalidate();
    };
  }, [scene, fogOn, fogHex, fogNear, fogFar, invalidate]);

  /* ---- key light -------------------------------------------------------- */

  const keyRef = React.useRef<THREE.DirectionalLight>(null);

  // A shadow map is allocated lazily at its current size and then never
  // resized, so switching quality tiers has to throw the old one away.
  React.useEffect(() => {
    const light = keyRef.current;
    if (!light) return;
    if (light.shadow.map) {
      light.shadow.map.dispose();
      light.shadow.map = null;
    }
    invalidate();
  }, [shadowMapSize, invalidate]);

  // DirectionalLight aims at `light.target`, whose matrixWorld is only kept up
  // to date if the target is in the scene graph. It is not, by default. Rather
  // than mount a dummy object we update it directly: with no parent,
  // updateMatrixWorld just copies the local matrix, which is exactly right and
  // stays put.
  React.useEffect(() => {
    const light = keyRef.current;
    if (!light) return;
    light.target.position.set(target[0], target[1], target[2]);
    light.target.updateMatrixWorld();
    invalidate();
    // Spread the tuple so a fresh-but-identical array literal from a parent's
    // render does not re-run this and burn a frame.
  }, [target[0], target[1], target[2], invalidate]);

  const distance = 9;
  const dir = React.useMemo(() => {
    const v = new THREE.Vector3(keyDirection[0], keyDirection[1], keyDirection[2]);
    if (v.lengthSq() === 0) v.set(0, 1, 0);
    return v.normalize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyDirection[0], keyDirection[1], keyDirection[2]]);

  const keyPos: [number, number, number] = [
    target[0] + dir.x * distance,
    target[1] + dir.y * distance,
    target[2] + dir.z * distance,
  ];

  // Opposite side, low, no shadow. Separates the pieces' silhouettes from the
  // board on the side the key does not reach — this is what keeps a dark-theme
  // frame from turning into a single brown mass.
  const rimPos: [number, number, number] = [
    target[0] - dir.x * distance * 0.9,
    target[1] + distance * 0.32,
    target[2] - dir.z * distance * 0.9,
  ];

  return (
    <group name="otrio-lighting">
      <directionalLight
        ref={keyRef}
        name="key"
        position={keyPos}
        intensity={keyIntensity ?? preset.keyIntensity}
        color={keyColor ?? preset.keyColor}
        castShadow={shadows}
        shadow-mapSize-width={shadowMapSize}
        shadow-mapSize-height={shadowMapSize}
        shadow-camera-left={-shadowBounds}
        shadow-camera-right={shadowBounds}
        shadow-camera-top={shadowBounds}
        shadow-camera-bottom={-shadowBounds}
        shadow-camera-near={Math.max(0.1, distance - shadowBounds - 1.5)}
        shadow-camera-far={distance + shadowBounds + 2.5}
        shadow-bias={shadowBias}
        shadow-normalBias={shadowNormalBias}
      />

      <directionalLight
        name="rim"
        position={rimPos}
        intensity={rimIntensity ?? preset.rimIntensity}
        color={preset.rimColor}
      />

      <hemisphereLight
        name="fill"
        args={[preset.fillSky, preset.fillGround, fillIntensity ?? preset.fillIntensity]}
      />

      <ambientLight intensity={ambientIntensity ?? preset.ambientIntensity} />
    </group>
  );
}

export default Lighting;
