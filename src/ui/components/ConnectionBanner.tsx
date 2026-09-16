import { useEffect, useState } from 'react';

import { msUntil, playerById, useNet, useTransportHolder } from '../../store';
import { describeLink, describePause, formatCountdown } from '../lib/copy';
import { Spinner } from './primitives';

/**
 * The strip that explains what the network is doing.
 *
 * Design brief, restated: in a four-phone game, dropping and reconnecting is
 * not an edge case, it is Tuesday. So this is built to be *legible rather than
 * alarming*:
 *
 *  - It only appears when there is something to say. A healthy link renders
 *    nothing at all, so its presence is itself information.
 *  - Reconnecting is a "working on it" tone, not an error tone, and the board
 *    stays on screen underneath.
 *  - Waiting for someone else names them and counts down to the point where the
 *    referee will give up, so nobody has to guess whether the game is stuck.
 *  - Only a genuinely terminal state (`failed`) is styled as bad news.
 */
export function ConnectionBanner() {
  const status = useNet((s) => s.status);
  const room = useNet((s) => s.room);
  const clockOffset = useNet((s) => s.quality.clockOffsetMs);
  const configured = useTransportHolder((s) => s.configured);
  const bootError = useTransportHolder((s) => s.bootError);

  // No networking backend compiled into this build: say so plainly rather than
  // pretending to connect forever.
  if (!configured) {
    return (
      <div className="o-banner o-banner--bad" role="status">
        <span className="o-banner__text">
          {bootError ?? 'Networking is not available in this build, so multiplayer is switched off.'}
        </span>
      </div>
    );
  }

  const pause = room?.pause ?? null;
  if (pause) {
    const names = pause.waitingFor
      .map((id) => playerById(room, id)?.name)
      .filter((n): n is string => Boolean(n));
    return (
      <div className="o-banner o-banner--warn" role="status">
        <Spinner />
        <span className="o-banner__text">{describePause(pause.reason, names)}</span>
        {pause.resumesAt !== null ? (
          <Countdown deadline={pause.resumesAt} clockOffset={clockOffset} />
        ) : null}
      </div>
    );
  }

  const link = describeLink(status);
  if (!link.banner) return null;

  return (
    <div className={`o-banner o-banner--${link.tone}`} role="status">
      {link.tone === 'busy' || link.tone === 'warn' ? <Spinner /> : null}
      <span className="o-banner__text">{link.detail}</span>
    </div>
  );
}

/**
 * A ticking countdown, isolated in its own component.
 *
 * It re-renders once a second; keeping it separate means that second-by-second
 * churn never reaches the banner's siblings, let alone the 3D canvas. The
 * deadline itself comes from the referee and is corrected for clock skew --
 * a phone whose clock is a minute fast must not render every deadline as
 * already expired.
 */
function Countdown({ deadline, clockOffset }: { deadline: number; clockOffset: number | null }) {
  const [remaining, setRemaining] = useState(() => msUntil(deadline, clockOffset));

  useEffect(() => {
    setRemaining(msUntil(deadline, clockOffset));
    const id = setInterval(() => setRemaining(msUntil(deadline, clockOffset)), 1000);
    return () => clearInterval(id);
  }, [deadline, clockOffset]);

  if (remaining === null) return null;
  return (
    <span className="o-banner__countdown u-tabular" aria-hidden="true">
      {formatCountdown(remaining)}
    </span>
  );
}
