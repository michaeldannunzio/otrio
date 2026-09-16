/**
 * Stable integer identity for every animatable object in the game.
 *
 * Animations need to name things — "the piece in space 4's medium slot", "red's
 * second unplaced large ring". The obvious encoding is a template string, and
 * it is exactly wrong here: building `` `${space}-${size}` `` inside `useFrame`
 * allocates a string every frame for every piece, which is how you get a
 * sawtooth GC trace on a phone.
 *
 * So every animatable gets a small dense integer instead, and the whole
 * runtime indexes flat preallocated arrays. No maps, no strings, no hashing in
 * the hot path.
 *
 * ```
 *    0 ..  26   board slots        space * 3 + sizeRank
 *   27 ..  62   reserve rings      27 + player * 9 + sizeRank * 3 + ordinal
 *   63 ..  66   player trays / storage arms
 *   67          the board itself
 *   68 ..  94   per-slot target indicators
 *   95 .. 102   pooled effect meshes (impact rings, pulses)
 * ```
 */

import { SIZE_ORDER, type PlayerId, type Size, type SpaceIndex } from '../../../game/types';

/** Board slots: 9 spaces x 3 sizes. */
export const BOARD_SLOT_COUNT = 27;

/** First key of the reserve (unplaced ring) range. */
export const RESERVE_BASE = BOARD_SLOT_COUNT; // 27
/** 4 colours x 3 sizes x 3 copies. */
export const RESERVE_COUNT = 36;

/** First key of the per-player tray / storage-arm range. */
export const TRAY_BASE = RESERVE_BASE + RESERVE_COUNT; // 63

/** The board mesh itself, for board-level effects. */
export const BOARD_KEY = TRAY_BASE + 4; // 67

/** First key of the per-slot target indicators. One per board slot. */
export const INDICATOR_BASE = BOARD_KEY + 1; // 68

/**
 * Pooled decorative effect meshes — impact rings, turn pulses, win flashes.
 * Eight is comfortably more than can be visible at once: placement spawns one,
 * a win spawns at most four, and they all last under a third of a second.
 */
export const EFFECT_BASE = INDICATOR_BASE + BOARD_SLOT_COUNT; // 95
export const EFFECT_COUNT = 8;

/**
 * The drag preview that follows a pointer or finger.
 *
 * There is exactly one, because there is exactly one pointer that matters at a
 * time. The animation layer owns its motion; the pieces agent owns its mesh.
 */
export const GHOST_KEY = EFFECT_BASE + EFFECT_COUNT; // 103

/** Total number of animatable keys. Sizes every flat array in the runtime. */
export const KEY_COUNT = GHOST_KEY + 1; // 104

/**
 * Key for an occupied (or about-to-be-occupied) board slot.
 *
 * This is the identity a ring takes on once it is placed. Because a slot holds
 * at most one ring ever, and placed rings never move, this key is stable for
 * the rest of the game — which is what lets an interrupted animation be
 * resumed or cancelled by key alone.
 */
export function slotKey(space: SpaceIndex, size: Size): number {
  return space * 3 + SIZE_ORDER[size];
}

/** Space component of a board-slot key. */
export function slotSpace(key: number): SpaceIndex {
  return ((key / 3) | 0) as SpaceIndex;
}

/** Size rank (0 small, 1 medium, 2 large) of a board-slot key. */
export function slotSizeRank(key: number): 0 | 1 | 2 {
  return (key % 3) as 0 | 1 | 2;
}

export function isBoardSlotKey(key: number): boolean {
  return key >= 0 && key < BOARD_SLOT_COUNT;
}

/**
 * Key for an unplaced ring sitting in a player's storage arm.
 *
 * `ordinal` is 0..2 — which of that colour's three same-size rings it is. The
 * physical board gives each player three storage spaces per arm, each holding a
 * nested small+medium+large set, so `ordinal` is literally which storage space
 * the ring is sitting in. The rules engine only tracks counts, so the scene
 * decides which ordinal leaves the arm; we just need a stable handle for the
 * one that is flying.
 */
export function reserveKey(player: PlayerId, size: Size, ordinal: number): number {
  return RESERVE_BASE + player * 9 + SIZE_ORDER[size] * 3 + (ordinal % 3);
}

export function isReserveKey(key: number): boolean {
  return key >= RESERVE_BASE && key < RESERVE_BASE + RESERVE_COUNT;
}

/** Player component of a reserve key. */
export function reservePlayer(key: number): PlayerId {
  return (((key - RESERVE_BASE) / 9) | 0) as PlayerId;
}

/** Key for a player's storage arm, used by turn and presence animations. */
export function trayKey(player: PlayerId): number {
  return TRAY_BASE + player;
}

export function isTrayKey(key: number): boolean {
  return key >= TRAY_BASE && key < TRAY_BASE + 4;
}

export function trayPlayer(key: number): PlayerId {
  return (key - TRAY_BASE) as PlayerId;
}

/** Key for the target indicator belonging to a board slot. */
export function indicatorKey(space: SpaceIndex, size: Size): number {
  return INDICATOR_BASE + slotKey(space, size);
}

/** Indicator key for an existing slot key. */
export function indicatorForSlot(slot: number): number {
  return INDICATOR_BASE + slot;
}

export function isIndicatorKey(key: number): boolean {
  return key >= INDICATOR_BASE && key < INDICATOR_BASE + BOARD_SLOT_COUNT;
}

/** Board slot that an indicator key refers to. */
export function indicatorSlot(key: number): number {
  return key - INDICATOR_BASE;
}

/** Nth pooled effect mesh. */
export function effectKey(index: number): number {
  return EFFECT_BASE + (index % EFFECT_COUNT);
}

export function isEffectKey(key: number): boolean {
  return key >= EFFECT_BASE && key < EFFECT_BASE + EFFECT_COUNT;
}

/**
 * Round-robin allocation of the effect pool.
 *
 * Wrapping rather than refusing is deliberate: if nine effects somehow overlap,
 * stealing the oldest is invisible (it was already fading out) whereas dropping
 * the newest would lose the feedback for the action the player just took.
 */
let effectCursor = 0;
export function nextEffectKey(): number {
  const k = EFFECT_BASE + (effectCursor % EFFECT_COUNT);
  effectCursor++;
  return k;
}
