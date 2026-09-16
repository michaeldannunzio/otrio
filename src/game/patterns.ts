/**
 * The win table: the 49 distinct winning triples a single colour can hold
 * (RULES.md §5.6).
 *
 * | Family                  | Count | Working          |
 * |-------------------------|-------|------------------|
 * | same-size line          | 24    | 8 lines x 3 sizes|
 * | ordered-size line       | 16    | 8 lines x 2 ways |
 * | concentric space        |  9    | 9 spaces         |
 * | **total**               | **49**|                  |
 *
 * Built once at module load and frozen. `winningLinesFor` is a scan over this
 * table, which keeps the rule in one declarative place rather than spread
 * across three hand-written loops.
 *
 * The order of the table is part of the contract: it determines the order of
 * `WinResult.lines`, so the victory animation is identical on every client.
 */

import { LINES, LINE_ORIENTATIONS } from './board.ts';
import {
  SIZES,
  SPACES,
  type LineOrientation,
  type Size,
  type SlotRef,
  type SpaceIndex,
  type WinCondition,
} from './types.ts';

/** One winning triple, colour-independent. */
export interface WinPattern {
  readonly condition: WinCondition;
  readonly orientation: LineOrientation;
  /**
   * The three slots that must all hold one colour, in animation order:
   * along the line for `'same-size'`, small-to-large for `'sequence'` and
   * `'nested'`.
   */
  readonly slots: readonly [SlotRef, SlotRef, SlotRef];
  /** `slots[i].space`, pulled out for convenience. */
  readonly spaces: readonly [SpaceIndex, SpaceIndex, SpaceIndex];
  /** Reading direction of a `'sequence'`; absent for the other families. */
  readonly sequenceDirection?: 'ascending' | 'descending';
  /** Index into {@link LINES}, or `null` for a `'nested'` pattern. */
  readonly line: number | null;
}

function slot(space: SpaceIndex, size: Size): SlotRef {
  return Object.freeze({ space, size });
}

function pattern(
  condition: WinCondition,
  orientation: LineOrientation,
  line: number | null,
  slots: [SlotRef, SlotRef, SlotRef],
  sequenceDirection?: 'ascending' | 'descending',
): WinPattern {
  const spaces: [SpaceIndex, SpaceIndex, SpaceIndex] = [
    slots[0].space,
    slots[1].space,
    slots[2].space,
  ];
  const built: WinPattern = {
    condition,
    orientation,
    line,
    slots: Object.freeze(slots),
    spaces: Object.freeze(spaces),
    ...(sequenceDirection === undefined ? {} : { sequenceDirection }),
  };
  return Object.freeze(built);
}

function buildPatterns(): WinPattern[] {
  const out: WinPattern[] = [];

  for (let i = 0; i < LINES.length; i += 1) {
    const [a, b, c] = LINES[i];
    const orientation = LINE_ORIENTATIONS[i];

    // W1 — three of the same size along the line (§5.3).
    for (const size of SIZES) {
      out.push(pattern('same-size', orientation, i, [slot(a, size), slot(b, size), slot(c, size)]));
    }

    // W2 — sizes strictly monotonic along the line (§5.4). The medium always
    // sits in the middle space; only the ends swap. Both readings win, and
    // they are distinct placements, so both are in the table.
    out.push(
      pattern(
        'sequence',
        orientation,
        i,
        [slot(a, 'small'), slot(b, 'medium'), slot(c, 'large')],
        'ascending',
      ),
    );
    out.push(
      pattern(
        'sequence',
        orientation,
        i,
        // Listed small-to-large, so the spaces run c, b, a — the line itself
        // descends when read in increasing space order.
        [slot(c, 'small'), slot(b, 'medium'), slot(a, 'large')],
        'descending',
      ),
    );
  }

  // W3 — all three sizes concentric in one space (§5.5).
  for (const space of SPACES) {
    out.push(
      pattern('nested', 'nested', null, [
        slot(space, 'small'),
        slot(space, 'medium'),
        slot(space, 'large'),
      ]),
    );
  }

  return out;
}

/** All 49 winning triples, in the canonical order described above. */
export const WIN_PATTERNS: readonly WinPattern[] = Object.freeze(buildPatterns());

/** 24 + 16 + 9. Asserted in the tests as a guard against table corruption. */
export const WIN_PATTERN_COUNT = WIN_PATTERNS.length;
