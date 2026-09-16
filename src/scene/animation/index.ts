/**
 * Otrio animation system — public API.
 *
 * ## Wiring it up (scene agent)
 *
 * ```tsx
 * <Canvas frameloop="demand">
 *   <AnimationDriver />      // MUST be the first child
 *   <ImpactRings />
 *   <Board />
 *   <Pieces />
 * </Canvas>
 * ```
 *
 * Then, once the board geometry is known:
 *
 * ```ts
 * setSceneLayout({ spacePitch, surfaceY, armAngle, armRadius });
 * ```
 *
 * Every spatial constant in the animation system is expressed as a fraction of
 * `spacePitch`, so this one call makes all of it correct at any board scale.
 *
 * ## Wiring it up (pieces agent)
 *
 * ```tsx
 * const ref = useAnimatedPiece(slotKey(space, size), {
 *   position: restingPosition,
 *   material: myOwnMaterialInstance,   // only if this mesh owns it
 * });
 * return <mesh ref={ref}>…</mesh>;
 * ```
 *
 * ## Wiring it up (app / game shell)
 *
 * ```ts
 * useGameAnimations({ state, localPlayers, getMoveOrigin });
 * ```
 *
 * That is the whole integration. Everything else — placement, turn changes,
 * wins, draws, joins, leaves — falls out of watching the state change.
 *
 * ## The two rules that keep this fast
 *
 * 1. **Nothing here ever sets React state per frame.** Animations mutate
 *    `Object3D` and material fields directly through a flat array of offsets.
 *    A running animation causes zero re-renders.
 * 2. **Animations are deltas, never truth.** A piece renders where the rules
 *    engine says it is; the animation is an offset on top that always decays to
 *    zero. That is why an animation can be cancelled, interrupted, dropped or
 *    never run at all without the board ever being wrong — and why a player is
 *    never blocked waiting for one to finish.
 */

// --- React integration -----------------------------------------------------
export { AnimationDriver, default as AnimationDriverDefault } from './AnimationDriver';
export type { AnimationDriverProps } from './AnimationDriver';

export { useAnimatedPiece, usePieceOffset } from './hooks/useAnimatedPiece';
export type { AnimatedPieceOptions } from './hooks/useAnimatedPiece';

export { useGameAnimations } from './hooks/useGameAnimations';
export type { GameAnimationOptions } from './hooks/useGameAnimations';

// --- Components we own -----------------------------------------------------
export { ImpactRings } from './components/ImpactRings';
export type { ImpactRingsProps } from './components/ImpactRings';
export { TargetIndicators } from './components/TargetIndicators';
export type { TargetIndicatorsProps } from './components/TargetIndicators';

// --- Imperative API --------------------------------------------------------
export {
  endGhost,
  hideValidTargets,
  moveGhost,
  playDraw,
  playGameStart,
  playHover,
  playPlacement,
  playPlayerJoin,
  playPlayerLeave,
  playReject,
  playRejectSlot,
  playReset,
  playSyncPulse,
  playTurnChange,
  playWin,
  showValidTargets,
  snapPlacement,
  startGhost,
  stopAllAnimations,
} from './schedule';
export type {
  PlacementOptions,
  RejectOptions,
  TargetOptions,
  TurnChangeOptions,
} from './schedule';

// --- Identity --------------------------------------------------------------
export {
  BOARD_KEY,
  BOARD_SLOT_COUNT,
  effectKey,
  GHOST_KEY,
  indicatorForSlot,
  indicatorKey,
  isBoardSlotKey,
  isIndicatorKey,
  isReserveKey,
  isTrayKey,
  reserveKey,
  reservePlayer,
  slotKey,
  slotSizeRank,
  slotSpace,
  trayKey,
  trayPlayer,
} from './core/ids';

// --- Scene geometry contract ----------------------------------------------
export { armAngleOf, LAYOUT, setSceneLayout, u } from './core/layout';
export type { SceneLayout } from './core/layout';

// --- Output channels for board / shader effects ---------------------------
export { CH, resetChannels } from './core/channels';
export type { Channels } from './core/channels';

// --- Binding internals, for renderers that apply offsets themselves -------
export {
  bindPiece,
  clearStatic,
  getBinding,
  makeBinding,
  readOffset,
  setBase,
  setStatic,
} from './core/offsets';
export type { PieceBinding, PieceOffset } from './core/offsets';

// --- Preferences ----------------------------------------------------------
export { dur, MOTION, subscribeMotion } from './core/prefs';
export type { MotionState, MotionOverride, QualityTier } from './core/prefs';

// --- Runner, for advanced control ----------------------------------------
export { runner } from './core/runner';
export { TrackKind, BEAT_IMPACT, BEAT_SETTLED } from './core/track';

// --- Design tokens, so the UI layer can match the 3D timings -------------
export {
  HOVER,
  IMPACT_RING,
  PLACE,
  PRESENCE,
  QUEUE,
  REJECT,
  RESET,
  START,
  TARGET,
  TURN,
  WIN,
} from './core/timing';

// --- Easing, shared with any CSS/DOM animation in the UI layer -----------
export {
  arc,
  clamp,
  clamp01,
  decayingShake,
  easeInOutCubic,
  easeInQuad,
  easeOutBack,
  easeOutCubic,
  easeOutExpo,
  easeOutQuad,
  easeOutQuart,
  flash,
  lerp,
  pulse,
  remap,
  smoothTowards,
} from './core/easing';
export type { Easing } from './core/easing';
