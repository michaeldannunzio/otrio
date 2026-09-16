/**
 * PBR materials for the Otrio scene.
 *
 * Everything is texture-backed: the CC0 scans come from `../textures`, and the
 * only thing defined here is how a moulded plastic game piece uses them.
 */

export {
  PLAYER_ORDER,
  PLAYER_PAINTS,
  boostFinish,
  finishToArray,
  paintForPlayer,
} from './palette';
export type { PlayerColorId, PlayerPaint, PieceFinish, Seat } from './palette';

export {
  DEFAULT_FINISH_VALUE,
  FINISH_ATTRIBUTE,
  applyPieceTextures,
  createGhostPieceMaterial,
  createPieceMaterial,
  detectPieceQuality,
  disposePieceMaterials,
  getPieceMaterial,
  getSoloPieceMaterial,
  setPieceFinish,
  usePieceMaterial,
  useSoloPieceMaterial,
} from './pieceMaterial';
export type { PieceMaterial, PieceQuality, CreatePieceMaterialOptions } from './pieceMaterial';
