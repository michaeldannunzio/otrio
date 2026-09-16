/**
 * Every user-facing sentence in the app, in one file.
 *
 * Centralised for three reasons: tone stays consistent, the same error never
 * gets two different explanations in two components, and the wording for the
 * connection states -- which players see constantly -- can be reviewed as a set
 * rather than discovered one at a time.
 *
 * House style for this app:
 *   - Say what happened, then what to do. Never only the first.
 *   - Reserve alarming language for things that are actually lost. A dropped
 *     phone in a four-player game is Tuesday, not a failure.
 *   - Name people, not seats. "Waiting for Sam" beats "Waiting for seat 2".
 */

import { PLAYER_COLORS } from '../../net/protocol';
import type { ErrorCode, GameEndReason, PieceSize, WinningLine } from '../../net/protocol';
import type { ConnectionStatus, QualityGrade } from '../../net/transport';

/* -------------------------------------------------------------------------- *
 * Errors
 * -------------------------------------------------------------------------- */

export interface ErrorCopy {
  /** Short, shown as the heading of a toast or inline error. */
  title: string;
  /** One sentence of what to do about it. */
  detail: string;
  /** Whether offering a "Try again" button makes sense. */
  retry: boolean;
}

const ERRORS: Record<ErrorCode, ErrorCopy> = {
  NETWORK_UNAVAILABLE: {
    title: 'No connection',
    detail: 'This device is offline. Reconnect to Wi-Fi or mobile data and try again.',
    retry: true,
  },
  CONNECT_FAILED: {
    title: "Couldn't reach the game",
    detail: 'The server did not answer. It may be restarting.',
    retry: true,
  },
  CONNECTION_LOST: {
    title: 'Connection dropped',
    detail: 'Reconnecting automatically. Your seat is held for a short while.',
    retry: true,
  },
  TIMEOUT: {
    title: 'That took too long',
    detail: 'No answer came back in time. The connection may be slow.',
    retry: true,
  },
  PROTOCOL_MISMATCH: {
    title: 'This tab is out of date',
    detail: 'The game was updated while this tab was open. Reload to continue.',
    retry: false,
  },
  RATE_LIMITED: {
    title: 'Slow down a moment',
    detail: 'Too many actions at once. Wait a couple of seconds and try again.',
    retry: true,
  },

  ROOM_NOT_FOUND: {
    title: 'No room with that code',
    detail: 'Check the code and try again. Rooms also expire after a few hours.',
    retry: false,
  },
  CODE_INVALID: {
    title: "That code doesn't look right",
    detail: 'Room codes are letters and numbers only.',
    retry: false,
  },
  ROOM_FULL: {
    title: 'That room is full',
    detail: 'Every seat is taken. Ask the host to start a bigger game.',
    retry: false,
  },
  ROOM_CLOSED: {
    title: 'The room has closed',
    detail: 'Everyone left, or the host ended it. Start a new game when you are ready.',
    retry: false,
  },
  ALREADY_STARTED: {
    title: 'That game has already started',
    detail: 'You can still join to watch, if the host allowed spectators.',
    retry: false,
  },
  SEAT_TAKEN: {
    title: 'Someone else has your seat',
    detail: 'Your seat was given away. Join again to take a free one.',
    retry: false,
  },
  RECONNECT_EXPIRED: {
    title: 'You were away too long',
    detail: 'Your seat was released so the others could carry on. Rejoin to watch or take a free seat.',
    retry: false,
  },

  NOT_IN_ROOM: {
    title: 'Not in a room',
    detail: 'Create a game or join one with a code.',
    retry: false,
  },
  NOT_HOST: {
    title: 'Only the host can do that',
    detail: 'Ask whoever created the room.',
    retry: false,
  },
  SPECTATOR_FORBIDDEN: {
    title: "You're watching this one",
    detail: 'Spectators cannot place rings. Join the next game to play.',
    retry: false,
  },
  NOT_YOUR_TURN: {
    title: 'Not your turn yet',
    detail: 'Hold on until the highlighted player has placed a ring.',
    retry: false,
  },
  ILLEGAL_MOVE: {
    title: "That ring can't go there",
    detail: 'The slot is taken, or you have none of that size left.',
    retry: false,
  },
  GAME_NOT_ACTIVE: {
    title: 'The game is not running',
    detail: 'It has either finished or not started yet.',
    retry: false,
  },
  NOT_ENOUGH_PLAYERS: {
    title: 'Not enough players yet',
    detail: 'You need at least two people, and everyone has to be ready.',
    retry: false,
  },

  SIGNALING_FAILED: {
    title: "Couldn't find the other players",
    detail: 'The rendezvous service did not respond. Try again in a moment.',
    retry: true,
  },
  PEER_UNREACHABLE: {
    title: "Couldn't connect directly",
    detail: 'This network is blocking direct connections between devices. A different Wi-Fi usually fixes it.',
    retry: true,
  },
  REFEREE_LOST: {
    title: 'Lost the game host',
    detail: 'The device running the game disappeared and nobody could take over.',
    retry: false,
  },

  UNSUPPORTED: {
    title: 'Not available here',
    detail: 'This way of playing does not support that.',
    retry: false,
  },
  INTERNAL: {
    title: 'Something went wrong',
    detail: 'That is a bug on our side, not yours. Try again, and reload if it keeps happening.',
    retry: true,
  },
};

