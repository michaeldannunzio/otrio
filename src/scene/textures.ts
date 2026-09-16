/**
 * textures.ts — PBR texture loading for the Otrio scene.
 *
 * ---------------------------------------------------------------------------
 * QUICK START (react-three-fiber)
 * ---------------------------------------------------------------------------
 *
 *   import { useSurfaceMaterial } from './textures';
 *
 *   function Board() {
 *     const mat = useSurfaceMaterial('board');
 *     return (
 *       <mesh>
 *         <boxGeometry args={[0.3, 0.02, 0.3]} />
 *         <meshStandardMaterial {...mat} />
 *       </mesh>
 *     );
 *   }
 *
 *   function Piece({ color }: { color: string }) {
 *     const mat = useSurfaceMaterial('piece', { color });  // colour comes from YOU
 *     return <meshStandardMaterial {...mat} />;
 *   }
 *
 * That is the whole contract. `useSurfaceMaterial` NEVER suspends and NEVER
 * throws. On first render it returns a flat-colour approximation; when the
 * textures arrive the component re-renders with the maps attached. If the
 * network is down, or an asset 404s, you keep the flat colour forever and the
 * game stays playable. You do not need a <Suspense> boundary.
 *
 * ---------------------------------------------------------------------------
 * ONE-TIME SETUP (recommended, not required)
 * ---------------------------------------------------------------------------
 *
 * Anisotropic filtering matters enormously for the table and board, which are
 * near-flat planes seen at a grazing angle. Without it they turn to mush a few
 * tiles out. We cannot query the limit without a renderer, so the scene root
 * should hand it to us once:
 *
 *   function SceneRoot() {
 *     const gl = useThree((s) => s.gl);
 *     useEffect(() => {
 *       configureTextures({ maxAnisotropy: gl.capabilities.getMaxAnisotropy() });
 *     }, [gl]);
 *     ...
 *   }
 *
 * Skipping this is safe — you just get anisotropy 1 (blurry at grazing angles).
 *
 * ---------------------------------------------------------------------------
 * COLOUR SPACE — the thing that is always wrong in PBR code
 * ---------------------------------------------------------------------------
 *
 * Albedo/base-colour maps are authored in sRGB and MUST be decoded to linear
 * before lighting. Normal, roughness, metalness and AO maps are *data*, not
 * colour, and must be sampled raw. Getting this backwards gives you washed-out
 * albedo and flat, plasticky lighting.
 *
 *   albedo (`map`)                     -> THREE.SRGBColorSpace
 *   normal / roughness / AO / metal    -> THREE.NoColorSpace  (i.e. linear)
 *
 * This module sets `colorSpace` explicitly on every texture — including the
 * linear ones, where it is already the default — so the intent is visible at
 * the call site and survives any future change to the library default.
 *
 * For this to produce correct output the renderer must also be in sRGB output
 * mode. That is three.js's default since r152 (`gl.outputColorSpace ===
 * THREE.SRGBColorSpace`); just don't set it to anything else.
 *
 * ---------------------------------------------------------------------------
 * NORMAL MAP CONVENTION
 * ---------------------------------------------------------------------------
 *
 * All normal maps here are OpenGL convention (+Y = up), which is what three.js
 * expects. The DirectX variants (-Y) were deliberately not used. If lighting
 * ever looks inverted — bumps reading as dents — that is the green channel,
 * and the fix belongs in scripts/fetch-textures.mjs, not in the shader.
 *
 * ---------------------------------------------------------------------------
 * ROUGHNESS IS A MULTIPLIER, NOT A VALUE
 * ---------------------------------------------------------------------------
 *
 * When a `roughnessMap` is present three.js does:
 *
 *     roughnessFactor = material.roughness * texture.g
 *
 * So `roughness` stops being "how rough is this" and becomes a gain on the
 * map. Leaving a hand-tuned 0.25 in place next to a map whose mean is 0.36
 * would give an effective 0.09 — a mirror. Each surface below therefore
 * carries two numbers: `flatRoughness` (used when no map loaded) and
 * `roughnessScale` (the gain applied to the map, normally 1.0). The hook picks
 * the right one.
 *
 * Measured means of the shipped roughness maps, so you can predict the result:
 *   board 0.76 (matte bamboo) · table 0.82 (felt) · piece 0.36 (glossy plastic)
 *
 * The same multiply applies to `map`/`color`: a textured surface wants a
 * near-white `color` unless you are deliberately tinting it.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO AMBIENT OCCLUSION MAP
 * ---------------------------------------------------------------------------
 *
 * Measured, not assumed: the board's source AO map has mean 98.7% and standard
 * deviation 1.1%. It is a white image. Flat veneer has no self-occlusion worth
 * baking, and the occlusion you actually want — inside the board's recessed
 * piece slots — comes from geometry, not from a texture. Shipping it would
 * have been ~25 KB of white per tier.
 *
 * The `aoMap` field is still present in the returned props (always null) so
 * that spreading these props over a material reliably clears any AO a previous
 * material had, and so the plumbing is there if a future surface needs one.
 *
 * `metalnessMap` is likewise unused: every surface here is a dielectric, so
 * metalness is a constant 0.
 *
 * ---------------------------------------------------------------------------
 * SHARING AND `repeat`
 * ---------------------------------------------------------------------------
 *
 * Textures are cached per (surface, map, tier) and shared between every mesh
 * that asks for them. If you pass a custom `repeat`, you get a `.clone()`
 * rather than a mutated shared texture — otherwise two meshes with different
 * tiling would fight over one object and the last one to render would win.
 *
 * Cloning is cheap: `Texture.clone()` shares the underlying `Source`, and
 * three.js keys its GPU upload cache on sampler state (wrap/filter/anisotropy),
 * not on `repeat`/`offset`. So N clones at different tilings are still one
 * texture in VRAM.
 *
 * ---------------------------------------------------------------------------
 * RESOLUTION TIERS
 * ---------------------------------------------------------------------------
 *
 * Two tiers ship: 'sd' (512px, ~250 KB total) and 'hd' (1024px, ~800 KB
 * total). Exactly one tier is ever fetched. The default is chosen from screen
 * size, DPR and the Save-Data header — see `pickDefaultTier`. Override with
 * `configureTextures({ tier: 'hd' })` before anything loads, or let the user
 * choose in settings.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';

/* ========================================================================== *
 * Public types
 * ========================================================================== */

