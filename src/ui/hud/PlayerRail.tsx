import { PIECE_SIZES } from '../../net/protocol';
import type { PlayerView, Reserve } from '../../net/protocol';
import {
  coloursOfSeat,
  dueColour,
  hasColourReserves,
  playersBySeat,
  reserveFor,
  reserveOfColour,
  totalReserve,
  useNet,
  usePrefs,
  useUi,
} from '../../store';
import {
  ReserveTray,
  SeatBadge,
  colourClass,
  colourName,
  cx,
  seatClass,
  seatColorName,
  seatIdentityText,
} from '../components/Ring';
import { ConnectionDot } from './ConnectionDot';

/**
 * Everyone's remaining rings, at a glance.
 *
 * In Otrio this is the game. You block by size, so "can Bo still play a large?"
 * decides most turns, and a HUD that hides it behind a tap has hidden the
 * strategy. Every player's tray is therefore on screen permanently, for all
 * four players, on a 360px phone.
 *
 * Getting that to fit: each card is a colour band, a short name, a 3x3 block of
 * pips, and a connection mark. Counting three pips is instantaneous; reading
 * "2" is not. Four cards at ~74px fit a small phone with room to spare, and on
 * a wide screen the rail becomes a column beside the board instead.
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
            reserve={reserveFor(room, player.seat)}
            isSelf={player.playerId === selfId}
            isTurn={room.phase === 'playing' && turn === player.seat && !player.forfeited}
            isHost={player.playerId === room.hostPlayerId}
            showLetters={sizeLabels}
            colours={coloursOfSeat(room, player.seat)}
            due={room.phase === 'playing' && turn === player.seat ? dueColour(room) : null}
            colourReserves={
              hasColourReserves(room)
                ? coloursOfSeat(room, player.seat).map((c) => reserveOfColour(room, c))
                : null
            }
            onOpen={() => openSheet('players')}
          />
        ))}
      </ul>
    </section>
  );
}

function PlayerCard({
  player,
  reserve,
  isSelf,
  isTurn,
  isHost,
  showLetters,
  colours,
  due,
  colourReserves,
  onOpen,
}: {
  player: PlayerView;
  reserve: Reserve;
  isSelf: boolean;
  isTurn: boolean;
  isHost: boolean;
  showLetters: boolean;
  /** Colours this seat controls. Two in the official 2-player game. */
  colours: number[];
  /** The colour due this turn, when this seat is to move and we know it. */
  due: number | null;
  /** Per-colour reserves, when the referee provides them. */
  colourReserves: Array<Reserve | null> | null;
  onOpen: () => void;
}) {
  const total = totalReserve(reserve);
  const summary = PIECE_SIZES.map((s) => `${reserve[s]} ${s}`).join(', ');

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
          due !== null ? colourClass(due) : seatClass(player.seat),
        )}
        onClick={onOpen}
        aria-label={[
          colours.length > 1
            ? `${player.name}, playing ${colours.map((c) => colourName(c)).join(' and ')}`
            : seatIdentityText(player.seat, player.name),
          due !== null && colours.length > 1 ? `${colourName(due)} due now` : null,
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
                <SeatBadge seat={c} size="sm" />
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
        {colourReserves ? (
          <span className="o-pcard__trays">
            {colours.map((c, i) => (
              <ReserveTray
                key={c}
                reserve={colourReserves[i] ?? reserve}
                seat={c}
                size="sm"
                showLetters={showLetters}
                label={`${player.name}, ${colourName(c)}`}
              />
            ))}
          </span>
        ) : (
          <ReserveTray
            reserve={reserve}
            seat={colours.length === 1 ? player.seat : null}
            size="sm"
            showLetters={showLetters}
            label={player.name}
          />
        )}
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
        const reserve = reserveFor(room, player.seat);
        return (
          <li className={cx('o-plist__item', seatClass(player.seat))} key={player.playerId}>
            <SeatBadge seat={player.seat} />
            <div className="o-plist__body">
              <p className="o-plist__name">
                {player.name}
                {player.playerId === selfId ? <span className="o-plist__tag">you</span> : null}
                {player.playerId === room.hostPlayerId ? (
                  <span className="o-plist__tag">host</span>
                ) : null}
              </p>
              <p className="o-plist__meta">{seatColorName(player.seat)}</p>
              <p className="o-plist__counts">
                {PIECE_SIZES.map((size) => (
                  <span key={size} className="o-plist__count">
                    <span className="o-plist__countValue u-tabular">{reserve[size]}</span>
                    <span className="o-plist__countLabel">{size}</span>
                  </span>
                ))}
              </p>
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