const UNKNOWN_ERROR: ErrorCopy = {
  title: 'Something went wrong',
  detail: 'Try again, and reload the page if it keeps happening.',
  retry: true,
};

export function describeError(code: ErrorCode | string | null | undefined): ErrorCopy {
  if (!code) return UNKNOWN_ERROR;
  return ERRORS[code as ErrorCode] ?? UNKNOWN_ERROR;
}

/**
 * The same, but allowed to use what the referee actually said.
 *
 * `protocol.ts` is clear that `WireError.message` is developer-facing and must
 * never be shown raw *in place of* a mapped sentence. That rule exists because
 * most of these messages are diagnostics. Two are not, and discarding them
 * costs the player the only actionable information in the failure:
 *
 *  - `PEER_UNREACHABLE` is written as player-facing prose and distinguishes
 *    "nobody configured a TURN relay" (a deployment fix, which will never
 *    resolve on retry) from "a relay is configured but no path worked" (which
 *    can be transient). Our mapped sentence cannot tell those apart, so here
 *    the referee's wording *replaces* it.
 *  - `SIGNALING_FAILED` embeds the server's own words verbatim, which is the
 *    difference between "my server is misconfigured" and "bad luck" — but it is
 *    unmistakably developer register and sometimes long. It goes underneath,
 *    muted, with our sentence still leading.
 *
 * Everything else keeps the mapped copy and drops the diagnostic entirely.
 */
export function describeWireError(error: {
  code: ErrorCode | string;
  message?: string;
} | null | undefined): ErrorCopy & { technical?: string } {
  const base = describeError(error?.code);
  const message = error?.message?.trim();
  if (!message) return base;

  if (error?.code === 'PEER_UNREACHABLE') {
    // Earned the main line: it names the cause and the two causes need
    // different fixes by different people.
    return { ...base, detail: message };
  }
  if (error?.code === 'SIGNALING_FAILED') {
    return { ...base, technical: message };
  }
  return base;
}

/* -------------------------------------------------------------------------- *
 * Errors
 * -------------------------------------------------------------------------- */

export interface ErrorCopy {
  /** Short, shown as the heading of a toast or inline error. */
  title: string;
  /** One sentence of what to do about it. */
  detail: string;
  /** Whether offering a "Try again" button makes sense. */
  retry: boolean;
}

