/**
 * What just happened, for people who can see.
 *
 * Every move is already announced — "Grace played medium in the centre" — into
 * a polite ARIA live region. A screen-reader user therefore gets a running
 * history of the game and a sighted player gets nothing: look away for ten
 * seconds in a four-player game and the information is gone, despite having
 * been computed and discarded. This store keeps it.
 *
 * ## The wire has no history
 *
 * `GameSnapshot` carries `moveCount` and `lastMove`, and nothing else about the
 * past — deliberately, since the referee's projection is a picture of *now*.
 * So the log is accumulated client-side by diffing consecutive snapshots, which
 * has to survive everything the protocol is allowed to do to us:
 *
 *  - **Duplicate snapshots.** Same `moveCount` twice is a no-op, not a repeat.
 *  - **Gaps.** A reconnect can replay several moves into one snapshot, and only
 *    the *last* is named. The rest are recovered by diffing board occupancy —
 *    which finds the pieces but cannot know their order, so they are flagged as
 *    inferred rather than presented as fact.
 *  - **Going backwards.** A rematch resets `moveCount`; the log clears.
 *  - **Joining late.** The board already holds pieces this client never saw.
 *    We seed from it silently instead of inventing nine entries we did not
 *    witness.
 *
 * Accumulating from `moveApplied` events would be simpler and wrong: the
 * protocol explicitly permits dropped, duplicated and reordered events, so an
 * event-sourced log is guaranteed to drift. Snapshots are the truth.
 */

import { create } from 'zustand';

import { BOARD_CELLS, PIECE_SIZES } from '../net/protocol';
import type {
  CellIndex,
  CellState,
  GameSnapshot,
  PieceSize,
  PlayerColor,
  Seat,
} from '../net/protocol';

export interface MoveLogEntry {
  /** 1-based move ordinal. Shared by every entry recovered from one gap. */
  n: number;
  cell: CellIndex;
  size: PieceSize;
  colour: PlayerColor;
  /** The participant, when the snapshot named them. Null for inferred entries. */
  seat: Seat | null;
  /**
   * Recovered by diffing the board rather than observed directly, so its
   * position in the list is not necessarily the order it was played. Shown with
   * a marker: a history that quietly mixes fact and reconstruction is worse
   * than one that admits the difference.
   */
  inferred: boolean;
  /** Client clock. Only used for relative times, never compared across devices. */
  at: number;
}

interface Seen {
  moveCount: number;
  board: readonly CellState[];
}

interface MoveLogState {
  entries: MoveLogEntry[];
  /** Moves that happened before this client was watching. */
  joinedAtMove: number;
  /** Set when a gap was reconstructed, so the UI can say the order is uncertain. */
  hasInferred: boolean;

  /** Feed a snapshot. Idempotent for a repeated one. */
  observe(game: GameSnapshot | null): void;
  clear(): void;
}

/**
 * Newly occupied slots between two boards.
 *
 * `!== null` rather than truthiness throughout: colour 0 is purple and falsy,
 * which is the single most common bug in this codebase.
 */
function newlyOccupied(
  before: readonly CellState[] | null,
  after: readonly CellState[],
): Array<{ cell: CellIndex; size: PieceSize; colour: PlayerColor }> {
  const out: Array<{ cell: CellIndex; size: PieceSize; colour: PlayerColor }> = [];
  for (let cell = 0; cell < BOARD_CELLS; cell += 1) {
    const now = after[cell];
    if (!now) continue;
    const was = before?.[cell] ?? null;
    for (const size of PIECE_SIZES) {
      const colour = now[size];
      if (colour === null || colour === undefined) continue;
      const previous = was ? was[size] : null;
      if (previous === null || previous === undefined) {
        out.push({ cell: cell as CellIndex, size, colour });
      }
    }
  }
  return out;
}

/** Kept outside the store: it is bookkeeping, not something the UI renders. */
let seen: Seen | null = null;

export const useMoveLog = create<MoveLogState>()((set, get) => ({
  entries: [],
  joinedAtMove: 0,
  hasInferred: false,

  observe: (game) => {
    if (!game) return;

    // First sight of a game. Seed silently — any pieces already on the board
    // were played before we were watching, and inventing entries for them would
    // put moves in the log that this client cannot vouch for.
    if (seen === null) {
      seen = { moveCount: game.moveCount, board: game.board };
      set({ entries: [], joinedAtMove: game.moveCount, hasInferred: false });
      return;
    }

    // A repeat. Snapshots are resent freely; this is not a move.
    if (game.moveCount === seen.moveCount) {
      seen = { moveCount: game.moveCount, board: game.board };
      return;
    }

    // Went backwards: a rematch reset the board. `seq` keeps running but
    // `moveCount` restarts, which is exactly the signal.
    if (game.moveCount < seen.moveCount) {
      seen = { moveCount: game.moveCount, board: game.board };
      set({ entries: [], joinedAtMove: game.moveCount, hasInferred: false });
      return;
    }

    const delta = game.moveCount - seen.moveCount;
    const added = newlyOccupied(seen.board, game.board);
    const at = Date.now();
    const next: MoveLogEntry[] = [];

    if (delta === 1 && game.lastMove && added.length <= 1) {
      // The ordinary case: one move, and the snapshot names who made it.
      const { seat, color, move } = game.lastMove;
      next.push({
        n: game.moveCount,
        cell: move.cell as CellIndex,
        size: move.size,
        colour: color,
        seat,
        inferred: false,
        at,
      });
    } else {
      /*
       * A gap — typically a reconnect replaying turns taken while we were away.
       * Only the last move is named, so the rest are recovered from the board.
       * The colour is certain (it is on the board); the *order* is not, and the
       * seat is only known for whichever one `lastMove` describes.
       */
      const lastCell = game.lastMove?.move.cell;
      const lastSize = game.lastMove?.move.size;
      added.forEach((piece, i) => {
        const isNamed = piece.cell === lastCell && piece.size === lastSize;
        next.push({
          n: game.moveCount - added.length + 1 + i,
          cell: piece.cell,
          size: piece.size,
          colour: piece.colour,
          seat: isNamed ? (game.lastMove?.seat ?? null) : null,
          inferred: !isNamed,
          at,
        });
      });
    }

    seen = { moveCount: game.moveCount, board: game.board };
    if (next.length === 0) return;
    set({
      entries: [...get().entries, ...next],
      hasInferred: get().hasInferred || next.some((e) => e.inferred),
    });
  },

  clear: () => {
    seen = null;
    set({ entries: [], joinedAtMove: 0, hasInferred: false });
  },
}));

/** Non-hook access, for the snapshot subscription. */
export const moveLog = {
  observe: (game: GameSnapshot | null) => useMoveLog.getState().observe(game),
  clear: () => useMoveLog.getState().clear(),
};
