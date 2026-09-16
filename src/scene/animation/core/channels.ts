/**
 * Animation output channels.
 *
 * Some effects belong to geometry this agent does not own. The turn sweep runs
 * around the board's rim; the win sweep washes across the board surface; the
 * active-player glow lives on a storage arm. Those are the board agent's
 * materials, and reaching into them would couple us to shader internals that
 * are still being written.
 *
 * So instead we publish plain numbers. The animation layer computes, the scene
 * layer consumes — in its own `useFrame`, its own shader uniform, or its own
 * `onBeforeRender`, however it prefers. No shared objects, no ownership
 * conflict, no allocation.
 *
 * ### For the scene / board agent
 *
 * ```ts
 * import { CH } from '../animation';
 *
 * useFrame(() => {
 *   material.uniforms.uSweepAngle.value    = CH.turnSweepAngle;
 *   material.uniforms.uSweepStrength.value = CH.turnSweepStrength;
 * });
 * ```
 *
 * Every channel rests at a documented neutral value, so a consumer that reads
 * them before anything has animated gets a sensible board. And because the
 * animation layer always returns them to neutral when a sequence ends, a
 * consumer never has to reset anything itself.
 */

export interface Channels {
  /**
   * Angle of the travelling bright band around the board rim, in radians.
   * Meaningful only while `turnSweepStrength > 0`.
   */
  turnSweepAngle: number;

  /** 0 at rest, rises to 1 at the peak of a turn change. */
  turnSweepStrength: number;

  /**
   * Angular half-width of the sweep band, in radians. Constant in practice but
   * exposed so the board can soften it on low tier.
   */
  turnSweepWidth: number;

  /** The colour index the sweep is travelling TOWARD. -1 when idle. */
  turnSweepTarget: number;

  /** The colour index the sweep is travelling FROM. -1 when idle. */
  turnSweepSource: number;

  /**
   * True (1) when the turn passed between two colours of the SAME seat — the
   * 2-player alternation case. The board should draw this as a line across the
   * centre rather than a trip round the rim, because "your other colour" is a
   * different event from "the next player".
   */
  turnSweepIsColorSwap: number;

  /** Steady highlight on the active colour's arm, 0..1. Neutral 0. */
  activeArmGlow: number;

  /** Colour index currently holding the turn, or -1 before the game starts. */
  activeColor: number;

  /**
   * Radius of the win light sweep, in space-pitch units, expanding from the
   * win centroid. 0 when idle.
   */
  winSweepRadius: number;

  /** 0 at rest, 1 at the brightest moment of the win sweep. */
  winSweepStrength: number;

  /** Board-plane X of the win centroid, in world units. */
  winSweepX: number;
  /** Board-plane Z of the win centroid, in world units. */
  winSweepZ: number;

  /**
   * Board-wide celebratory wave for a draw, 0..1. Draws are "you all win" in
   * the rulebook, so this is deliberately a separate, warmer channel from the
   * win sweep rather than a reused one.
   */
  drawWave: number;

  /** Generic board pulse, used for game start and for a post-resync settle. */
  boardPulse: number;

  /**
   * Per-colour ambient emphasis, 0..1, indexed by `PlayerId`. Used by the
   * presence animations: a departed player's arm sits near 0, a freshly joined
   * player's arm blooms to 1 and settles to its resting value.
   */
  playerPresence: [number, number, number, number];
}

/** Live channel values. Read freely; only the animation runtime writes them. */
export const CH: Channels = {
  turnSweepAngle: 0,
  turnSweepStrength: 0,
  turnSweepWidth: 0.16 * Math.PI * 2,
  turnSweepTarget: -1,
  turnSweepSource: -1,
  turnSweepIsColorSwap: 0,
  activeArmGlow: 0,
  activeColor: -1,
  winSweepRadius: 0,
  winSweepStrength: 0,
  winSweepX: 0,
  winSweepZ: 0,
  drawWave: 0,
  boardPulse: 0,
  playerPresence: [1, 1, 1, 1],
};

/** Return every channel to its neutral resting value. Used on reset/new game. */
export function resetChannels(): void {
  CH.turnSweepStrength = 0;
  CH.turnSweepTarget = -1;
  CH.turnSweepSource = -1;
  CH.turnSweepIsColorSwap = 0;
  CH.winSweepRadius = 0;
  CH.winSweepStrength = 0;
  CH.drawWave = 0;
  CH.boardPulse = 0;
}
