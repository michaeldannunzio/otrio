/**
 * pieceMaterial.ts — the plastic.
 *
 * WHAT WE ARE MAKING
 * ------------------
 * docs/RULES.md §9: the deluxe board is carbonized bamboo with recessed inlays
 * and the pieces are plastic, and a hands-on review notes the pieces "feel a
 * bit cheap in the hand" next to it. That contrast is the artefact, so this
 * material goes the other way from the board: hard, glossy, clear-coated,
 * injection-moulded. The board is warm and matte; the pieces are cold and shiny.
 *
 * TEXTURES
 * --------
 * From `../textures`, surface id 'piece' — ambientCG Plastic010, CC0, shipped
 * at 512px ('sd') or 1024px ('hd'). That set is deliberately albedo-free: piece
 * colour is player identity and has to come from us. What it gives us is the
 * micro-surface — the faint mould texture in the normal map, and the roughness
 * variation that stops the highlight looking like a perfect mirror. That is
 * exactly the part that makes a piece read as a moulded object rather than a
 * tinted shape.
 *
 * We ask for `repeat: 1` and do the tiling in the UVs instead, because the
 * three piece sizes need different tile counts to hold the same texel density
 * (see `geometry/lathe.ts`). Leaving it at the module's default would give the
 * large ring grain 2.5x coarser than the peg's.
 *
 * ONE MATERIAL, FOUR FINISHES
 * ---------------------------
 * All 36 pieces share one material so they can be instanced into three draw
 * calls. Colour comes from `instanceColor`, which three.js multiplies into the
 * albedo for free. Finish — roughness, clear-coat, how much mould grain shows —
 * comes from a per-instance `vec4` attribute patched into the standard physical
 * shader. Four visibly different plastics, no extra draw calls, no extra
 * shader compiles.
 */

import {
  Color,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Vector2,
  Vector4,
  type IUniform,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { useEffect, useMemo } from 'react';
import { useSurfaceMaterial, type SurfaceMaterialProps } from '../textures';
import {
  finishToArray,
  paintForPlayer,
  type PieceFinish,
  type PlayerColorId,
} from './palette';

export type PieceQuality = 'low' | 'medium' | 'high';

export type PieceMaterial = MeshPhysicalMaterial | MeshStandardMaterial;

/**
 * Base roughness handed to the texture module, which uses it as the multiplier
 * over the roughness map. Slightly above the module's own 0.25 default because
 * the per-player finish multipliers are centred near 1.0 and the mattest player
 * needs headroom before clamping.
 */
const BASE_ROUGHNESS = 0.3;

/**
 * Normal map strength. Above the module's 0.35 default: at a 30-40px piece on a
 * phone, mould grain at 0.35 is below the noise floor of the screen. Per-player
 * strength then scales it from 0.45x to 1.85x.
 */
const BASE_NORMAL_SCALE = 0.5;

/* -------------------------------------------------------------------------- *
 * Shader patch
 * -------------------------------------------------------------------------- */

const FINISH_UNIFORM = 'uOtrioFinish';

/**
 * x = roughness multiplier
 * y = clearcoat            (absolute 0..1)
 * z = clearcoatRoughness   (absolute)
 * w = normal map strength multiplier
 */
export const FINISH_ATTRIBUTE = 'aFinish';

/** What `<InstancedAttribute defaultValue>` should be: a middling satin. */
export const DEFAULT_FINISH_VALUE: [number, number, number, number] = [1, 0.6, 0.14, 1];

function patchShader(shader: WebGLProgramParametersWithUniforms, instanced: boolean): void {
  const read = instanced ? 'vOtrioFinish' : FINISH_UNIFORM;

  if (instanced) {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
attribute vec4 ${FINISH_ATTRIBUTE};
varying vec4 vOtrioFinish;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vOtrioFinish = ${FINISH_ATTRIBUTE};`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
varying vec4 vOtrioFinish;`,
    );
  } else {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
uniform vec4 ${FINISH_UNIFORM};`,
    );
  }

  // Roughness. The map supplies variation, `material.roughness` the calibrated
  // level, and this the per-player spread. Floored above zero so the glossiest
  // player still has a highlight with a width rather than a singularity.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <roughnessmap_fragment>',
    `#include <roughnessmap_fragment>
roughnessFactor = clamp( roughnessFactor * ${read}.x, 0.015, 1.0 );`,
  );

  // Mould grain. Lerping the perturbed normal back towards the geometric one
  // is cheaper and better behaved than scaling `normalScale`: it cannot push
  // the normal below the horizon, and it is a no-op when no normal map has
  // loaded yet, so the piece degrades to smooth plastic rather than breaking.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_maps>',
    `#include <normal_fragment_maps>
normal = normalize( mix( nonPerturbedNormal, normal, clamp( ${read}.w, 0.0, 4.0 ) ) );`,
  );

  // Clear-coat. Compiles out entirely when the material has none (low quality
  // tier, or MeshStandardMaterial), so the same patch serves both.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_physical_fragment>',
    `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
material.clearcoat = clamp( ${read}.y, 0.0, 1.0 );
material.clearcoatRoughness = clamp( ${read}.z, 0.0525, 1.0 );
#endif`,
  );
}

