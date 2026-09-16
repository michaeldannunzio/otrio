# The peer-to-peer backend

Otrio has two networking backends behind one interface (`src/net/transport.ts`).
This document is about the peer-to-peer one: `src/net/rtcTransport.ts` and
`src/net/signaling.ts`. It covers how it works, how to test it, what it looks
like when it breaks, and when you should use the hosted backend instead.

Switching is one line:

```ts
// hosted
const transport = createWsTransport({ identity });
// peer-to-peer
const transport = createRtcTransport({ identity });
```

Everything above that line — the store, the board, the lobby — is identical.
Both resolve their endpoint the same way, from the same environment, so in the
common deployment neither needs a URL at all.

### Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `VITE_OTRIO_SERVER_URL` | both | The deployed server. Peer-to-peer appends `/signal` to it. |
| `VITE_OTRIO_SIGNALING_URL` | p2p | Override, when signalling lives somewhere else entirely. |
| `VITE_STUN_URLS` | p2p | Comma-separated. Defaults to Google's public STUN. |
| `VITE_TURN_URLS` | p2p | Comma-separated. Omit and there is no TURN. |
| `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` | p2p | TURN credentials. |

`resolveSignalingUrl()` prefers an explicit `signalingUrl`, then
`VITE_OTRIO_SIGNALING_URL`, then `VITE_OTRIO_SERVER_URL` + `/signal`, then the
page's own origin, and finally `localhost:8787` in dev. Everything it needs is
already set for the hosted backend, so adding a `/signal` route to `server/` is
the whole of the deployment work.

---

## The short version

**Use peer-to-peer when** four friends are in the same room, you want the
lowest possible latency, and you would rather not pay for a server that touches
game data.

**Use hosted when** the game needs to work for people you cannot troubleshoot,
when anyone might care about cheating, or when you have already been bitten once
by a network that blocks peer-to-peer traffic.

