import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { BOARD_CELLS, PIECE_SIZES } from '../../net/protocol';
import type { CellIndex, CellState, PieceSize } from '../../net/protocol';
import {
  interaction,
  placePiece,
  playerBySeat,
  reserveFor,
  ui,
  useNet,
  usePrefs,
  useUi,
} from '../../store';
import { CELL_NAME, SIZE_LABEL, describeError } from '../lib/copy';
import { RingGlyph, cx, seatClass } from '../components/Ring';

/**
 * A parallel, fully accessible control surface for the board.
 *
 * This is the honest answer to "a 3D board game cannot be made accessible". The
 * WebGL canvas is a single opaque element: it has no DOM, so it has no roles, no
 * names, no focus order and nothing for a screen reader to read. Rather than
 * bolt fake semantics onto a canvas, the 2D layer offers a second way to play
 * the same game -- a real 3x3 grid of real buttons, reading the same
 * authoritative state and calling the same `placePiece` action.
 *
 * It is not a fallback mode or a settings-page afterthought. It is always in the
 * DOM and always in the tab order, revealed the moment anything inside it takes
 * focus (the skip-link pattern), so a sighted keyboard user can see where their
 * focus went instead of driving an invisible cursor. Players who prefer it can
 * pin it open permanently from settings.
 *
 * Keyboard model:
 *   - Arrow keys move between spaces, wrapping at the edges.
 *   - Home / End jump to the first and last space.
 *   - 1 / 2 / 3 arm small / medium / large without leaving the grid.
 *   - Enter or Space places the armed ring.
 * One tab stop for the whole grid (roving tabindex), so Tab still gets you out.
 */
