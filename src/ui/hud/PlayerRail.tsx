import { PIECE_SIZES } from '../../net/protocol';
import type { PlayerColor, PlayerView, Reserve } from '../../net/protocol';
import {
  colourLabel,
  coloursOfSeat,
  dueColour,
  playersBySeat,
  reservesOfSeat,
  totalRemainingForSeat,
  useNet,
  usePrefs,
  useUi,
} from '../../store';
import { ColourBadge, ReserveTray, colourClass, cx, seatIdentityText } from '../components/Ring';
import { ConnectionDot } from './ConnectionDot';

/**
 * Everyone's remaining rings, at a glance.
 *
 * In Otrio this is the game. You block by size, so "can Bo still play a large?"
 * decides most turns, and a HUD that hides it behind a tap has hidden the
 * strategy. Every player's tray is therefore on screen permanently, for all
 * four players, on a 360px phone.
 *
 * Each card is a colour band, one or two colour badges, a short name, a
 * connection mark, and one `ReserveTray` per colour the seat plays. A tray is
 * three ring glyphs, each with its remaining count beside it. From 1024px the
 * rail docks into a column beside the board instead.
 *
 * This paragraph used to describe a 3x3 block of nine pips per colour and argue
 * that counting pips beats reading a digit — a card that was replaced by the
 * ring-and-count trays above, leaving the comment recommending the opposite of
 * what ships. It also carried a "four cards at ~74px" budget. **That figure is
 * gone rather than updated: it measured the pip card, and no one has measured
 * the current one.** Two agents quoted it as a current width on 2026-09-24 and
 * both published wrong arithmetic from it. If you need a per-card width, take
 * it off a frame and say which frame.
 *
 * Tapping a card opens the detail sheet -- full name, connection, latency --
 * so nothing is lost by the compact form, it is just one tap away.
 */
export function PlayerRail() {
  const room = useNet((s) => s.room);
  const selfId = useNet((s) => s.playerId);
  const openSheet = useUi((s) => s.openSheet);
  const sizeLabels = usePrefs((s) => s.sizeLabels);

  const players = playersBySeat(room);
  const turn = room?.game?.turn ?? null;
  if (!room || players.length === 0) return null;

  return (
    <section className="o-rail" aria-labelledby="rail-heading">
      <h2 className="u-visually-hidden" id="rail-heading">
        Players and rings left
      </h2>
      <ul className="o-rail__list">
        {players.map((player) => (
          <PlayerCard
            key={player.playerId}
            player={player}
            isSelf={player.playerId === selfId}
            isTurn={room.phase === 'playing' && turn === player.seat && !player.forfeited}
            isHost={player.playerId === room.hostPlayerId}
            showLetters={sizeLabels}
            colours={coloursOfSeat(room, player.seat)}
            due={room.phase === 'playing' && turn === player.seat ? dueColour(room) : null}
            trays={reservesOfSeat(room, player.seat)}
            total={totalRemainingForSeat(room, player.seat)}
            onOpen={() => openSheet('players')}
          />
        ))}
      </ul>
    </section>
  );
}

