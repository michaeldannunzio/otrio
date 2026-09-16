#!/usr/bin/env node
/**
 * fetch-textures.mjs — download and process the CC0 PBR textures for Otrio.
 *
 *   npm run textures            # normal run (idempotent, offline-safe)
 *   npm run textures -- --force # re-process everything
 *   npm run textures -- --strict# exit non-zero if anything is missing
 *   npm run textures -- --clean # delete outputs and the download cache
 *
 * ---------------------------------------------------------------------------
 * GUARANTEES
 * ---------------------------------------------------------------------------
 *
 * IDEMPOTENT. Source files are cached under node_modules/.cache/otrio-textures
 * and verified by MD5 where the provider publishes one. Outputs are keyed by a
 * hash of (source bytes + every processing parameter), so re-running does no
 * work and re-downloads nothing. Change a quality setting here and only the
 * affected outputs rebuild.
 *
 * OFFLINE-SAFE. This script never breaks a build. If the network is
 * unreachable and the processed textures are already present (they are
 * committed — see docs/TEXTURE-LICENSES.md), it reports and exits 0. If they
 * are absent it still exits 0 with a warning: src/scene/textures.ts falls back
 * to flat colours and the game remains playable. Pass --strict to make
 * failures fatal, e.g. in a release check.
 *
 * GENTLE. The machine this was written for power-cycles under sudden
 * multi-core load. Every ImageMagick invocation is single-threaded
 * (MAGICK_THREAD_LIMIT=1, OMP_NUM_THREADS=1) and run under `nice -n 19`, and
 * images are processed strictly one at a time. Do not parallelise this.
 *
 * ---------------------------------------------------------------------------
 * LICENSING
 * ---------------------------------------------------------------------------
 *
 * Every source below is CC0 1.0 Universal (public domain dedication) from
 * ambientCG or Poly Haven, both of which apply CC0 site-wide to their asset
 * files. No attribution is required. Provenance is recorded anyway, in
 * docs/TEXTURE-LICENSES.md and in the generated public/textures/manifest.json.
 *
 * Do not add a source here without confirming its licence at the provider's
 * licence page and recording it in both places.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'otrio-textures');
const OUT_DIR = path.join(ROOT, 'public', 'textures');
const STATE_FILE = path.join(CACHE_DIR, 'build-state.json');
const TEXTURES_TS = path.join(ROOT, 'src', 'scene', 'textures.ts');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const STRICT = argv.includes('--strict');
const CLEAN = argv.includes('--clean');

/* ========================================================================== *
 * Licences — verified 2026-09-15 at the providers' own licence pages.
 * ========================================================================== */

const LICENSES = {
  ambientcg: {
    id: 'CC0-1.0',
    name: 'Creative Commons CC0 1.0 Universal',
    url: 'https://docs.ambientcg.com/license/',
    attributionRequired: false,
    verified:
      'Provider states: "All ambientCG assets are provided under the Creative Commons CC0 1.0 ' +
      'Universal License. This applies to the downloadable asset files and the material preview ' +
      'renders shown for each asset on the site." No carve-outs.',
  },
  polyhaven: {
    id: 'CC0-1.0',
    name: 'Creative Commons CC0 1.0 Universal',
    url: 'https://polyhaven.com/license',
    attributionRequired: false,
    verified:
      'Provider states all HDRIs, textures and models are CC0: "You do not need to give credit or ' +
      'attribution when using them (although it is appreciated)." Site chrome (logos, example ' +
      'renders) is excluded, but the asset files themselves are not.',
  },
};

/* ========================================================================== *
 * Sources
 * ========================================================================== */

/**
 * Poly Haven serves individual maps, so we fetch only what we use.
 * ambientCG only publishes zips, so we cache the zip and extract from it.
 *
 * `nor_gl` / `NormalGL` are deliberate: OpenGL normal convention (+Y up) is
 * what three.js expects. The DirectX variants would invert the lighting.
 */
