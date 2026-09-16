import { useEffect, useRef } from 'react';

import {
  coloursOfSeat,
  isTwoPlayerVariant,
  leaveRoom,
  openSeatCount,
  playersBySeat,
  reserveFor,
  setReady,
  startCheck,
  startGame,
  ui,
  useNet,
  variantBadges,
} from '../../store';
import { MAX_PLAYERS } from '../../net/protocol';
import type { PlayerView, Reserve, Seat } from '../../net/protocol';
import { describeError, describePeer, joinNames } from '../lib/copy';
import { useScreenFocus } from '../lib/a11y';
import { Button, Card, Pill } from '../components/primitives';
import { RoomCodeDisplay } from '../components/RoomCode';
import {
  ReserveTray,
  SeatBadge,
  colourName,
  cx,
  seatClass,
  seatColorName,
  seatGlyph,
} from '../components/Ring';
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
                reserve={reserveFor(room, seat)}
                colours={coloursOfSeat(room, seat)}
              />
            );
          })}
        </ul>
        {/*
          "Pick a colour" is the wrong shape for this game. In a 2-player game a
          seat owns a *pair* of opposite colours and must alternate between them
          every turn (docs/RULES.md §4.6), so there is no single colour to pick;
          and the protocol assigns seats in join order with no message for
          swapping them. Saying what actually happens beats a control that lies.
        */}
        <p className="o-lobby__note">
          {isTwoPlayerVariant(room)
            ? 'Two-player games use all four colours: each player takes two opposite ones and switches between them every turn.'
            : 'Colours follow the order people joined.'}
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
  reserve,
  colours,
}: {
  seat: Seat;
  player: PlayerView | null;
  isSelf: boolean;
  isHostSeat: boolean;
  reserve: Reserve;
  /** Colours this seat controls. Two in the official 2-player game. */
  colours: number[];
}) {
  const colour = colours.length > 1
    ? colours.map((c) => colourName(c)).join(' and ')
    : seatColorName(seat);
  const { glyph, label: glyphLabel } = seatGlyph(seat);

  if (!player) {
    return (
      <li className={cx('o-seat o-seat--empty', seatClass(seat))}>
        <span className="o-seat__badge" aria-hidden="true">
          {glyph}
        </span>
        <span className="o-seat__body">
          <span className="o-seat__name">Open seat</span>
          <span className="o-seat__meta">
            {colour} {glyphLabel} — waiting for someone to join
          </span>
        </span>
      </li>
    );
  }

  const peer = describePeer(player.connection, player.forfeited);

  return (
    <li
      className={cx('o-seat', isSelf && 'is-self', player.ready && 'is-ready', seatClass(seat))}
    >
      <span className="o-seat__badges">
        {colours.map((c) => (
          <SeatBadge key={c} seat={c} />
        ))}
      </span>
      <span className="o-seat__body">
        <span className="o-seat__name">
          {player.name}
          {isSelf ? <span className="o-seat__you"> (you)</span> : null}
        </span>
        <span className="o-seat__meta">
          {colour} {glyphLabel}
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
      <ReserveTray
        reserve={reserve}
        seat={colours.length > 1 ? null : seat}
        size="sm"
        label={player.name}
      />
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
