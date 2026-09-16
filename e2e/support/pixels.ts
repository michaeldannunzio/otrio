import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Page } from '@playwright/test';

import { SHOT_DIR } from '../../playwright.config';

/**
 * Looking at the picture, in a test.
 *
 * For anything visual an assertion is weaker evidence than an image, so every
 * helper here writes the PNG to disk first and analyses it second. The analysis
 * exists to catch the one failure mode a human would spot instantly and a
 * `toBeVisible()` never will: a scene that drew, with correct geometry, in the
 * wrong material — the environment map is a PMREM bake with no fallback, and
 * without it the wooden board reads as grey clay.
 *
 * Decoding happens inside the browser. Chromium already has a PNG decoder and a
 * 2D canvas; a decoder in Node would be another dependency to justify for two
 * numbers.
 */

export interface ImageStats {
  width: number;
  height: number;
  /** The most common colour, which for this app is the table behind the board. */
  background: [number, number, number];
  /** Fraction of pixels that are not close to `background`. */
  subjectRatio: number;
  /** Bounding box of those pixels, in image pixels. Null if there are none. */
  subject: { left: number; top: number; right: number; bottom: number } | null;
  /** Distinct quantised colours. A blank or flat-shaded frame has very few. */
  distinctColours: number;
  /**
   * Of the subject pixels, the fraction that are warm — red channel clearly
   * above blue. Wood is warm; unlit clay is not.
   */
  warmRatio: number;
  /** Spread of luminance across subject pixels. Flat shading collapses this. */
  luminanceStdDev: number;
}

/** Write a screenshot and return both the path and what is in it. */
export async function captureAndAnalyse(
  page: Page,
  name: string,
  options: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {},
): Promise<{ path: string; stats: ImageStats }> {
  const path = resolve(process.cwd(), SHOT_DIR, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  const buffer = await page.screenshot({ fullPage: options.fullPage ?? false, clip: options.clip });
  writeFileSync(path, buffer);
  const stats = await analyse(page, buffer);
  return { path, stats };
}

/** Screenshot to disk with no analysis, for the frames that are pure evidence. */
export async function capture(page: Page, name: string): Promise<string> {
  const path = resolve(process.cwd(), SHOT_DIR, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await page.screenshot());
  return path;
}

async function analyse(page: Page, png: Buffer): Promise<ImageStats> {
  return page.evaluate(async (base64: string) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();

    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context to analyse the screenshot with');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, image.width, image.height);

    /* Quantising to 5 bits per channel before counting: two pixels a shade
       apart are the same colour for the purpose of "is anything there", and an
       exact count would be dominated by antialiasing and dither. */
    const histogram = new Map<number, number>();
    const key = (r: number, g: number, b: number) =>
      ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

    for (let i = 0; i < data.length; i += 4) {
      const k = key(data[i], data[i + 1], data[i + 2]);
      histogram.set(k, (histogram.get(k) ?? 0) + 1);
    }

    let bestKey = 0;
    let bestCount = -1;
    for (const [k, count] of histogram) {
      if (count > bestCount) {
        bestCount = count;
        bestKey = k;
      }
    }
    const bg: [number, number, number] = [
      ((bestKey >> 10) & 31) << 3,
      ((bestKey >> 5) & 31) << 3,
      (bestKey & 31) << 3,
    ];

    let left = image.width;
    let top = image.height;
    let right = -1;
    let bottom = -1;
    let subject = 0;
    let warm = 0;
    let lumSum = 0;
    let lumSqSum = 0;

    /* 24 per channel is about 9% of the range: far enough that a gradient in
       the table does not count as subject, close enough that a dark board edge
       against a dark table still does. */
    const TOLERANCE = 24;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (
        Math.abs(r - bg[0]) <= TOLERANCE &&
        Math.abs(g - bg[1]) <= TOLERANCE &&
        Math.abs(b - bg[2]) <= TOLERANCE
      ) {
        continue;
      }
      const px = i >> 2;
      const x = px % image.width;
      const y = (px / image.width) | 0;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      subject += 1;
      if (r - b > 18) warm += 1;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum;
      lumSqSum += lum * lum;
    }

    const total = data.length / 4;
    const mean = subject > 0 ? lumSum / subject : 0;
    const variance = subject > 0 ? Math.max(0, lumSqSum / subject - mean * mean) : 0;

    return {
      width: image.width,
      height: image.height,
      background: bg,
      subjectRatio: subject / total,
      subject: right >= 0 ? { left, top, right, bottom } : null,
      distinctColours: histogram.size,
      warmRatio: subject > 0 ? warm / subject : 0,
      luminanceStdDev: Math.sqrt(variance),
    };
  }, png.toString('base64'));
}
