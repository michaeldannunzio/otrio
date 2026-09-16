/**
 * Valid-target indicators: one flat ring per board slot, showing where the held
 * piece may legally go.
 *
 * All 27 are mounted permanently and hidden by default. `autoHide` means a
 * hidden indicator is genuinely not drawn, so the resting cost is 27 culled
 * objects rather than 27 draw calls — cheaper than mounting and unmounting
 * them, which would put a React commit in the middle of a pointer gesture.
 *
 * ## Touch and mouse
 *
 * There is no hover on a touch screen, so this is driven by SELECTION, not by
 * pointer position: the player taps a piece, and every slot it may legally
 * occupy lights up. On a mouse the same indicators appear on selection and the
 * separate hover animation rides on top. One mechanism, two triggers.
 *
 * ## Legality is not decided here
 *
 * The `slots` prop comes from the rules engine. This component animates what it
 * is told and never reasons about the board — including the optional
 * centre-medium handicap (RULES.md §8.2), which simply never appears in `slots`.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { DoubleSide, type Mesh, type MeshBasicMaterial } from 'three';
import { SIZES, SPACES, type Size, type SpaceIndex } from '../../../game/types';
import { indicatorKey } from '../core/ids';
import { bindPiece, makeBinding, setStatic } from '../core/offsets';
import { hideValidTargets, showValidTargets } from '../schedule';

export interface TargetIndicatorsProps {
  /**
   * The slots the current player may legally fill. Pass an empty array (or
   * nothing) to put the indicators away.
   */
  slots?: readonly { space: SpaceIndex; size: Size }[];

  /** World position of a slot's centre. Supplied by the board agent. */
  positionOf: (space: SpaceIndex, size: Size) => readonly [number, number, number];

  /** Outer radius to draw for a given size, in world units. */
  radiusOf: (size: Size) => number;

  /** Ripple the reveal outward from this space — usually the last move. */
  originSpace?: SpaceIndex;

  /** Ring colour. Usually the active player's colour. */
  color?: string;

  /** Ring wall thickness in world units. */
  thickness?: number;

  /** Vertical offset above the board surface, to avoid z-fighting the inlay. */
  lift?: number;
}

function Indicator({
  space,
  size,
  position,
  radius,
  color,
  thickness,
  lift,
}: {
  space: SpaceIndex;
  size: Size;
  position: readonly [number, number, number];
  radius: number;
  color: string;
  thickness: number;
  lift: number;
}) {
  const mesh = useRef<Mesh>(null);
  const material = useRef<MeshBasicMaterial>(null);

  useLayoutEffect(() => {
    const object = mesh.current;
    if (!object) return;
    const key = indicatorKey(space, size);
    const binding = makeBinding(object, material.current);
    binding.baseX = position[0];
    binding.baseY = position[1] + lift;
    binding.baseZ = position[2];
    binding.baseOpacity = 1;
    binding.autoHide = true;
    const unbind = bindPiece(key, binding);
    setStatic(key, { sFade: 1 });
    return unbind;
  }, [space, size, position[0], position[1], position[2], lift]);

  return (
    <mesh ref={mesh} rotation-x={-Math.PI / 2} visible={false} frustumCulled={false} renderOrder={9}>
      <ringGeometry args={[Math.max(0.001, radius - thickness), radius, 28]} />
      <meshBasicMaterial
        ref={material}
        color={color}
        transparent
        opacity={0}
        depthWrite={false}
        side={DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

export function TargetIndicators({
  slots,
  positionOf,
  radiusOf,
  originSpace,
  color = '#ffffff',
  thickness,
  lift = 0.006,
}: TargetIndicatorsProps) {
  // Drive the reveal from an effect, so the meshes (bound in a LAYOUT effect,
  // which runs first) always exist by the time a track looks for them.
  useEffect(() => {
    if (!slots || slots.length === 0) {
      hideValidTargets();
      return;
    }
    showValidTargets({ slots, originSpace });
    return () => hideValidTargets();
  }, [slots, originSpace]);

  const meshes = [];
  for (const space of SPACES) {
    for (const size of SIZES) {
      const radius = radiusOf(size);
      meshes.push(
        <Indicator
          key={space * 3 + SIZES.indexOf(size)}
          space={space}
          size={size}
          position={positionOf(space, size)}
          radius={radius}
          color={color}
          thickness={thickness ?? radius * 0.14}
          lift={lift}
        />,
      );
    }
  }
  return <>{meshes}</>;
}

export default TargetIndicators;
