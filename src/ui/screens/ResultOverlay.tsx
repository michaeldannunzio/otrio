import { useEffect, useRef } from 'react';

import { PIECE_SIZES } from '../../net/protocol';
import {
  leaveRoom,
  outcomeOf,
  rematchView,
  requestRematch,
  ui,
  useNet,
  useUi,
} from '../../store';
import { CELL_NAME, describeEndReason, describeError, describeWin, joinNames, winConditionLabel } from '../lib/copy';
import { useFocusTrap } from '../lib/a11y';
import { Button } from '../components/primitives';
import { RingGlyph, SeatBadge, cx, seatClass } from '../components/Ring';

/**
 * The end of the game: who won, *how*, and what happens next.
 *
 * "How" is the part usually left out, and it is the part that makes the ending
 * satisfying instead of confusing. Otrio's three win conditions are easy to miss
 * on a crowded board -- particularly the small-medium-large line, which people
 * routinely complete without noticing -- so the overlay names the condition,
 * lists the three rings that formed it, and leaves the board highlighted behind
 * it. `Dismiss` collapses the overlay to a bar so the position can be studied
 * with the winning line still lit.
 *
 * Draws are a real, official outcome (docs/RULES.md §6.2): 27 slots and, in a
 * 3-player game, exactly 27 pieces, so a full board with nobody on three is a
 * reachable ending and the rulebook's answer is "You all win!". It gets its own
 * celebratory state rather than being treated as a failure to win.
 */
