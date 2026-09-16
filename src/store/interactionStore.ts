/**
 * Pointer state shared between the 3D board and the 2D interface.
 *
 * This is the one store that may be written from inside the render loop, so it
 * is a **vanilla** zustand store rather than a React one. Writing it does not
 * schedule a React render by itself -- only components that explicitly subscribe
 * re-render, and the 3D scene is expected to subscribe imperatively
 * (`interaction.subscribe(...)`) and mutate materials directly rather than go
 * through React at all.
 *
 * Rule of thumb for the scene: call `setHover` as often as you like; call
 * `setArmedSize` only on a deliberate user action.
 */

import { subscribeWithSelector } from 'zustand/middleware';
import { createStore, useStore } from 'zustand';

import type { CellIndex, PieceSize } from '../net/protocol';

/** A specific ring slot: one of three sizes in one of nine cells. */
export interface Slot {
  cell: CellIndex;
  size: PieceSize;
}

export interface InteractionState {
  /**
   * The slot under the pointer, or focused by the keyboard board. Updated at
   * pointer-move rates -- never render a whole screen off this.
   */
  hover: Slot | null;
  /** Where hover came from, so the scene can style a keyboard focus differently. */
  hoverSource: 'pointer' | 'keyboard' | null;
  /**
   * The cell the keyboard board has focus on, 0-8. Kept separate from `hover`
   * because it persists while the player tabs away to choose a size.
   */
  keyboardCell: CellIndex;
  /** True while a drag is in progress, so the UI can get out of the way. */
  dragging: boolean;

  setHover(slot: Slot | null, source?: 'pointer' | 'keyboard'): void;
  setKeyboardCell(cell: CellIndex): void;
  setDragging(dragging: boolean): void;
  reset(): void;
}

export const interactionStore = createStore<InteractionState>()(
  subscribeWithSelector((set) => ({
    hover: null,
    hoverSource: null,
    keyboardCell: 4,
    dragging: false,

    setHover: (slot, source = 'pointer') =>
      set((s) => {
        // Cheap identity guard: hover fires continuously and an unchanged value
        // must not wake subscribers.
        if (
          (slot === null && s.hover === null) ||
          (slot !== null &&
            s.hover !== null &&
            s.hover.cell === slot.cell &&
            s.hover.size === slot.size &&
            s.hoverSource === source)
        ) {
          return s;
        }
        return { hover: slot, hoverSource: slot ? source : null };
      }),

    setKeyboardCell: (keyboardCell) => set({ keyboardCell }),
    setDragging: (dragging) => set({ dragging }),
    reset: () => set({ hover: null, hoverSource: null, keyboardCell: 4, dragging: false }),
  })),
);

/** React binding. Always pass a selector -- there is no cheap whole-store read. */
export function useInteraction<T>(selector: (state: InteractionState) => T): T {
  return useStore(interactionStore, selector);
}

/** Imperative handle for the scene. No React involved. */
export const interaction = {
  get: interactionStore.getState,
  set: interactionStore.setState,
  subscribe: interactionStore.subscribe,
};
