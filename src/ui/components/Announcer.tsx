import { useUi } from '../../store';
import type { Announcement } from '../../store';

/**
 * The app's two ARIA live regions.
 *
 * Mounted once, at the root, and never unmounted. That matters: a live region
 * added to the DOM at the same moment it gets its text is frequently missed,
 * because assistive technology watches *existing* regions for changes. Both
 * regions therefore exist from first paint and only their contents change.
 *
 * Repeats are handled by alternating between two sibling nodes. A screen reader
 * announces a region when its text content *changes*, so setting "Your turn"
 * twice in a row is silence -- which in a game where it is genuinely your turn
 * on four separate occasions is a bug, not an optimisation. Alternating nodes
 * guarantees a real change every time.
 *
 * Division of labour:
 *   - polite: turn changes, players joining and leaving, connection recovery.
 *   - assertive: your turn, and the end of the game. Nothing else. Interrupting
 *     is a cost, and a live region that interrupts constantly is a live region
 *     users switch off.
 */
function Region({
  announcement,
  urgency,
}: {
  announcement: Announcement | null;
  urgency: 'polite' | 'assertive';
}) {
  const even = (announcement?.id ?? 0) % 2 === 0;
  return (
    <div
      className="u-visually-hidden"
      aria-live={urgency}
      aria-atomic="true"
      // `role="status"` / `role="alert"` are the redundant-but-widely-supported
      // pairing for aria-live; several combinations of browser and screen
      // reader honour one and not the other.
      role={urgency === 'assertive' ? 'alert' : 'status'}
    >
      <span>{even ? (announcement?.text ?? '') : ''}</span>
      <span>{even ? '' : (announcement?.text ?? '')}</span>
    </div>
  );
}

export function Announcer() {
  const polite = useUi((s) => s.polite);
  const assertive = useUi((s) => s.assertive);
  return (
    <>
      <Region announcement={polite} urgency="polite" />
      <Region announcement={assertive} urgency="assertive" />
    </>
  );
}
