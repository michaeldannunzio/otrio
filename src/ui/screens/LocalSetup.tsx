import { useState } from 'react';

import {
  colourLabel,
  firstColourOfSeat,
  secondColourIfTwoPlay,
  startLocalGame,
  useUi,
} from '../../store';
import {
  ALL_SEATS,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  sanitizeName,
} from '../../net/protocol';
import type { Seat } from '../../net/protocol';
import { describeWireError } from '../lib/copy';
import { Button, Card, Field, Segmented } from '../components/primitives';
import { ColourBadge } from '../components/Ring';

/**
 * Setting up a game for people sharing one device.
 *
 * Everything an online room discovers over time -- who is here, what they are
 * called, how many are playing -- is known on this screen before the game
 * exists, because the people are all in the room. So this asks for all of it at
 * once and then starts, with no lobby in between (Bob, 2026-09-24); there is
 * nobody to wait for and a ready-up screen would be a button that only says
 * "yes, still me".
 *
 * WHY THE COLOURS ARE SHOWN HERE AND NOT IN THE ONLINE LOBBY
 * ---------------------------------------------------------
 * `LobbyScreen` deliberately shows seat numbers and no colours, because how
 * many colours a seat gets depends on the final player count and the lobby
 * cannot know it. That reasoning does not carry over: the count is chosen on
 * this very screen, two fields up. The fact is not unknowable, it was only
 * unknowable *from there* -- so this screen names both colours outright rather
 * than inheriting a hedge that was never about this situation.
 *
 * That matters most at two players, where each person runs two opposite colours
 * and alternates every turn (docs/RULES.md 4.6). Labelling seat 0 "Purple" and
 * stopping would be true and half the story, and the half it omits is the half
 * that decides the game.
 */
export function LocalSetup() {
  const setEntry = useUi((s) => s.setEntry);

  /*
   * INVENTED DEFAULT, stated per house rule 8: nothing in the brief or in
   * docs/RULES.md says what player count a pass-and-play game should open on.
   * The online create screen opens on 4. This opens on 2, because passing one
   * phone is most often two people on a sofa, and because 2 is the count whose
   * rules differ (two colours each) and so the count worth showing by default.
   * Arthur's to overrule.
   */
  const [count, setCount] = useState<number>(MIN_PLAYERS);

  /*
   * All four names are kept, not just the `count` in use, so that going 4 -> 2
   * -> 4 does not silently discard what someone already typed into seats 3
   * and 4. Only the first `count` are ever submitted.
   */
  const [names, setNames] = useState<string[]>(() => ALL_SEATS.map(defaultNameForSeat));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seats = ALL_SEATS.slice(0, count);

  async function onStart() {
    setBusy(true);
    setError(null);
    // Sanitised here only to choose the *fallback*. `sanitizeName` is the
    // referee's own function, imported rather than reimplemented, so a blank
    // field becomes this seat's colour instead of the protocol's generic
    // "Player" -- which is what four blank fields would otherwise produce, four
    // times over. The referee still sanitises authoritatively afterwards.
    const chosen = seats.map((seat, i) => sanitizeName(names[i], defaultNameForSeat(seat)));
    const result = await startLocalGame(chosen);
    setBusy(false);
    if (!result.ok) {
      const copy = describeWireError(result.error);
      setError(`${copy.title}. ${copy.detail}`);
    }
    // On success there is nothing to do: the room lands in the transport
    // snapshot and `routeOf` moves the app to the board on its own.
  }

  return (
    <Card className="o-home__card">
      <h2 className="o-home__cardTitle">On this device</h2>

      <Segmented
        legend="How many players?"
        name="localPlayers"
        value={count}
        onChange={setCount}
        hint={
          count === MIN_PLAYERS
            ? 'Two players means two colours each, switching every turn.'
            : 'Everyone plays on this one device, passing it round.'
        }
        options={Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => {
          const n = MIN_PLAYERS + i;
          return { value: n, label: String(n), detail: 'players' };
        })}
      />

      <div className="o-local__seats">
        {seats.map((seat, i) => {
          const first = firstColourOfSeat(seat);
          // Only meaningful at two players, and deterministic there: the pairs
          // are fixed by the rulebook artwork and the engine never varies them.
          const second = count === MIN_PLAYERS ? secondColourIfTwoPlay(seat) : null;
          return (
            <div className="o-local__seat" key={seat}>
              <span className="o-local__seatColours">
                <ColourBadge colour={first} size="md" />
                {second !== null ? <ColourBadge colour={second} size="sm" /> : null}
              </span>
              <Field
                className="o-local__seatName"
                label={seatColourLabel(seat, second !== null)}
                value={names[i]}
                maxLength={MAX_NAME_LENGTH}
                autoComplete="off"
                enterKeyHint={i === seats.length - 1 ? 'go' : 'next'}
                data-seat-index={i}
                onChange={(e) => {
                  const next = e.currentTarget.value;
                  setNames((prev) => prev.map((n, j) => (j === i ? next : n)));
                }}
                /*
                 * Enter advances, and only submits from the last field.
                 *
                 * This used to submit from any field, which contradicted the
                 * `enterKeyHint` directly above it -- the phone keyboard shows
                 * "next" on every field but the last, and the behaviour was
                 * "go" on all of them. At four players, typing seat 1's name
                 * and pressing the key the keyboard labels "next" started the
                 * game immediately with three default names, and a placement
                 * is final. The hint and the behaviour disagreed and the
                 * behaviour was the destructive one. (Arthur found it.)
                 */
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || busy) return;
                  e.preventDefault();
                  if (i === seats.length - 1) {
                    void onStart();
                    return;
                  }
                  const form = e.currentTarget.closest('.o-local__seats');
                  const next = form?.querySelector<HTMLInputElement>(
                    `input[data-seat-index="${i + 1}"]`,
                  );
                  next?.focus();
                  next?.select();
                }}
              />
            </div>
          );
        })}
      </div>

      {error ? (
        <div role="alert">
          <p className="o-inlineError">{error}</p>
        </div>
      ) : null}

      <div className="o-home__actions">
        <Button variant="primary" size="lg" block busy={busy} disabled={busy} onClick={onStart}>
          {busy ? 'Setting up…' : 'Start playing'}
        </Button>
        <Button variant="ghost" block onClick={() => setEntry('home')} disabled={busy}>
          Back
        </Button>
      </div>
    </Card>
  );
}