/* -------------------------------------------------------------------------- *
 * Construction
 * -------------------------------------------------------------------------- */

export interface CreatePieceMaterialOptions {
  quality?: PieceQuality;
  /**
   * true  — finish comes from the per-instance `aFinish` attribute. Use for
   *         anything rendered through `<PieceField>`.
   * false — finish comes from a uniform. Use for a lone `<mesh>`: a tray
   *         preview, a HUD piece, a hover ghost.
   */
  instanced: boolean;
  /** Only meaningful when `instanced` is false. */
  finish?: PieceFinish;
  /** Only meaningful when `instanced` is false; instanced colour is per-instance. */
  color?: string;
}

interface PatchedMaterial {
  userData: { otrioFinish?: IUniform<Vector4> };
}

export function createPieceMaterial(options: CreatePieceMaterialOptions): PieceMaterial {
  const { quality = 'medium', instanced, finish, color } = options;

  // The low tier drops to MeshStandardMaterial outright. Clear-coat is a second
  // specular lobe plus its own normal handling; on a mid-range phone filling
  // 36 pieces it is the single most expensive thing in this material, and the
  // roughness spread alone still separates the four players.
  const material: PieceMaterial =
    quality === 'low'
      ? new MeshStandardMaterial({ name: 'otrio-piece' })
      : new MeshPhysicalMaterial({
          name: 'otrio-piece',
          // Base values of 1.0 so the per-instance vec4 sets the absolute
          // level rather than scaling an arbitrary default. Non-zero is also
          // what makes three define USE_CLEARCOAT at all.
          clearcoat: 1,
          clearcoatRoughness: 1,
          // Hard, dense plastic. 1.52 is acrylic; ABS and PS sit either side.
          ior: 1.52,
        });

  material.metalness = 0;
  material.roughness = BASE_ROUGHNESS;
  material.normalScale = new Vector2(BASE_NORMAL_SCALE, BASE_NORMAL_SCALE);
  material.envMapIntensity = 1.2;
  material.color = new Color(color ?? '#ffffff');
  material.dithering = true; // the pieces are large areas of flat saturated colour

  const uniform: IUniform<Vector4> = {
    value: new Vector4(...finishToArray(finish ?? paintForPlayer(0).finish)),
  };
  (material as unknown as PatchedMaterial).userData.otrioFinish = uniform;

  material.onBeforeCompile = (shader) => {
    if (!instanced) shader.uniforms[FINISH_UNIFORM] = uniform;
    patchShader(shader, instanced);
  };
  // Without this, three caches one compiled program across both variants and
  // whichever compiled first wins.
  material.customProgramCacheKey = () => `otrio-piece|${quality}|${instanced ? 'inst' : 'solo'}`;

  return material;
}

/** Update a solo material's finish in place. No recompile. */
export function setPieceFinish(material: PieceMaterial, finish: PieceFinish): void {
  const uniform = (material as unknown as PatchedMaterial).userData.otrioFinish;
  if (uniform) uniform.value.set(...finishToArray(finish));
}

/* -------------------------------------------------------------------------- *
 * Texture wiring
 * -------------------------------------------------------------------------- */

const MAP_SLOTS = ['normalMap', 'roughnessMap', 'aoMap', 'map'] as const;

/**
 * Copy the texture module's props onto a material we own.
 *
 * `useSurfaceMaterial` is built to be spread onto a declarative
 * `<meshStandardMaterial>`; we need a single shared instance instead, so the
 * props get applied imperatively. Adding or removing a map changes the shader
 * defines, hence the `needsUpdate` when a slot flips between null and a
 * texture — but only then, because setting it every frame would recompile the
 * program every frame.
 */
export function applyPieceTextures(material: PieceMaterial, props: SurfaceMaterialProps): void {
  let slotsChanged = false;
  for (const slot of MAP_SLOTS) {
    const next = (props as unknown as Record<string, Texture | null>)[slot] ?? null;
    const current = (material as unknown as Record<string, Texture | null>)[slot] ?? null;
    if ((current === null) !== (next === null)) slotsChanged = true;
    (material as unknown as Record<string, Texture | null>)[slot] = next;
  }

  material.normalScale.set(BASE_NORMAL_SCALE, BASE_NORMAL_SCALE);
  material.aoMapIntensity = props.aoMapIntensity;
  material.envMapIntensity = props.envMapIntensity;
  material.metalness = props.metalness;
  material.roughness = props.roughness;

  if (slotsChanged) material.needsUpdate = true;
}

