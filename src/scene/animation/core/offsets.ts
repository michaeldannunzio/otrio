/**
 * The offset registry — "animation is a delta from truth, never truth itself".
 *
 * This is the single most important structural decision in the animation layer,
 * and everything else follows from it.
 *
 * Every piece renders at the position the *rules engine* says it is at. An
 * animation never sets that position. It writes into a separate per-piece
 * **offset** which is added on top at draw time and which always decays to
 * zero. Consequences, all of which are requirements for this game:
 *
 *  - **Animations cannot block input.** The move is committed at t=0; the
 *    offset is cosmetic. A player may place their next piece while the last one
 *    is still settling, and nothing has to be awaited or cancelled.
 *
 *  - **Interruption is free.** Killing an animation means zeroing an offset.
 *    The piece is instantly correct — it was always correct. There is no
 *    "snap back to where it should have been" case to get wrong.
 *
 *  - **Dropped frames and dropped animations are harmless.** If an animation
 *    never runs at all (tab backgrounded, resync, low tier), the board is still
 *    right. This is what lets the network layer treat its events as
 *    best-effort hints, exactly as `net/protocol.ts` promises.
 *
 *  - **Several animations can affect one piece.** A winning piece can be lifted
 *    by the win sequence and glowing from a hover at the same time, because
 *    tracks *accumulate* into the offset rather than assigning to it.
 *
 * ## Two layers: animated and static
 *
 * Some visual states must PERSIST — a losing piece stays dimmed after the win
 * animation ends; a disconnected player's pieces stay grey. Expressing those as
 * never-ending animations would pin `frameloop="demand"` awake forever and cook
 * the battery, which is the exact failure this system exists to avoid.
 *
 * So each binding also carries a **static** layer, written once and applied on
 * top of the animated offset. A transition animates into a static value and
 * then latches it, costing nothing thereafter. Changing a static marks the
 * binding dirty and buys exactly one frame.
 */

import type { Material, Object3D } from 'three';
import { KEY_COUNT } from './ids';

/**
 * A per-piece visual delta. All fields are plain numbers; this object is
 * allocated once at startup and mutated forever after.
 *
 * Composition rules when several tracks touch the same piece in one frame:
 *  - position / rotation: **added**
 *  - scale: **multiplied**
 *  - emissive: **added**
 *  - dim / fade / tint: **max**, so two dimming tracks cannot push past 1
 */
export class PieceOffset {
  /** Position delta, in the object's parent space. */
  px = 0;
  py = 0;
  pz = 0;

  /** Scale multiplier. 1 = untouched. */
  sx = 1;
  sy = 1;
  sz = 1;

  /** Rotation delta in radians, added to the base euler. */
  rx = 0;
  ry = 0;
  rz = 0;

  /** Additive emissive intensity — the "glow" channel. */
  emissive = 0;

  /** 0..1 darkening, for pushing non-winning pieces into the background. */
  dim = 0;

  /** 0..1 transparency, for entrances, exits and ghosts. */
  fade = 0;

  /** Colour overlay, used for the rejection flash and player-left greying. */
  tintR = 0;
  tintG = 0;
  tintB = 0;
  /** Overlay strength. 0 means no tint and skips the colour work entirely. */
  tintA = 0;

  /** True while this offset is accumulating and needs resetting next frame. */
  active = false;

  reset(): void {
    this.px = this.py = this.pz = 0;
    this.sx = this.sy = this.sz = 1;
    this.rx = this.ry = this.rz = 0;
    this.emissive = 0;
    this.dim = 0;
    this.fade = 0;
    this.tintR = this.tintG = this.tintB = this.tintA = 0;
  }
}

/**
 * What a renderable registers so the runtime can drive it.
 *
 * `base*` is the truth — where the rules engine and the scene layout say this
 * piece belongs. The scene owner updates these whenever the logical position
 * changes; the animation layer only ever reads them.
 */
export interface PieceBinding {
  object: Object3D | null;

  /**
   * Per-piece material, or null.
   *
   * MUST be unique to this piece if provided. Materials are usually shared per
   * colour for batching, and mutating a shared material's emissive would light
   * up all nine of that colour's pieces at once. If the piece does not own its
   * material, pass null and read the offset yourself (see `readOffset`) — the
   * transform channels still work, because `Object3D` is always per-piece.
   */
  material: Material | null;

  baseX: number;
  baseY: number;
  baseZ: number;
  baseRX: number;
  baseRY: number;
  baseRZ: number;
  baseScale: number;
  baseEmissive: number;
  baseOpacity: number;

  /** Capability flags, resolved once at bind time so the frame loop never probes. */
  hasEmissive: boolean;
  hasOpacity: boolean;
  hasColor: boolean;
  /** Base colour cached at bind time, so dim and tint are reversible. */
  baseColorR: number;
  baseColorG: number;
  baseColorB: number;

  /** Persistent layer — see the module doc. Applied on top of the offset. */
  sEmissive: number;
  sDim: number;
  sFade: number;
  sTintR: number;
  sTintG: number;
  sTintB: number;
  sTintA: number;
  sLiftY: number;

