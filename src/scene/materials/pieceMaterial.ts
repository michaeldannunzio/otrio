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
  BackSide,
  Color,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Vector2,
  Vector4,
  type IUniform,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { useEffect, useMemo } from 'react';
import { OUTLINE_NORMAL_ATTRIBUTE } from '../geometry/lathe';
import { useSurfaceMaterial, type SurfaceMaterialProps } from '../textures';
import {
  finishToArray,
  paintForPlayer,
  type PieceFinish,
  type PlayerColorId,
} from './palette';

const RIM_WIDTH_UNIFORM = 'uOtrioRimWidth';

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
const MARK_UNIFORM = 'uOtrioMark';
const INK_UNIFORM = 'uOtrioInk';
const GLYPH_MAP_UNIFORM = 'uOtrioGlyphMap';
const GLYPH_STRENGTH_UNIFORM = 'uOtrioGlyphStrength';

/**
 * x = roughness multiplier
 * y = clearcoat            (absolute 0..1)
 * z = clearcoatRoughness   (absolute)
 * w = normal map strength multiplier
 */
export const FINISH_ATTRIBUTE = 'aFinish';

/**
 * Where this piece's identity glyph is printed, and which one it is.
 *
 * x = atlas row, i.e. player index 0..3
 * y = band inner radius, object space  (ignored when planar)
 * z = band outer radius / mark radius, object space
 * w = 0 a single mark centred on a solid top, 1 a band repeated round a bezel
 */
export const MARK_ATTRIBUTE = 'aMark';

/** Ink colour for the glyph — the theme's `players[i].on`, as linear RGB. */
export const INK_ATTRIBUTE = 'aInk';

/** What `<InstancedAttribute defaultValue>` should be: a middling satin. */
export const DEFAULT_FINISH_VALUE: [number, number, number, number] = [1, 0.6, 0.14, 1];

/** Off: row 0, degenerate band, planar. Masked out until a piece sets it. */
export const DEFAULT_MARK_VALUE: [number, number, number, number] = [0, 0, 0, 0];

/** Default ink: black. Never seen — the mark is masked off by default. */
export const DEFAULT_INK_VALUE: [number, number, number] = [0, 0, 0];

/**
 * How much the printed glyph roughens the surface it sits on. Pad-printed ink
 * is measurably less glossy than the moulded plastic around it, and that
 * difference is most of what stops a mark looking like a decal pasted on in
 * post.
 */
const INK_ROUGHNESS_GAIN = 0.22;

function patchShader(shader: WebGLProgramParametersWithUniforms, instanced: boolean): void {
  const read = instanced ? 'vOtrioFinish' : FINISH_UNIFORM;
  const mark = instanced ? MARK_ATTRIBUTE : MARK_UNIFORM;
  const ink = instanced ? INK_ATTRIBUTE : INK_UNIFORM;

  // ---- declarations ------------------------------------------------------
  // `position`, `normal` and `uv` are declared by three's own vertex prefix
  // unconditionally, so the mark projection below can rely on all three even
  // before any texture has loaded and USE_UV is defined.
  const vertexDecls = instanced
    ? `attribute vec4 ${FINISH_ATTRIBUTE};
attribute vec4 ${MARK_ATTRIBUTE};
attribute vec3 ${INK_ATTRIBUTE};
varying vec4 vOtrioFinish;`
    : `uniform vec4 ${MARK_UNIFORM};
uniform vec3 ${INK_UNIFORM};`;

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    `#include <common>
${vertexDecls}
varying vec4 vOtrioMark;
varying float vOtrioMarkRow;
varying vec3 vOtrioInk;`,
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>
${instanced ? 'varying vec4 vOtrioFinish;' : `uniform vec4 ${FINISH_UNIFORM};`}
uniform sampler2D ${GLYPH_MAP_UNIFORM};
uniform float ${GLYPH_STRENGTH_UNIFORM};
varying vec4 vOtrioMark;
varying float vOtrioMarkRow;
varying vec3 vOtrioInk;`,
  );

  // ---- mark projection ---------------------------------------------------
  // Two placements, because the pieces are two different shapes. The peg has a
  // solid top, so it takes one mark planar-projected onto it. A ring has only a
  // narrow annular land, where a single mark would be a few pixels and would
  // rotate out of view — so its mark repeats round the bezel instead, the way
  // index marks are printed on a real dial. Even when one glyph is too small to
  // identify, the rhythm of ten of them still separates from six squares.
  //
  // The angular coordinate is `uv.x`, which the lathe already emits as a whole
  // number of wraps, so the repeat closes at the seam for free.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
${instanced ? `vOtrioFinish = ${FINISH_ATTRIBUTE};` : ''}
{
  float otrioR = length( position.xz );
  float otrioSpan = max( ${mark}.z - ${mark}.y, 1e-5 );
  vec2 otrioPlanar = position.xz / max( ${mark}.z, 1e-5 ) * 0.5 + 0.5;
  vec2 otrioBand = vec2( uv.x, ( otrioR - ${mark}.y ) / otrioSpan );
  vOtrioMark = vec4(
    mix( otrioPlanar, otrioBand, step( 0.5, ${mark}.w ) ),
    smoothstep( 0.55, 0.88, normal.y ),
    ${mark}.w
  );
  vOtrioMarkRow = ${mark}.x;
  vOtrioInk = ${ink};
}`,
  );

  // ---- ink -------------------------------------------------------------- *
  // After <color_fragment>, so the mark prints over the player tint rather than
  // being multiplied by it. `otrioInk` stays in scope for the roughness step
  // below, which is why it is not wrapped in a block.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