/** The three distinct materials in the scene. */
export type SurfaceId = 'board' | 'table' | 'piece';

/** Texture resolution tier. 'sd' = 512px, 'hd' = 1024px. */
export type QualityTier = 'sd' | 'hd';

/**
 * Props to spread directly onto `<meshStandardMaterial>` (or to pass to the
 * `MeshStandardMaterial` constructor). Every field is always present; the map
 * fields are `null` until the textures load, and stay `null` if they fail.
 */
export interface SurfaceMaterialProps {
  /**
   * Base colour. For textured surfaces this is white (so the albedo map shows
   * through unmodified) or the flat fallback colour while loading. For
   * 'piece' it is whatever colour you passed in — pieces have no albedo map
   * precisely so that you can tint them per player.
   */
  color: string;
  roughness: number;
  metalness: number;
  map: THREE.Texture | null;
  normalMap: THREE.Texture | null;
  normalScale: THREE.Vector2;
  roughnessMap: THREE.Texture | null;
  aoMap: THREE.Texture | null;
  aoMapIntensity: number;
  envMapIntensity: number;
}

export interface UseSurfaceMaterialOptions {
  /**
   * Base colour override.
   *
   * - For 'piece' this is the player colour and is REQUIRED in practice —
   *   pieces ship without an albedo map so this is the only thing that makes
   *   a red piece red.
   * - For 'board'/'table' this multiplies the albedo map, and both surfaces
   *   already use it: the board is tinted from blonde bamboo to carbonized,
   *   and the neutral grey felt is tinted to baize green. Override it to
   *   restyle either surface without touching the assets — the felt in
   *   particular takes any hue cleanly because the scan is desaturated.
   */
  color?: string;

  /**
   * Texture tiling. Number = square repeat, tuple = [x, y].
   *
   * Defaults are tuned per surface (see SURFACES below). Raising it makes the
   * grain/weave finer and hides tiling seams; lowering it magnifies the
   * texture and will eventually go soft.
   */
  repeat?: number | [number, number];

  /** Normal map strength. 1 = as authored. Lower for a subtler surface. */
  normalScale?: number;

  /**
   * Override roughness.
   *
   * Careful: three.js multiplies this by the roughness map, so once the
   * textures have loaded this is a GAIN (1 = the map as authored), not an
   * absolute roughness. Leave it undefined and the surface picks the right
   * behaviour for whether its map is loaded yet. See the header.
   */
  roughness?: number;
}