  /** Set by the owner to temporarily exclude a piece without unbinding. */
  enabled: boolean;

  /**
   * When true, the runtime drives `object.visible` from the combined fade.
   *
   * This is how pooled effect meshes and the 27 target indicators cost nothing
   * while idle: fully faded means not drawn at all, rather than drawn at zero
   * opacity. Off by default, because a piece's visibility belongs to whoever
   * renders it and we must not fight them for it.
   */
  autoHide: boolean;
}

/** Flat, preallocated. Indexed by the integer keys from `ids.ts`. */
const offsets: PieceOffset[] = new Array(KEY_COUNT);
for (let i = 0; i < KEY_COUNT; i++) offsets[i] = new PieceOffset();

const bindings: (PieceBinding | null)[] = new Array(KEY_COUNT).fill(null);

/**
 * Keys whose offset is non-identity this frame. We only ever reset these, so
 * the per-frame cost is proportional to what is animating, not to the ~100
 * possible keys.
 */
const activeKeys: number[] = [];

/** Keys whose static layer changed and need one apply pass. */
const dirtyKeys: number[] = [];

/** Installed by the runner so a static change can wake the demand frame loop. */
let onDirty: (() => void) | null = null;

export function setDirtyListener(fn: (() => void) | null): void {
  onDirty = fn;
}

/** Get the mutable offset for a key. Tracks write through this. */
export function getOffset(key: number): PieceOffset {
  return offsets[key];
}

/**
 * Mark an offset as being written this frame, so it gets reset next frame.
 * Tracks must call this before accumulating, every frame they accumulate.
 */
export function touchOffset(key: number): PieceOffset {
  const o = offsets[key];
  if (!o.active) {
    o.active = true;
    activeKeys.push(key);
  }
  return o;
}

/**
 * Read-only view of a piece's current offset, for scene code that applies the
 * delta itself (instanced meshes, shared materials, custom shaders).
 */
export function readOffset(key: number): Readonly<PieceOffset> {
  return offsets[key];
}

/** Register a renderable. Returns an unbind function. */
export function bindPiece(key: number, binding: PieceBinding): () => void {
  bindings[key] = binding;
  markDirty(key);
  return () => {
    if (bindings[key] === binding) bindings[key] = null;
  };
}

export function getBinding(key: number): PieceBinding | null {
  return bindings[key];
}

/**
 * Build a binding from an `Object3D`, capturing its current transform as the
 * base and probing material capabilities once.
 */
export function makeBinding(object: Object3D, material: Material | null = null): PieceBinding {
  const mat = material as (Material & Record<string, unknown>) | null;
  const hasEmissive = !!mat && typeof mat.emissiveIntensity === 'number';
  const hasOpacity = !!mat && typeof mat.opacity === 'number';
  const col = mat && (mat.color as { r: number; g: number; b: number } | undefined);
  const hasColor = !!col && typeof col.r === 'number';

  return {
    object,
    material,
    baseX: object.position.x,
    baseY: object.position.y,
    baseZ: object.position.z,
    baseRX: object.rotation.x,
    baseRY: object.rotation.y,
    baseRZ: object.rotation.z,
    baseScale: object.scale.x || 1,
    baseEmissive: hasEmissive ? (mat!.emissiveIntensity as number) : 0,
    baseOpacity: hasOpacity ? (mat!.opacity as number) : 1,
    hasEmissive,
    hasOpacity,
    hasColor,
    baseColorR: hasColor ? col!.r : 1,
    baseColorG: hasColor ? col!.g : 1,
    baseColorB: hasColor ? col!.b : 1,
    sEmissive: 0,
    sDim: 0,
    sFade: 0,
    sTintR: 0,
    sTintG: 0,
    sTintB: 0,
    sTintA: 0,
    sLiftY: 0,
    enabled: true,
    autoHide: false,
  };
}

/** Update the logical resting transform of a bound piece. */
export function setBase(key: number, x: number, y: number, z: number): void {
  const b = bindings[key];
  if (!b) return;
  b.baseX = x;
  b.baseY = y;
  b.baseZ = z;
  markDirty(key);
}

/** Mark a key for one apply pass (static layer changed, or a fresh binding). */
export function markDirty(key: number): void {
  if (dirtyKeys.indexOf(key) === -1) dirtyKeys.push(key);
  onDirty?.();
}

/**
 * Write the persistent layer. Values not supplied are left alone.
 *
 * Call this to latch a state that must outlive its transition — the losing
 * pieces' dim, a departed player's grey. Costs one frame, then nothing.
 */
export function setStatic(
  key: number,
  patch: Partial<
    Pick<
      PieceBinding,
      'sEmissive' | 'sDim' | 'sFade' | 'sTintR' | 'sTintG' | 'sTintB' | 'sTintA' | 'sLiftY'
    >
  >,
): void {
  const b = bindings[key];
  if (!b) return;
  let changed = false;
  for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
    const v = patch[k];
    if (v !== undefined && b[k] !== v) {
      b[k] = v;
      changed = true;
    }
  }
  if (changed) markDirty(key);
}

