# Deploying Otrio

The goal is a URL you can send to three other people, that works from their
phones, without anything running on your own machine.

## What has to be true

Otrio needs a host that can do two things at once:

1. **Serve static files** — the built `dist/` bundle.
2. **Hold open WebSocket connections** — for the whole length of a game, not
   for the length of an HTTP request.

The second requirement is the one that rules hosts out. A platform built around
short-lived serverless functions can serve the first perfectly and cannot do the
second at all.

There is a third requirement that is easy to miss:

3. **Real HTTPS.** Not a nicety. `RTCPeerConnection` is only exposed in a
   [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
   so on a plain `http://` origin the WebRTC transport does not merely perform
   badly — the API is not there, and the code path fails at construction.
   Every host below terminates TLS for you, which is the main reason deploying
   is *easier* than testing over your LAN.

## Recommended: one container, one origin

All three configs in this repo deploy the same shape: a single container that
serves `dist/` **and** the WebSocket endpoint from the same origin.

Keeping them together is worth doing deliberately. It gives you one hostname to
read out loud, one certificate, no CORS policy, and no chance of a `https://`
page trying to open a `ws://` socket (browsers block that as mixed content —
it must be `wss://`).

| Host | Config file | Scales to zero | Notes |
|---|---|---|---|
| **Fly.io** | `fly.toml` | yes, configurable | Recommended. Persistent process, global regions, TLS included. |
| **Railway** | `railway.toml` | no (Hobby) | Simplest dashboard. Bills per resource-minute. |
| **Render** | `render.yaml` | yes, on free | Free tier spins down after ~15 min idle. |

### Fly.io

```sh
fly launch --no-deploy --copy-config   # sets a unique app name + region
fly deploy
fly open
```

Edit `app = "otrio-CHANGEME"` in `fly.toml` first — Fly app names are globally
unique, and the placeholder is not registered to you.

The one setting to think about is `min_machines_running`. At `0` the app costs
essentially nothing when idle, but Fly stops the machine, **and in-memory room
state dies with it**. Mid-game that means a lost game. Set it to `1` if you want
a room to survive people wandering off for twenty minutes.

### Railway

```sh
railway init
railway up
```

Then **Settings → Networking → Generate Domain** to get an HTTPS hostname.
WebSocket upgrades pass through the edge proxy without extra configuration.

### Render

Point Render at the repo and choose **New → Blueprint**; it reads `render.yaml`.

On the free plan the service sleeps after ~15 minutes of no traffic and takes
tens of seconds to wake. Every open socket drops when it sleeps. Use Starter if
that matters.

## About Vercel — the honest version

**Vercel is an excellent host for the static half of this app and a poor fit for
the WebSocket half.** Vercel's model is serverless functions: they are invoked
per request, have a bounded execution time, and are not designed to own a
long-lived, bidirectional connection. There is no supported way to run a
`ws` server there the way `server/` expects.

So if you want to use Vercel, the deployment splits in two:

- `dist/` → Vercel
- `server/` → Fly / Railway / Render, on its own hostname

That works, but understand what you are taking on:

- **Two origins.** The page is served from `otrio.vercel.app`, the socket lives
  at `otrio.fly.dev`. The client must be told the socket URL explicitly
  (`VITE_SERVER_URL`) instead of using a same-origin relative `/ws`.
- **CORS**, for any plain HTTP endpoints the server exposes. The WebSocket
  handshake itself is not subject to CORS, but it *is* subject to the server's
  own `Origin` checking — so the server has to allow the Vercel hostname.
- **`wss://`, never `ws://`.** An HTTPS page may not open an insecure socket.

That is more moving parts than the single-container setup, for a game that will
have at most four players. Recommended only if you are already on Vercel for
other reasons.

`vercel.json` is deliberately **not** included in this repo, so that nobody
deploys the frontend there and then spends an evening wondering why no one can
join a room.

## The contract the server must satisfy

The deployment configs assume `server/` honours these. If a deploy comes up but
nothing connects, check these first:

| Variable | Meaning |
|---|---|
| `PORT` | Port to bind. **Injected by the host.** Binding a hardcoded port instead is the single most common reason a first deploy fails its health check. |
| `OTRIO_STATIC_DIR` | Directory of built frontend files to serve. Set to `/app/dist` in the container. If unset, the server should serve the socket only. |
| `NODE_ENV` | `production`. |

Bind to `0.0.0.0`, not `127.0.0.1` — inside a container, localhost is not
reachable from the platform's proxy.

## WebRTC, STUN and TURN

When the transport is WebRTC, the server is only used for **signalling**: the
short exchange that lets two browsers find each other. Once the peer connection
is up, moves travel directly between phones and the server is idle.

- **Four phones on the same Wi-Fi** connect on host candidates alone. No STUN
  needed.
- **Across different networks** you need a STUN server to discover public
  addresses. Public STUN is free and widely available.
- **Behind symmetric NAT or restrictive mobile carrier NAT**, STUN is not
  enough and the connection needs a **TURN relay**, which is not free — it
  relays all the traffic, so nobody gives it away. If players on cellular data
  cannot connect while Wi-Fi players can, this is why.

For a game played in one room, the WebSocket transport is the more predictable
choice, and the reason WebRTC exists here is latency between people who are not
in the same building.

## Deploying from CI

`.github/workflows/ci.yml` typechecks, tests and builds, but does **not**
deploy — it holds no credentials, and none should be invented. To add
deployment, create the host's token as a repository secret and add a job:

```yaml
deploy:
  needs: verify
  if: github.ref == 'refs/heads/main'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: superfly/flyctl-actions/setup-flyctl@master
    - run: flyctl deploy --remote-only
      env:
        FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

Generate that token yourself with `fly tokens create deploy`. Railway and Render
both also redeploy automatically on push to the connected branch, which needs no
secrets in the repo at all and is the lower-effort option.
