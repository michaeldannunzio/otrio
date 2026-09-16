import { useEffect, useRef, useState } from 'react';

import {
  coloursOfSeat,
  colourLabel,
  dueColour,
  playersBySeat,
  ui,
  useNet,
  useUi,
} from '../../store';
import type { PlayerColor } from '../../net/protocol';
import { joinNames } from '../lib/copy';
import { Button } from '../components/primitives';
import { ColourBadge, colourClass, colourGlyph, cx } from '../components/Ring';

/**
 * Who you are, shown once, at the only moment it is knowable.
 *
 * Nothing in this product ever told a player their colour. The lobby
 * deliberately cannot (colours are dealt at start), the game begins, the live
 * region says "The game has started", and from there a player reverse-engineers
 * their own identity by finding the YOU label in the rail and matching its
 * badge against the board. Meanwhile the first player is genuinely randomised
 * per RULES.md §4.8 — which is correct, and precisely why it has to be stated
 * rather than inferred.
 *
 * So: one short beat between the lobby and the board. It is the difference
 * between the game starting and the game starting *for you*.
 *
 * Three constraints shaped it:
 *
 *  - **Skippable**, and never blocking. The game is already running underneath;
 *    this is an overlay over a live board, not a gate in front of it.
 *  - **Once per room.** A rematch keeps seats and colours, so there is nothing
 *    to learn the second time and a beat there would just be a delay.
 *  - **No focus trap.** It auto-dismisses, and a trap that grabs focus and then
 *    releases it on a timer takes the keyboard away mid-action. Screen reader
 *    users get the same content through the assertive live region instead,
 *    which is the channel that already carries "your turn" and "you win".
 */
export function ColourReveal() {
  const room = useNet((s) => s.room);
  const seat = useNet((s) => s.seat);
  const role = useNet((s) => s.role);

  const shownFor = useUi((s) => s.revealShownFor);
  const setShownFor = useUi((s) => s.setRevealShownFor);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const code = room?.code ?? null;
  const playing = room?.phase === 'playing';
  const mine = seat === null ? [] : coloursOfSeat(room, seat);
  const first = dueColour(room);

  /*
   * Decide whether to show. Deliberately depends only on scalars.
   *
   * An earlier version also depended on `mine` and `room`, which are a fresh
   * array and a fresh object on most renders — so the effect re-ran constantly,
   * its cleanup cleared the auto-dismiss timer, and the re-run then returned
   * early at the guard without setting a new one. The overlay would have sat
   * there forever. The timer now lives in its own effect keyed on `visible`,
   * which is the only thing it actually depends on.
   */
  const hasColours = mine.length > 0;
  useEffect(() => {
    if (!playing || !code || shownFor === code) return;
    // Colours are only real once the referee has dealt them.
    if (!hasColours && role === 'player') return;

    setShownFor(code);
    setVisible(true);

    const names = playersBySeat(room)
      .filter((p) => p.seat !== seat)
      .map((p) => `${p.name} is ${p.colors.map((c) => colourLabel(c)).join(' and ')}`);
    const yours = hasColours
      ? `You are ${mine.map((c) => colourLabel(c)).join(' and ')}.`
      : 'You are watching.';
    const opener = first !== null ? ` ${colourLabel(first)} goes first.` : '';
    ui.announce(`${yours} ${joinNames(names)}.${opener}`, 'assertive');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // scalar-only: see the comment above. Re-running on every new array or room
    // object identity is what broke the dismiss timer.
  }, [playing, code, shownFor, setShownFor, hasColours, role]);

  // Auto-dismiss, owned separately so nothing else can cancel it.
  useEffect(() => {
    if (!visible) return;
    timer.current = setTimeout(() => setVisible(false), 6000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') setVisible(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  if (!visible || !room) return null;

  const others = playersBySeat(room).filter((p) => p.seat !== seat);
  const youFirst = first !== null && mine.includes(first);

  return (
    <div
      className="o-reveal"
      // Not a dialog: it is not modal and it takes no focus. The spoken version
      // has already gone out through the live region.
      role="presentation"
      onPointerDown={() => setVisible(false)}
    >
      <div className="o-reveal__panel">
        <ArmsDiagram mine={mine} first={first} />

        {mine.length > 0 ? (
          <p className={cx('o-reveal__you', colourClass(mine[0]))}>
            <span className="o-reveal__youLabel">You are</span>
            <span className="o-reveal__colours">
              {mine.map((c) => (
                <span key={c} className={cx('o-reveal__colour', colourClass(c))}>
                  <ColourBadge colour={c} size="lg" />
                  {colourLabel(c)}
                </span>
              ))}
            </span>
            {mine.length > 1 ? (
              <span className="o-reveal__note">
                Two colours — you switch between them every turn.
              </span>
            ) : null}
          </p>
        ) : (
          <p className="o-reveal__you">
            <span className="o-reveal__youLabel">You are watching</span>
          </p>
        )}

        {others.length > 0 ? (
          <ul className="o-reveal__others">
            {others.map((p) => (
              <li key={p.playerId} className={cx(colourClass(p.colors[0] ?? null))}>
                {p.colors.map((c) => (
                  <ColourBadge key={c} colour={c} size="sm" />
                ))}
                <span className="o-reveal__otherName">{p.name}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {first !== null ? (
          <p className={cx('o-reveal__first', colourClass(first))}>
            {youFirst ? 'You go first' : `${colourLabel(first)} goes first`}
          </p>
        ) : null}

        <Button variant="primary" onClick={() => setVisible(false)}>
          Start playing
        </Button>
      </div>
    </div>
  );
}

/**
 * The board's four arms, so the colour maps to a *place* and not just a word.
 *
 * Fixed by the rulebook artwork: purple north, red east, green south, blue
 * west. The local player's arm is the one nearest the camera in 3D, so showing
 * which arm is theirs is the fastest way to connect "I am purple" to "that side
 * of the board is mine".
 */
function ArmsDiagram({ mine, first }: { mine: PlayerColor[]; first: PlayerColor | null }) {
  const arms: Array<{ colour: PlayerColor; x: number; y: number; w: number; h: number }> = [
    { colour: 0, x: 26, y: 2, w: 20, h: 18 },
    { colour: 1, x: 52, y: 26, w: 18, h: 20 },
    { colour: 2, x: 26, y: 52, w: 20, h: 18 },
    { colour: 3, x: 2, y: 26, w: 18, h: 20 },
  ];
  return (
    <svg className="o-reveal__arms" viewBox="0 0 72 72" aria-hidden="true" focusable="false">
      <rect className="o-reveal__grid" x="24" y="24" width="24" height="24" rx="2" />
      {arms.map((arm) => (
        <rect
          key={arm.colour}
          className={cx(
            'o-reveal__arm',
            colourClass(arm.colour),
            mine.includes(arm.colour) && 'is-mine',
            first === arm.colour && 'is-first',
          )}
          x={arm.x}
          y={arm.y}
          width={arm.w}
          height={arm.h}
          rx="2"
        />
      ))}
      {arms
        .filter((a) => mine.includes(a.colour))
        .map((a) => (
          <text
            key={`me-${a.colour}`}
            className="o-reveal__armMark"
            x={a.x + a.w / 2}
            y={a.y + a.h / 2}
            dominantBaseline="central"
            textAnchor="middle"
          >
            {colourGlyph(a.colour).glyph}
          </text>
        ))}
    </svg>
  );
}
