import { useEffect, useRef } from 'react';

import {
  coloursOfSeat,
  dueColour,
  msUntil,
  playerToMove,
  seatAlternates,
  ui,
  useNet,
} from '../../store';
import type { PlayerColor } from '../../net/protocol';
import { formatCountdown } from '../lib/copy';
import { ColourBadge, colourClass, colourLabel, cx } from '../components/Ring';

/**
 * Whose turn it is. The brief said unmissable, so:
 *
 *  - it spans the full width above the board and takes the current player's
 *    colour as a solid fill, not a tint -- from across a table you should be
 *    able to tell whose turn it is without reading anything;
 *  - your own turn says "Your turn" in the largest type in the HUD and gets a
 *    slow breathing animation, which is the one thing on screen that moves;
 *  - identity is carried by colour *and* the player's glyph *and* their name,
 *    so none of the three is load-bearing on its own;
 *  - the turn clock, when the room has one, counts down here rather than in a
 *    corner nobody looks at.
 *
 * It is also the source of the spoken turn announcement, because the moment
 * the banner changes is exactly the moment a screen reader user needs to know.
 */
export function TurnBanner() {
  const room = useNet((s) => s.room);
  const isMyTurn = useNet((s) => s.isMyTurn);
  const role = useNet((s) => s.role);
  const pendingMove = useNet((s) => s.pendingMove);

  const current = playerToMove(room);
  const finished = room?.phase === 'finished';
  const paused = room?.phase === 'paused';

  // Announce turn changes. Assertive for your own turn -- interrupting is
  // justified exactly here -- polite for everyone else's, so the room does not
  // shout every few seconds.
  const due = dueColour(room);
  const alternates = current ? seatAlternates(room, current.seat) : false;
  const pair = current ? coloursOfSeat(room, current.seat) : [];

  const lastAnnounced = useRef<string | null>(null);
  useEffect(() => {
    if (!current || finished || paused) return;
    const key = `${current.playerId}:${room?.game?.moveCount ?? 0}:${due ?? 'x'}`;
    if (lastAnnounced.current === key) return;
    lastAnnounced.current = key;
    // In the two-player variant the colour is as much of the instruction as the
    // turn is: "your turn" without it is not actionable.
    const colourPart = alternates && due !== null ? ` Play ${colourLabel(due)}.` : '';
    if (isMyTurn) {
      ui.announce(`Your turn.${colourPart}`, 'assertive');
    } else if (role !== 'none') {
      ui.announce(`${current.name}'s turn.${colourPart}`);
    }
  }, [current, finished, paused, isMyTurn, role, room?.game?.moveCount, due, alternates]);

  if (!room || !current) {
    return (
      <div className="o-turn o-turn--idle">
        <span className="o-turn__label">{finished ? 'Game over' : 'Waiting…'}</span>
      </div>
    );
  }

  const label = isMyTurn ? 'Your turn' : `${current.name}'s turn`;

  return (
    <div
      className={cx(
        'o-turn',
        isMyTurn && 'is-mine',
        paused && 'is-paused',
        pendingMove && 'is-pending',
        colourClass(due ?? pair[0] ?? null),
      )}
      // The live region lives in <Announcer/>; this one only needs a role so a
      // user who navigates here on purpose hears the current state.
      role="status"
      aria-label={`${label}. ${due !== null ? colourLabel(due) : pair.map((c) => colourLabel(c)).join(' and ')}.`}
    >
      <ColourBadge colour={due ?? pair[0] ?? null} size="lg" />
      <span className="o-turn__label">
        {label}
        {pendingMove ? <span className="o-turn__pending"> — placing…</span> : null}
      </span>
      {alternates ? <DueColour due={due} pair={pair} isMine={isMyTurn} /> : null}
      {room.turnDeadline !== null ? <TurnClock deadline={room.turnDeadline} /> : null}
    </div>
  );
}

/**
 * Which of a two-colour player's colours is due.
 *
 * The official 2-player game makes each player run two colours and forces them
 * to switch every turn (docs/RULES.md §4.6), which means a player will regularly
 * be sitting on a winning placement they are not allowed to make yet. If the
 * screen does not say which colour is live, that reads as a broken board rather
 * than a rule -- so the due colour gets its own chip, and the other colour is
 * shown greyed beside it so the alternation is visible rather than remembered.
 *
 * When the referee has not told us which colour is due (see `colours.ts` -- the
 * wire protocol cannot carry it yet) we show both colours unmarked and say that
 * they alternate, rather than guessing and being confidently wrong.
 */
function DueColour({
  due,
  pair,
  isMine,
}: {
  // Genuinely colours, not seats: `due` comes from `dueColour(room)` and `pair`
  // from `coloursOfSeat(room, seat)`, both of which return `PlayerColor`. Typed
  // as such rather than widened to `number` -- a seat and a colour are different
  // quantities now, and letting them meet at `number` is the conflation the
  // protocol change exists to prevent.
  due: PlayerColor | null;
  pair: PlayerColor[];
  isMine: boolean;
}) {
  if (due === null) {
    return (
      <span className="o-turn__colours" title="This player uses two colours, switching every turn">
        {pair.map((c) => (
          <span key={c} className={cx('o-turn__colourChip is-unknown', colourClass(c))}>
            <span aria-hidden="true">{colourLabel(c)}</span>
          </span>
        ))}
        <span className="u-visually-hidden">
          {isMine ? 'You play' : 'They play'} {pair.map((c) => colourLabel(c)).join(' and ')},
          switching every turn.
        </span>
      </span>
    );
  }
  const other = pair.find((c) => c !== due);
  return (
    <span className="o-turn__colours">
      <span className={cx('o-turn__colourChip is-due', colourClass(due))}>
        <span aria-hidden="true">{colourLabel(due)}</span>
      </span>
      {other !== undefined ? (
        <span className={cx('o-turn__colourChip is-next', colourClass(other))} aria-hidden="true">
          next
        </span>
      ) : null}
      <span className="u-visually-hidden">
        {isMine ? 'Play your' : 'Playing'} {colourLabel(due)} ring
        {other !== undefined ? `. ${colourLabel(other)} next turn.` : '.'}
      </span>
    </span>
  );
}

/**
 * The turn clock.
 *
 * Its own component and its own interval so a per-second tick never re-renders
 * the rest of the HUD, and never competes with the 3D render loop. The referee
 * owns expiry; this only draws it.
 */
function TurnClock({ deadline }: { deadline: number }) {
  const offset = useNet((s) => s.quality.clockOffsetMs);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // Written straight to the DOM rather than through state: this updates every
    // second for the whole game, and there is no reason for React to see it.
    function tick() {
      const node = ref.current;
      if (!node) return;
      const remaining = msUntil(deadline, offset);
      node.textContent = formatCountdown(remaining);
      node.dataset.urgent = remaining !== null && remaining < 10_000 ? 'true' : 'false';
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline, offset]);

  return <span className="o-turn__clock u-tabular" ref={ref} aria-hidden="true" />;
}
