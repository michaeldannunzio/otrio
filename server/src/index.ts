/**
 * Otrio authoritative game server.
 * ============================================================================
 *
 * RUNNING IT
 * ----------
 *     npm run server          # node --experimental-strip-types server/src/index.ts
 *
 * Requires Node 22.6+ (type stripping is on by default from Node 23).
 *
 * DEPLOYMENT CONTRACT
 * -------------------
 * Host-agnostic by construction:
 *
 *   - Binds `PORT` from the environment, defaulting to 8787. Never hardcoded.
 *   - Binds `0.0.0.0` (override with `HOST`). Binding `localhost` inside a
 *     container makes the service unreachable with no error anywhere.
 *   - Touches the filesystem for nothing: no static assets, no uploads, no log
 *     files, no SQLite. Safe on read-only and ephemeral filesystems.
 *   - Has no origin allowlist by default, because the front end's deployed
 *     origin is not knowable at build time. Narrow it with
 *     `OTRIO_ALLOWED_ORIGINS` once you know it.
 *   - Serves `GET /healthz` for platform health checks.
 *   - Handles `SIGTERM` by draining, which is how every PaaS asks a process to
 *     stop. Without it, deploys sever every live game abruptly.
 *
 * Verified to fit: Fly.io, Railway, Render, Koyeb, Heroku, a plain VPS behind
 * nginx, or a Docker image with `CMD ["npm","run","server"]`.
 *
 * **Vercel will not work**, and this is worth stating plainly because it was on
 * the shortlist: Vercel's serverless and edge functions cannot hold a
 * long-lived WebSocket. Host the Vite front end on Vercel if you like, and put
 * this server somewhere that supports persistent connections — the client only
 * needs `VITE_OTRIO_SERVER_URL` to point at it.
 *
 * STATE
 * -----
 * Entirely in memory. No database. A restart ends every game in progress, and
 * multiple instances need routing by room code or they will split rooms. See
 * the header of `rooms.ts` for why that is the right trade here.
 *
 * The rules, and the entire room lifecycle, are NOT in this directory: they live
 * in `src/net/referee.ts`, which the peer-to-peer backend drives too. The
 * reconnect grace period is therefore a shared constant (`TIMING`), not a
 * server setting — the two backends must not disagree about how long a seat is
 * held.
 *
 * ENVIRONMENT
 * -----------
 *   PORT                        listen port                    (8787)
 *   HOST                        bind address                   (0.0.0.0)
 *   OTRIO_TURN_TIMEOUT_MS       per-turn clock, 0 = untimed     (0)
 *   OTRIO_MAX_ROOMS             room ceiling                    (500)
 *   OTRIO_MAX_CONNECTIONS       socket ceiling                  (2000)
 *   OTRIO_ALLOWED_ORIGINS       comma-separated, empty = any    ('')
 *   OTRIO_LOG_LEVEL             debug|info|warn|error           (info)
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
// Named imports, not a default import: `ws`'s ESM wrapper exports the class and
// the server separately, and does not hang `.Server` off the default export the
// way its CommonJS entry point does.
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';

import { PROTOCOL_VERSION } from '../../src/net/protocol.ts';
import { RoomRegistry } from './rooms.ts';
import { CLOSE, HEARTBEAT_INTERVAL_MS, Session, buildCapabilities } from './session.ts';
import type { Socket } from './session.ts';
import { MAX_SIGNAL_BYTES, SignalingRelay } from './signal.ts';
import { Logger, loadConfig, shortId } from './util.ts';
import { MAX_MESSAGE_BYTES } from './validate.ts';

const config = loadConfig();
const log = new Logger(config.logLevel);

/** Adapts a `ws` socket to the minimal surface `Session` needs. */
function adaptSocket(ws: WebSocket): Socket {
  return {
    send(data: string) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close(code?: number, reason?: string) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    },
    terminate() {
      ws.terminate();
    },
    get open() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
}

function originAllowed(req: IncomingMessage): boolean {
  if (config.allowedOrigins.length === 0) return true;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  return config.allowedOrigins.includes(origin);
}