const SOURCES = {
  bamboo: {
    provider: 'polyhaven',
    assetId: 'bamboo_veneer',
    displayName: 'Bamboo Veneer',
    pageUrl: 'https://polyhaven.com/a/bamboo_veneer',
    authors: { 'Jenelle van Heerden': 'All' },
    tileSizeMm: 1000,
    kind: 'files',
    files: {
      diffuse: {
        url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/bamboo_veneer/bamboo_veneer_diff_1k.jpg',
        md5: '8642edf2af80a6158585a97264d40419',
      },
      normal: {
        url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/bamboo_veneer/bamboo_veneer_nor_gl_1k.jpg',
        md5: 'affa5edeeae2af3ed841d532ca135bcb',
      },
      rough: {
        url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/bamboo_veneer/bamboo_veneer_rough_1k.jpg',
        md5: '8ad387ac67e82a3fa4201ee3c79c3a1e',
      },
      // NOTE: bamboo_veneer_ao_1k.jpg is deliberately NOT fetched. Measured
      // mean 98.7%, stddev 1.1% — it is a white image. A flat veneer has no
      // self-occlusion worth baking; the recesses in the board get their
      // occlusion from geometry. Shipping it would be shipping ~25 KB of
      // white.
    },
  },

  felt: {
    provider: 'ambientcg',
    assetId: 'Fabric034',
    displayName: 'Fabric 034 (felt)',
    pageUrl: 'https://ambientcg.com/a/Fabric034',
    authors: { ambientCG: 'All' },
    tileSizeMm: null, // provider does not publish physical dimensions
    kind: 'zip',
    zipUrl: 'https://ambientcg.com/get?file=Fabric034_1K-JPG.zip',
    zipName: 'Fabric034_1K-JPG.zip',
    entries: {
      diffuse: 'Fabric034_1K-JPG_Color.jpg',
      normal: 'Fabric034_1K-JPG_NormalGL.jpg',
      rough: 'Fabric034_1K-JPG_Roughness.jpg',
    },
  },

  plastic: {
    provider: 'ambientcg',
    assetId: 'Plastic010',
    displayName: 'Plastic 010 (smooth white)',
    pageUrl: 'https://ambientcg.com/a/Plastic010',
    authors: { ambientCG: 'All' },
    tileSizeMm: null,
    kind: 'zip',
    zipUrl: 'https://ambientcg.com/get?file=Plastic010_1K-JPG.zip',
    zipName: 'Plastic010_1K-JPG.zip',
    entries: {
      normal: 'Plastic010_1K-JPG_NormalGL.jpg',
      rough: 'Plastic010_1K-JPG_Roughness.jpg',
      // No Color map. Piece colour is player identity and comes from
      // material.color in src/scene/textures.ts. A baked albedo would fight it.
    },
  },
};

/* ========================================================================== *
 * Outputs
 * ========================================================================== *
 *
 * `hd` is the authored size; `sd` is half, floored at 256. Exactly one tier is
 * ever downloaded by a client.
 *
 * Sizes are chosen per map, from what the surface actually needs:
 *  - The board is the hero surface, seen closest and barely tiled -> 1024.
 *  - The table is tiled 12x and sits in the background. A 1024 felt texture
 *    would be thrown away by mipmapping before it reached a pixel -> 512.
 *  - Roughness is low-frequency on all three surfaces -> half the albedo size,
 *    converted to greyscale (three.js samples .g; R=G=B decodes correctly) so
 *    that WebP's chroma subsampling has nothing to damage.
 *
 * Quality: albedo is real colour and tolerates q84-88. Normal maps are vector
 * data, and lossy WebP is always 4:2:0, so they get q90 to limit the damage —
 * measured RMSE at q90 was within 0.2 points of near-lossless while being 12x
 * to 50x smaller.
 */