function PlayerCard({
  player,
  isSelf,
  isTurn,
  isHost,
  showLetters,
  colours,
  due,
  trays,
  total,
  onOpen,
}: {
  player: PlayerView;
  isSelf: boolean;
  isTurn: boolean;
  isHost: boolean;
  showLetters: boolean;
  /** Colours this seat plays. Two in the official 2-player game. */
  colours: PlayerColor[];
  /** The colour due this turn, when this seat is to move. */
  due: PlayerColor | null;
  /** One tray per colour this seat plays. */
  trays: Array<{ colour: PlayerColor; reserve: Reserve }>;
  /** Rings left across every colour they play. */
  total: number;
  onOpen: () => void;
}) {
  // Per colour, because in a two-player game "7 left" across two colours is a
  // number you cannot act on -- what matters is 3 purple and 4 green.
  const summary = trays
    .map(({ colour, reserve }) =>
      `${colourLabel(colour)} ${PIECE_SIZES.map((s) => `${reserve[s]} ${s}`).join(', ')}`,
    )
    .join('; ');

  return (
    <li className="o-rail__item">
      {/*
        A real button: the card is tappable, so it must be reachable by keyboard
        and announce what activating it does. The accessible name is the whole
        card's meaning in one sentence, because a screen reader user should not
        have to assemble it from five nested spans.
      */}
      <button
        type="button"
        className={cx(
          'o-pcard',
          isSelf && 'is-self',
          isTurn && 'is-turn',
          player.forfeited && 'is-gone',
          player.connection !== 'online' && 'is-away',
          colourClass(due ?? colours[0] ?? null),
        )}
        onClick={onOpen}
        aria-label={[
          seatIdentityText(colours, player.name),
          due !== null && colours.length > 1 ? `${colourLabel(due)} due now` : null,
          isSelf ? 'you' : null,
          isHost ? 'host' : null,
          isTurn ? 'to move now' : null,
          `${total} rings left: ${summary}`,
          player.forfeited
            ? 'has left the game'
            : player.connection === 'reconnecting'
              ? 'reconnecting'
              : player.connection === 'offline'
                ? 'offline'
                : null,
        ]
          .filter(Boolean)
          .join('. ')}
      >
        <span className="o-pcard__top">
          {/*
            A two-colour seat gets both swatches, with the due one lit. That is
            the only place on a compact card where the 2-player variant is
            visible at a glance.
          */}
          <span className="o-pcard__badges">
            {colours.map((c) => (
              <span
                key={c}
                className={cx('o-pcard__badge', due === c && 'is-due', due !== null && due !== c && 'is-idle')}
              >
                <ColourBadge colour={c} size="sm" />
              </span>
            ))}
          </span>
          <span className="o-pcard__name">{player.name}</span>
          <ConnectionDot
            connection={player.connection}
            forfeited={player.forfeited}
            rttMs={player.rttMs}
            name={player.name}
          />
        </span>
        <span className="o-pcard__trays">
          {trays.map(({ colour, reserve }) => (
            <ReserveTray
              key={colour}
              reserve={reserve}
              colour={colour}
              size="sm"
              showLetters={showLetters}
              label={colours.length > 1 ? `${player.name}, ${colourLabel(colour)}` : player.name}
            />
          ))}
        </span>
        {isSelf ? <span className="o-pcard__you">You</span> : null}
      </button>
    </li>
  );
}

/**
 * The expanded view, shown in a sheet. Everything the compact card had to drop:
 * full names that would otherwise truncate, latency, host badge, and the
 * numeric reserve for people who would rather read a number than count pips.
 */
export function PlayerDetails() {
  const room = useNet((s) => s.room);
  const selfId = useNet((s) => s.playerId);
  const players = playersBySeat(room);
  if (!room) return null;

  return (
    <ul className="o-plist">
      {players.map((player) => {
        const trays = reservesOfSeat(room, player.seat);
        return (
          <li
            className={cx('o-plist__item', colourClass(player.colors[0] ?? null))}
            key={player.playerId}
          >
            <span className="o-seat__badges">
              {player.colors.length > 0 ? (
                player.colors.map((c) => <ColourBadge key={c} colour={c} />)
              ) : (
                <ColourBadge colour={null} />
              )}
            </span>
            <div className="o-plist__body">
              <p className="o-plist__name">
                {player.name}
                {player.playerId === selfId ? <span className="o-plist__tag">you</span> : null}
                {player.playerId === room.hostPlayerId ? (
                  <span className="o-plist__tag">host</span>
                ) : null}
              </p>
              <p className="o-plist__meta">
                {player.colors.length > 0
                  ? player.colors.map((c) => colourLabel(c)).join(' and ')
                  : `Seat ${player.seat + 1}`}
              </p>
              {trays.map(({ colour, reserve }) => (
                <p className="o-plist__counts" key={colour}>
                  {trays.length > 1 ? (
                    <span className="o-plist__countColour">{colourLabel(colour)}</span>
                  ) : null}
                  {PIECE_SIZES.map((size) => (
                    <span key={size} className="o-plist__count">
                      <span className="o-plist__countValue u-tabular">{reserve[size]}</span>
                      <span className="o-plist__countLabel">{size}</span>
                    </span>
                  ))}
                </p>
              ))}
            </div>
            <ConnectionDot
              connection={player.connection}
              forfeited={player.forfeited}
              rttMs={player.rttMs}
              name={player.name}
              showLatency
            />
          </li>
        );
      })}
      {room.spectators.length > 0 ? (
        <li className="o-plist__spectators">
          <p className="o-plist__meta">
            Watching: {room.spectators.map((s) => s.name).join(', ')}
          </p>
        </li>
      ) : null}
    </ul>
  );
}