async function main(): Promise<void> {
  // Room lifecycle and every rule live in the shared referee
  // (`src/net/referee.ts`), which both backends drive. This process only owns
  // the registry: which rooms exist, which socket is whose, and the clock.
  const capabilities = buildCapabilities(config);
  const registry = new RoomRegistry(log, config, capabilities);
  registry.start();
  const startedAt = Date.now();

  /* ---------------------------------------------------------------------- *
   * HTTP
   * ---------------------------------------------------------------------- */

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0];

    // Permissive CORS: these endpoints are read-only, carry no credentials, and
    // the front end's origin is not known at build time.
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (url === '/healthz' || url === '/health') {
      const body = JSON.stringify({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        rooms: registry.size,
        connections: sessions.size,
        signalRooms: relay.roomCount,
        signalPeers: relay.peerCount,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        'otrio game server\n' +
          '  /ws or /   authoritative game socket (hosted backend)\n' +
          '  /signal    WebRTC signalling relay (peer-to-peer backend)\n' +
          '  /healthz   health check\n',
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  });

  /* ---------------------------------------------------------------------- *
   * WebSocket
   * ---------------------------------------------------------------------- */

  // Two servers, not one, because the two protocols need different payload
  // caps: a game move is a few hundred bytes and is held to a tight 4 KB, while
  // an SDP offer with a full candidate list runs to several kilobytes and would
  // be truncated by that cap. `maxPayload` is per-server, so the split is the
  // only way to hold each to its own limit.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    // Compression is off on purpose: messages are a few hundred bytes, so
    // permessage-deflate costs more in CPU and memory per connection than it
    // saves in bandwidth, and its zlib buffers are a known leak source.
    perMessageDeflate: false,
  });

  const signalWss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_SIGNAL_BYTES,
    perMessageDeflate: false,
  });

  const relay = new SignalingRelay(log);
  relay.start();
  signalWss.on('connection', (ws: WebSocket) => relay.attach(ws));

  const sessions = new Map<WebSocket, Session>();

  httpServer.on('upgrade', (req, socket, head) => {
    if (sessions.size >= config.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!originAllowed(req)) {
      log.warn('upgrade rejected: origin not allowed', { origin: req.headers.origin });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    // Route by path. Accepting every path as a game socket is what made the
    // peer-to-peer backend fail in the most confusing way possible: `/signal`
    // was handed to the game protocol, which answered a `join` frame with
    // `INTERNAL: unknown message type "join"` — a missing feature wearing the
    // costume of a runtime bug. An unknown path is now refused outright.
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';

    if (path === '/signal') {
      signalWss.handleUpgrade(req, socket, head, (ws) => {
        signalWss.emit('connection', ws, req);
      });
      return;
    }

    if (path === '/' || path === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }

    log.warn('upgrade rejected: unknown path', { path });
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const id = shortId();
    const session = new Session(id, adaptSocket(ws), registry, log, config, capabilities);
    sessions.set(ws, session);
    log.debug('socket: open', { id, ip: req.socket.remoteAddress, connections: sessions.size });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        // The protocol is JSON text. A binary frame is either a bug or a probe.
        session.close(CLOSE.BAD_MESSAGE, 'binary frames are not accepted');
        return;
      }
      session.handleRaw(data.toString());
    });

    ws.on('pong', () => {
      session.alive = true;
    });

    ws.on('error', (err: Error) => {
      log.debug('socket: error', { id, err: err.message });
    });

    ws.on('close', (code: number) => {
      sessions.delete(ws);
      session.onSocketClosed();
      log.debug('socket: closed', { id, code, connections: sessions.size });
    });
  });

  /**
   * Socket-level heartbeat.
   *
   * A TCP connection that dies without a FIN — a laptop lid closing, a phone
   * losing signal — leaves the server holding a socket that will never close on
   * its own. Without this the seat is held forever and the room never resolves
   * the disconnect. Ping every interval; anything that has not ponged since the
   * last round is gone.
   */
  const heartbeat = setInterval(() => {
    for (const [ws, session] of sessions) {
      if (!session.alive) {
        log.debug('socket: heartbeat timeout', { id: session.id });
        ws.terminate();
        continue;
      }
      session.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  /* ---------------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------------- */

  httpServer.listen(config.port, config.host, () => {
    log.info('server: listening', {
      host: config.host,
      port: config.port,
      protocolVersion: PROTOCOL_VERSION,
      reconnectGraceMs: config.reconnectGraceMs,
      turnTimeoutMs: config.turnTimeoutMs,
      originsRestricted: config.allowedOrigins.length > 0,
    });
  });

  httpServer.on('error', (err: Error) => {
    log.error('server: http error', { err: err.message });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('server: shutting down', { signal, rooms: registry.size });

    clearInterval(heartbeat);
    registry.stop();
    relay.stop();
    relay.closeAll('server is restarting');
    // Tell everyone why, so clients show "server restarting" rather than
    // silently retrying into a closed port.
    registry.closeAll('server is restarting');
    for (const [ws, session] of sessions) {
      session.close(CLOSE.SHUTDOWN, 'server is restarting');
      ws.terminate();
    }
    wss.close();
    signalWss.close();
    httpServer.close(() => process.exit(0));

    // A PaaS typically allows ~10s between SIGTERM and SIGKILL. Do not be the
    // reason it has to escalate.
    setTimeout(() => process.exit(0), 3_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    // Survivable: one request's promise failed, the rest of the process is fine.
    log.error('server: unhandled rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (err: Error) => {
    // Not survivable: an invariant broke somewhere unknown, so in-memory room
    // state can no longer be trusted. Exit and let the platform restart us.
    log.error('server: uncaught exception', { err: err.message, stack: err.stack });
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  log.error('server: failed to start', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
