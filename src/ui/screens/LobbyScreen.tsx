import { useEffect, useRef } from 'react';

import {
  leaveRoom,
  openSeatCount,
  playersBySeat,
  seatedCount,
  setReady,
  startCheck,
  startGame,
  ui,
  useNet,
  variantBadges,
} from '../../store';
import { MAX_PLAYERS } from '../../net/protocol';
import type { PlayerView, Seat } from '../../net/protocol';
import { describeError, describePeer, joinNames } from '../lib/copy';
import { useScreenFocus } from '../lib/a11y';
import { Button, Card, Pill } from '../components/primitives';
import { RoomCodeDisplay } from '../components/RoomCode';
import { cx } from '../components/Ring';
import { ConnectionDot } from '../hud/ConnectionDot';

/**
 * The waiting room.
 *
 * Its whole job is to answer, from across a table, four questions at once:
 * what do I type into my phone, who is already in, who has not tapped Ready,
 * and why is the Start button grey. The last one matters most -- a lobby
 * usually stalls because the host is looking at their screen and the person
 * holding things up is looking at theirs.
 */
export function LobbyScreen() {
  const headingRef = useRef<HTMLHeadingElement>(null);

  const room = useNet((s) => s.room);
  const selfId = useNet((s) => s.playerId);
  const isHost = useNet((s) => s.isHost);
  const role = useNet((s) => s.role);

  useScreenFocus(headingRef, 'lobby');

  const players = playersBySeat(room);
  const me = players.find((p) => p.playerId === selfId) ?? null;
  const open = openSeatCount(room);
  const check = startCheck(room, isHost);

  // Announce arrivals and departures for players who cannot see the list.
  const previousNames = useRef<string[]>([]);
  useEffect(() => {
    const names = players.map((p) => p.name);
    const before = previousNames.current;
    const joined = names.filter((n) => !before.includes(n));
    const left = before.filter((n) => !names.includes(n));
    if (before.length > 0) {
      if (joined.length) ui.announce(`${joinNames(joined)} joined. ${names.length} in the room.`);
      if (left.length) ui.announce(`${joinNames(left)} left. ${names.length} in the room.`);
    }
    previousNames.current = names;
  }, [players]);

  if (!room) return null;

  return (
    <div className="o-screen o-lobby">
      <header className="o-lobby__header">
        <h1 className="o-lobby__title" ref={headingRef} tabIndex={-1}>
          Waiting room
        </h1>
        <p className="o-lobby__sub">
          {open > 0
            ? `Room for ${open} more ${open === 1 ? 'player' : 'players'}.`
            : 'Everyone is here.'}
        </p>
      </header>

      <Card className="o-lobby__codeCard">
        <RoomCodeDisplay code={room.code} />
      </Card>

      <section className="o-lobby__seats" aria-labelledby="lobby-seats-heading">
        <h2 className="o-lobby__sectionTitle" id="lobby-seats-heading">
          Players
        </h2>
        <ul className="o-seats">
          {Array.from({ length: Math.min(room.maxPlayers, MAX_PLAYERS) }, (_, seat) => {
            const player = players.find((p) => p.seat === seat) ?? null;
            return (
              <SeatRow
                key={seat}
                seat={seat}
                player={player}
                isSelf={player?.playerId === selfId}
                isHostSeat={player?.playerId === room.hostPlayerId}
              />
            );
          })}
        </ul>
        {/*
          The lobby deliberately shows NO game colours.

          `PlayerView.colors` is empty until the game starts, and that is the
          protocol being careful rather than incomplete: how many colours a seat
          gets depends on the final player count, so seat 1 is red in a
          three-player game and red+blue in a two-player one. A lobby that
          guessed would be wrong every time the last player joined or left, and
          the wrongness would look like the game reassigning colours under you.
          So seats are numbered here, and colour appears when it is real.
        */}
        <p className="o-lobby__note">
          {seatedCount(room) === 2
            ? 'With two players you each take two opposite colours and switch between them every turn. Colours are dealt when the game starts.'
            : 'Colours are dealt when the game starts.'}
        </p>
        {variantBadges(room).length > 0 ? (
          <ul className="o-variantBadges" aria-label="Optional rules in play">
            {variantBadges(room).map((badge) => (
              <li key={badge}>
                <Pill tone="accent">{badge}</Pill>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {room.spectators.length > 0 ? (
        <section className="o-lobby__spectators" aria-labelledby="lobby-spectators-heading">
          <h2 className="o-lobby__sectionTitle" id="lobby-spectators-heading">
            Watching
          </h2>
          <p className="o-lobby__note">{joinNames(room.spectators.map((s) => s.name))}</p>
        </section>
      ) : null}

      <div className="o-lobby__actions">
        {role === 'player' && me ? (
          <Button
            variant={me.ready ? 'secondary' : 'primary'}
            size="lg"
            block
            aria-pressed={me.ready}
            onClick={async () => {
              const next = !me.ready;
              const result = await setReady(next);
              if (result.ok) {
                ui.announce(next ? 'You are ready.' : 'You are no longer ready.');
              } else {
                const copy = describeError(result.error.code);
                ui.toast({ tone: 'warning', title: copy.title, detail: copy.detail, timeout: 5000 });
              }
            }}
          >
            {me.ready ? "I'm ready — tap to undo" : "I'm ready"}
          </Button>
        ) : null}

        {isHost ? (
          <>
            <Button
              variant="primary"
              size="lg"
              block
              disabled={!check.canStart}
              aria-describedby={check.canStart ? undefined : 'start-blockers'}
              onClick={async () => {
                const result = await startGame();
                if (!result.ok) {
                  const copy = describeError(result.error.code);
                  ui.toast({ tone: 'warning', title: copy.title, detail: copy.detail, timeout: 6000 });
                }
              }}
            >
              Start the game
            </Button>
            {!check.canStart ? (
              // Never a bare disabled button. The reason is the useful part.
              <ul className="o-blockers" id="start-blockers">
                {check.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="o-lobby__note" role="status">
            {check.canStart
              ? 'Waiting for the host to start.'
              : check.blockers.filter((b) => !b.startsWith('Only ')).join(' ') ||
                'Waiting for the host to start.'}
          </p>
        )}

        <Button variant="ghost" block onClick={() => void leaveRoom()}>
          Leave room
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * One seat
 * -------------------------------------------------------------------------- */

function SeatRow({
  seat,
  player,
  isSelf,
  isHostSeat,
}: {
  seat: Seat;
  player: PlayerView | null;
  isSelf: boolean;
  isHostSeat: boolean;
}) {
  // Seat number, not a colour. See the note in LobbyScreen above.
  const seatName = `Seat ${seat + 1}`;

  if (!player) {
    return (
      <li className="o-seat o-seat--empty">
        <span className="o-seat__number" aria-hidden="true">
          {seat + 1}
        </span>
        <span className="o-seat__body">
          <span className="o-seat__name">Open seat</span>
          <span className="o-seat__meta">{seatName} — waiting for someone to join</span>
        </span>
      </li>
    );
  }

  const peer = describePeer(player.connection, player.forfeited);

  return (
    <li className={cx('o-seat', isSelf && 'is-self', player.ready && 'is-ready')}>
      <span className="o-seat__number" aria-hidden="true">
        {seat + 1}
      </span>
      <span className="o-seat__body">
        <span className="o-seat__name">
          {player.name}
          {isSelf ? <span className="o-seat__you"> (you)</span> : null}
        </span>
        <span className="o-seat__meta">
          {seatName}
          {isHostSeat ? ' — host' : ''}
        </span>
      </span>
      <span className="o-seat__status">
        {player.ready ? (
          <Pill tone="ok" icon={<CheckIcon />}>
            Ready
          </Pill>
        ) : (
          <Pill tone="neutral">Not ready</Pill>
        )}
        <ConnectionDot
          connection={player.connection}
          forfeited={player.forfeited}
          rttMs={player.rttMs}
          name={player.name}
        />
        <span className="u-visually-hidden">{peer.label}</span>
      </span>
    </li>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="o-icon">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}