**The thing most people get wrong:** peer-to-peer does not mean serverless. It
means the server is small and stays out of the game path. You still have to
deploy something. See [Signalling](#signalling-the-server-you-cannot-avoid).

---

## Topology: a host-peer star

```
        hosted backend                    peer-to-peer backend

      ┌──────────────┐                        ┌─────────┐
      │  Node server │ referee                │ phone A │ referee
      └───┬──┬──┬──┬─┘                        └──┬───┬──┴─┐
          │  │  │  │                             │   │    │
        ┌─┘  │  │  └─┐                       ┌───┘   │    └───┐
        ▼    ▼  ▼    ▼                       ▼       ▼        ▼
       A    B  C    D                       B       C        D
```

Same shape. The only difference is whether the thing in the middle is a
datacenter or somebody's phone.

### Why a star and not a mesh

A full mesh for four players is six peer connections; a star is three.

1. **Every connection is an independent chance to fail.** NAT traversal happens
   per pair, not per room. Six pairs means six opportunities for ICE to fail,
   and when one fails in a mesh the room is partitioned with no obvious culprit:
   B and C can both see A but not each other, and now what? In a star, a failed
   link is one player who cannot join. The other three never notice.

2. **The protocol already assumes a referee.** `protocol.ts` is built on whole
   `RoomState` snapshots with a monotonic `seq`, produced by one authority.
   A star has an obvious place to put that authority. A mesh does not, and
   making four phones agree on a total order without one means lockstep or
   consensus — dramatically more code, and more ways to deadlock, than a game
   where you place one ring every thirty seconds justifies.

3. **It keeps the backends the same shape.** The frames on the data channel are
   literally `ClientMessage` and `ServerMessage` from `protocol.ts` — the same
   JSON the hosted backend puts on its WebSocket. So the referee is not a
   peer-to-peer component at all: `PeerReferee` lives in `src/net/referee.ts`
   and **both backends run the same instance of it**, one pumped from a data
   channel and one from a WebSocket. Seat assignment, readiness, rematch,
   forfeit, the pause policy and the turn clock therefore cannot drift between
   them, because there is only one copy. That is what makes the backends
   genuinely swappable rather than merely similar.

The costs, stated plainly: the referee's phone does all the work, and every
message costs two hops (leaf → referee → leaf) instead of one. For nine cells of
board state, neither matters.

---

## Signalling: the server you cannot avoid

Two phones cannot exchange an SDP offer over a connection that does not exist
yet. Something both of them can already reach has to introduce them. That is
signalling, and it is the irreducible server in a "serverless" design.

The good news is how little it has to do. **The signalling service never sees a
game move, never parses an SDP, and never knows the rules.** It is a
room-scoped message relay.

### The exact contract

Transport: WebSocket. Messages: JSON, one object per frame.

**Client → server**

| Message | Meaning |
|---|---|
| `{t:'join', room, peer, name?}` | Put me in this room under this id. |
| `{t:'signal', to, data}` | Relay `data` verbatim to peer `to` in my room. |
| `{t:'leave'}` | Remove me now. |
| `{t:'ping', ts}` | Keepalive. |

**Server → client**

| Message | Meaning |
|---|---|
| `{t:'welcome', room, you, order, peers}` | You are in. Here is everyone else. |
| `{t:'peer-join', peer}` | Someone arrived. |
| `{t:'peer-leave', peer, reason?}` | Someone left. |
| `{t:'signal', from, data}` | A relayed blob. |
| `{t:'error', error: WireError, fatal}` | See below. Same frame the game socket uses. |
| `{t:'pong', ts}` | Keepalive reply. |

#### The error frame

It is `ErrorMsg` from `protocol.ts` — deliberately the same shape as the game
socket's, so there is one error vocabulary in the app rather than two that can
drift. `error.code` is an `ErrorCode`; `error.retryable` is `!fatal`.

| Condition | `error.code` | `fatal` | Socket |
|---|---|---|---|
| Room already has 4 peers | `ROOM_FULL` | true | closed, 4003 |
| Malformed/empty room code or peer id | `CODE_INVALID` | true | closed, 4003 |
| `signal` before `join`, or room vanished | `PROTOCOL_MISMATCH` | true | closed, 4003 |
| Too many frames | `RATE_LIMITED` | false | stays open |
| Unknown type, bad JSON, oversize | `INTERNAL` | false | stays open |

**`fatal` is stated by the server, never inferred by the client.** That is the
whole point of the field. An earlier design had the client decide fatality from
a hardcoded list of codes, which meant a server that learned a new terminal
condition had no way to say so and the client would retry it forever. On
`fatal: true` the server also closes the socket; the client must treat the frame
as the reason and not the close as a fresh failure to retry.

### The requirements that actually matter

These are the ones a naive implementation gets wrong:

1. **`order` must be server-assigned, monotonic per room, and preserved across
   a rejoin.** It is how a peer joining an existing room works out who to talk
   to. It cannot be a client clock (phones disagree) and it cannot be derived
   from the peer id (random ids elect a random player). Preserving it across a
   rejoin is what stops a host whose WebSocket blipped from losing seniority.

   **Preserved across a real disconnect, not just a replaced socket.** This is
   the subtle part, and the reference implementation that used to live in this
   document got it wrong: it held `order` inside the peer record and deleted
   that record on socket close, so seniority survived a socket being swapped
   while still open but not an actual drop — precisely the case the requirement
   exists for. A host whose Wi-Fi blinked came back with a fresh, higher `order`
   and silently stopped being the host. Keep the order map for the room's
   lifetime, separately from the live peer set.

   For the same reason, **do not delete a room the instant it empties.** Two
   peers on one Wi-Fi drop together, both reconnect into a brand-new room, and
   swap seniority. Hold an emptied room briefly (the live server uses 60s).

2. **Peer ids are client-generated. Do not mint your own.** They are the
   players' `PlayerId`s, and the rest of the stack depends on there being
   exactly one identity space. A repeat `join` from a known id in the same room
   is a *resume*: replace the old socket, keep the `order`, and do not tell the
   other peers that somebody joined.

3. **The connection must stay open for the whole session.** This is the big
   one. "Signalling is only needed during the handshake" is false, and a client
   that disconnects after `welcome` works perfectly in testing and fails in
   every interesting real case. Signalling is needed again for late joiners,
   for ICE restarts after a Wi-Fi-to-cellular handover, and for host migration —
   which has to be coordinated at exactly the moment the data channels are the
   thing that died.

4. **Relay `data` without looking at it.** It is opaque. If you ever find
   yourself parsing SDP in the signalling server, something has gone wrong.

5. **Cap rooms at 4 peers and expire empty rooms.** Otherwise the first bored
   person with a script fills your memory.

6. **`wss://`, not `ws://`.** Browsers require a secure context for
   `RTCPeerConnection`, and a page served over HTTPS cannot open a plaintext
   WebSocket anyway.

7. **Route by path, and refuse everything else at the upgrade.** `/signal` is
   the relay; `/` and `/ws` are the game socket. A server that accepts any path
   and treats it as a game socket will answer signalling frames with `INTERNAL`,
   which is indistinguishable from a working relay right up until the first
   error — a missing feature presenting as a runtime bug. Refusing unknown paths
   with a 404 at upgrade turns that into an immediate, unambiguous failure.

8. **Give the relay its own payload cap.** SDP offers carrying a full candidate
   list are far larger than any game message; the live server allows 64 KB on
   `/signal` against 4 KB on the game socket. In `ws`, `maxPayload` is per
   `WebSocketServer`, so this means a second instance rather than a bigger
   number.

9. **A `signal` addressed to a departed peer is dropped silently, not an
   error.** Departure races every normal disconnect; erroring on it would make
   routine leaves look like faults. The sender learns from `peer-leave`.

### The implementation

It lives in **`server/src/signal.ts`**, mounted at `/signal` on the same Node
process as the game socket. That is the canonical implementation; this document
is the contract it satisfies, not a second copy of it.

There used to be a ~90-line reference implementation here. It is gone on
purpose. It had the `order` bug described above, and keeping a parallel
implementation in a document guarantees the two drift — the document is where
the drift is hardest to notice, because nothing fails when it goes stale.

If you are porting the relay somewhere else — a Cloudflare Durable Object, Deno
Deploy — read `server/src/signal.ts` and the nine requirements above. The whole
thing is a room map, an order map, and a `switch` on four message types; the
requirements are the hard part, not the code.

### Where to put it

It needs a long-lived WebSocket and almost no CPU. It must not be your PC — a
game only works while your machine is on, and you have ruled that out.

| Option | Notes |
|---|---|
| **Fly.io / Render / Railway** | Simplest. One tiny always-on instance. Watch for free tiers that sleep — a cold start looks exactly like a broken game. |
| **Deno Deploy** | Native WebSocket support, generous free tier, no container to babysit. |
| **Cloudflare Workers + Durable Objects** | Best fit architecturally: one Durable Object per room code gives you the room map for free. Workers alone are not enough — a stateless Worker cannot fan out to other sockets. |
| **The same service as the hosted backend** | **What we actually do.** See below. |

**The honest note, now settled by construction:** the hosted backend already
needs a deployed Node + `ws` service, and `/signal` is mounted on it. So
peer-to-peer does not save you a deployment — you would run the same box either way. What it actually
buys you is that the box never sees game state, never scales with game activity,
and can be the cheapest thing you can find. If the argument for P2P in your head
was "then I don't need a server", that argument is wrong. The remaining
arguments (latency, privacy, the server not being a single point of failure for
an in-progress game) are real.

---

## NAT traversal: the part that actually fails

Two peers connect by trading candidate addresses and probing every pair until
one works. There are three kinds:

- **host** — a local address (`192.168.1.42`). Works when both peers are on the
  same network segment. Free and instant.
- **srflx** — your public address as seen by a STUN server. This is hole
  punching: both sides fire packets outward, each opening a hole in its own NAT
  that the other's packets fit through.
- **relay** — a TURN server that forwards everything. Always works. Costs money
  and adds a hop.

### What works without TURN

These are rules of thumb from people who run WebRTC at scale, not measurements
of your network. Treat them as "what to expect", not as a promise.

| Situation | Expectation |
|---|---|
| All four phones on the same home Wi-Fi | Usually excellent. Host candidates connect directly — often sub-millisecond, no STUN involved. |
| Ordinary home internet, different houses | Good. Roughly **80–90%** of pairs connect with STUN alone. |
| One or more on cellular | Mixed. Carrier-grade NAT is usually cone-like and punches fine. Some carriers are effectively symmetric. IPv6-first carriers can actually make this *easier*, since two peers with real global IPv6 addresses barely need NAT traversal at all. |
| Corporate, hotel, café, or guest Wi-Fi | **Poor, and this is the one that will bite you.** See below. |

Overall: expect **roughly 10–20% of peer pairs on the open internet to need
TURN**, and much worse than that on managed networks.

### The counterintuitive one: same Wi-Fi can be the *worst* case

"We're all on the same Wi-Fi, so it'll definitely work" is wrong often enough to
be worth planning for. Two mechanisms:

- **AP isolation** (a.k.a. client isolation) is on by default on virtually all
  guest, hotel and café Wi-Fi, and on some consumer routers. It blocks traffic
  between clients. Host candidates therefore fail. And because both peers are
  behind the same NAT, their srflx candidates point at the *same* public IP, so
  connecting needs NAT hairpinning, which many routers do not support. Both
  paths fail, and only TURN is left.

- **mDNS candidate obfuscation.** Modern browsers hide your real local IP behind
  a `<uuid>.local` hostname for privacy. Peers resolve it over multicast DNS.
  On networks where multicast is filtered — again, guest and corporate Wi-Fi —
  resolution fails silently and the fast same-LAN path disappears.

### What a player actually sees when it fails

Nothing dramatic, provided the deadline is in place — which it is
(`peerConnectTimeoutMs`, default 20s):

1. They tap **Join**, the code is accepted, the spinner starts.
2. ICE gathers candidates, probes for up to 20 seconds, finds nothing.
3. The link goes to `failed`. `joinRoom()` rejects with `PEER_UNREACHABLE`.
4. The UI shows: *"Couldn't connect directly to the host. You're probably on a
   network that blocks peer-to-peer — try mobile data, or use the hosted game."*

The important part is step 3. Left to itself, ICE reaches `failed` slowly and
not always, and the player gets an infinite spinner instead of a sentence they
can act on. The hard deadline is what turns a hang into a diagnosis.

Mid-game the failure is different: the board stays on screen, status goes to
`reconnecting`, and either the link recovers via ICE restart or the referee is
declared lost and migration kicks in.

### TURN

There is no free public TURN, and anything advertised as one is either a
honeypot, about to disappear, or both — all your traffic goes through it.

Options:

- **coturn on a small VPS** (~$5/month). For a turn-based board game the relayed
  traffic is a few kilobytes per game, so the cheapest instance is enormous
  overkill. This is the sensible choice.
- **A paid service** — Twilio, Metered, Xirsys, Cloudflare Calls. Simplest, and
  the free tiers are generous relative to this game's needs.
- **Nothing.** Perfectly reasonable. Accept that some players cannot connect and
  send them to the hosted backend, which is the fallback TURN would otherwise be.

Configure it out of band so credentials never land in the repo:

```bash
# .env.local
VITE_STUN_URLS=stun:stun.l.google.com:19302
VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
VITE_TURN_USERNAME=…
VITE_TURN_CREDENTIAL=…
```

That is the whole change — the transport reads these itself, so no code moves.
Pass `iceServers` explicitly only if you need something the env vars cannot say.

Include a **TLS-over-TCP** (`turns:`, port 443) URL as well as UDP. Restrictive
networks that block UDP entirely will still let 443 through, and that is often
the difference between "works everywhere" and "works everywhere except the
office".

> The default is Google's public STUN. It is free, universally used, and comes
> with no availability commitment of any kind. Fine for development; run your
> own (coturn does STUN too) if you care.

---

## Authority: who decides what happened

There is no impartial referee. The design does not pretend otherwise; it
confines the difference to one boolean.

### The model: host-peer referee, snapshots, fencing epoch

One peer is the **referee**. It runs `PeerReferee` from `src/net/referee.ts` —
the same room logic over the same rules engine that the hosted server runs —
validates every move, and broadcasts a whole `RoomState` with an incremented
`seq`. Everyone else renders that verbatim. Clients never compute game state;
they receive it.

The referee's seam is `handle(from, ClientMessage)` in and `send(to,
ServerMessage)` out. It knows nothing about sockets, peers or ICE, which is why
the same object works behind both transports.

**Seats and colours are not the same thing**, and the referee is careful about
it. A `Seat` is a person; a `PlayerColor` is a colour of rings. They coincide in
3- and 4-player games and do *not* in the official 2-player game, where each
person plays two colours on opposite arms and a win must form within a single
colour. Board cells and reserves are keyed by colour; turns, forfeits and wins
are keyed by seat. `Move.color` is omitted whenever the seat to move has exactly
one playable colour, which is every turn of every game this referee builds —
strict alternation fixes it even in the 2-player case.

The referee's own moves go through the identical
validate → apply → snapshot → deliver path rather than short-circuiting, so the
host player's experience is not subtly different from everyone else's. That
uniformity is the only thing stopping bugs from hiding on exactly one side.

**No prediction, and none is needed.** A leaf's move costs one round trip:
5–15 ms on shared Wi-Fi, 30–80 ms over cellular, against a turn-based game's
~100 ms perception budget. `pendingMove` draws a ghost ring on the tap frame and
that is the whole of the optimism. Building rollback netcode for Otrio would be
inventing a problem.

### Migration: what happens when the host's phone rings

This is the interesting failure, and it is not hypothetical — iOS Safari
throttles timers in a backgrounded tab and will freeze the page outright.

```
  1. Referee (seat 0) goes quiet.
  2. Leaves notice within ~8s (four missed 2s heartbeats), or immediately if
     the data channel reports failure.
  3. Board stays on screen. status -> 'reconnecting',
     RoomState.pause.reason -> 'host-migrating'. Same UI the hosted backend
     already uses for a disconnect pause; no new screens.
  4. Election, staggered by seat so the senior survivor claims first and the
     others usually never claim at all.
  5. The claimant broadcasts {claim, epoch+1} over SIGNALLING — the data
     channels to the old referee are exactly what is broken.
  6. Peers ack, attaching their own snapshot if it is ahead of the claimant's.
  7. On reaching quorum the claimant adopts the highest-seq snapshot, rebuilds
     the rules engine from it, and dials everyone at the new epoch.
  8. Play resumes. `seq` keeps climbing, so no client rewinds.
