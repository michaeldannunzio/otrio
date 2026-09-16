# Testing Otrio

Three levels, and this file is about the third.

| Level | Where | What it proves |
|---|---|---|
| Unit | `src/game/**.test.ts`, run by `npm test` | Pure rules logic. Fast, exhaustive, no I/O. |
| Server | `server/**`, driven by the same runner | The referee against the real engine. |
| **End to end** | **`e2e/**`, run by `npm run test:e2e`** | **The actual app, in a real browser, driven like a person — several browsers at once where the product is several browsers at once.** |

A green unit suite proves the rules. A green `tsc` proves the types. Neither has
ever caused a board to appear on a screen. That is what this directory is for.

## Running it

```sh
npm run test:e2e                       # everything, serially
npm run test:e2e -- e2e/specs/01-render.spec.ts
npm run test:e2e -- -g "nine plies"    # one test by name
npm run test:e2e:report                # open the last HTML report
```

Playwright starts both halves of the product itself — the Node game server on
`:8787` and the Vite dev server on `:5173` — and reuses them if they are already
up. Nothing needs starting by hand.

You need the browser once:

```sh
npx playwright install chromium        # ~115 MB, network-heavy, CPU-light
```

### The machine's power limit

This box powers off hard when CPU load ramps quickly; the ceiling is load ~6.
`playwright.config.ts` therefore sets `workers: 1` and `fullyParallel: false`,
and both dev servers are launched under `nice -n 19`.

Note what the expensive part is. It is **not** the browser download and it is
**not** the dev server. It is software WebGL: each browser context that renders
the board costs roughly a full SwiftShader rasteriser, and a four-player test is
four of them alive at the same time. Measured on this machine:

| Situation | 1-min load | CPU busy |
|---|---|---|
| idle | 0.4 – 1.1 | ~0 % |
| 2 contexts rendering | ~1.6 | — |
| 3 contexts rendering | ~3.0 | — |
| 4 contexts rendering | ~4.9 | — |
| whole suite, serial | peak 5.1 while running | peak 63 % |

Four contexts in one room is not parallelism that can be turned down — four
players in one room *are* four browsers that must be alive simultaneously. Keep
it as one test containing four contexts, which is what `03-multi-client.spec.ts`
does. If you need more headroom, cut the number of *rendering* clients (open
some with `noWebGL: true`), not the number of players.

Watch `/proc/loadavg` rather than the clock, and remember the 1-minute average
lags: it keeps climbing for a minute after a run finishes, and it counts
uninterruptible I/O, so a big download reads as a load spike that is not one.

## What software rendering does and does not prove

Headless Chromium has no display server here, so `playwright.config.ts` forces
ANGLE onto SwiftShader:

```
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist
```

`--enable-unsafe-swiftshader` is required from Chromium 120 on; without it WebGL
is refused and the app correctly reports "this device can't draw the 3D board",
which looks like a product failure and is not.

That gives a real WebGL 2 context, a real `WebGLRenderer` and a real
framebuffer, so **every line of scene code executes**: a wrong matrix, a missing
material or an environment map that never baked all show up exactly as they
would on a phone.

It proves nothing at all about **performance**. SwiftShader is orders of
magnitude slower than the GPU in the same machine and exercises no vendor driver
path. Nothing in this suite asserts a frame rate, and nothing here should ever
be read as evidence that the game is smooth. Neither is device emulation a
phone: it models viewport, pixel ratio and touch events, not thermal
throttling, not Safari, not iOS safe-area behaviour while the URL bar moves, not
`navigator.vibrate`, not the share sheet.

**Get it onto a real handset before believing the layout, and onto a real GPU
before believing the performance.**

## Layout