export function ResultOverlay() {
  const room = useNet((s) => s.room);
  const selfId = useNet((s) => s.playerId);
  const dismissed = useUi((s) => s.resultDismissed);
  const setDismissed = useUi((s) => s.setResultDismissed);
  const panelRef = useRef<HTMLDivElement>(null);

  const outcome = outcomeOf(room);
  const open = outcome.kind !== 'none' && !dismissed;

  useFocusTrap(panelRef, { active: open, onEscape: () => setDismissed(true) });

  // Say it once, assertively. The end of the game is the other occasion where
  // interrupting is justified.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (outcome.kind === 'none') {
      announced.current = null;
      return;
    }
    const key = `${outcome.kind}:${outcome.winner?.playerId ?? 'none'}`;
    if (announced.current === key) return;
    announced.current = key;
    if (outcome.kind === 'win' && outcome.winner) {
      ui.announce(describeWin(outcome.line, outcome.winner.name), 'assertive');
    } else if (outcome.kind === 'draw') {
      ui.announce('Draw. The board is full and nobody made three. Everybody wins.', 'assertive');
    } else {
      ui.announce(describeEndReason(room?.endReason ?? null, null), 'assertive');
    }
  }, [outcome.kind, outcome.winner, outcome.line, room?.endReason]);

  if (outcome.kind === 'none') return null;

  if (dismissed) {
    return (
      <div className="o-resultbar">
        <span className="o-resultbar__text">
          {outcome.kind === 'win' && outcome.winner
            ? `${outcome.winner.name} won`
            : outcome.kind === 'draw'
              ? 'Draw — everybody wins'
              : 'Game over'}
        </span>
        <Button size="md" variant="primary" onClick={() => setDismissed(false)}>
          Show result
        </Button>
      </div>
    );
  }

  const isWinner = outcome.winner?.playerId === selfId;
  const rematch = rematchView(room, selfId);

  return (
    <div className="o-result" role="presentation">
      <div className="o-result__scrim" aria-hidden="true" />
      <div
        className={cx(`o-result__panel o-result__panel--${outcome.kind}`, outcome.winner ? seatClass(outcome.winner.seat) : '')}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="result-title"
        aria-describedby="result-detail"
        tabIndex={-1}
      >
        {outcome.kind === 'win' && outcome.winner ? (
          <>
            <p className="o-result__badge">{winConditionLabel(outcome.line)}</p>
            <div className="o-result__crest">
              <SeatBadge seat={outcome.winner.seat} size="lg" />
            </div>
            <h2 className="o-result__title" id="result-title">
              {isWinner ? 'You win' : `${outcome.winner.name} wins`}
            </h2>
            <p className="o-result__detail" id="result-detail">
              {describeWin(outcome.line, outcome.winner.name, isWinner)}
            </p>
            {outcome.line ? <WinningLineList line={outcome.line} seat={outcome.winner.seat} /> : null}
          </>
        ) : null}

        {outcome.kind === 'draw' ? (
          <>
            <p className="o-result__badge">Every slot filled</p>
            <h2 className="o-result__title" id="result-title">
              It&rsquo;s a draw
            </h2>
            <p className="o-result__detail" id="result-detail">
              Nobody made three. The rulebook is unusually generous about this one: you all win.
            </p>
          </>
        ) : null}

        {outcome.kind === 'abandoned' ? (
          <>
            <h2 className="o-result__title" id="result-title">
              Game over
            </h2>
            <p className="o-result__detail" id="result-detail">
              {describeEndReason(room?.endReason ?? null, null)}
            </p>
          </>
        ) : null}

        <RematchControls />

        <div className="o-result__actions">
          <Button variant="ghost" block onClick={() => setDismissed(true)}>
            Look at the board
          </Button>
          <Button variant="ghost" block onClick={() => void leaveRoom()}>
            Leave room
          </Button>
        </div>

        {rematch.offered && rematch.waitingOn.length > 0 ? (
          <p className="o-result__waiting" role="status">
            Waiting for {joinNames(rematch.waitingOn.map((p) => p.name))}.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The three rings that made the win, in the order the engine ordered them.
 *
 * Shown rather than merely described so the player can find them on the board:
 * for a small-medium-large line "top left, centre, bottom right" plus the three
 * ring sizes is enough to locate it without hunting.
 */
function WinningLineList({
  line,
  seat,
}: {
  line: { kind: string; cells: number[]; sizes: string[] };
  seat: number;
}) {
  return (
    <ol className={cx('o-winline', seatClass(seat))}>
      {line.cells.map((cell, i) => {
        const size = (line.sizes[i] ?? 'small') as (typeof PIECE_SIZES)[number];
        return (
          <li className="o-winline__item" key={`${cell}-${size}-${i}`}>
            <RingGlyph size={size} />
            <span className="o-winline__text">
              {size} in the {CELL_NAME[cell] ?? `space ${cell + 1}`}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Rematch, which deliberately keeps the room together: same code, same seats,
 * same people. Nobody has to read a code out again, which is the whole point --
 * the friction of re-forming a four-person room is why a second game often does
 * not happen.
 */
function RematchControls() {
  const room = useNet((s) => s.room);
  const selfId = useNet((s) => s.playerId);
  const role = useNet((s) => s.role);
  const rematch = rematchView(room, selfId);

  if (role !== 'player') return null;

  async function respond(accept: boolean) {
    const result = await requestRematch(accept);
    if (!result.ok) {
      const copy = describeError(result.error.code);
      ui.toast({ tone: 'warning', title: copy.title, detail: copy.detail, timeout: 5000 });
    }
  }

  if (!rematch.offered) {
    return (
      <Button variant="primary" size="lg" block onClick={() => void respond(true)}>
        Play again
      </Button>
    );
  }

  if (rematch.youAccepted) {
    return (
      <div className="o-rematch">
        <p className="o-rematch__status" role="status">
          You&rsquo;re in. {rematch.accepted.length} of {rematch.accepted.length + rematch.waitingOn.length} ready.
        </p>
        <Button variant="ghost" block onClick={() => void respond(false)}>
          Actually, no
        </Button>
      </div>
    );
  }

  return (
    <div className="o-rematch">
      <p className="o-rematch__status">
        {rematch.requestedBy?.name ?? 'Someone'} wants a rematch — same room, same seats.
      </p>
      <Button variant="primary" size="lg" block onClick={() => void respond(true)}>
        Play again
      </Button>
      <Button variant="ghost" block onClick={() => void respond(false)}>
        No thanks
      </Button>
    </div>
  );
}
