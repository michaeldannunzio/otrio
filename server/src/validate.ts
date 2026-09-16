/**
 * Inbound message validation.
 *
 * NEVER TRUST THE CLIENT
 * ----------------------
 * Everything arriving on a socket is hostile input until proven otherwise. A
 * browser tab is fully under its user's control: they can open a console and
 * send whatever they like. This module is the only place raw bytes become
 * typed values, and nothing downstream re-checks shapes.
 *
 * What it enforces:
 *   - the payload is valid JSON, within a size bound, and is an object;
 *   - `t` is one of the known message types;
 *   - every field has the right primitive type and is within range;
 *   - strings are length-capped before they reach a room and get broadcast.
 *
 * What it deliberately does NOT enforce: anything semantic. Whether a move is
 * legal, whether it is this player's turn, whether the room exists — those are
 * the referee's decisions in `rooms.ts`, made against server state. A message
 * passing validation means only that it is well-formed.
 *
 * Note the asymmetry that matters: `MoveMsg.expectedSeq` is accepted but never
 * believed. A client's opinion about the current sequence number is a hint for
 * logging, never an input to validation.
 */

import {
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  isMove,
  isShortString,
  normalizeRoomCode,
} from '../../src/net/protocol.ts';
import type { ClientMessage, CreateRoomOptions } from '../../src/net/protocol.ts';
import { clampInt } from './util.ts';

/** Largest accepted frame. A `hello` is the biggest legitimate message, ~300 B. */
export const MAX_MESSAGE_BYTES = 4096;

export type ParseResult =
  | { ok: true; msg: ClientMessage }
  | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Request ids are echoed back verbatim, so they are bounded and typed. */
function validRid(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64;
}

function coerceCreateOptions(v: unknown, defaultTurnTimeoutMs: number): CreateRoomOptions {
  if (!isRecord(v)) return { turnTimeoutMs: defaultTurnTimeoutMs };
  return {
    maxPlayers: clampInt(v.maxPlayers, MIN_PLAYERS, MAX_PLAYERS, MAX_PLAYERS),
    allowSpectators: v.allowSpectators !== false,
    turnTimeoutMs: clampInt(v.turnTimeoutMs, 0, 10 * 60 * 1000, defaultTurnTimeoutMs),
  };
}

/**
 * Parse and validate one frame.
 *
 * `defaultTurnTimeoutMs` is the server's configured default, applied when the
 * client does not specify one.
 */