export function TextBoard() {
  const room = useNet((s) => s.room);
  const seat = useNet((s) => s.seat);
  const isMyTurn = useNet((s) => s.isMyTurn);
  const pinned = usePrefs((s) => s.showTextBoard);
  const openedThisSession = useUi((s) => s.textBoardOpen);
  const selectedSize = useUi((s) => s.selectedSize);
  const selectSize = useUi((s) => s.selectSize);

  const gridRef = useRef<HTMLDivElement>(null);
  const [focusCell, setFocusCell] = useState<CellIndex>(4);
  // Mirrored in a ref so the key handler never reads a stale closure.
  const focusRef = useRef<CellIndex>(4);

  const game = room?.game ?? null;
  const visible = pinned || openedThisSession;

  // Drop the shared hover when this component goes away, so the 3D scene does
  // not keep highlighting a space nobody is looking at.
  useEffect(() => () => interaction.get().setHover(null), []);

  const focusOn = useCallback(
    (to: number) => {
      const cell = ((((to % BOARD_CELLS) + BOARD_CELLS) % BOARD_CELLS) as CellIndex);
      focusRef.current = cell;
      setFocusCell(cell);
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${cell}"]`)?.focus();
    },
    [],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const at = focusRef.current;
      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault();
          focusOn(at + 1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          focusOn(at - 1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          focusOn(at + 3);
          break;
        case 'ArrowUp':
          event.preventDefault();
          focusOn(at - 3);
          break;
        case 'Home':
          event.preventDefault();
          focusOn(0);
          break;
        case 'End':
          event.preventDefault();
          focusOn(BOARD_CELLS - 1);
          break;
        case '1':
        case '2':
        case '3': {
          event.preventDefault();
          const size = PIECE_SIZES[Number(event.key) - 1];
          selectSize(size, true);
          ui.announce(`${SIZE_LABEL[size]} ring armed.`);
          break;
        }
        default:
          break;
      }
    },
    [focusOn, selectSize],
  );

  if (!game) return null;

  const reserve = seat === null ? null : reserveFor(room, seat);
  const armedLeft = reserve ? reserve[selectedSize] : 0;

  async function place(cell: CellIndex) {
    const result = await placePiece(cell);
    if (result.ok) {
      ui.announce(
        `Placed ${SIZE_LABEL[selectedSize].toLowerCase()} in the ${CELL_NAME[cell]} space.`,
      );
    } else {
      const copy = describeError(result.error.code);
      ui.announce(`${copy.title}. ${copy.detail}`, 'assertive');
    }
  }

  const rows: CellIndex[][] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
  ];

  return (
    <section
      className={cx('o-textboard', visible && 'is-visible')}
      aria-labelledby="textboard-heading"
    >
      <h2 className="o-textboard__heading" id="textboard-heading">
        Board
      </h2>
      <p className="o-textboard__hint" id="textboard-hint">
        Arrow keys move. 1, 2 and 3 pick small, medium and large. Enter places the{' '}
        {SIZE_LABEL[selectedSize].toLowerCase()} ring
        {armedLeft === 0 ? ' — you have none of that size left' : ''}.
      </p>
      <div
        className="o-textboard__grid"
        ref={gridRef}
        role="grid"
        aria-labelledby="textboard-heading"
        aria-describedby="textboard-hint"
        aria-rowcount={3}
        aria-colcount={3}
        onKeyDown={onKeyDown}
      >
        {rows.map((row, rowIndex) => (
          <div className="o-textboard__row" role="row" aria-rowindex={rowIndex + 1} key={rowIndex}>
            {row.map((cell, colIndex) => (
              <CellButton
                key={cell}
                cell={cell}
                colIndex={colIndex + 1}
                state={game.board[cell]}
                nameOfSeat={(s) => playerBySeat(room, s)?.name ?? `Seat ${s + 1}`}
                armed={selectedSize}
                canPlace={isMyTurn && armedLeft > 0 && game.board[cell]?.[selectedSize] === null}
                isFocusTarget={focusCell === cell}
                onFocus={() => {
                  focusRef.current = cell;
                  setFocusCell(cell);
                  interaction.get().setKeyboardCell(cell);
                  interaction.get().setHover({ cell, size: selectedSize }, 'keyboard');
                }}
                onActivate={() => void place(cell)}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function CellButton({
  cell,
  colIndex,
  state,
  nameOfSeat,
  armed,
  canPlace,
  isFocusTarget,
  onFocus,
  onActivate,
}: {
  cell: CellIndex;
  colIndex: number;
  state: CellState | undefined;
  nameOfSeat: (seat: number) => string;
  armed: PieceSize;
  canPlace: boolean;
  isFocusTarget: boolean;
  onFocus: () => void;
  onActivate: () => void;
}) {
  // The accessible name is a complete sentence about this space, because a
  // screen reader user has no board to glance at: what is here, and what would
  // happen if I pressed Enter.
  const occupancy = PIECE_SIZES.map((size) => {
    const owner = state?.[size];
    return `${size} ${owner === null || owner === undefined ? 'free' : nameOfSeat(owner)}`;
  }).join(', ');
  const action = canPlace ? `Place your ${armed} ring here.` : 'Cannot place here.';

  return (
    <button
      type="button"
      role="gridcell"
      data-cell={cell}
      aria-colindex={colIndex}
      // Roving tabindex: exactly one cell is tabbable, so Tab leaves the grid
      // rather than walking through nine buttons.
      tabIndex={isFocusTarget ? 0 : -1}
      aria-label={`${CELL_NAME[cell]}. ${occupancy}. ${action}`}
      // aria-disabled rather than disabled: an unplayable space still needs to
      // be readable and reachable, it just cannot be activated.
      aria-disabled={!canPlace || undefined}
      className={cx('o-tcell', canPlace && 'is-playable')}
      onFocus={onFocus}
      onClick={() => {
        if (canPlace) onActivate();
      }}
    >
      <span className="o-tcell__rings" aria-hidden="true">
        {PIECE_SIZES.map((size) => {
          const owner = state?.[size] ?? null;
          return (
            <span
              key={size}
              className={cx('o-tcell__ring', owner === null ? '' : seatClass(owner))}
              data-empty={owner === null ? 'true' : 'false'}
            >
              <RingGlyph size={size} state={owner === null ? 'spent' : 'held'} />
            </span>
          );
        })}
      </span>
    </button>
  );
}
