/**
 * Barrel for the design system's TypeScript surface.
 *
 *   import { getSceneTheme, PLAYERS, SPRING } from '../styles'
 *
 * The stylesheet is imported separately, once, from `main.tsx`:
 *
 *   import './styles/index.css'
 */

export {
  BREAKPOINTS,
  BREAKPOINT_ORDER,
  COLORS,
  DURATION,
  EASING,
  FONT,
  FONT_WEIGHT,
  HIT_TARGET,
  LAYOUT,
  LINE_HEIGHT,
  MEDIA,
  PHONE_LANDSCAPE_RAIL,
  PLAYERS,
  PLAYER_ROLES,
  RADIUS,
  RIM_BOARD_CEILING_LSTAR,
  SHELL_MAX,
  SPACE,
  SPRING,
  TYPE_SCALE,
  Z,
  densityFor,
  mq,
  playerColor,
  playerVar,
  type BreakpointName,
  type ColorTokens,
  type Density,
  type LayoutMetrics,
  type PlayerIdentity,
  type PlayerIndex,
  type PlayerRole,
  type SpringName,
  type ThemeMode,
  type ThemePreference,
} from './tokens'

export {
  THEME_ATTRIBUTE,
  THEME_PREFERENCE_ATTRIBUTE,
  applyThemeAttributes,
  getSceneTheme,
  getTheme,
  verifyThemeSync,
  type ApplyThemeOptions,
  type EnvironmentPreset,
  type PlayerColors,
  type SceneLight,
  type SceneTheme,
  type Theme,
  type Vec3,
} from './theme'
