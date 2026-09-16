import { PIECE_SIZES } from '../../net/protocol';
import { RingGlyph } from './Ring';

/**
 * The three ways to win, and the one rule people get wrong.
 *
 * This existed only as a collapsed `<details>` on the home screen, which is
 * unreachable the moment a game starts — i.e. unreachable at exactly the moment
 * someone asks "wait, how do you win?". Now it is a component so the same words
 * can appear in both places.
 *
 * Deliberately short. It is a reminder for someone mid-game, not a rulebook;
 * `docs/RULES.md` is the rulebook. The ordering is by how often people miss the
 * condition, not by how the rules sheet lists them — the small-medium-large line
 * is the one players routinely complete without noticing.
 */
export function HowToPlay({ twoPlayer = false }: { twoPlayer?: boolean }) {
  return (
    <div className="o-rules">
      <p className="o-rules__lead">
        On your turn you place exactly one ring. Rings never move once placed.
      </p>

      <h3 className="o-rules__subheading">Three ways to win</h3>
      <ul className="o-rules__list">
        <li>
          <span className="o-rules__icon" aria-hidden="true">
            {PIECE_SIZES.map((size) => (
              <RingGlyph key={size} size="medium" />
            ))}
          </span>
          <span>
            <strong>Three of a size</strong> in a row, column or diagonal — all small,
            all medium or all large.
          </span>
        </li>
        <li>
          <span className="o-rules__icon" aria-hidden="true">
            {PIECE_SIZES.map((size) => (
              <RingGlyph key={size} size={size} />
            ))}
          </span>
          <span>
            <strong>Small, medium, large in a line</strong> — growing or shrinking, either
            direction counts. This is the one people finish without noticing.
          </span>
        </li>
        <li>
          <span className="o-rules__icon o-rules__icon--nested" aria-hidden="true">
            {PIECE_SIZES.map((size) => (
              <RingGlyph key={size} size={size} />
            ))}
          </span>
          <span>
            <strong>All three sizes nested</strong> in one space.
          </span>
        </li>
      </ul>

      <h3 className="o-rules__subheading">Worth knowing</h3>
      <ul className="o-rules__list o-rules__list--plain">
        <li>A line has to be all one colour. Two of yours and one of a partner&rsquo;s is not a win.</li>
        <li>
          Each space holds one ring of each size, so three different colours can share a
          space.
        </li>
        <li>If you cannot place anything, your turn is skipped — that is a real rule, not a bug.</li>
        {twoPlayer ? (
          <li>
            <strong>You play two colours</strong> and must switch between them every turn. You can
            win with either, but they never combine.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