export function parseClientMessage(raw: string, defaultTurnTimeoutMs: number): ParseResult {
  if (raw.length > MAX_MESSAGE_BYTES) {
    return { ok: false, reason: `message too large (${raw.length} > ${MAX_MESSAGE_BYTES})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed JSON' };
  }

  if (!isRecord(parsed)) return { ok: false, reason: 'message must be an object' };
  const t = parsed.t;
  if (typeof t !== 'string') return { ok: false, reason: 'missing message type' };

  switch (t) {
    case 'hello': {
      if (typeof parsed.protocolVersion !== 'number') {
        return { ok: false, reason: 'hello: missing protocolVersion' };
      }
      if (!isShortString(parsed.playerId, 64)) return { ok: false, reason: 'hello: bad playerId' };
      if (!isShortString(parsed.sessionSecret, 128)) {
        return { ok: false, reason: 'hello: bad sessionSecret' };
      }
      return {
        ok: true,
        msg: {
          t: 'hello',
          protocolVersion: parsed.protocolVersion,
          playerId: parsed.playerId,
          sessionSecret: parsed.sessionSecret,
          name: typeof parsed.name === 'string' ? parsed.name.slice(0, MAX_NAME_LENGTH * 2) : '',
          clientVersion:
            typeof parsed.clientVersion === 'string' ? parsed.clientVersion.slice(0, 64) : undefined,
        },
      };
    }

    case 'createRoom': {
      if (!validRid(parsed.rid)) return { ok: false, reason: 'createRoom: bad rid' };
      return {
        ok: true,
        msg: {
          t: 'createRoom',
          rid: parsed.rid,
          options: coerceCreateOptions(parsed.options, defaultTurnTimeoutMs),
        },
      };
    }

    case 'joinRoom': {
      if (!validRid(parsed.rid)) return { ok: false, reason: 'joinRoom: bad rid' };
      if (!isShortString(parsed.code, 32)) return { ok: false, reason: 'joinRoom: bad code' };
      return {
        ok: true,
        msg: {
          t: 'joinRoom',
          rid: parsed.rid,
          code: normalizeRoomCode(parsed.code),
          asSpectator: parsed.asSpectator === true,
        },
      };
    }

    case 'leaveRoom': {
      if (!validRid(parsed.rid)) return { ok: false, reason: 'leaveRoom: bad rid' };
      return { ok: true, msg: { t: 'leaveRoom', rid: parsed.rid } };
    }

    case 'setReady': {
      if (!validRid(parsed.rid)) return { ok: false, reason: 'setReady: bad rid' };
      if (typeof parsed.ready !== 'boolean') return { ok: false, reason: 'setReady: bad ready' };
      return { ok: true, msg: { t: 'setReady', rid: parsed.rid, ready: parsed.ready } };
    }

    case 'setName': {
      if (!validRid(parsed.rid)) return { ok: false, reason: 'setName: bad rid' };
      if (typeof parsed.name !== 'string') return { ok: false, reason: 'setName: bad name' };
      return {
        ok: true,
        msg: { t: 'setName', rid: parsed.rid, name: parsed.name.slice(0, MAX_NAME_LENGTH * 2) },
      };
    }

    case 'startGame': {
      if (!validRid(parsed.rid)) return { ok: false, reason: 'startGame: bad rid' };
      return { ok: true, msg: { t: 'startGame', rid: parsed.rid } };
    }

    case 'move': {
      if (!validRid(parsed.rid)) return { ok: false, reason: 'move: bad rid' };
      if (!isMove(parsed.move)) return { ok: false, reason: 'move: bad move' };
      // Rebuilt field by field rather than passed through, so nothing the
      // client attached to the object survives into the referee. `color` is
      // optional and `0` is a real colour, so test against `undefined`.
      return {
        ok: true,
        msg: {
          t: 'move',
          rid: parsed.rid,
          move: {
            cell: parsed.move.cell,
            size: parsed.move.size,
            ...(parsed.move.color !== undefined ? { color: parsed.move.color } : {}),
          },
          expectedSeq: typeof parsed.expectedSeq === 'number' ? parsed.expectedSeq : undefined,
        },
      };
    }

    case 'rematch': {
      if (!validRid(parsed.rid)) return { ok: false, reason: 'rematch: bad rid' };
      if (typeof parsed.accept !== 'boolean') return { ok: false, reason: 'rematch: bad accept' };
      return { ok: true, msg: { t: 'rematch', rid: parsed.rid, accept: parsed.accept } };
    }

    case 'resync': {
      if (!validRid(parsed.rid)) return { ok: false, reason: 'resync: bad rid' };
      return { ok: true, msg: { t: 'resync', rid: parsed.rid } };
    }

    case 'ping': {
      if (!isShortString(parsed.id, 64)) return { ok: false, reason: 'ping: bad id' };
      if (typeof parsed.t0 !== 'number' || !Number.isFinite(parsed.t0)) {
        return { ok: false, reason: 'ping: bad t0' };
      }
      const rtt = parsed.rttMs;
      return {
        ok: true,
        msg: {
          t: 'ping',
          id: parsed.id,
          t0: parsed.t0,
          rttMs:
            typeof rtt === 'number' && Number.isFinite(rtt) && rtt >= 0 && rtt < 60_000
              ? Math.round(rtt)
              : undefined,
        },
      };
    }

    default:
      return { ok: false, reason: `unknown message type "${t.slice(0, 32)}"` };
  }
}