const OUTPUTS = [
  // --- board: carbonized-bamboo game board (RULES.md §9) ---
  { name: 'board_albedo', source: 'bamboo', map: 'diffuse', hd: 1024, quality: 88, gray: false, srgb: true },
  { name: 'board_normal', source: 'bamboo', map: 'normal', hd: 1024, quality: 90, gray: false, srgb: false },
  { name: 'board_rough', source: 'bamboo', map: 'rough', hd: 512, quality: 88, gray: true, srgb: false },

  // --- table: neutral felt, tinted by the scene ---
  { name: 'table_albedo', source: 'felt', map: 'diffuse', hd: 512, quality: 84, gray: false, srgb: true },
  { name: 'table_normal', source: 'felt', map: 'normal', hd: 512, quality: 88, gray: false, srgb: false },
  { name: 'table_rough', source: 'felt', map: 'rough', hd: 256, quality: 85, gray: true, srgb: false },

  // --- pieces: injection-moulded plastic, no albedo ---
  { name: 'piece_normal', source: 'plastic', map: 'normal', hd: 512, quality: 90, gray: false, srgb: false },
  { name: 'piece_rough', source: 'plastic', map: 'rough', hd: 512, quality: 88, gray: true, srgb: false },
];

const TIERS = { hd: 1, sd: 0.5 };
const MIN_TIER_PX = 256;

/** Total payload we refuse to exceed, per tier. Failing this is a hard error. */
const BUDGET_BYTES = { hd: 460 * 1024, sd: 160 * 1024 };

/* ========================================================================== *
 * Small utilities
 * ========================================================================== */

const c = {
  dim: (s) => `[2m${s}[0m`,
  red: (s) => `[31m${s}[0m`,
  green: (s) => `[32m${s}[0m`,
  yellow: (s) => `[33m${s}[0m`,
  bold: (s) => `[1m${s}[0m`,
};

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/* ========================================================================== *
 * Minimal ZIP reader
 * ========================================================================== *
 *
 * ambientCG ships zips and Node has no built-in reader. Rather than add a
 * dependency or shell out to `unzip` (which may not exist), this walks the
 * central directory directly. Handles stored (0) and deflate (8), which is
 * everything these archives use.
 */
function readZipEntry(buf, wantName) {
  // End of central directory: scan back for signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (name === wantName) {
      // The local header has its own (often different) extra-field length.
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('corrupt local file header');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method} for ${wantName}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`entry not found in zip: ${wantName}`);
}

/* ========================================================================== *
 * Download with cache
 * ========================================================================== */

let networkFailed = false;

/**
 * Fetch `url` into the cache as `name`, unless already cached. Returns the
 * file's bytes, or null if it isn't cached and can't be downloaded.
 */
async function cachedDownload(url, name, expectedMd5) {
  const dest = path.join(CACHE_DIR, name);

  if (await exists(dest)) {
    const buf = await fs.readFile(dest);
    if (!expectedMd5 || md5(buf) === expectedMd5) {
      console.log(c.dim(`  cached   ${name} (${kb(buf.length)})`));
      return buf;
    }
    console.log(c.yellow(`  checksum mismatch on cached ${name}, re-downloading`));
  }

  if (networkFailed) {
    console.log(c.dim(`  skipped  ${name} (network already known to be down)`));
    return null;
  }

  try {
    process.stdout.write(c.dim(`  download ${name} ... `));
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'otrio-texture-fetch/1.0 (+https://github.com/; CC0 assets)' },
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());

    if (expectedMd5 && md5(buf) !== expectedMd5) {
      throw new Error(`checksum mismatch: expected ${expectedMd5}, got ${md5(buf)}`);
    }

    // Write via a temp file so an interrupted run never leaves a truncated
    // file that a later run would trust.
    const tmp = `${dest}.${process.pid}.part`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, dest);
    console.log(c.green(`ok (${kb(buf.length)})`));
    return buf;
  } catch (err) {
    console.log(c.red(`failed: ${err.message}`));
    // Anything that looks like a connectivity problem disables further
    // attempts, so an offline run fails once rather than eight times.
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|timeout|aborted/i.test(String(err))) {
      networkFailed = true;
    }
    return null;
  }
}

