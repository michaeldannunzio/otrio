import { PIECE_SIZES } from '../../net/protocol';
import type { PieceSize, Reserve, Seat } from '../../net/protocol';
import { PLAYERS } from '../../styles/tokens';
import { SIZE_INITIAL, SIZE_LABEL } from '../lib/copy';

/**
 * The visual vocabulary for pieces, shared by the reserve trays, the size
 * picker and the text board so that "a large red ring" looks like the same
 * thing everywhere in the 2D layer.
 *
 * Three channels carry player identity, because one is never enough:
 *   - hue, from `--player-N`
 *   - a glyph (circle / triangle / square / diamond) from `PLAYERS[n].glyph`,
 *     which survives total colour blindness and a sun-washed phone screen
 *   - the name, spelled out
 * and two carry ring size: diameter, and an optional S/M/L letter that the
 * player can switch on in settings.
 */

/** `seat` 0-3 maps onto token players 1-4. Anything else falls back to neutral. */
export function seatTokenIndex(seat: Seat | null | undefined): 0 | 1 | 2 | 3 | null {
  if (seat === 0 || seat === 1 || seat === 2 || seat === 3) return seat;
  return null;
}

/**
 * Scope a subtree to one player's colours.
 *
 * `src/styles/utilities.css` already owns this mechanism: putting `u-player-2`
 * on a container rebinds `--player-current`, `--player-current-ui` and friends
 * for everything inside, so components never name a specific player. We consume
 * that rather than inventing a parallel set of inline custom properties.
 *
 * Returns `''` for an unseated slot, which leaves `--player-current` at its
 * neutral default from `tokens.css`.
 */
export function seatClass(seat: Seat | null | undefined): string {
  const i = seatTokenIndex(seat);
  return i === null ? '' : `u-player-${i + 1}`;
}

/** Join class names, dropping the empty ones. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** The non-colour identity glyph and its accessible name. */
export function seatGlyph(seat: Seat | null | undefined): { glyph: string; label: string } {
  const i = seatTokenIndex(seat);
  if (i === null) return { glyph: '○', label: 'no colour' };
  return { glyph: PLAYERS[i].glyph, label: PLAYERS[i].glyphLabel };
}

/** Default colour name, used before anyone has typed a name. */
export function seatColorName(seat: Seat | null | undefined): string {
  const i = seatTokenIndex(seat);
  return i === null ? 'Unseated' : PLAYERS[i].label;
}

/* -------------------------------------------------------------------------- *
 * A single ring
 * -------------------------------------------------------------------------- */

const RADIUS: Record<PieceSize, number> = { small: 5.5, medium: 8.5, large: 11.5 };

export function RingGlyph({
  size,
  state = 'held',
  showLetter = false,
  className,
}: {
  size: PieceSize;
  /** `held` = still in the tray, `spent` = already played, `ghost` = preview. */
  state?: 'held' | 'spent' | 'ghost';
  showLetter?: boolean;
  className?: string;
}) {
  const r = RADIUS[size];
  return (
    <svg
      className={['o-ring', `o-ring--${state}`, className ?? ''].filter(Boolean).join(' ')}
      viewBox="0 0 28 28"
      // Decorative: every place this is used supplies its own text alternative,
      // and a per-ring label would make a tray of nine announce nine times.
      aria-hidden="true"
      focusable="false"
    >
      <circle className="o-ring__stroke" cx="14" cy="14" r={r} />
      {showLetter ? (
        <text className="o-ring__letter" x="14" y="14" dominantBaseline="central" textAnchor="middle">
          {SIZE_INITIAL[size]}
        </text>
      ) : null}
    </svg>
  );
}

/* -------------------------------------------------------------------------- *
 * Reserve tray
 * -------------------------------------------------------------------------- */

/**
 * How many rings of each size a player still holds.
 *
 * This is the single most strategically important thing on screen after the
 * board itself -- in Otrio you block by size, and "can Bo still play a large?"
 * decides most turns. So it is shown for *everyone*, always, as three columns
 * of three pips rather than as numbers: three marks can be counted at a glance
 * from across a table, where "2" has to be read.
 *
 * The numeric form is what the screen reader gets, because counting pips is
 * exactly the wrong job for a screen reader.
 */
export function ReserveTray({
  reserve,
  seat,
  showLetters = false,
  size = 'md',
  label,
}: {
  reserve: Reserve;
  seat: Seat | null;
  showLetters?: boolean;
  size?: 'sm' | 'md';
  /** Who this tray belongs to, for the accessible summary. */
  label?: string;
}) {
  const summary = PIECE_SIZES.map((s) => `${reserve[s]} ${s}`).join(', ');
  return (
    <div
      className={cx(`o-tray o-tray--${size}`, seatClass(seat))}
      role="img"
      aria-label={label ? `${label}: ${summary} rings left` : `${summary} rings left`}
    >
      {PIECE_SIZES.map((pieceSize) => (
        <div className="o-tray__col" key={pieceSize}>
          {[0, 1, 2].map((i) => (
            <RingGlyph
              key={i}
              size={pieceSize}
              state={i < reserve[pieceSize] ? 'held' : 'spent'}
              showLetter={showLetters && i === 0}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Seat badge
 * -------------------------------------------------------------------------- */

/** Colour swatch plus identity glyph. Never used without a name next to it. */
export function SeatBadge({
  seat,
  size = 'md',
}: {
  seat: Seat | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const { glyph } = seatGlyph(seat);
  return (
    <span className={cx(`o-seatbadge o-seatbadge--${size}`, seatClass(seat))} aria-hidden="true">
      {glyph}
    </span>
  );
}

/** Full accessible description of a seat's identity, for labels. */
export function seatIdentityText(seat: Seat | null, name?: string): string {
  const { label } = seatGlyph(seat);
  const colour = seatColorName(seat);
  return name ? `${name}, ${colour} ${label}` : `${colour} ${label}`;
}

export { SIZE_LABEL };

/**
 * Colour-facing aliases.
 *
 * `Seat` and `ColourId` are both 0-3 indices into the same four-entry token
 * palette, so the styling helpers are literally the same function. They are
 * aliased rather than reused under the seat name so that call sites dealing
 * with the two-player variant -- where a seat owns *two* colours and the two
 * concepts genuinely diverge -- read correctly.
 */
export const colourClass = seatClass;
export const colourGlyph = seatGlyph;
export const colourName = seatColorName;