/** Snapshot of overall texture loading, for progress UI. */
export interface TextureLoadState {
  /**
   * - 'idle'    nothing requested yet
   * - 'loading' at least one request in flight
   * - 'ready'   everything requested has settled, nothing failed
   * - 'partial' everything settled, but some assets failed (fallbacks in use)
   */
  status: 'idle' | 'loading' | 'ready' | 'partial';
  /** Files that have settled (loaded or failed). */
  loaded: number;
  /** Files requested so far. */
  total: number;
  /** `loaded / total`, or 1 when nothing has been requested. */
  progress: number;
  /** Public paths that failed to load. Non-fatal; those maps are null. */
  failed: string[];
  /** The tier actually in use. */
  tier: QualityTier;
}

/* ========================================================================== *
 * Asset manifest
 * ========================================================================== *
 *
 * Kept in lockstep with scripts/fetch-textures.mjs, which verifies at the end
 * of every run that every path referenced here exists on disk and fails loudly
 * if one is missing.
 *
 * Provenance and licensing for every file: docs/TEXTURE-LICENSES.md
 * (all assets are CC0 1.0 Universal — no attribution required).
 */

type MapKind = 'albedo' | 'normal' | 'rough' | 'ao';

interface SurfaceSpec {
  /** file basenames under /textures/<tier>/, keyed by map kind */
  files: Partial<Record<MapKind, string>>;
  /** default tiling */
  repeat: [number, number];
  /** flat colour used before/instead of the albedo map */
  fallbackColor: string;
  /** colour multiplier applied once the albedo map is present */
  tintedColor: string;
  /** absolute roughness used when no roughness map is loaded */
  flatRoughness: number;
  /** gain applied to the roughness map when one IS loaded (see header) */
  roughnessScale: number;
  metalness: number;
  normalScale: number;
  aoMapIntensity: number;
  envMapIntensity: number;
}

const SURFACES: Record<SurfaceId, SurfaceSpec> = {
  /**
   * Carbonized bamboo — the board itself.
   *
   * RULES.md §9 pins the reference edition as a "carbonized bamboo board with
   * recessed circular inlays" and asks for "warm matte wood grain", so this is
   * Poly Haven `bamboo_veneer` rather than a varnished hardwood. The source
   * scan is natural blonde bamboo; `tintedColor` darkens and warms it into the
   * carbonized range. Carbonizing is a heat treatment that darkens the sugars,
   * so a multiply is physically the right operation — and it keeps the shipped
   * albedo faithful to the scan. Adjust that one hex value to taste.
   *
   * Tiling: the real board is ~389 mm across (§9, 15 1/3") and the source tile
   * is 1000 mm, so physically-exact would be repeat 0.39. We use 1.0 instead,
   * for two reasons: it puts the full 1024px across the board (2.6 px/mm,
   * properly sharp) instead of using only 40% of it, and the resulting ~6-10 mm
   * bamboo strips read as a finer, better-made board than the ~20 mm strips
   * true scale would give. Both are plausible bamboo; this one looks better.
   */
  board: {
    files: { albedo: 'board_albedo.webp', normal: 'board_normal.webp', rough: 'board_rough.webp' },
    repeat: [1, 1],
    fallbackColor: '#8a6a45',
    tintedColor: '#c9a074',
    flatRoughness: 0.75,
    roughnessScale: 1.0,
    metalness: 0,
    normalScale: 0.6,
    aoMapIntensity: 1.0,
    envMapIntensity: 0.7,
  },

  /**
   * Felt / baize — the table the board sits on.
   *
   * ambientCG `Fabric034`, a near-neutral grey felt (measured saturation 0.03).
   * Deliberately not green: a neutral scan takes a tint cleanly, so the same
   * 11 KB of texture gives baize green, burgundy or charcoal by changing
   * `color`. The default is a deep card-table green.
   *
   * Tiling: 12x assumes a table plane around 1.5 m. Scale it with the plane —
   * if the scene uses a 3 m table, pass `repeat: 24` to keep the fibre size
   * constant. The provider does not publish a physical tile size, so this is
   * matched by eye rather than derived.
   */
  table: {
    files: { albedo: 'table_albedo.webp', normal: 'table_normal.webp', rough: 'table_rough.webp' },
    repeat: [12, 12],
    fallbackColor: '#2c6647',
    tintedColor: '#2c6647',
    flatRoughness: 0.9,
    roughnessScale: 1.0,
    metalness: 0,
    normalScale: 0.8,
    aoMapIntensity: 1.0,
    envMapIntensity: 0.35,
  },

  /**
   * Injection-moulded plastic — the playing pieces.
   *
   * ambientCG `Plastic010`. NOTE: no albedo map, on purpose. Piece colour is
   * player identity and must come from `color`; a baked albedo would fight it.
   * All we take from the scan is the micro-surface.
   *
   * RULES.md §9 wants these to read as "slightly glossy, hard" plastic that
   * "feels a bit cheap in the hand" next to the bamboo — that contrast is the
   * artefact, so resist polishing them. The source roughness map has mean 0.36,
   * which lands exactly there; leave `roughnessScale` at 1.0 unless you want
   * to deliberately move away from the scan.
   *
   * The normal map is nearly flat (measured stddev 0.36%) and encodes to under
   * a kilobyte. It contributes only a faint wobble in the specular highlight —
   * which is precisely the cheap-moulding cue we want — so it earns its ~700
   * bytes.
   */
  piece: {
    files: { normal: 'piece_normal.webp', rough: 'piece_rough.webp' },
    repeat: [1, 1],
    fallbackColor: '#cccccc',
    tintedColor: '#cccccc',
    flatRoughness: 0.35,
    roughnessScale: 1.0,
    metalness: 0,
    normalScale: 0.35,
    aoMapIntensity: 1.0,
    envMapIntensity: 1.1,
  },
};

