/**
 * The pooled shockwave rings that fire when a piece seats into the board.
 *
 * Eight flat rings, permanently mounted and permanently invisible until a
 * placement borrows one. They are pooled rather than mounted on demand because
 * mounting a mesh mid-animation costs a React commit and a geometry upload at
 * exactly the moment the frame budget is tightest.
 *
 * While idle they cost nothing at all: `autoHide` drives `object.visible` from
 * the fade, so a ring that is not playing is not drawn, not sorted and not
 * rasterised.
 *
 * Mount once, anywhere inside the canvas:
 * ```tsx
 * <ImpactRings color="#fff6e0" />
 * ```
 */

import { useLayoutEffect, useRef } from 'react';
import { AdditiveBlending, type Mesh, type MeshBasicMaterial } from 'three';
import { EFFECT_COUNT, effectKey } from '../core/ids';
import { LAYOUT } from '../core/layout';
import { bindPiece, makeBinding, setStatic } from '../core/offsets';

export interface ImpactRingsProps {
  /** Ring colour. Additively blended, so lighter reads as brighter. */
  color?: string;
  /** Inner radius in world units. Defaults to a third of a space. */
  innerRadius?: number;
  /** Outer radius in world units. */
  outerRadius?: number;
  /** Radial segments. 24 is plenty at the size these are drawn. */
  segments?: number;
}

function PooledRing({
  index,
  color,
  inner,
  outer,
  segments,
}: {
  index: number;
  color: string;
  inner: number;
  outer: number;
  segments: number;
}) {
  const mesh = useRef<Mesh>(null);
  const material = useRef<MeshBasicMaterial>(null);

  useLayoutEffect(() => {
    const object = mesh.current;
    if (!object) return;
    const key = effectKey(index);
    const binding = makeBinding(object, material.current);
    // The JSX starts at zero opacity so nothing can flash before this runs;
    // the animation drives the real value from a base of 1.
    binding.baseOpacity = 1;
    binding.autoHide = true;
    const unbind = bindPiece(key, binding);
    setStatic(key, { sFade: 1 });
    return unbind;
  }, [index]);

  return (
    <mesh
      ref={mesh}
      rotation-x={-Math.PI / 2}
      visible={false}
      // These sit flat on the board and are always in view when they play;
      // culling them per-frame is wasted work.
      frustumCulled={false}
      renderOrder={10}
    >
      <ringGeometry args={[inner, outer, segments]} />
      <meshBasicMaterial
        ref={material}
        color={color}
        transparent
        opacity={0}
        depthWrite={false}
        blending={AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  );
}

export function ImpactRings({
  color = '#fff4e2',
  innerRadius,
  outerRadius,
  segments = 24,
}: ImpactRingsProps = {}) {
  const pitch = LAYOUT.spacePitch;
  const inner = innerRadius ?? pitch * 0.3;
  const outer = outerRadius ?? pitch * 0.37;

  const rings = [];
  for (let i = 0; i < EFFECT_COUNT; i++) {
    rings.push(
      <PooledRing key={i} index={i} color={color} inner={inner} outer={outer} segments={segments} />,
    );
  }
  return <>{rings}</>;
}

export default ImpactRings;