/**
 * The name a seat gets if nobody types one.
 *
 * Via `firstColourOfSeat` rather than by indexing a colour array with the seat
 * number. The two agree -- seat N starts on colour N -- but writing that out
 * here would be a second statement of it, and "a seat and a colour are the same
 * thing" is the single conflation this codebase has been bitten by most.
 *
 * `colourLabel` is the owner of these four strings for the interface.
 * `PLAYERS[n].label` in `styles/tokens.ts` carries the same four and is the
 * owner of the *glyphs*; `Ring.tsx` already draws the line that way, and this
 * follows it rather than introducing a third opinion.
 */
function defaultNameForSeat(seat: Seat): string {
  return colourLabel(firstColourOfSeat(seat));
}

/**
 * The field's label: which colours this seat plays, where they sit, and what to
 * type. All three, because the label is the input's accessible name.
 *
 * It used to be the bare colour -- so a screen-reader user heard "Purple, edit
 * text, Purple" and was given no reason to think a person's name went there,
 * and a sighted user read a text box labelled with a colour and pre-filled with
 * that colour. The badge beside it already carries the colour; the label
 * carries the ask. (Arthur.)
 *
 * The side of the screen is a permanent fact only because the board is pinned
 * in local mode (`BoardStage`), which is what makes it worth learning here.
 * `SEAT_SIDES` is indexed by seat and that mapping holds for the same reason --
 * see the note on the constant.
 */
function seatColourLabel(seat: Seat, twoColours: boolean): string {
  const first = colourLabel(firstColourOfSeat(seat));
  const second = twoColours ? secondColourIfTwoPlay(seat) : null;
  const colours =
    second === null ? first : `${first} and ${colourLabel(second).toLowerCase()}`;
  return `${colours} — ${SEAT_SIDES[seat]} — who's playing?`;
}

/**
 * Where each seat's arm sits on screen, in words.
 *
 * True only because the board is pinned to SOUTH on one device, which makes
 * `boardYawForSeat` exactly 0 and leaves purple north/top, red east/right,
 * green south/bottom, blue west/left. **If the pin in `BoardStage.tsx` ever
 * moves, these four words are silently wrong and nothing fails.** Same
 * accidental agreement that the `ColourReveal` arm diagram depends on, written
 * down in both places rather than in neither.
 */
const SEAT_SIDES: Record<Seat, string> = {
  0: 'top',
  1: 'right',
  2: 'bottom',
  3: 'left',
};
