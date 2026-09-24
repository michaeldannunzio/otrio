import { useEffect, useRef } from 'react';

import {
  colourLabel,
  dueColour,
  handoffPendingFor,
  playerBySeat,
  seatAlternates,
  settleOpeningSeat,
  takeDevice,
  ui,
  useNet,
  useUi,
} from '../../store';
import { Button } from '../components/primitives';
import { ColourBadge, colourClass, colourGlyph, cx } from '../components/Ring';

/**
 * The handoff: the moment the phone changes hands.
 *
 * This is the one genuinely new piece of interface in offline mode, and it
 * exists for one reason. `docs/RULES.md` 4.3 is `[OFFICIAL]` and absolute --
 * once a piece is placed it cannot be moved, there is no capture and no undo.
 * So the player who has just moved is still holding the phone and is one tap
 * away from making an irreversible move on behalf of the next player, with no
 * recovery path in the rules or in the code. Nothing online can fail that way,
 * and it is the entire justification for spending a tap a turn.
 *
 * It is NOT about secrecy. Otrio has no hidden information -- the board is
 * public and everyone has been watching it -- so this hides nothing, and the
 * design follows from that:
 *
 *  - **It sits in the bottom third and leaves the 3x3 clear** (Arthur's
 *    amendment, docs/UX.md). It covers the player rail and the size picker,
 *    which are useless to the incoming player until they start anyway. The
 *    thing they actually need is time to read a position of up to 27 pieces
 *    that they last looked at three turns ago -- so a full-screen interstitial
 *    would spend the one resource it was supposed to protect. It also costs
 *    nothing persistent: it is transient and sits where the HUD already is.
 *  - **It never auto-dismisses and has no timer.** The deliberate contrast is
 *    `ColourReveal`, which auto-dismisses after 6000 ms -- right there, wrong
 *    here. The dismissal *is* the handoff, and a timer that fires while the
 *    phone is still crossing the table has protected nothing while looking
 *    like it did.
 *  - **It is not a focus trap and not `aria-modal`.** The board stays readable
 *    to a screen-reader user for the same reason it stays visible to everyone
 *    else. The real gate is in `placePiece`, which is what makes that safe.
 *
 * Why the gate is in the action and not in this component's pointer-events:
 * `TextBoard` is always in the DOM and always in the tab order, so a visual
 * cover is defeated by Tab then Enter. One gate in `placePiece` covers the 3D
 * tap, the flat board and the keyboard alike.
 */
export function PassDevice() {
  const room = useNet((s) => s.room);
  const deviceHeldBy = useUi((s) => s.deviceHeldBy);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const waitingFor = handoffPendingFor(room, deviceHeldBy);
  const incoming = playerBySeat(room, waitingFor);
  const due = dueColour(room);
  const alternates = waitingFor === null ? false : seatAlternates(room, waitingFor);

  // The opening turn is not a handoff: nobody has passed anything yet, and
  // `ColourReveal` has already named the opener. Recording it here rather than
  // gating it is what makes `deviceHeldBy === null` mean "no turn has settled".
  const phase = room?.game?.phase ?? null;
  useEffect(() => {
    if (phase === 'playing') settleOpeningSeat();
  }, [phase]);

  /*
   * Speak the pass, assertively.
   *
   * In hot seat the screen-reader user is the person holding the phone the
   * whole game, so interrupting is right here in a way it would not be online.
   * This REPLACES the banner's "Your turn" rather than joining it --
   * `TurnBanner` does not announce at all in local mode, so there is one owner
   * per moment: the reveal opens, this speaks every handoff, the banner speaks
   * online only.
   *
   * Keyed on the seat alone. The panel's other inputs are fresh objects on most
   * renders and would re-fire this on every one.
   */
  const spokenFor = useRef<number | null>(null);
  useEffect(() => {
    if (waitingFor === null) {
      spokenFor.current = null;
      return;
    }
    if (spokenFor.current === waitingFor) return;
    spokenFor.current = waitingFor;
    const name = incoming?.name ?? 'the next player';
    const colour = due !== null ? ` ${name} plays ${colourLabel(due).toLowerCase()}.` : '';
    ui.announce(`Pass the phone to ${name}.${colour}`, 'assertive');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed
    // on the seat only; see above.
  }, [waitingFor]);

  // Put the keyboard on the one control that clears the gate. Without this a
  // keyboard user's next Tab lands on `TextBoard`, where every placement is
  // correctly refused by `placePiece` and they have no visible way forward.
  useEffect(() => {
    if (waitingFor !== null) buttonRef.current?.focus();
  }, [waitingFor]);

  if (waitingFor === null || !incoming) return null;

  const glyph = colourGlyph(due ?? incoming.colors[0] ?? null);

  return (
    <div className={cx('o-pass', colourClass(due ?? incoming.colors[0] ?? null))}>
      <div className="o-pass__panel">
        <p className="o-pass__who">
          <ColourBadge colour={due ?? incoming.colors[0] ?? null} size="lg" />
          <span className="o-pass__name">{incoming.name}</span>
        </p>
        <p className="o-pass__instruction">Pass the phone to {incoming.name}</p>

        {/*
          Which colour is due, for the 2-player game only. Under strict
          alternation "you are purple and green" is not an instruction and
          "play green" is -- the same reason `alternationNote()` exists, and the
          incoming player is about to be told they may not make a move they can
          plainly see.
        */}
        {alternates && due !== null ? (
          <p className="o-pass__due">
            <span className={cx('o-pass__dueChip', colourClass(due))}>{colourLabel(due)}</span>
            <span> this turn</span>
          </p>
        ) : null}

        <Button ref={buttonRef} variant="primary" size="lg" block onClick={takeDevice}>
          I&rsquo;m {incoming.name} — start my turn
        </Button>

        {/*
          The spoken version has already gone out assertively above, so this
          panel does not need to be a live region as well. `aria-hidden` on the
          glyph for the same reason it is hidden on every other badge: it is a
          second channel for colour, not a second name.
        */}
        <span className="u-visually-hidden">{glyph.label}</span>
      </div>
    </div>
  );
}
