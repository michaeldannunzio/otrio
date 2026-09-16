import { PIECE_SIZES } from '../../net/protocol';
import type { PieceSize, PlayerColor, Reserve } from '../../net/protocol';
import { colourLabel } from '../../store/colours';
import { PLAYERS } from '../../styles/tokens';
import { SIZE_INITIAL, SIZE_LABEL } from '../lib/copy';

/**
 * The visual vocabulary for pieces, shared by the reserve trays, the size
 * picker and the text board so that "a large red ring" looks like the same
 * thing everywhere in the 2D layer.
 *
 * Everything here is keyed by **colour**, never by seat. A piece belongs to a
 * colour; in the official two-player game one person owns two of them, so
 * colouring anything by seat shows the wrong colour on half the turns.
 *
 * Three channels carry colour identity, because one is never enough:
 *   - hue, from `--player-N`
 *   - a glyph (circle / triangle / square / diamond) from `PLAYERS[n].glyph`,
 *     which survives total colour blindness and a sun-washed phone screen
 *   - the name, spelled out
 * and two carry ring size: diameter, and an optional S/M/L letter that the
 * player can switch on in settings.
 */

/**
 * `PlayerColor` 0-3 maps onto token players 1-4, in the same clockwise order
 * (purple north, red east, green south, blue west). Anything else is neutral.
 */
export function colourTokenIndex(colour: PlayerColor | null | undefined): 0 | 1 | 2 | 3 | null {
  if (colour === 0 || colour === 1 || colour === 2 || colour === 3) return colour;
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
export function colourClass(colour: PlayerColor | null | undefined): string {
  const i = colourTokenIndex(colour);
  return i === null ? '' : `u-player-${i + 1}`;
}

/** Join class names, dropping the empty ones. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** The non-colour identity glyph and its accessible name. */
export function colourGlyph(colour: PlayerColor | null | undefined): { glyph: string; label: string } {
  const i = colourTokenIndex(colour);
  if (i === null) return { glyph: '○', label: 'no colour' };
  return { glyph: PLAYERS[i].glyph, label: PLAYERS[i].glyphLabel };
}

export { colourLabel };

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
  colour,
  showLetters = false,
  size = 'md',
  label,
}: {
  reserve: Reserve;
  colour: PlayerColor | null;
  showLetters?: boolean;
  size?: 'sm' | 'md';
  /** Who this tray belongs to, for the accessible summary. */
  label?: string;
}) {
  const summary = PIECE_SIZES.map((s) => `${reserve[s]} ${s}`).join(', ');
  const who = label ?? colourLabel(colour);
  return (
    <div
      className={cx(`o-tray o-tray--${size}`, colourClass(colour))}
      role="img"
      aria-label={`${who}: ${summary} rings left`}
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
export function ColourBadge({
  colour,
  size = 'md',
}: {
  colour: PlayerColor | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const { glyph } = colourGlyph(colour);
  return (
    <span className={cx(`o-seatbadge o-seatbadge--${size}`, colourClass(colour))} aria-hidden="true">
      {glyph}
    </span>
  );
}

/**
 * A seat's identity as a sentence, for accessible names.
 *
 * Takes the colours rather than the seat, because a two-player seat has two of
 * them and "Ann, red circle" would be half the truth on alternate turns.
 */
export function seatIdentityText(colours: PlayerColor[], name?: string): string {
  if (colours.length === 0) return name ?? 'Unseated';
  const parts = colours.map((c) => `${colourLabel(c)} ${colourGlyph(c).label}`);
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return name ? `${name}, ${joined}` : joined;
}

export { SIZE_LABEL };