```

Two mechanisms make this safe:

**The fencing epoch.** Every frame carries the referee epoch. When the old
referee's phone wakes up and cheerfully resumes refereeing, its frames carry a
stale epoch and are dropped; the first current-epoch heartbeat it receives
demotes it to a leaf. Without this, a phone coming out of suspend produces two
referees and two divergent boards.

**Quorum.** A claimant needs acks from a majority of the room. Two halves of a
partitioned table cannot both reach a majority, so they cannot both elect a
referee and fork the game.

Rebuilding the engine works because legality in `src/game` depends only on the
board, the config, the status, and which colours are playable — reserves are
*derived* from the board rather than tracked separately. So a snapshot is
sufficient.

Two details make it exact rather than nearly right. A withdrawn seat is removed
from the engine's turn *rotation*, not merely flagged, so `rehydrateEngine`
replays that filter before it does anything else. And the turn index is
recovered by matching both the seat and its due colours, because in the official
2-player game a seat appears twice in the rotation and only the colours tell the
two entries apart.

The move history does not survive; nothing in the protocol exposes it, so
nothing notices.

### A deliberate deviation from `transport.ts`

The interface specifies electing "the lexicographically smallest `PlayerId`
among those currently connected". This implementation elects **the lowest
connected `seat`, tie-broken by `PlayerId`, and never migrates away from a
reachable referee.**

The specified rule is deterministic but not *stable*. `PlayerId` is random, so a
player whose id happens to sort low seizes the referee role the instant they
join — taking it from the person who made the room — and hands it back every
time their connection blinks. The interface's own justification, that the room
creator holds it "initially by construction", stops being true the moment a
second player arrives. Seats are assigned in join order, so seat order gives
every property the rule was reaching for (every peer computes the same answer
from the same shared inputs, no vote, no tie-break) plus the one it was missing.

### Failure modes, honestly

| Failure | What happens | Residual risk |
|---|---|---|
| Referee's phone backgrounded briefly | `visibilitychange` fires an immediate probe and ICE restart on return. ~1s, usually invisible. | None worth worrying about. |
| Referee's phone suspended by iOS, then returns | Migration completed while it was away. It is fenced out by epoch and demotes itself. | A short window where it may have applied a move it never broadcast. Recovered by the snapshot-ahead ack, unless *no* survivor saw it — then that one move is lost. |
| Referee leaves permanently | Migration. Game continues. | None. |
| Two players left, one leaves | Quorum of 2 cannot be met, so no migration. Game ends. | Correct behaviour: a two-player game with one player is over. |
| Table partitions 2–2 | Neither half reaches quorum. Both stall, then fail. | Nobody forks. The game is unrecoverable, which is the honest outcome. |
| Referee is malicious | They can do anything: illegal moves, rewritten boards, fabricated wins. | **Not mitigated. At all.** |
| Any player is malicious | They can send illegal moves, which the referee rejects, and forged `RoomState` frames, which are ignored because they are not from the referee. | Limited to nuisance. |
| Fresh referee after migration | Has no record of anyone's `sessionSecret`, so the first `hello` from each peer re-establishes it (trust on first use). | A brief window in which a spectator could claim a vacant seat. Unpatched by design; the alternative is locking legitimate players out of their own seats. |

The malicious-referee row is not a gap to be plugged later. Cross-validation,
commit-reveal and consensus were all considered and rejected: for a four-player
abstract with nothing at stake they cost more than they are worth, and a
half-measure is worse than nothing because it invites the belief that P2P is
cheat-proof. `Capabilities.impartialReferee` is `false`. Show the badge.

---

## Mobile reality

The four-phones-on-a-table scenario runs headlong into every mobile browser
quirk at once. What the implementation does about each:

**Backgrounded tabs.** iOS Safari throttles timers when a tab is hidden and
freezes the page entirely after a while. WebRTC sometimes survives a short
background and usually does not survive a long one. Waiting for ICE to notice
costs about thirty seconds of consent-freshness timeouts (STUN probes every 5s,
failure declared at 30s), during which the player stares at a frozen board.
`visibilitychange` triggers an immediate probe on return and an ICE restart if
anything is not demonstrably healthy — about a second instead of thirty. Coming
back from the back/forward cache (`pageshow` with `persisted`) restarts
unconditionally, because every socket is dead even though the objects still look
alive.

**Wi-Fi → cellular handover.** The local candidate vanishes and ICE goes
`disconnected` then `failed`. The fix is an ICE restart, which needs signalling
to still be alive — hence the persistent signalling connection, and hence the
restart request travelling over signalling rather than over the data channel
that just died. Only the referee ever initiates a restart; leaves ask for one.
Exactly one side renegotiates, so glare is structurally impossible.

**`pagehide`.** A best-effort synchronous `bye` so the others do not wait out the
full 8-second timeout. iOS gives no reliable async window here; if it does not
land, the heartbeat catches it.

### iOS Safari specifics

- **Lockdown Mode disables WebRTC entirely.** If one person's phone cannot
  connect and everyone else's can, ask.
- **In-app browsers** (opening the link from inside a chat app) are the single
  most common source of unexplained failures. "Open in Safari" fixes a
  surprising proportion of reports.
- **`restartIce()` only exists from Safari 16.** The code feature-detects and
  falls back to `createOffer({iceRestart: true})`.
- **Data channels do not support `binaryType = 'blob'`.** We send JSON strings,
  and set `'arraybuffer'` anyway.
- **`negotiationneeded` timing differs across browsers.** Negotiation is driven
  explicitly instead — with a negotiated data channel and no media, we know
  exactly when an offer is needed.
- **The data channel is created with `negotiated: true, id: 1`,** so both sides
  construct it up front and there is no `ondatachannel` race to lose.
- **Low Power Mode throttles timers**, which mostly manifests as heartbeats
  arriving late. The 8-second silence threshold is four missed beats precisely
  so this does not cause spurious migrations.

---

## Testing

Four tiers, cheapest first. Do not skip to the end; tier 0 catches most of the
bugs and costs nothing.

### Tier 0 — four tabs, no server, no network

```ts
createRtcTransport({ identity, signalingUrl: 'broadcast:otrio' });
```

`BroadcastChannelSignaling` substitutes a `BroadcastChannel` between tabs of the
same browser. Open four tabs of `localhost:5173`, join the same code, play.

This exercises the **entire real WebRTC stack** — real `RTCPeerConnection`s,
real SCTP data channels, real election, real migration — over loopback
candidates. Kill the host tab and watch migration happen.

What it does **not** test: NAT, STUN, TURN, cellular, iOS Safari, or anything
about signalling that is not a message relay. A green run here means "my state
machine is correct", never "this works".

> Each tab needs its own identity. `loadOrCreateIdentity()` persists to
> `localStorage`, which tabs share, so use private windows or distinct
> profiles — otherwise four tabs are all the same player.

### Tier 1 — real signalling, one machine

Run the server (`npm run server`) and point two different browsers — not two
tabs — at it. `/signal` is mounted on the same process as the game socket, so
this is one command. Confirms the relay works before any phone is involved.

If `createRoom` rejects with `SIGNALING_FAILED`, read the message: it carries
whatever the server actually said, so "unknown message type" means you reached
something that is not the relay, while a connection failure means nothing is
listening on that path at all.

### Tier 2 — real phones, same Wi-Fi

**The gotcha:** `RTCPeerConnection` requires a secure context. `http://localhost`
counts; `http://192.168.1.42:5173` does **not**. Phones on your LAN will hit a
page where WebRTC silently does not exist.