/** Maps that carry colour and therefore need sRGB decoding. */
const SRGB_MAPS: ReadonlySet<MapKind> = new Set<MapKind>(['albedo']);

/* ========================================================================== *
 * Base URL
 * ========================================================================== */

/**
 * Resolved without importing `vite/client` types, so this file compiles even
 * if the project's tsconfig doesn't pull them in. Honours a non-root deploy
 * base (`vite build --base=/otrio/`).
 */
const BASE_URL: string =
  (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

function publicPath(tier: QualityTier, file: string): string {
  return `${BASE_URL}textures/${tier}/${file}`;
}

/* ========================================================================== *
 * Tier selection
 * ========================================================================== */

function pickDefaultTier(): QualityTier {
  if (typeof window === 'undefined') return 'sd';

  try {
    // Respect an explicit data-saver request above everything else.
    const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } })
      .connection;
    if (conn?.saveData) return 'sd';
    if (conn?.effectiveType && /(^|-)2g$/.test(conn.effectiveType)) return 'sd';

    // Physical pixels across the short edge of the viewport. A phone lands
    // around 750-1200; a laptop 800+ on the short edge but with far more
    // pixels across. Using the short edge keeps portrait phones in 'sd'.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const shortEdge = Math.min(window.screen?.width ?? 1280, window.screen?.height ?? 800) * dpr;
    return shortEdge >= 1400 ? 'hd' : 'sd';
  } catch {
    return 'sd';
  }
}

/* ========================================================================== *
 * Loading state store (framework-agnostic, React-subscribable)
 * ========================================================================== */

