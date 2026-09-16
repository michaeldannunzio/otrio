/**
 * The one and only `useFrame` in the animation system.
 *
 * Mount this as the **first child of `<Canvas>`**. Position matters: React
 * Three Fiber runs priority-0 frame callbacks in subscription order, and this
 * one writes the transforms that other components may want to read in the same
 * frame.
 *
 * ```tsx
 * <Canvas frameloop="demand">
 *   <AnimationDriver />
 *   <Board />
 *   <Pieces />
 * </Canvas>
 * ```
 *
 * ## Note on `priority`
 *
 * This deliberately uses the default priority of 0. Passing any non-zero
 * priority to `useFrame` switches React Three Fiber into manual render mode and
 * makes the whole canvas go black unless someone calls `gl.render()` by hand.
 * Ordering here is achieved by mount position, never by priority.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { runner } from './core/runner';

/**
 * A gap longer than this means the tab was backgrounded or the device slept.
 * Animations queued before the gap are stale — nobody wants to come back to
 * their phone and watch a celebration for a move made two minutes ago — so we
 * drop them and let the offsets settle to truth.
 */
const STALE_GAP_SECONDS = 2;

export interface AnimationDriverProps {
  /**
   * Called whenever the runner goes from idle to animating or back. Useful if
   * the scene wants to suppress an unrelated idle effect while the board is
   * busy. Fires at most twice per animation sequence, never per frame.
   */
  onActivityChange?: (animating: boolean) => void;
}

export function AnimationDriver({ onActivityChange }: AnimationDriverProps = {}): null {
  const invalidate = useThree((s) => s.invalidate);

  // Hand the runner its wake-up call. Everything that starts an animation from
  // outside the render loop — a WebSocket delta, a pointer handler, a timer —
  // reaches `invalidate` through here.
  useEffect(() => {
    runner.setInvalidate(invalidate);
    return () => {
      runner.setInvalidate(null);
    };
  }, [invalidate]);

  // Drop stale work when the tab comes back.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = performance.now();
        return;
      }
      const gap = (performance.now() - hiddenAt) / 1000;
      if (hiddenAt > 0 && gap > STALE_GAP_SECONDS && runner.isAnimating) {
        // `clear()` is safe at any instant: offsets decay to identity on the
        // next tick and every piece is already at its correct position.
        runner.clear();
      }
      hiddenAt = 0;
      runner.wake();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Report idle/busy transitions without ever setting state per frame.
  useEffect(() => {
    if (!onActivityChange) return;
    let last = runner.isAnimating;
    const id = window.setInterval(() => {
      const now = runner.isAnimating;
      if (now !== last) {
        last = now;
        onActivityChange(now);
      }
    }, 120);
    return () => window.clearInterval(id);
  }, [onActivityChange]);

  useFrame((_, dt) => {
    runner.tick(dt);
  });

  return null;
}

export default AnimationDriver;