/* -------------------------------------------------------------------------- *
 * Shared instances
 * -------------------------------------------------------------------------- *
 *
 * Materials are cached at module scope rather than per component. A material
 * owns its compiled program, so creating and disposing one on every mount of a
 * hover ghost would recompile the physical shader on every mount — tens of
 * milliseconds each time, on the frame where the player is already waiting.
 */

const materialCache = new Map<string, PieceMaterial>();

function cached(key: string, make: () => PieceMaterial): PieceMaterial {
  const hit = materialCache.get(key);
  if (hit) return hit;
  const made = make();
  materialCache.set(key, made);
  return made;
}

/** The one instanced material every piece on the board draws with. */
export function getPieceMaterial(quality: PieceQuality = 'medium'): PieceMaterial {
  return cached(`inst|${quality}`, () => createPieceMaterial({ quality, instanced: true }));
}

/** A per-player material for a piece drawn outside `<PieceField>`. */
export function getSoloPieceMaterial(
  player: PlayerColorId | number,
  quality: PieceQuality = 'medium',
): PieceMaterial {
  const paint = paintForPlayer(player);
  return cached(`solo|${paint.id}|${quality}`, () =>
    createPieceMaterial({
      quality,
      instanced: false,
      finish: paint.finish,
      color: paint.hex,
    }),
  );
}

/** Drop every cached material. Call on teardown; not needed between scenes. */
export function disposePieceMaterials(): void {
  for (const material of materialCache.values()) material.dispose();
  materialCache.clear();
}

/**
 * The shared instanced material, wired to the texture module.
 *
 * Returns a stable object, so three's program cache is hit exactly once and
 * textures attach themselves as they arrive without re-rendering anything that
 * draws with it.
 */
export function usePieceMaterial(quality: PieceQuality = 'medium'): PieceMaterial {
  const material = useMemo(() => getPieceMaterial(quality), [quality]);

  const props = useSurfaceMaterial('piece', {
    // White base: the tint is per-instance. See the header.
    color: '#ffffff',
    // Tiling lives in the UVs so it can scale with each piece.
    repeat: 1,
    normalScale: BASE_NORMAL_SCALE,
    roughness: BASE_ROUGHNESS,
  });

  useEffect(() => {
    applyPieceTextures(material, props);
  }, [material, props]);

  return material;
}

/**
 * A standalone material for one piece outside `<PieceField>` — a tray preview,
 * a HUD swatch, a win-screen hero piece. Costs a draw call per piece, so do
 * not use it for pieces on the board.
 */
export function useSoloPieceMaterial(
  player: PlayerColorId | number,
  quality: PieceQuality = 'medium',
): PieceMaterial {
  const paint = paintForPlayer(player);
  const material = useMemo(() => getSoloPieceMaterial(paint.id, quality), [paint.id, quality]);

  const props = useSurfaceMaterial('piece', {
    color: paint.hex,
    repeat: 1,
    normalScale: BASE_NORMAL_SCALE,
    roughness: BASE_ROUGHNESS,
  });

  useEffect(() => {
    applyPieceTextures(material, props);
    material.color.set(paint.hex);
    setPieceFinish(material, paint.finish);
  }, [material, props, paint]);

  return material;
}

/**
 * Translucent variant for a placement preview — the piece that follows the
 * cursor before it is committed. Same geometry, same texture set, so the
 * preview reads as the actual piece rather than a marker.
 */
export function createGhostPieceMaterial(
  player: PlayerColorId | number,
  quality: PieceQuality = 'medium',
): PieceMaterial {
  const paint = paintForPlayer(player);
  const material = createPieceMaterial({
    quality,
    instanced: false,
    finish: paint.finish,
    color: paint.hex,
  });
  material.name = 'otrio-piece-ghost';
  material.transparent = true;
  material.opacity = 0.42;
  material.depthWrite = false;
  return material;
}

/**
 * Pick a quality tier when nothing else has an opinion.
 *
 * Deliberately conservative: four people on mid-range phones rendering this
 * continuously is the budget, and clear-coat is not worth a dropped frame.
 * The caller should override from a settings menu.
 */
export function detectPieceQuality(): PieceQuality {
  if (typeof window === 'undefined') return 'medium';
  try {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const shortEdge = Math.min(window.screen?.width ?? 1280, window.screen?.height ?? 800) * dpr;
    const cores = navigator.hardwareConcurrency ?? 4;
    if (shortEdge < 900 || cores <= 4) return 'low';
    if (shortEdge >= 1400 && cores >= 8) return 'high';
    return 'medium';
  } catch {
    return 'medium';
  }
}