const ERRORS: Record<ErrorCode, ErrorCopy> = {
  NETWORK_UNAVAILABLE: {
    title: 'No connection',
    detail: 'This device is offline. Reconnect to Wi-Fi or mobile data and try again.',
    retry: true,
  },
  CONNECT_FAILED: {
    title: "Couldn't reach the game",
    detail: 'The server did not answer. It may be restarting.',
    retry: true,
  },
  CONNECTION_LOST: {
    title: 'Connection dropped',
    detail: 'Reconnecting automatically. Your seat is held for a short while.',
    retry: true,
  },
  TIMEOUT: {
    title: 'That took too long',
    detail: 'No answer came back in time. The connection may be slow.',
    retry: true,
  },
  PROTOCOL_MISMATCH: {
    title: 'This tab is out of date',
    detail: 'The game was updated while this tab was open. Reload to continue.',
    retry: false,
  },
  RATE_LIMITED: {
    title: 'Slow down a moment',
    detail: 'Too many actions at once. Wait a couple of seconds and try again.',
    retry: true,
  },

  ROOM_NOT_FOUND: {
    title: 'No room with that code',
    detail: 'Check the code and try again. Rooms also expire after a few hours.',
    retry: false,
  },
  CODE_INVALID: {
    title: "That code doesn't look right",
    detail: 'Room codes are letters and numbers only.',
    retry: false,
  },
  ROOM_FULL: {
    title: 'That room is full',
    detail: 'Every seat is taken. Ask the host to start a bigger game.',
    retry: false,
  },
  ROOM_CLOSED: {
    title: 'The room has closed',
    detail: 'Everyone left, or the host ended it. Start a new game when you are ready.',
    retry: false,
  },
  ALREADY_STARTED: {
    title: 'That game has already started',
    detail: 'You can still join to watch, if the host allowed spectators.',
    retry: false,
  },
  SEAT_TAKEN: {
    title: 'Someone else has your seat',
    detail: 'Your seat was given away. Join again to take a free one.',
    retry: false,
  },
  RECONNECT_EXPIRED: {
    title: 'You were away too long',
    detail: 'Your seat was released so the others could carry on. Rejoin to watch or take a free seat.',
    retry: false,
  },

  NOT_IN_ROOM: {
    title: 'Not in a room',
    detail: 'Create a game or join one with a code.',
    retry: false,
  },
  NOT_HOST: {
    title: 'Only the host can do that',
    detail: 'Ask whoever created the room.',
    retry: false,
  },
  SPECTATOR_FORBIDDEN: {
    title: "You're watching this one",
    detail: 'Spectators cannot place rings. Join the next game to play.',
    retry: false,
  },
  NOT_YOUR_TURN: {
    title: 'Not your turn yet',
    detail: 'Hold on until the highlighted player has placed a ring.',
    retry: false,
  },
  ILLEGAL_MOVE: {
    title: "That ring can't go there",
    detail: 'The slot is taken, or you have none of that size left.',
    retry: false,
  },
  GAME_NOT_ACTIVE: {
    title: 'The game is not running',
    detail: 'It has either finished or not started yet.',
    retry: false,
  },
  NOT_ENOUGH_PLAYERS: {
    title: 'Not enough players yet',
    detail: 'You need at least two people, and everyone has to be ready.',
    retry: false,
  },

  SIGNALING_FAILED: {
    title: "Couldn't find the other players",
    detail: 'The rendezvous service did not respond. Try again in a moment.',
    retry: true,
  },
  PEER_UNREACHABLE: {
    title: "Couldn't connect directly",
    detail: 'This network is blocking direct connections between devices. A different Wi-Fi usually fixes it.',
    retry: true,
  },
  REFEREE_LOST: {
    title: 'Lost the game host',
    detail: 'The device running the game disappeared and nobody could take over.',
    retry: false,
  },

  UNSUPPORTED: {
    title: 'Not available here',
    detail: 'This way of playing does not support that.',
    retry: false,
  },
  INTERNAL: {
    title: 'Something went wrong',
    detail: 'That is a bug on our side, not yours. Try again, and reload if it keeps happening.',
    retry: true,
  },
};

const UNKNOWN_ERROR: ErrorCopy = {
  title: 'Something went wrong',
  detail: 'Try again, and reload the page if it keeps happening.',
  retry: true,
};

export function describeError(code: ErrorCode | string | null | undefined): ErrorCopy {
  if (!code) return UNKNOWN_ERROR;
  return ERRORS[code as ErrorCode] ?? UNKNOWN_ERROR;
}

