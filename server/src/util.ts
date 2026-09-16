/**
 * Small server utilities: configuration, logging, ids, room codes, rate
 * limiting.
 *
 * SYNTAX CONSTRAINT
 * -----------------
 * Everything under `server/**` is executed by Node's type *stripping* loader
 * (`node --experimental-strip-types`, see the `server` script in package.json;
 * on Node 23+ it is the default). Stripping erases type annotations but cannot
 * transform syntax, so this directory must avoid `enum`, `namespace`,
 * parameter properties (`constructor(private x)`), and legacy decorators. Use
 * `as const` objects and explicit field declarations instead.
 *
 * It also means every relative import needs its explicit `.ts` extension.
 */

import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  TIMING,
  randomId,
} from '../../src/net/protocol.ts';

/* ========================================================================== *
 * Configuration
 * ========================================================================== */

/**
 * Runtime configuration, entirely from the environment.
 *
 * DEPLOYMENT CONTRACT — this server makes no assumptions about where it runs:
 *
 *  - It binds `PORT` from the environment. Every PaaS (Fly, Railway, Render,
 *    Koyeb, Heroku, a bare VPS behind nginx) injects this. Never hardcode.
 *  - It binds `0.0.0.0`, not `localhost`, or container networking silently
 *    drops every request.
 *  - It writes nothing to disk — no uploads, no logs, no SQLite — which is what
 *    makes it safe on read-only and ephemeral filesystems. It also happens to
 *    read nothing, but do not conflate the two: reading files baked into the
 *    image is permitted on a read-only filesystem, so "serves no static assets"
 *    is a scope decision rather than a safety one.
 *  - It has no origin allowlist by default, because the deployed front end's
 *    origin is not knowable at build time. `OTRIO_ALLOWED_ORIGINS` narrows it
 *    when you do know.
 *  - All state is in memory (see `rooms.ts`). There is no database and no
 *    Redis, so a restart drops every room, and running more than one instance
 *    requires sticky routing by room code — neither is a problem at the scale
 *    this game operates at, but both are deliberate.
 */
export interface ServerConfig {
  port: number;
  host: string;
  /**
   * How long a dropped player's seat is held.
   *
   * Read-only, and deliberately not configurable: the shared referee in
   * `src/net/referee.ts` uses `TIMING.reconnectGraceMs` directly, so both
   * backends wait the same amount. A server-only override would make the
   * hosted game behave differently from the peer-to-peer one and make the
   * `reconnectGraceMs` advertised in `Capabilities` a lie.
   */
  readonly reconnectGraceMs: number;
  /** Default per-turn limit for new rooms. `0` disables the clock. */
  turnTimeoutMs: number;
  /** Refuse to create more rooms than this, to bound memory. */
  maxRooms: number;
  /** Refuse more than this many concurrent sockets. */
  maxConnections: number;
  /**
   * Origins permitted to open a WebSocket. Empty means allow all, which is the
   * default: the deployed client's origin is not known when this is built, and
   * a WebSocket carries no ambient credentials to protect. Set it when you do
   * know your front end's origin.
   */
  allowedOrigins: string[];
  logLevel: LogLevel;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read configuration from `process.env`, applying defaults. */
export function loadConfig(): ServerConfig {
  const level = (process.env.OTRIO_LOG_LEVEL ?? 'info').toLowerCase();
  return {
    port: envInt('PORT', 8787),
    host: process.env.HOST ?? '0.0.0.0',
    reconnectGraceMs: TIMING.reconnectGraceMs,
    turnTimeoutMs: envInt('OTRIO_TURN_TIMEOUT_MS', 0),
    maxRooms: envInt('OTRIO_MAX_ROOMS', 500),
    maxConnections: envInt('OTRIO_MAX_CONNECTIONS', 2000),
    allowedOrigins: envList('OTRIO_ALLOWED_ORIGINS'),
    logLevel: (['debug', 'info', 'warn', 'error'] as const).includes(level as LogLevel)
      ? (level as LogLevel)
      : 'info',
  };
}

/* ========================================================================== *
 * Logging
 * ========================================================================== */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured single-line JSON logging to stdout.
 *
 * Every managed host collects stdout; none of them want a log file. One JSON
 * object per line means the platform's log search can filter on fields without
 * a parser.
 */
export class Logger {
  private threshold: number;

  constructor(level: LogLevel) {
    this.threshold = LEVEL_ORDER[level];
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const line = { ts: new Date().toISOString(), level, msg, ...fields };
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    try {
      out.write(JSON.stringify(line) + '\n');
    } catch {
      // A serialisation failure in a log line must never take the server down.
      out.write(JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n');
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }
}

/* ========================================================================== *
 * Identifiers
 * ========================================================================== */

/** Short opaque id for logging and correlation. */
export function shortId(): string {
  return randomId(6);
}

/**
 * Generate a room code from `ROOM_CODE_ALPHABET`.
 *
 * Uses rejection sampling rather than `% alphabet.length`, because the alphabet
 * is 32 characters and `256 % 32 === 0` — so modulo happens to be unbiased
 * here, but the next person to edit the alphabet would silently introduce bias.
 * Rejection sampling stays correct whatever the alphabet becomes.
 */
export function generateRoomCode(length = ROOM_CODE_LENGTH): string {
  const n = ROOM_CODE_ALPHABET.length;
  const limit = Math.floor(256 / n) * n;
  let out = '';
  while (out.length < length) {
    const bytes = new Uint8Array(length * 2);
    globalThis.crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < limit) out += ROOM_CODE_ALPHABET[bytes[i] % n];
    }
  }
  return out;
}

/* ========================================================================== *
 * Rate limiting
 * ========================================================================== */

/**
 * Token bucket, one per connection.
 *
 * Not a security control so much as a guard against a buggy client in a render
 * loop, or a bored player holding down a key. `burst` accommodates the natural
 * clump at join time (hello, join, setReady, ping) without tripping.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private capacity: number;
  private refillPerMs: number;

  constructor(capacity: number, refillPerSecond: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  /** Consume one token. Returns false when the caller should be throttled. */
  take(cost = 1): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefill = now;
    }
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/* ========================================================================== *
 * Misc
 * ========================================================================== */

/** Clamp `n` into `[min, max]`, falling back to `fallback` when not a number. */
export function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
