import { useEffect, useRef } from 'react';

import { ownerNameOfColour, useMoveLog, useNet } from '../../store';
import type { MoveLogEntry } from '../../store';
import { CELL_NAME, SIZE_LABEL } from '../lib/copy';
import { ColourBadge, colourClass, colourLabel, cx } from '../components/Ring';

/**
 * What has been played, in order.
 *
 * This information already existed and was being thrown away: every move goes
 * into a polite live region, so a screen-reader user hears the whole game and a
 * sighted player sees nothing. In a four-player game you look away for ten
 * seconds and three rings have appeared with no way to find out whose.
 *
 * Newest last, scrolled to the bottom — a game log reads like a transcript, and
 * reversing it to put "latest" on top makes the sequence of a *sequence* win
 * unreadable, which is exactly the kind of thing people scroll back for.
 *
 * Not a live region itself: `Announcer` already speaks every move, and a second
 * announcement of the same event is how people end up switching the first one
 * off. This is the visual channel for something that was previously only aural.
 */
export function MoveLog({ compact = false }: { compact?: boolean }) {
  const entries = useMoveLog((s) => s.entries);
  const joinedAtMove = useMoveLog((s) => s.joinedAtMove);
  const hasInferred = useMoveLog((s) => s.hasInferred);
  const room = useNet((s) => s.room);

  const listRef = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);

  // Follow the tail, but only while the player is already there. Yanking the
  // view back down while someone is reading earlier moves is worse than not
  // following at all.
  useEffect(() => {
    const node = listRef.current;
    if (!node || !atBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [entries.length]);

  return (
    <section className={cx('o-log', compact && 'o-log--compact')} aria-labelledby="move-log-heading">
      <h2 className="o-log__heading" id="move-log-heading">
        Moves
      </h2>

      {entries.length === 0 ? (
        <p className="o-log__empty">
          {joinedAtMove > 0
            ? `You joined after ${joinedAtMove} ${joinedAtMove === 1 ? 'move' : 'moves'}. New moves appear here.`
            : 'Moves appear here as they are played.'}
        </p>
      ) : (
        <ol
          className="o-log__list"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {joinedAtMove > 0 ? (
            <li className="o-log__note">
              Joined after {joinedAtMove} {joinedAtMove === 1 ? 'move' : 'moves'}
            </li>
          ) : null}
          {entries.map((entry) => (
            <LogRow key={`${entry.n}-${entry.cell}-${entry.size}`} entry={entry} room={room} />
          ))}
        </ol>
      )}

      {hasInferred ? (
        // Said once, at the bottom, rather than repeated per row: the rows carry
        // a marker and this explains what the marker means.
        <p className="o-log__caveat">
          Moves marked ~ were recovered after a reconnection. They were played,
          but possibly not in this order.
        </p>
      ) : null}
    </section>
  );
}

function LogRow({
  entry,
  room,
}: {
  entry: MoveLogEntry;
  room: Parameters<typeof ownerNameOfColour>[0];
}) {
  const who = ownerNameOfColour(room, entry.colour);
  const where = CELL_NAME[entry.cell] ?? `space ${entry.cell + 1}`;
  const size = SIZE_LABEL[entry.size].toLowerCase();

  return (
    <li className={cx('o-log__row', colourClass(entry.colour), entry.inferred && 'is-inferred')}>
      <span className="o-log__n u-tabular" aria-hidden="true">
        {entry.n}
      </span>
      <ColourBadge colour={entry.colour} size="sm" />
      <span className="o-log__text">
        {/*
          Colour first, then the person. A win is always within one colour and
          the two never combine, so in the official 2-player game "Ada" names
          both of Ada's campaigns and tells you nothing about which one this
          move advanced.
        */}
        <span className="o-log__who">
          {colourLabel(entry.colour)}
          {who !== colourLabel(entry.colour) ? ` (${who})` : ''}
        </span>{' '}
        played {size} in the {where}
        {entry.inferred ? <span className="o-log__mark" aria-hidden="true"> ~</span> : null}
      </span>
    </li>
  );
}