Either:

```bash
# a real cert for the LAN address
mkcert 192.168.1.42 && npx vite --host --https
```

or tunnel it, which also gets you a public URL to text people:

```bash
npx vite --host &
cloudflared tunnel --url http://localhost:5173     # or: ngrok http 5173
```

Then, in order: play a full game; background the referee's phone for ten seconds
and bring it back; background it for two minutes and watch migration; turn Wi-Fi
off on one leaf and back on.

### Tier 3 — real networks

At least one phone on cellular with Wi-Fi **off** (not just "not connected" —
iOS will quietly keep using it). This is the first tier that tests NAT traversal
at all. Then try it from somewhere with hostile Wi-Fi — a café, an office — and
expect it to fail. That failure is the information you are buying.

### Tier 4 — prove TURN works

```ts
createRtcTransport({ identity, forceRelay: true });
```

`forceRelay` sets `iceTransportPolicy: 'relay'`, which discards host and srflx
candidates so **nothing** connects unless TURN is configured correctly. If a
game plays through with this on, your TURN works. If it does not, your TURN was
never going to save anyone.

### What to look at when something breaks

```ts
console.log(transport.getDiagnostics());
```

Prints status, referee, epoch, seq, signalling state, roster, and per-link ICE
history — including the selected candidate pair and whether it is relayed.
`ICE server error 401` means your TURN credentials are wrong, and it appears
nowhere else.