float otrioInk = 0.0;
{
  float inRow = step( 0.0, vOtrioMark.y ) * step( vOtrioMark.y, 1.0 );
  // A planar mark must stay inside its disc; a banded one is meant to tile.
  float inCol = step( 0.0, vOtrioMark.x ) * step( vOtrioMark.x, 1.0 );
  float inside = inRow * mix( inCol, 1.0, step( 0.5, vOtrioMark.w ) );
  float coverage = texture2D(
    ${GLYPH_MAP_UNIFORM},
    vec2( vOtrioMark.x, ( vOtrioMarkRow + vOtrioMark.y ) * ${(1 / 4).toFixed(6)} )
  ).a;
  otrioInk = coverage * inside * vOtrioMark.z * ${GLYPH_STRENGTH_UNIFORM};
  diffuseColor.rgb = mix( diffuseColor.rgb, vOtrioInk, otrioInk );
}`,
  );

  // Roughness. The map supplies variation, `material.roughness` the calibrated
  // level, and this the per-player spread. Floored above zero so the glossiest
  // player still has a highlight with a width rather than a singularity.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <roughnessmap_fragment>',
    `#include <roughnessmap_fragment>
roughnessFactor = clamp( roughnessFactor * ${read}.x, 0.015, 1.0 );
roughnessFactor = mix(
  roughnessFactor,
  min( 1.0, roughnessFactor + ${INK_ROUGHNESS_GAIN.toFixed(3)} ),
  otrioInk
);`,
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
  userData: {
    otrioFinish?: IUniform<Vector4>;
    otrioMark?: IUniform<Vector4>;
    otrioInk?: IUniform<Color>;
    otrioGlyphMap?: IUniform<Texture | null>;
    otrioGlyphStrength?: IUniform<number>;
  };
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

  const finishUniform: IUniform<Vector4> = {
    value: new Vector4(...finishToArray(finish ?? paintForPlayer(0).finish)),
  };
  const markUniform: IUniform<Vector4> = { value: new Vector4(...DEFAULT_MARK_VALUE) };
  const inkUniform: IUniform<Color> = { value: new Color(0, 0, 0) };
  // Strength starts at zero: an unbound sampler reads as opaque, so a material
  // whose atlas never arrives must not be allowed to print anything.
  const glyphMapUniform: IUniform<Texture | null> = { value: null };
  const glyphStrengthUniform: IUniform<number> = { value: 0 };

  const store = (material as unknown as PatchedMaterial).userData;
  store.otrioFinish = finishUniform;
  store.otrioMark = markUniform;
  store.otrioInk = inkUniform;
  store.otrioGlyphMap = glyphMapUniform;
  store.otrioGlyphStrength = glyphStrengthUniform;

  material.onBeforeCompile = (shader) => {
    if (!instanced) {
      shader.uniforms[FINISH_UNIFORM] = finishUniform;
      shader.uniforms[MARK_UNIFORM] = markUniform;
      shader.uniforms[INK_UNIFORM] = inkUniform;
    }
    shader.uniforms[GLYPH_MAP_UNIFORM] = glyphMapUniform;
    shader.uniforms[GLYPH_STRENGTH_UNIFORM] = glyphStrengthUniform;
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

/**
 * Where a solo material prints its glyph, and in what colour. See
 * `MARK_ATTRIBUTE` for the packing; `ink` is an sRGB hex, converted here.
 */
export function setPieceMark(
  material: PieceMaterial,
  mark: readonly [number, number, number, number],
  ink: string,
): void {
  const store = (material as unknown as PatchedMaterial).userData;
  store.otrioMark?.value.set(mark[0], mark[1], mark[2], mark[3]);
  store.otrioInk?.value.set(ink);
}

/**
 * Attach the glyph atlas. Passing null (no DOM to rasterise on) leaves the
 * strength at zero and the piece simply goes unmarked.
 *
 * Changing the sampler's value does not change the shader's defines, so this
 * never triggers a recompile.
 */
export function setGlyphAtlas(
  material: PieceMaterial,
  atlas: Texture | null,
  strength = 1,
): void {
  const store = (material as unknown as PatchedMaterial).userData;
  if (!store.otrioGlyphMap || !store.otrioGlyphStrength) return;
  store.otrioGlyphMap.value = atlas;
  store.otrioGlyphStrength.value = atlas ? strength : 0;
}

/* -------------------------------------------------------------------------- *
 * Outline
 * -------------------------------------------------------------------------- *
 *
 * The piece's silhouette against the board, in the theme's `players[i].rim`.
 *
 * It exists because no single board tint clears 3:1 against all four player
 * hues at once — the scene agent swept it and 2.24:1 is the ceiling — so the
 * silhouette cannot come from the piece's own colour. The rim colours were
 * derived and verified per player against the board in both themes, which is
 * why this is a fixed world-space width rather than a fresnel term: a
 * view-dependent rim would only hit that verified contrast at some angles.
 *
 * Implementation is an inverted hull — the same geometry, pushed out along its
 * normals and drawn back-faces-only, so it shows exactly where it extends past
 * the piece. The push uses the lathe's `outlineNormal` attribute rather than
 * `normal`: the shading normals are creased at every chamfer and parting line,
 * and pushing along those would tear the shell open along each one.
 *
 * Below the board's top surface the shell is buried in the recess wall and
 * never seen, which is correct — the outline is there to separate the piece
 * from the board, and only the proud part of the piece has a silhouette.
 */
export function createPieceOutlineMaterial(rimWidth: number): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    name: 'otrio-piece-outline',
    side: BackSide,
    // The rim colours were contrast-checked as sRGB values. Tone mapping would
    // shift them off the numbers the theming agent verified, and an outline is
    // an affordance rather than a lit surface, so it opts out.
    toneMapped: false,
  });

  const width: IUniform<number> = { value: rimWidth };
  (material.userData as { otrioRimWidth?: IUniform<number> }).otrioRimWidth = width;

  material.onBeforeCompile = (shader) => {
    shader.uniforms[RIM_WIDTH_UNIFORM] = width;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
attribute vec3 ${OUTLINE_NORMAL_ATTRIBUTE};
uniform float ${RIM_WIDTH_UNIFORM};`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
transformed += ${OUTLINE_NORMAL_ATTRIBUTE} * ${RIM_WIDTH_UNIFORM};`,
    );
  };
  material.customProgramCacheKey = () => 'otrio-piece-outline';

  return material;
}

/** Retune the outline thickness in place. No recompile. */
export function setOutlineWidth(material: MeshBasicMaterial, rimWidth: number): void {
  const uniform = (material.userData as { otrioRimWidth?: IUniform<number> }).otrioRimWidth;
  if (uniform) uniform.value = rimWidth;
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

const outlineCache = new Map<string, MeshBasicMaterial>();

/**
 * The outline material a piece's shell draws with.
 *
 * With no colour it stays white and takes its rim from `instanceColor`, which
 * is the instanced path and the one that matters: one material, one draw call
 * per size. Pass a colour for a standalone piece, which has no instance colour
 * to tint it; those are cached per colour and there are at most four.
 */
export function getPieceOutlineMaterial(rimWidth: number, color?: string): MeshBasicMaterial {
  const key = `${rimWidth.toFixed(5)}|${color ?? ''}`;
  const hit = outlineCache.get(key);
  if (hit) return hit;
  const made = createPieceOutlineMaterial(rimWidth);
  if (color) made.color.set(color);
  outlineCache.set(key, made);
  return made;
}

/** Drop every cached material. Call on teardown; not needed between scenes. */
export function disposePieceMaterials(): void {
  for (const material of materialCache.values()) material.dispose();
  materialCache.clear();
  for (const material of outlineCache.values()) material.dispose();
  outlineCache.clear();
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
