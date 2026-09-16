import { useEffect, useRef } from 'react';

import {
  firstColourOfSeat,
  leaveRoom,
  openSeatCount,
  playersNeededForSeat,
  playersBySeat,
  seatedCount,
  secondColourIfTwoPlay,
  setReady,
  startCheck,
  startGame,
  ui,
  useNet,
  variantBadges,
} from '../../store';
import { ALL_SEATS, MAX_PLAYERS } from '../../net/protocol';
import type { PlayerView, Seat } from '../../net/protocol';
import { describeError, describePeer, joinNames } from '../lib/copy';
import { useScreenFocus } from '../lib/a11y';
import { Button, Card, Pill } from '../components/primitives';
import { RoomCodeDisplay } from '../components/RoomCode';
import { ColourBadge, colourClass, colourLabel, cx } from '../components/Ring';
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
          {/*
            `ALL_SEATS` rather than `Array.from({length}, (_, i) => i)`: the
            latter produces a bare `number`, which then needs a cast to reach
            anything typed `Seat` -- and a cast there puts back exactly the hole
            that narrowing `Seat` just closed.
          */}
          {ALL_SEATS.filter((seat) => seat < Math.min(room.maxPlayers, MAX_PLAYERS)).map((seat) => {
            const player = players.find((p) => p.seat === seat) ?? null;
            return (
              <SeatRow
                key={seat}
                seat={seat}
                player={player}
                isSelf={player?.playerId === selfId}
                isHostSeat={player?.playerId === room.hostPlayerId}
                mayGetSecondColour={room.maxPlayers > 2 && seatedCount(room) === 2}
              />
            );
          })}
        </ul>
        {/*
          The lobby shows each seat's colour, and says so carefully.

          `PlayerView.colors` is empty until the game starts, and I originally
          read that as "colour is unknowable here". It is narrower than that:
          `buildShape` in engine.ts is fully deterministic and `referee.ts`
          never passes a custom `colors` array, so **seat N's first colour is
          always N** -- purple, red, green, blue. For two players the pairs are
          [0,2] and [1,3], so seat 0 still starts purple and seat 1 still starts
          red.

          What is genuinely unknown in the lobby is the *count*: whether a seat
          gets one colour or two, which depends on how many people end up
          playing. So we state the colour, which cannot change, and hedge only
          the second colour, which can.
        */}
        <p className="o-lobby__note">
          {room.maxPlayers === 2
            ? 'With two players you each take two opposite colours and switch between them every turn.'
            : room.maxPlayers > 2 && seatedCount(room) === 2
              ? 'If only two of you play, you will each get a second colour on the opposite arm.'
              : 'Each seat plays the colour of its arm on the board.'}
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
  mayGetSecondColour,
}: {
  seat: Seat;
  player: PlayerView | null;
  isSelf: boolean;
  isHostSeat: boolean;
  /** True while the final player count could still make this seat two-coloured. */
  mayGetSecondColour: boolean;
}) {
  // Seat N always starts on colour N -- deterministic in the engine, see the
  // note in LobbyScreen. Only whether a *second* colour joins it is open.
  //
  // Through `firstColourOfSeat` rather than `seat as PlayerColor`: the two
  // unions are structurally identical, so the cast would compile forever even
  // if the seating rule changed. The helper is where that rule lives.
  const colour = firstColourOfSeat(seat);
  const seatName = `Seat ${seat + 1} — ${colourLabel(colour)}`;
  const second = secondColourIfTwoPlay(seat);

  if (!player) {
    /*
     * An empty row must not present its colour as waiting for an occupant.
     * A 4-player room with two people in it can still *start* with two, and
     * `buildShape(2, …)` then hands colours 2 and 3 to the seated players as
     * their second colours -- so "Seat 3 — Green, open" and "Seat 1 — Purple
     * (+ green if only two play)" would be two halves of the same list
     * contradicting each other. The badge is hollow and the colour is stated
     * with the condition that makes it true.
     */
    const needed = playersNeededForSeat(seat);
    // "4 or more" is silly when 4 is the maximum. Say "if 4 play" on the last
    // seat and keep "or more" where there genuinely is a more.
    const condition = needed >= MAX_PLAYERS ? `if ${needed} play` : `if ${needed} or more play`;
    return (
      <li className={cx('o-seat o-seat--empty', colourClass(colour))}>
        <ColourBadge colour={colour} provisional />
        <span className="o-seat__body">
          <span className="o-seat__name">Open seat</span>
          <span className="o-seat__meta">
            {`Seat ${seat + 1} — ${colourLabel(colour)} ${condition}`}
          </span>
        </span>
      </li>
    );
  }

  const peer = describePeer(player.connection, player.forfeited);

  return (
    <li
      className={cx('o-seat', isSelf && 'is-self', player.ready && 'is-ready', colourClass(colour))}
    >
      <ColourBadge colour={colour} />
      <span className="o-seat__body">
        <span className="o-seat__name">
          {player.name}
          {isSelf ? <span className="o-seat__you"> (you)</span> : null}
        </span>
        <span className="o-seat__meta">
          {seatName}
          {/*
            Name the second colour rather than counting it. It is as
            deterministic as the first (the pairs are fixed at [0,2] and [1,3]),
            so "+1" both understates what we know and, next to a seat number,
            reads as a score.
          */}
          {mayGetSecondColour && second !== null
            ? ` (+ ${colourLabel(second).toLowerCase()} if only two play)`
            : ''}
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