/** Clear every persistent modifier on a key. Used on new game / rematch. */
export function clearStatic(key: number): void {
  const b = bindings[key];
  if (!b) return;
  if (
    b.sEmissive === 0 &&
    b.sDim === 0 &&
    b.sFade === 0 &&
    b.sTintA === 0 &&
    b.sLiftY === 0
  ) {
    return;
  }
  b.sEmissive = b.sDim = b.sFade = 0;
  b.sTintR = b.sTintG = b.sTintB = b.sTintA = 0;
  b.sLiftY = 0;
  markDirty(key);
}

/** Clear persistent modifiers on every bound key. */
export function clearAllStatic(): void {
  for (let i = 0; i < KEY_COUNT; i++) clearStatic(i);
}

/**
 * Phase 1 of the frame: clear last frame's accumulation.
 *
 * Pieces that stopped animating get one final reset, which restores them
 * exactly to base + static — this is why a cancelled animation can never leave
 * a piece stranded.
 */
export function resetActiveOffsets(): void {
  for (let i = 0; i < activeKeys.length; i++) {
    const o = offsets[activeKeys[i]];
    o.reset();
    o.active = false;
  }
  activeKeys.length = 0;
}

/**
 * Phase 3 of the frame: write accumulated offsets onto the bound objects.
 *
 * `settling` carries keys that accumulated LAST frame but not this one, so they
 * get one final write at identity before we stop touching them. Overlap with
 * the active set is harmless — a redundant write is cheaper than deduplicating.
 */
export function applyOffsets(settling: readonly number[]): void {
  for (let i = 0; i < activeKeys.length; i++) applyOne(activeKeys[i]);
  for (let i = 0; i < settling.length; i++) applyOne(settling[i]);
  if (dirtyKeys.length > 0) {
    for (let i = 0; i < dirtyKeys.length; i++) applyOne(dirtyKeys[i]);
    dirtyKeys.length = 0;
  }
}

function applyOne(key: number): void {
  const b = bindings[key];
  if (!b || !b.enabled) return;
  const o = offsets[key];
  const obj = b.object;
  const fade = o.fade > b.sFade ? o.fade : b.sFade;

  if (obj) {
    if (b.autoHide) {
      // Fully faded means not drawn at all. A pooled impact ring or an unused
      // target indicator should cost zero draw calls, not a zero-opacity one.
      const visible = fade < 0.999;
      if (obj.visible !== visible) obj.visible = visible;
      if (!visible) return;
    }
    obj.position.set(b.baseX + o.px, b.baseY + o.py + b.sLiftY, b.baseZ + o.pz);
    obj.rotation.set(b.baseRX + o.rx, b.baseRY + o.ry, b.baseRZ + o.rz);
    const s = b.baseScale;
    obj.scale.set(s * o.sx, s * o.sy, s * o.sz);
    // The scene may disable auto-update on settled pieces for a cheap win;
    // if so we must push the matrix ourselves.
    if (!obj.matrixAutoUpdate) obj.updateMatrix();
  }

  const mat = b.material as (Material & Record<string, unknown>) | null;
  if (!mat) return;

  if (b.hasEmissive) {
    mat.emissiveIntensity = b.baseEmissive + o.emissive + b.sEmissive;
  }

  if (b.hasOpacity) {
    const opacity = b.baseOpacity * (1 - fade);
    mat.opacity = opacity;
    // `transparent` is toggled, not left on: an always-transparent material is
    // depth-sorted every frame and cannot early-z. Flipping it back when the
    // fade ends is worth the branch.
    const wantsTransparent = opacity < 0.999;
    if (mat.transparent !== wantsTransparent) {
      mat.transparent = wantsTransparent;
      mat.needsUpdate = true;
    }
  }

  if (!b.hasColor) return;

  const dim = o.dim > b.sDim ? o.dim : b.sDim;
  const useOffsetTint = o.tintA >= b.sTintA;
  const tintA = useOffsetTint ? o.tintA : b.sTintA;

  // Note: no `.bind()` here. Binding allocates a closure, and this runs for
  // every animating piece every frame.
  const color = mat.color as { setRGB(r: number, g: number, b: number): void };

  if (dim <= 0 && tintA <= 0) {
    color.setRGB(b.baseColorR, b.baseColorG, b.baseColorB);
    return;
  }

  const k = 1 - dim;
  let r = b.baseColorR * k;
  let g = b.baseColorG * k;
  let bl = b.baseColorB * k;

  if (tintA > 0) {
    const tr = useOffsetTint ? o.tintR : b.sTintR;
    const tg = useOffsetTint ? o.tintG : b.sTintG;
    const tb = useOffsetTint ? o.tintB : b.sTintB;
    r += (tr - r) * tintA;
    g += (tg - g) * tintA;
    bl += (tb - bl) * tintA;
  }

  color.setRGB(r, g, bl);
}

/** Currently-accumulating keys. The runner uses this to compute settling. */
export function currentActiveKeys(): readonly number[] {
  return activeKeys;
}

/** Test seam: drop every binding. Not used in normal operation. */
export function clearAllBindings(): void {
  bindings.fill(null);
  dirtyKeys.length = 0;
}
