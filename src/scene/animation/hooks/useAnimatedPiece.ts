/**
 * Bind a mesh to the animation system.
 *
 * This is the one thing the pieces agent has to call. Attach the returned ref
 * to a mesh, give it the key for what that mesh represents, and every animation
 * in the game can drive it.
 *
 * ```tsx
 * function Piece({ space, size, player }) {
 *   const ref = useAnimatedPiece(slotKey(space, size), {
 *     position: worldPositionOf(space, size),
 *     material: myOwnMaterialInstance,
 *   });
 *   return <mesh ref={ref}>…</mesh>;
 * }
 * ```
 *
 * ## The material rule
 *
 * Pass a material ONLY if this mesh owns it exclusively. Materials are usually
 * shared per colour so the renderer can batch, and mutating a shared material's
 * emissive would light up all nine of that colour's pieces at once instead of
 * the one that moved.
 *
 * If the material is shared, pass nothing. Transforms still animate — an
 * `Object3D` is always per-mesh — and the colour and glow channels can be read
 * out of `readOffset(key)` and applied however that renderer prefers, including
 * as an instanced attribute.
 *
 * ## What this hook does NOT do
 *
 * It never sets React state, never subscribes to a frame loop, and never
 * re-renders while an animation plays. Binding happens once, and after that the
 * runtime mutates the object directly.
 */

import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Material, Object3D } from 'three';
import {
  bindPiece,
  makeBinding,
  readOffset,
  setStatic,
  type PieceOffset,
} from '../core/offsets';
import { runner } from '../core/runner';

export interface AnimatedPieceOptions {
  /**
   * Per-mesh material. Omit when the material is shared between pieces — see
   * "The material rule" above.
   */
  material?: Material | null;

  /**
   * The piece's resting position. Animations are offsets from this, so it must
   * be the position the rules engine says the piece occupies, not an animated
   * one. Changing it moves the piece's anchor; it does not animate anything.
   */
  position?: readonly [number, number, number];

  /** Resting uniform scale. Defaults to the mesh's own scale at bind time. */
  scale?: number;

  /** Set false to leave this mesh alone without unbinding it. */
  enabled?: boolean;

  /** Start hidden. Useful for pooled or not-yet-dealt pieces. */
  initiallyHidden?: boolean;
}

/**
 * Bind a mesh for animation. Returns the ref to attach.
 */
export function useAnimatedPiece<T extends Object3D = Object3D>(
  key: number,
  options: AnimatedPieceOptions = {},
): RefObject<T> {
  const ref = useRef<T>(null);
  const { material = null, position, scale, enabled = true, initiallyHidden = false } = options;

  // Layout effect, not effect: the binding captures the mesh's transform as its
  // resting pose, so it has to run after the mesh exists but before the browser
  // paints, or the first animated frame would be measured against a stale base.
  useLayoutEffect(() => {
    const object = ref.current;
    if (!object) return;

    const binding = makeBinding(object, material);
    if (position) {
      binding.baseX = position[0];
      binding.baseY = position[1];
      binding.baseZ = position[2];
    }
    if (scale !== undefined) binding.baseScale = scale;
    binding.enabled = enabled;

    const unbind = bindPiece(key, binding);
    if (initiallyHidden) setStatic(key, { sFade: 1 });
    runner.wake();
    return unbind;
    // `position` is spread into primitives below so a fresh array literal from
    // the caller does not force a rebind every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    key,
    material,
    scale,
    enabled,
    initiallyHidden,
    position?.[0],
    position?.[1],
    position?.[2],
  ]);

  return ref;
}

/**
 * Read a piece's current animation offset.
 *
 * For renderers that cannot hand over a material — instanced meshes, custom
 * shaders, anything batched. Call it inside your own `useFrame` and apply the
 * channels however your material works.
 *
 * The returned object is live and mutable-by-the-runtime; do not hold onto its
 * values across frames, and never write to it.
 */
export function usePieceOffset(key: number): Readonly<PieceOffset> {
  return readOffset(key);
}

export { readOffset };