let state: TextureLoadState = {
  status: 'idle',
  loaded: 0,
  total: 0,
  progress: 1,
  failed: [],
  tier: pickDefaultTier(),
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function setState(patch: Partial<TextureLoadState>): void {
  const next = { ...state, ...patch };
  next.progress = next.total === 0 ? 1 : next.loaded / next.total;
  if (next.total > 0 && next.loaded >= next.total) {
    next.status = next.failed.length > 0 ? 'partial' : 'ready';
  } else if (next.total > 0) {
    next.status = 'loading';
  }
  state = next;
  emit();
}

/** Current loading snapshot. Safe to call from anywhere, including non-React code. */
export function getTextureLoadState(): TextureLoadState {
  return state;
}

/**
 * Subscribe to loading-state changes. Returns an unsubscribe function.
 * For React, prefer `useTextureLoadState()`.
 */
export function subscribeToTextureLoadState(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/* ========================================================================== *
 * Global configuration
 * ========================================================================== */

let maxAnisotropy = 1;
let tierLocked = false;

export interface ConfigureTexturesOptions {
  /**
   * From `gl.capabilities.getMaxAnisotropy()`. Applied to every texture,
   * including ones already loaded. Call this once from the scene root.
   */
  maxAnisotropy?: number;
  /**
   * Force a resolution tier. Only takes effect before the first load starts;
   * after that it is ignored (changing tier mid-session would mean re-fetching
   * everything, which is not worth the complexity).
   */
  tier?: QualityTier;
}

export function configureTextures(options: ConfigureTexturesOptions): void {
  if (typeof options.maxAnisotropy === 'number' && options.maxAnisotropy > maxAnisotropy) {
    maxAnisotropy = Math.max(1, Math.floor(options.maxAnisotropy));
    // Retro-apply to anything already resident, clones included — a clone
    // copies anisotropy at clone time, so one made before this call would
    // otherwise keep the stale value.
    for (const entry of cache.values()) {
      if (entry.texture) {
        entry.texture.anisotropy = maxAnisotropy;
        entry.texture.needsUpdate = true;
      }
    }
    for (const clone of cloneCache.values()) {
      clone.anisotropy = maxAnisotropy;
      clone.needsUpdate = true;
    }
    emit();
  }

  if (options.tier && !tierLocked && options.tier !== state.tier) {
    setState({ tier: options.tier });
  }
}

/** The tier currently in use. */
export function getTier(): QualityTier {
  return state.tier;
}

/* ========================================================================== *
 * Texture cache and loading
 * ========================================================================== */

interface CacheEntry {
  promise: Promise<THREE.Texture | null>;
  texture: THREE.Texture | null;
  failed: boolean;
}

const cache = new Map<string, CacheEntry>();
const loader = new THREE.TextureLoader();

function cacheKey(surface: SurfaceId, kind: MapKind, tier: QualityTier): string {
  return `${tier}/${surface}/${kind}`;
}

/**
 * Load one map. Resolves to null on any failure — callers must handle null,
 * and every caller in this file does.
 */
function loadMap(surface: SurfaceId, kind: MapKind, tier: QualityTier): CacheEntry {
  const key = cacheKey(surface, kind, tier);
  const existing = cache.get(key);
  if (existing) return existing;

  const file = SURFACES[surface].files[kind];
  if (!file) {
    const entry: CacheEntry = { promise: Promise.resolve(null), texture: null, failed: false };
    cache.set(key, entry);
    return entry;
  }

  const url = publicPath(tier, file);
  tierLocked = true;
  setState({ total: state.total + 1 });

  const entry: CacheEntry = {
    texture: null,
    failed: false,
    promise: new Promise<THREE.Texture | null>((resolve) => {
      loader.load(
        url,
        (texture) => {
          // --- Colour space. See the header comment. ---
          texture.colorSpace = SRGB_MAPS.has(kind) ? THREE.SRGBColorSpace : THREE.NoColorSpace;

          // --- Tiling. Every surface here is a tiled plane or solid. ---
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;

          // --- Filtering. Trilinear + anisotropic; these surfaces are all
          //     viewed at grazing angles. ---
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.generateMipmaps = true;
          texture.anisotropy = maxAnisotropy;

          const spec = SURFACES[surface];
          texture.repeat.set(spec.repeat[0], spec.repeat[1]);
          texture.needsUpdate = true;

          entry.texture = texture;
          setState({ loaded: state.loaded + 1 });
          resolve(texture);
        },
        undefined,
        () => {
          // Non-fatal by design: the surface keeps its flat fallback colour.
          entry.failed = true;
          if (typeof console !== 'undefined') {
            console.warn(
              `[textures] failed to load ${url} — falling back to flat colour for "${surface}".`,
            );
          }
          setState({ loaded: state.loaded + 1, failed: [...state.failed, url] });
          resolve(null);
        },
      );
    }),
  };

  cache.set(key, entry);
  return entry;
}

/**
 * Start loading one or more surfaces without rendering them. Useful to warm
 * the cache during a menu or lobby screen so the board appears textured on
 * first paint.
 *
 * Resolves when everything has settled. Never rejects.
 */
export function preloadSurfaces(...surfaces: SurfaceId[]): Promise<void> {
  const list = surfaces.length > 0 ? surfaces : (Object.keys(SURFACES) as SurfaceId[]);
  const tier = state.tier;
  const jobs: Promise<unknown>[] = [];
  for (const surface of list) {
    for (const kind of Object.keys(SURFACES[surface].files) as MapKind[]) {
      jobs.push(loadMap(surface, kind, tier).promise);
    }
  }
  return Promise.all(jobs).then(() => undefined);
}

/**
 * Dispose every cached texture and reset loading state. Call on teardown (hot
 * reload, leaving the game) if you care about VRAM; you usually don't need to.
 */
export function disposeTextures(): void {
  for (const clone of cloneCache.values()) clone.dispose();
  cloneCache.clear();
  for (const entry of cache.values()) entry.texture?.dispose();
  cache.clear();
  tierLocked = false;
  state = { ...state, status: 'idle', loaded: 0, total: 0, progress: 1, failed: [] };
  emit();
}

/* ========================================================================== *
 * Repeat handling
 * ========================================================================== */

function normalizeRepeat(repeat: number | [number, number] | undefined): [number, number] | null {
  if (repeat === undefined) return null;
  return typeof repeat === 'number' ? [repeat, repeat] : repeat;
}

/**
 * Return a texture tiled as requested. If the request matches the surface
 * default we hand back the shared instance; otherwise we clone, because
 * mutating the shared one would change tiling for every other mesh using it.
 *
 * Clones share the underlying Source, and three.js's GPU cache is keyed on
 * sampler state rather than repeat/offset, so this does not cost extra VRAM.
 */
const cloneCache = new Map<string, THREE.Texture>();

function withRepeat(
  texture: THREE.Texture | null,
  want: [number, number] | null,
  fallback: [number, number],
): THREE.Texture | null {
  if (!texture) return null;
  const [x, y] = want ?? fallback;
  if (texture.repeat.x === x && texture.repeat.y === y) return texture;

  // Memoised: this runs on every re-render, and allocating a fresh clone each
  // time would churn one Texture (and one set of WebGL property entries) per
  // render for every mesh using a custom repeat.
  const key = `${texture.uuid}|${x}|${y}`;
  let clone = cloneCache.get(key);
  if (!clone) {
    clone = texture.clone();
    clone.repeat.set(x, y);
    clone.needsUpdate = true;
    cloneCache.set(key, clone);
  }
  return clone;
}

/* ========================================================================== *
 * React hooks
 * ========================================================================== */

/**
 * Subscribe to texture loading progress. Drive a spinner or progress bar with
 * this; it is the only thing the UI needs.
 *
 *   const { status, progress } = useTextureLoadState();
 *   if (status === 'loading') return <Spinner value={progress} />;
 *
 * Note that 'partial' is a success state as far as the game is concerned —
 * some maps failed and those surfaces are flat-shaded, but everything works.
 */
export function useTextureLoadState(): TextureLoadState {
  return useSyncExternalStore(
    useCallback((fn: () => void) => subscribeToTextureLoadState(fn), []),
    getTextureLoadState,
    getTextureLoadState,
  );
}

/**
 * The main entry point. Returns props to spread onto `<meshStandardMaterial>`.
 *
 * Does not suspend, does not throw. Returns flat-colour props immediately and
 * re-renders with maps attached once they load.
 *
 *   <meshStandardMaterial {...useSurfaceMaterial('board')} />
 *   <meshStandardMaterial {...useSurfaceMaterial('piece', { color: '#c0392b' })} />
 *   <meshStandardMaterial {...useSurfaceMaterial('table', { repeat: 20 })} />
 */
export function useSurfaceMaterial(
  surface: SurfaceId,
  options: UseSurfaceMaterialOptions = {},
): SurfaceMaterialProps {
  const { color, repeat, normalScale, roughness } = options;
  const loadState = useTextureLoadState();
  const tier = loadState.tier;

  // Kick off loading. Effect (not render) so we stay StrictMode-safe and
  // side-effect-free during render.
  const started = useRef<string>('');
  useEffect(() => {
    const key = `${surface}/${tier}`;
    if (started.current === key) return;
    started.current = key;
    void preloadSurfaces(surface);
  }, [surface, tier]);

  const spec = SURFACES[surface];
  const wantRepeat = useMemo(() => normalizeRepeat(repeat), [repeat]);
  const normalScaleVec = useMemo(
    () => new THREE.Vector2(normalScale ?? spec.normalScale, normalScale ?? spec.normalScale),
    [normalScale, spec.normalScale],
  );

  // `loadState` is in the dep list so that each settled file re-runs this and
  // the maps appear as they arrive.
  return useMemo(() => {
    const get = (kind: MapKind): THREE.Texture | null =>
      spec.files[kind] ? (cache.get(cacheKey(surface, kind, tier))?.texture ?? null) : null;

    const albedo = withRepeat(get('albedo'), wantRepeat, spec.repeat);
    const normal = withRepeat(get('normal'), wantRepeat, spec.repeat);
    const roughnessMap = withRepeat(get('rough'), wantRepeat, spec.repeat);
    const aoMap = withRepeat(get('ao'), wantRepeat, spec.repeat);

    // If there is no albedo map, `color` is the surface's entire colour, so
    // the fallback applies. If there is one, `color` multiplies it.
    const baseColor = color ?? (albedo ? spec.tintedColor : spec.fallbackColor);

    // See the header: with a map present, `roughness` is a gain on it, not a
    // value. Using the same number for both cases is the bug this avoids.
    const baseRoughness =
      roughness ?? (roughnessMap ? spec.roughnessScale : spec.flatRoughness);

    return {
      color: baseColor,
      roughness: baseRoughness,
      metalness: spec.metalness,
      map: albedo,
      normalMap: normal,
      normalScale: normalScaleVec,
      roughnessMap,
      aoMap,
      aoMapIntensity: spec.aoMapIntensity,
      envMapIntensity: spec.envMapIntensity,
    };
  }, [
    surface,
    tier,
    spec,
    color,
    roughness,
    normalScaleVec,
    wantRepeat,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    loadState,
  ]);
}

/**
 * Escape hatch for imperative three.js code that isn't using r3f's declarative
 * materials. Applies the same maps and settings to an existing material and
 * resolves once everything has settled.
 *
 *   const mat = new THREE.MeshStandardMaterial();
 *   await applySurfaceToMaterial(mat, 'board');
 */
export async function applySurfaceToMaterial(
  material: THREE.MeshStandardMaterial,
  surface: SurfaceId,
  options: UseSurfaceMaterialOptions = {},
): Promise<THREE.MeshStandardMaterial> {
  const spec = SURFACES[surface];
  const tier = state.tier;
  await preloadSurfaces(surface);

  const wantRepeat = normalizeRepeat(options.repeat);
  const get = (kind: MapKind): THREE.Texture | null =>
    spec.files[kind]
      ? withRepeat(cache.get(cacheKey(surface, kind, tier))?.texture ?? null, wantRepeat, spec.repeat)
      : null;

  const albedo = get('albedo');
  const roughnessMap = get('rough');

  material.map = albedo;
  material.normalMap = get('normal');
  material.normalScale.setScalar(options.normalScale ?? spec.normalScale);
  material.roughnessMap = roughnessMap;
  material.aoMap = get('ao');
  material.aoMapIntensity = spec.aoMapIntensity;
  material.roughness =
    options.roughness ?? (roughnessMap ? spec.roughnessScale : spec.flatRoughness);
  material.metalness = spec.metalness;
  material.envMapIntensity = spec.envMapIntensity;
  material.color.set(options.color ?? (albedo ? spec.tintedColor : spec.fallbackColor));
  material.needsUpdate = true;
  return material;
}

/**
 * Flat-colour props for a surface, with no textures at all. Handy for tests,
 * for a deliberate low-fidelity mode, or as a reference for what the fallback
 * looks like.
 */
export function getFallbackMaterialProps(
  surface: SurfaceId,
  color?: string,
): SurfaceMaterialProps {
  const spec = SURFACES[surface];
  return {
    color: color ?? spec.fallbackColor,
    roughness: spec.flatRoughness,
    metalness: spec.metalness,
    map: null,
    normalMap: null,
    normalScale: new THREE.Vector2(spec.normalScale, spec.normalScale),
    roughnessMap: null,
    aoMap: null,
    aoMapIntensity: spec.aoMapIntensity,
    envMapIntensity: spec.envMapIntensity,
  };
}

/**
 * Every public texture path this module can request, for both tiers. The fetch
 * script reads this to verify that the files it produced match what the app
 * expects.
 */
export function listTexturePaths(): string[] {
  const out: string[] = [];
  for (const tier of ['sd', 'hd'] as QualityTier[]) {
    for (const surface of Object.keys(SURFACES) as SurfaceId[]) {
      for (const file of Object.values(SURFACES[surface].files)) {
        if (file) out.push(`textures/${tier}/${file}`);
      }
    }
  }
  return out;
}