- **Chrome**: `chrome://webrtc-internals` — the candidate-pair table is the
  ground truth for what connected and how.
- **Safari on iOS**: connect the phone by USB, Safari → Develop → *device* →
  the page. The only way to see a console on a phone.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `SIGNALING_FAILED` immediately | Wrong URL, service asleep, or `ws://` from an HTTPS page | Check the URL; free tiers that sleep look exactly like this |
| `ROOM_NOT_FOUND` when the code is right | Joined before the creator's `join` landed, or the room expired | Retry; check the server does not drop empty rooms too eagerly |
| `PEER_UNREACHABLE` after ~20s | NAT traversal failed | Try cellular; configure TURN; use the hosted backend |
| Works on cellular, fails on the shared Wi-Fi | AP isolation or blocked mDNS | Nothing client-side fixes this. TURN, or hosted. |
| Everything works except one person | Lockdown Mode, or an in-app browser | Ask them to open the link in Safari/Chrome directly |
| `ICE server error 401` in diagnostics | Wrong TURN credentials | Re-check username/credential; some providers issue short-lived ones |
| Game freezes ~30s after someone's phone locks | A link died and the restart has not landed | Expected shape; if it does not recover, check signalling is still connected |
| Two players see different boards | Should be impossible — snapshots are authoritative and `seq`-gated | File it. Attach `getDiagnostics()` from both. |
| `REFEREE_LOST` | Not enough survivors for quorum | Start a new game; with 2 players this is the designed outcome |
| Board frozen, "waiting for host" forever | Migration could not complete | Check signalling is reachable from the *survivors*, not just from you |