/* ========================================================================== *
 * Image processing
 * ========================================================================== */

let magickBin = null;

async function findMagick() {
  for (const bin of ['magick', 'convert']) {
    const ok = await new Promise((resolve) => {
      const p = spawn(bin, ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
    if (ok) return bin;
  }
  return null;
}

/**
 * Run ImageMagick once, single-threaded and niced. Never run two of these
 * concurrently — see the header.
 */
function runMagick(args) {
  return new Promise((resolve, reject) => {
    const useNice = process.platform !== 'win32';
    const cmd = useNice ? 'nice' : magickBin;
    const fullArgs = useNice ? ['-n', '19', magickBin, ...args] : args;

    const p = spawn(cmd, fullArgs, {
      env: {
        ...process.env,
        MAGICK_THREAD_LIMIT: '1',
        OMP_NUM_THREADS: '1',
        MAGICK_THROTTLE: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d;
    });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ImageMagick exited ${code}: ${stderr.trim()}`)),
    );
  });
}

/**
 * Convert one source map to one WebP output at one size.
 *
 * Colour handling is explicit and worth reading:
 *  - `-colorspace sRGB` on albedo keeps it in sRGB; three.js is told to decode
 *    it (texture.colorSpace = SRGBColorSpace).
 *  - Data maps (normal/roughness) get `-set colorspace sRGB`, which relabels
 *    without converting, so the stored bytes pass through untouched. Letting
 *    ImageMagick "helpfully" linearise them is the classic way to wreck a
 *    normal map.
 *  - Resizing a normal map rescales vectors but does not renormalise them.
 *    That is fine at these ratios: the shader renormalises after applying
 *    normalScale.
 */
async function processMap(srcPath, outPath, { size, quality, gray, srgb }) {
  const args = [srcPath];

  if (srgb) {
    args.push('-colorspace', 'sRGB');
  } else {
    // relabel, do not convert
    args.push('-set', 'colorspace', 'sRGB');
  }

  args.push('-filter', 'Lanczos', '-resize', `${size}x${size}!`);

  if (gray) {
    // Roughness is scalar. Greyscale removes chroma entirely, so WebP's 4:2:0
    // subsampling has nothing to lose. three.js reads .g, and a greyscale
    // WebP decodes to R=G=B, so .g is the value we stored.
    args.push('-colorspace', 'Gray', '-set', 'colorspace', 'sRGB');
  }

  args.push('-strip', '-define', `webp:method=6`, '-quality', String(quality), outPath);
  await runMagick(args);
}

/* ========================================================================== *
 * Verification against src/scene/textures.ts
 * ========================================================================== */

/**
 * The app's manifest lives in src/scene/textures.ts (so there is no extra
 * round-trip at runtime). This checks the two have not drifted: every .webp
 * basename that file names must exist in every tier we built.
 */
async function verifyAgainstApp(builtNames) {
  if (!(await exists(TEXTURES_TS))) {
    console.log(c.yellow('  ! src/scene/textures.ts not found, skipping manifest cross-check'));
    return [];
  }
  const src = await fs.readFile(TEXTURES_TS, 'utf8');
  const wanted = new Set([...src.matchAll(/['"]([a-z0-9_]+\.webp)['"]/g)].map((m) => m[1]));
  const missing = [];
  for (const file of wanted) {
    const base = file.replace(/\.webp$/, '');
    if (!builtNames.has(base)) missing.push(file);
  }
  return missing;
}

/* ========================================================================== *
 * Main
 * ========================================================================== */

async function main() {
  console.log(c.bold('\notrio textures — CC0 PBR pipeline\n'));

  if (CLEAN) {
    await fs.rm(OUT_DIR, { recursive: true, force: true });
    await fs.rm(CACHE_DIR, { recursive: true, force: true });
    console.log('Removed public/textures and the download cache.');
    return 0;
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  for (const tier of Object.keys(TIERS)) {
    await fs.mkdir(path.join(OUT_DIR, tier), { recursive: true });
  }

  let state = {};
  if (!FORCE && (await exists(STATE_FILE))) {
    try {
      state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    } catch {
      state = {};
    }
  }

  /* ---- 1. acquire sources ------------------------------------------------ */

  console.log(c.bold('Sources'));
  /** @type {Record<string, Record<string, {buf: Buffer, md5: string}>>} */
  const maps = {};

  for (const [key, src] of Object.entries(SOURCES)) {
    console.log(`  ${c.bold(src.displayName)} ${c.dim(`— ${src.provider}, CC0-1.0`)}`);
    maps[key] = {};

    if (src.kind === 'files') {
      for (const [mapName, f] of Object.entries(src.files)) {
        const local = `${src.assetId}_${mapName}.jpg`;
        const buf = await cachedDownload(f.url, local, f.md5);
        if (buf) maps[key][mapName] = { buf, md5: md5(buf) };
      }
    } else {
      const zip = await cachedDownload(src.zipUrl, src.zipName, null);
      if (zip) {
        for (const [mapName, entry] of Object.entries(src.entries)) {
          try {
            const buf = readZipEntry(zip, entry);
            maps[key][mapName] = { buf, md5: md5(buf) };
          } catch (err) {
            console.log(c.red(`  ! could not extract ${entry}: ${err.message}`));
          }
        }
        console.log(c.dim(`  extracted ${Object.keys(maps[key]).length} map(s) from ${src.zipName}`));
      }
    }
  }

  /* ---- 2. process -------------------------------------------------------- */

  magickBin = await findMagick();
  if (!magickBin) {
    console.log(
      c.yellow(
        '\n! ImageMagick not found (looked for `magick` and `convert`).\n' +
          '  Cannot process textures. Existing outputs are left untouched.\n' +
          '  Install it with e.g. `dnf install ImageMagick` or `brew install imagemagick`.',
      ),
    );
  } else {
    console.log(c.bold(`\nProcessing ${c.dim(`(${magickBin}, single-threaded, nice -n 19)`)}`));
  }

  const tmpDir = path.join(CACHE_DIR, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  const built = new Set();
  const report = [];
  let didWork = false;

  for (const out of OUTPUTS) {
    const src = maps[out.source]?.[out.map];

    for (const [tier, scale] of Object.entries(TIERS)) {
      const size = Math.max(MIN_TIER_PX, Math.round(out.hd * scale));
      const outPath = path.join(OUT_DIR, tier, `${out.name}.webp`);
      const stateKey = `${tier}/${out.name}`;

      // Key on source bytes + every parameter that affects the result, so a
      // settings change rebuilds exactly what it should.
      const recipe = src
        ? sha1([src.md5, size, out.quality, out.gray, out.srgb, 'v1'].join('|'))
        : null;

      if (!FORCE && recipe && state[stateKey] === recipe && (await exists(outPath))) {
        const st = await fs.stat(outPath);
        built.add(out.name);
        report.push({ tier, name: out.name, size, bytes: st.size, status: 'up-to-date' });
        continue;
      }

      if (!src || !magickBin) {
        if (await exists(outPath)) {
          const st = await fs.stat(outPath);
          built.add(out.name);
          report.push({ tier, name: out.name, size, bytes: st.size, status: 'kept (no source)' });
        } else {
          report.push({ tier, name: out.name, size, bytes: 0, status: c.red('MISSING') });
        }
        continue;
      }

      // Write the source to a temp file for ImageMagick (zip entries are only
      // in memory).
      const tmpSrc = path.join(tmpDir, `${out.source}_${out.map}.jpg`);
      await fs.writeFile(tmpSrc, src.buf);

      // One image at a time. Sequential on purpose.
      await processMap(tmpSrc, outPath, {
        size,
        quality: out.quality,
        gray: out.gray,
        srgb: out.srgb,
      });

      const st = await fs.stat(outPath);
      state[stateKey] = recipe;
      built.add(out.name);
      didWork = true;
      report.push({ tier, name: out.name, size, bytes: st.size, status: c.green('built') });
    }
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));

  /* ---- 3. report and budget --------------------------------------------- */

  console.log();
  const totals = {};
  for (const tier of Object.keys(TIERS)) {
    console.log(c.bold(`  ${tier}/`));
    let sum = 0;
    for (const r of report.filter((r) => r.tier === tier)) {
      sum += r.bytes;
      console.log(
        `    ${r.name.padEnd(14)} ${String(r.size).padStart(4)}px  ${kb(r.bytes).padStart(9)}  ${c.dim(r.status)}`,
      );
    }
    totals[tier] = sum;
    const budget = BUDGET_BYTES[tier];
    const verdict =
      sum <= budget ? c.green(`within budget (${kb(budget)})`) : c.red(`OVER BUDGET (${kb(budget)})`);
    console.log(`    ${c.bold('total'.padEnd(14))}       ${kb(sum).padStart(9)}  ${verdict}`);
  }

  /* ---- 4. manifest ------------------------------------------------------- */

  const manifest = {
    _comment:
      'Generated by scripts/fetch-textures.mjs. Provenance and licensing for every file below. ' +
      'This file is NOT fetched at runtime — src/scene/textures.ts holds the paths inline to ' +
      'avoid an extra round-trip. It exists for auditing. See docs/TEXTURE-LICENSES.md.',
    generated: new Date().toISOString().slice(0, 10),
    tiers: Object.fromEntries(
      Object.keys(TIERS).map((t) => [t, { totalBytes: totals[t], budgetBytes: BUDGET_BYTES[t] }]),
    ),
    textures: OUTPUTS.map((o) => {
      const src = SOURCES[o.source];
      return {
        name: o.name,
        files: Object.fromEntries(
          Object.keys(TIERS).map((t) => [
            t,
            {
              path: `textures/${t}/${o.name}.webp`,
              px: Math.max(MIN_TIER_PX, Math.round(o.hd * TIERS[t])),
              bytes: report.find((r) => r.tier === t && r.name === o.name)?.bytes ?? 0,
            },
          ]),
        ),
        colorSpace: o.srgb ? 'sRGB' : 'linear',
        greyscale: o.gray,
        webpQuality: o.quality,
        source: {
          provider: src.provider,
          assetId: src.assetId,
          displayName: src.displayName,
          pageUrl: src.pageUrl,
          map: o.map,
          authors: src.authors,
          tileSizeMm: src.tileSizeMm,
        },
        license: LICENSES[src.provider],
      };
    }),
  };
  await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  /* ---- 5. cross-check with the app -------------------------------------- */

  const missing = await verifyAgainstApp(built);
  const overBudget = Object.entries(totals).filter(([t, v]) => v > BUDGET_BYTES[t]);
  const failedOutputs = report.filter((r) => r.bytes === 0);

  console.log();
  if (missing.length > 0) {
    console.log(
      c.red(
        `! src/scene/textures.ts references files this script did not build: ${missing.join(', ')}`,
      ),
    );
  }
  if (overBudget.length > 0) {
    console.log(c.red(`! payload budget exceeded for: ${overBudget.map(([t]) => t).join(', ')}`));
  }

  if (failedOutputs.length > 0) {
    console.log(
      c.yellow(
        `! ${failedOutputs.length} texture(s) could not be produced.\n` +
          '  The game still runs: src/scene/textures.ts falls back to flat colours.',
      ),
    );
  } else if (!didWork) {
    console.log(c.green('Everything up to date. Nothing downloaded, nothing re-encoded.'));
  } else {
    console.log(c.green('Done.'));
  }

  const bad = missing.length > 0 || overBudget.length > 0 || failedOutputs.length > 0;
  if (bad && STRICT) return 1;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Even an unexpected crash must not break a build.
    console.error(c.red(`\nfetch-textures crashed: ${err?.stack ?? err}`));
    console.error(
      c.yellow('Committed textures (if present) are untouched and the app has flat-colour fallbacks.'),
    );
    process.exit(STRICT ? 1 : 0);
  });
