import type { ConnectionState } from '../../net/protocol';
import { gradeQuality } from '../../net/transport';
import { describePeer, describeQuality } from '../lib/copy';

/**
 * Per-player connection indicator.
 *
 * Three states, three *shapes* as well as three colours -- a filled dot, a
 * hollow pulsing ring, a crossed circle -- because a 6px coloured dot is
 * exactly the kind of thing that disappears for a colour-blind player, and
 * "why is Sam not moving" is a question everyone at the table asks.
 *
 * `title` carries the detail on hover; the accessible name always spells it
 * out, including latency when we have it, so a screen reader user can tell
 * "thinking" from "gone".
 */
export function ConnectionDot({
  connection,
  forfeited,
  rttMs,
  name,
  showLatency = false,
}: {
  connection: ConnectionState;
  forfeited: boolean;
  rttMs: number | null;
  name: string;
  showLatency?: boolean;
}) {
  const peer = describePeer(connection, forfeited);
  const quality = describeQuality(gradeQuality(rttMs), rttMs);
  const state = forfeited ? 'gone' : connection;
  const detail =
    connection === 'online' && !forfeited ? `${name}: ${quality}` : `${name}: ${peer.label}`;

  return (
    <span className={`o-conn o-conn--${state}`} title={detail}>
      <span className="o-conn__mark" aria-hidden="true">
        {state === 'online' ? <DotIcon /> : null}
        {state === 'reconnecting' ? <PulseIcon /> : null}
        {state === 'offline' || state === 'gone' ? <GoneIcon /> : null}
      </span>
      {showLatency && rttMs !== null && connection === 'online' ? (
        <span className="o-conn__ms u-tabular" aria-hidden="true">
          {Math.round(rttMs)}
        </span>
      ) : null}
      <span className="u-visually-hidden">{detail}</span>
    </span>
  );
}

function DotIcon() {
  return (
    <svg viewBox="0 0 16 16" className="o-icon" focusable="false">
      <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="o-icon o-conn__pulse" focusable="false">
      <circle cx="8" cy="8" r="4" fill="none" />
      <circle cx="8" cy="8" r="6.5" fill="none" className="o-conn__halo" />
    </svg>
  );
}

function GoneIcon() {
  return (
    <svg viewBox="0 0 16 16" className="o-icon" focusable="false">
      <circle cx="8" cy="8" r="5" fill="none" />
      <path d="M4.8 4.8 11.2 11.2" />
    </svg>
  );
}