---

## Known limits

Nothing here is a bug to be fixed later. These are consequences of the design.

1. **No cheat protection.** The referee peer is a player.
2. **Signalling is a hard dependency**, for the whole session, not just at join.
3. **Some networks cannot be made to work** without TURN, and some not even then
   (a network that blocks UDP and 443 TURN is a network that does not want you
   to do this).
4. **Spectators count toward the star's fan-out.** Four players plus spectators
   means the referee's phone holds more connections than the game needs.
5. **Move history does not survive a migration.** Nothing exposes it; noted for
   whoever adds a replay feature.
6. **The centre-medium handicap does not survive a migration.** `bannedSlots`
   is not on the wire, so a new referee rebuilds the game without it. The
   referee never enables it today; if it ever becomes a room option, it has to
   be added to `GameSnapshot` at the same time.
7. **The referee's phone must stay awake.** Realistically, put it on the table
   face-up. This is genuinely a reason to prefer hosted.

---

## So which should you use?

Play a game on each. The interface exists so you can, and the difference you
care about will not show up in a design document.

Expect peer-to-peer to feel slightly snappier and to fail in ways that are hard
to explain to the person it fails for. Expect hosted to be unremarkable, which
in networking is the highest praise available.

If you only want one: ship hosted, keep peer-to-peer behind a toggle, and use it
when you are in the same room as everyone playing.
