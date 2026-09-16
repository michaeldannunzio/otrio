/**
 * glyphAtlas.ts — the player identity glyph, as pad-printed ink.
 *
 * WHY
 * ---
 * `PLAYERS[i].glyph` (●▲■◆) is the non-colour identity channel. The theming
 * agent's note is blunt about why it exists: greyscale separation between the
 * four official hues is only ~10 dE, which is under their floor, so the glyph
 * and the gloss-to-matte finish ladder are the two channels covering that gap.
 * Both have to actually render for the trade to hold.
 *
 * HOW, AND WHY IT IS A TEXTURE
 * ----------------------------
 * The mark is rasterised to a canvas once and composited into the piece's
 * albedo in the fragment shader. It is not geometry and not an overlay quad: it
 * goes on the surface the way a real game piece is marked, by pad printing, and
 * it takes the surface with it — the ink sits under the clear-coat, reads a
 * little more matte than the moulded plastic around it, and is lit by the same
 * normal map. Colour separation is by texture, exactly as the rest of the piece.
 *
 * The four shapes are drawn as canvas paths from `glyphLabel`
 * ('circle' | 'triangle' | 'square' | 'diamond') rather than by setting a font
 * and calling `fillText`. Those code points are not reliably present on every
 * phone, and a missing glyph box on a game piece is worse than no glyph. The
 * character itself is the fallback for any label we do not recognise.
 *
 * LAYOUT
 * ------
 * One column, four rows, so the shader can tile horizontally (RepeatWrapping on
 * S) for the marks that run round a ring's bezel, while picking a row by player
 * index. Wrapping on T is clamped, and each shape is drawn well inside its cell
 * so the rows do not bleed into each other at coarse mip levels.
 */

import { CanvasTexture, ClampToEdgeWrapping, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, type Texture } from 'three';

/** Pixels per cell. 128 is ample: the mark is 10-15 px on screen at most. */
const CELL = 128;

/** Number of rows. One per player. */
export const GLYPH_ROWS = 4;

/**
 * Areas are matched across the four shapes rather than their bounding boxes.
 * A square and a triangle drawn to the same width do not carry the same visual
 * weight, and at 10 px the heavier one reads as "bigger piece" — which is the
 * one thing a size-based game cannot afford a marking to suggest.
 */
const CIRCLE_R = 0.2523;
const SQUARE_A = 0.4472;
const TRIANGLE_R = 0.3924;
const DIAMOND_D = 0.3162;

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  label: string,
  glyph: string,
  cx: number,
  cy: number,
  size: number,
): void {
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();

  switch (label) {
    case 'circle':
      ctx.arc(cx, cy, CIRCLE_R * size, 0, Math.PI * 2);
      break;

    case 'square': {
      const a = SQUARE_A * size;
      ctx.rect(cx - a / 2, cy - a / 2, a, a);
      break;
    }

    case 'triangle': {
      const r = TRIANGLE_R * size;
      for (let i = 0; i < 3; i++) {
        // Start at -90 degrees so the triangle points up.
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      break;
    }

    case 'diamond': {
      const d = DIAMOND_D * size;
      ctx.moveTo(cx, cy - d);
      ctx.lineTo(cx + d, cy);
      ctx.lineTo(cx, cy + d);
      ctx.lineTo(cx - d, cy);
      ctx.closePath();
      break;
    }

    default: {
      // Unknown label: fall back to the character itself. Only reached if the
      // theming agent adds a fifth shape without telling us.
      ctx.font = `${Math.round(size * 0.62)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(glyph, cx, cy);
      return;
    }
  }

  ctx.fill();
}

export interface GlyphSpec {
  glyph: string;
  glyphLabel: string;
}

const cache = new Map<string, Texture | null>();

/**
 * Build (once) the glyph atlas for a set of players, in index order.
 *
 * Returns null where there is no DOM to draw on — server rendering, or a test
 * environment. The shader treats a missing atlas as "no mark" and everything
 * else still works, so a glyph is never a hard dependency for the scene coming
 * up.
 */
export function getGlyphAtlas(specs: readonly GlyphSpec[]): Texture | null {
  const key = specs.map((s) => s.glyphLabel).join('|');
  if (cache.has(key)) return cache.get(key) ?? null;

  if (typeof document === 'undefined') {
    cache.set(key, null);
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = CELL;
  canvas.height = CELL * GLYPH_ROWS;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    cache.set(key, null);
    return null;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < GLYPH_ROWS; i++) {
    const spec = specs[i];
    if (!spec) continue;
    drawGlyph(ctx, spec.glyphLabel, spec.glyph, CELL / 2, CELL * i + CELL / 2, CELL);
  }

  const texture = new CanvasTexture(canvas);
  // A coverage mask, not colour: only the alpha channel is read, and decoding
  // it as sRGB would bend the anti-aliased edges.
  texture.colorSpace = NoColorSpace;
  // Tiles round a ring's bezel horizontally; rows must not wrap into each other.
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  cache.set(key, texture);
  return texture;
}

/** Drop the cached atlas. Teardown only. */
export function disposeGlyphAtlas(): void {
  for (const texture of cache.values()) texture?.dispose();
  cache.clear();
}