/**
 * The same, but allowed to use what the referee actually said.
 *
 * `protocol.ts` is clear that `WireError.message` is developer-facing and must
 * never be shown raw *in place of* a mapped sentence. That rule exists because
 * most of these messages are diagnostics. Two are not, and discarding them
 * costs the player the only actionable information in the failure:
 *
 *  - `PEER_UNREACHABLE` is written as player-facing prose and distinguishes
 *    "nobody configured a TURN relay" (a deployment fix, which will never
 *    resolve on retry) from "a relay is configured but no path worked" (which
 *    can be transient). Our mapped sentence cannot tell those apart, so here
 *    the referee's wording *replaces* it.
 *  - `SIGNALING_FAILED` embeds the server's own words verbatim, which is the
 *    difference between "my server is misconfigured" and "bad luck" — but it is
 *    unmistakably developer register and sometimes long. It goes underneath,
 *    muted, with our sentence still leading.
 *
 * Everything else keeps the mapped copy and drops the diagnostic entirely.
 */
export function describeWireError(error: {
  code: ErrorCode | string;
  message?: string;
} | null | undefined): ErrorCopy & { technical?: string } {
  const base = describeError(error?.code);
  const message = error?.message?.trim();
  if (!message) return base;

  if (error?.code === 'PEER_UNREACHABLE') {
    // Earned the main line: it names the cause and the two causes need
    // different fixes by different people.
    return { ...base, detail: message };
  }
  if (error?.code === 'SIGNALING_FAILED') {
    return { ...base, technical: message };
  }
  return base;
}

/**
 * True when the failure is a missing TURN relay — a deployment problem that
 * retrying cannot fix, so the only useful offer is a different backend.
 *
 * Matched on the message because both branches share the `PEER_UNREACHABLE`
 * code; there is no discriminator on the wire. Deliberately conservative: a
 * miss just means we offer the switch anyway, which is never wrong for this
 * code — switching backends resolves the transient branch too, it is merely
 * heavier than a retry would have been.
 */
export function isMissingRelay(message: string | undefined): boolean {
  return /no TURN relay is configured/i.test(message ?? '');
}

/* -------------------------------------------------------------------------- *
 * Connection
 * -------------------------------------------------------------------------- */

export interface LinkCopy {
  /** Short label for the status pill. */
  label: string;
  /** Fuller sentence for the banner. */
  detail: string;
  tone: 'ok' | 'busy' | 'warn' | 'bad';
  /** Whether a banner should be shown at all. */
  banner: boolean;
}

/**
 * How our own link is doing.
 *
 * `reconnecting` is explicitly *not* an error tone. The board stays on screen,
 * the words stay calm, and the only thing that changes is a quiet strip saying
 * what is happening -- because on four phones around a table this state happens
 * several times an hour and treating it as a failure trains people to ignore
 * the one time it really is.
 */
export function describeLink(status: ConnectionStatus): LinkCopy {
  switch (status) {
    case 'idle':
      return { label: 'Not connected', detail: 'Not connected yet.', tone: 'busy', banner: false };
    case 'connecting':
      return { label: 'Connecting', detail: 'Connecting to the game…', tone: 'busy', banner: true };
    case 'connected':
      return { label: 'Connected', detail: 'Connected.', tone: 'ok', banner: false };
    case 'reconnecting':
      return {
        label: 'Reconnecting',
        detail: 'Reconnecting — your seat is being held. The board will catch up on its own.',
        tone: 'warn',
        banner: true,
      };
    case 'closed':
      return { label: 'Disconnected', detail: 'You have left the game.', tone: 'busy', banner: false };
    case 'failed':
      return {
        label: 'Disconnected',
        detail: 'Could not get back to the game.',
        tone: 'bad',
        banner: true,
      };
    default:
      return { label: 'Unknown', detail: '', tone: 'busy', banner: false };
  }
}

/** How *another* player is doing, as the referee sees them. */
export function describePeer(
  connection: 'online' | 'reconnecting' | 'offline',
  forfeited: boolean,
): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (forfeited) return { label: 'Left the game', tone: 'bad' };
  switch (connection) {
    case 'online':
      return { label: 'Connected', tone: 'ok' };
    case 'reconnecting':
      return { label: 'Reconnecting', tone: 'warn' };
    case 'offline':
      return { label: 'Offline', tone: 'bad' };
  }
}

