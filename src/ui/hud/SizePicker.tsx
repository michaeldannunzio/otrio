import { useEffect } from 'react';

import { PIECE_SIZES } from '../../net/protocol';
import type { PieceSize } from '../../net/protocol';
import {
  alternationNote,
  armColour,
  armSize,
  autoArmSize,
  colourLabel,
  dueColour,
  reserveOfColour,
  turnColours,
  useNet,
  usePrefs,
  useUi,
} from '../../store';
import { SIZE_LABEL } from '../lib/copy';
import { ColourBadge, RingGlyph, colourClass, cx } from '../components/Ring';

/**
 * Which ring you are about to place.
 *
 * Placement is two steps on a phone -- arm a size here, then tap a space on the
 * board -- rather than dragging a ring out of a 3D tray. Dragging looks better
 * in a demo and is miserable in practice: the tray competes with the camera
 * gesture, and a mis-drag on someone else's turn is indistinguishable from a
 * mis-drag on your own.
 *
 * It sits at the bottom, in the thumb zone, above the home indicator. Each
 * button is a full-height target with the ring drawn at its true relative size
 * and the count beside it, so the control doubles as your own reserve readout.
 * A size you have run out of is disabled and says why.
 */
export function SizePicker() {
  const room = useNet((s) => s.room);
  const seat = useNet((s) => s.seat);
  const isMyTurn = useNet((s) => s.isMyTurn);
  const pendingMove = useNet((s) => s.pendingMove);
  const moveCount = useNet((s) => s.room?.game?.moveCount ?? 0);

  const selected = useUi((s) => s.selectedSize);
  const selectedColour = useUi((s) => s.selectedColour);
  const showLetters = usePrefs((s) => s.sizeLabels);

  // Re-arm the largest ring still held at the start of each turn, unless the
  // player has chosen one deliberately.
  useEffect(() => {
    if (isMyTurn) autoArmSize();
  }, [isMyTurn, moveCount]);

  if (seat === null || !room?.game) return null;
  const note = alternationNote(room, seat);
  const offered = turnColours(room);
  const due = dueColour(room);
  // The tray belongs to the COLOUR being placed. When the referee has left a
  // real choice (alternation off) we show that choice first and fall back to
  // whichever colour is currently armed.
  const active = due ?? selectedColour ?? offered[0] ?? null;
  const reserve = active === null ? { small: 0, medium: 0, large: 0 } : reserveOfColour(room, active);
  const disabled = !isMyTurn || pendingMove !== null;

  // Tinted with the colour actually being placed, so the control the player is
  // about to touch agrees with the turn banner.
  return (
    <div className={cx('o-sizes', colourClass(active))}>
      {offered.length > 1 && isMyTurn ? (
        // Only reachable with strict alternation switched off. A radiogroup for
        // the same reasons as the size picker below.
        <div className="o-sizes__colours" role="radiogroup" aria-label="Colour to place">
          {offered.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={active === c}
              tabIndex={active === c ? 0 : -1}
              className={cx('o-colourpick', colourClass(c), active === c && 'is-selected')}
              aria-label={`Place ${colourLabel(c)}`}
              onClick={() => armColour(c)}
            >
              <ColourBadge colour={c} size="sm" />
              <span className="o-colourpick__label">{colourLabel(c)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {/*
        A radiogroup rather than a row of toggle buttons: arrow keys move
        between the options, the group has one tab stop, and the current choice
        is announced as "2 of 3" rather than as three independent pressed
        states.
      */}
      <div
        className="o-sizes__group"
        role="radiogroup"
        aria-label="Ring size to place"
        aria-disabled={disabled || undefined}
      >
        {PIECE_SIZES.map((size) => (
          <SizeOption
            key={size}
            size={size}
            count={reserve[size]}
            selected={selected === size}
            disabled={disabled || reserve[size] === 0}
            showLetter={showLetters}
          />
        ))}
      </div>
      <p className="o-sizes__hint" id="size-hint">
        {disabled
          ? pendingMove
            ? 'Placing your ring…'
            : 'Wait for your turn.'
          : due !== null && note
            ? `Placing ${colourLabel(due)}. Pick a size, then a space.`
            : 'Pick a size, then choose a space on the board.'}
      </p>
      {note && isMyTurn ? (
        // The rule, stated where it bites. A player holding a winning placement
        // they are not allowed to make needs to be told why, not left to
        // conclude the board is broken.
        <p className="o-sizes__rule">{note}</p>
      ) : null}
    </div>
  );
}

function SizeOption({
  size,
  count,
  selected,
  disabled,
  showLetter,
}: {
  size: PieceSize;
  count: number;
  selected: boolean;
  disabled: boolean;
  showLetter: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      // Roving tabindex: one stop for the whole group, arrows move within it.
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      className={cx('o-size', selected && 'is-selected', count === 0 && 'is-empty')}
      aria-label={`${SIZE_LABEL[size]}, ${count} left${count === 0 ? ', none remaining' : ''}`}
      onClick={() => armSize(size)}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (step === 0) return;
        e.preventDefault();
        moveWithinGroup(e.currentTarget, step);
      }}
    >
      <RingGlyph size={size} state={count === 0 ? 'spent' : 'held'} showLetter={showLetter} />
      <span className="o-size__label">{SIZE_LABEL[size]}</span>
      <span className="o-size__count u-tabular" aria-hidden="true">
        {count}
      </span>
    </button>
  );
}

/**
 * Move the selection to the next *enabled* option and take focus with it.
 *
 * Arrow-key navigation that leaves focus behind is worse than none: the ring
 * appears to change for a sighted user while the screen reader stays on the old
 * option. Skipping disabled options matters too -- a player with no small rings
 * left should not have to arrow through a dead button.
 */
function moveWithinGroup(current: HTMLElement, step: 1 | -1): void {
  const group = current.closest('[role="radiogroup"]');
  if (!group) return;
  const options = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const from = options.indexOf(current as HTMLButtonElement);
  if (from < 0) return;
  const n = options.length;
  for (let hop = 1; hop <= n; hop += 1) {
    const next = options[(((from + step * hop) % n) + n) % n];
    if (next && !next.disabled) {
      next.focus();
      next.click();
      return;
    }
  }
}