```
e2e/
  support/
    app.ts        OtrioApp — one player, one context, driven through roles and labels
    table.ts      openTable() — a room with everyone in it; load sampling
    probe.ts      the three.js devtools hook, the GL report, and WebGL refusal
    pixels.ts     screenshots to disk, plus what is actually in them
    link.ts       a game link you can cut, for testing a drop
  specs/
    01-render.spec.ts        does it render at all, and does a ring appear
    02-two-player.spec.ts    the official 2-player rule, nine plies, through the UI
    03-multi-client.spec.ts  2/3/4 contexts, turn order, reconnect, a player leaving
    04-devices.spec.ts       small phone, large phone, tablet, desktop
    05-accessibility.spec.ts keyboard-only game; the WebGL-unavailable path
    06-p2p.spec.ts           WebRTC: secure context, signalling, a peer game
  screenshots/               the deliverable; overwritten on each run
```

### Principles these tests hold to

**Everything goes through roles, labels and accessible names.** There are no
test-only hooks in `src/`. If a state cannot be read from the DOM, a screen
reader user cannot read it either, and finding that out is part of the job.
There are exactly three exceptions, all setup rather than assertion, all
commented at the site: the three.js devtools hook, seeded `localStorage` prefs,
and a handful of `u-player-N` class reads — which carry the *colour*, the one
thing that distinguishes two pieces belonging to the same person in the
two-player game and that no accessible name exposes per cell.

**A screenshot is the evidence; an assertion is the supporting cast.** Anything
visual writes a PNG to `e2e/screenshots/` first and asserts second.

**Count only what ran.** No test is skipped to keep a run green. Tests that fail
are failing because of a bug, and their failure message names it.

## Things it is easy to get wrong here

- **One context per player.** The identity in `otrio.identity.v1` is
  per-context. Two tabs in one context reconnect as the same player and take one
  seat, which looks like a server bug.
- **The client does not use Vite's `/ws` proxy.** `resolveServerUrl()` special-
  cases dev ports and dials `ws://<hostname>:8787` directly, so the game server
  must be genuinely up. Health-check it at `/healthz` — `/api/health` does not
  exist despite what the proxy config implies.
- **Hot reload will break a test.** Ten agents share this tree, and a saved file
  makes the dev server push a full page reload that wipes the room mid-test.
  `OtrioApp.open` intercepts the HMR socket on `:5173` and never forwards it, so
  the page runs but stops being told about edits. The game socket on `:8787` is
  untouched.
- **Cutting a connection is harder than it looks.** `context.setOffline(true)`
  does not tear down an established loopback WebSocket. `routeWebSocket` +
  `close()` closes only one side, leaving the server's view healthy — the
  dropped client shows a banner while everyone else plays on, which reads as a
  server bug and is entirely the harness. `support/link.ts` wraps
  `window.WebSocket` instead, so the close frame is real.
- **Don't click a `u-visually-hidden` radio.** The player-count control has real
  radios inside their labels; click the label, which is what a person does.
- **Don't re-click an already-armed ring size.** `autoArmSize()` arms the largest
  held ring at the start of every turn. Clicking the selected radio makes
  Playwright wait for its transition to settle, which is long enough for the turn
  to move on.
- **The flat board is 1px until focused.** It is revealed on `:focus-within`, so
  either focus it first or pin it with `{ pinTextBoard: true }`.
- **Colours are absent from the lobby on purpose.** `PlayerView.colors` is empty
  until the game starts, because how many colours a seat gets depends on the
  final player count. Assert their absence, never their value.

## Reading the two-player test

`02-two-player.spec.ts` is the most valuable file here, because the official
two-player game is where `Seat` and `PlayerColor` come apart — two people, four
colours, each holding an opposite pair and obliged to alternate every turn. Both
are `number` on the wire, so a seat used where a colour belongs type-checks
perfectly and returns the wrong ring tray.

The arithmetic consequence is the test: a colour only comes round on every
second turn of its own seat, so **the fastest same-size row takes nine plies, not
five**. The scripted game gives each of the four colours exactly one ring size,
which makes the ascending-line and nested win conditions structurally
unreachable and guarantees nothing ends the game early by accident.

## Adding a test

Prefer the page object. If you need a new reading of the app, add it to
`OtrioApp` rather than reaching into the DOM from a spec, and write the comment
that says which markup it depends on.

If a test fails because of a bug in someone else's module, that is the result.
Leave it failing, make the failure message say what is wrong, and report it.