export function describeQuality(grade: QualityGrade, rttMs: number | null): string {
  const ms = rttMs === null ? '' : ` (${Math.round(rttMs)} ms)`;
  switch (grade) {
    case 'excellent':
      return `Excellent connection${ms}`;
    case 'good':
      return `Good connection${ms}`;
    case 'fair':
      return `Slow connection${ms}`;
    case 'poor':
      return `Very slow connection${ms}`;
    default:
      return 'Connection quality unknown';
  }
}

/* -------------------------------------------------------------------------- *
 * The game
 * -------------------------------------------------------------------------- */

export const SIZE_LABEL: Record<PieceSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

/** One-letter badge, for the colour-blind / low-vision size labels. */
export const SIZE_INITIAL: Record<PieceSize, string> = {
  small: 'S',
  medium: 'M',
  large: 'L',
};

/** Human names for the nine spaces, so a screen reader can say where. */
export const CELL_NAME = [
  'top left',
  'top middle',
  'top right',
  'middle left',
  'centre',
  'middle right',
  'bottom left',
  'bottom middle',
  'bottom right',
] as const;

/**
 * Explain *how* someone won, not just that they did.
 *
 * Otrio's three win conditions are easy to miss on a busy board -- especially
 * the ascending one, which people frequently do not notice they have set up.
 * Saying it out loud is most of what makes the end of a game satisfying rather
 * than confusing.
 */
export function describeWin(
  line: WinningLine | null,
  winnerName: string,
  /** Pass true when the winner is the person reading, so the verb agrees. */
  isSelf = false,
): string {
  const who = isSelf ? 'You' : winnerName;
  const verb = isSelf ? 'win' : 'wins';
  if (!line) return `${who} ${verb}.`;
  switch (line.kind) {
    case 'same-size': {
      const size = line.sizes[0] ?? 'small';
      return `${who} ${verb} with three ${size} ${PLAYER_COLORS[line.color]} rings in a line.`;
    }
    case 'ascending':
      return `${who} ${verb} with ${PLAYER_COLORS[line.color]} small, medium and large in a line.`;
    case 'concentric': {
      const where = CELL_NAME[line.cells[0]] ?? 'one space';
      return `${who} ${verb} with all three ${PLAYER_COLORS[line.color]} sizes nested in the ${where} space.`;
    }
    default:
      return `${who} ${verb}.`;
  }
}

/** Short badge text for the win condition. */
export function winConditionLabel(line: WinningLine | null): string {
  switch (line?.kind) {
    case 'same-size':
      return 'Three of a size';
    case 'ascending':
      return 'Small, medium, large';
    case 'concentric':
      return 'Nested in one space';
    default:
      return 'Otrio';
  }
}

export function describeEndReason(reason: GameEndReason | null, winnerName: string | null): string {
  switch (reason) {
    case 'win':
      return winnerName ? `${winnerName} won.` : 'The game was won.';
    case 'draw':
      return 'Every slot is filled and nobody made three. It is a draw.';
    case 'opponents-left':
      return 'Too many players left for the game to continue.';
    case 'host-ended':
      return 'The host ended the game.';
    case 'referee-lost':
      return 'The device running the game disappeared, so the game could not continue.';
    default:
      return 'The game has finished.';
  }
}

/** Why play is paused, phrased as information rather than alarm. */
export function describePause(
  reason: 'player-disconnected' | 'host-migrating',
  names: string[],
): string {
  if (reason === 'host-migrating') {
    return 'Handing the game over to another device. This takes a few seconds.';
  }
  if (names.length === 0) return 'Waiting for a player to come back.';
  if (names.length === 1) return `Waiting for ${names[0]} to come back.`;
  const last = names[names.length - 1];
  return `Waiting for ${names.slice(0, -1).join(', ')} and ${last} to come back.`;
}

/** Seconds, rounded for display, with a sensible word. */
export function formatCountdown(ms: number | null): string {
  if (ms === null) return '';
  const s = Math.ceil(ms / 1000);
  if (s <= 0) return 'any moment now';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** "Ann, Bo and Cal" */
export function joinNames(names: string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
