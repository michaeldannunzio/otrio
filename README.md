# Otrio

Otrio in 3D, in a browser, for two to four players on whatever phones are in the
room.

Otrio is a small, sharp abstract game: each player has three rings of each of
three sizes, and there are three different ways to make a line. Full rules,
including the ones people usually get wrong, are in [`docs/RULES.md`](docs/RULES.md).

Everyone opens the same URL on their own phone and plays on their own screen.
There is no app store to go through and no account to make. The page will save
itself to a home screen and open again with no network if you want that — see
[Offline and installing](#offline-and-installing).

---

## Quick start

```sh
npm install
npm run dev
```

Open the URL Vite prints. That gets you the game on the machine you are sitting
at; the next section is the part you actually want.

To play against yourself while developing, open several tabs and use the
`broadcast:otrio` signalling mode (see [Transports](#transports)) — it connects
tabs to each other with no server running at all.

---

## Getting four phones into a game

Two commands, two terminals:

```sh
npm run server     # the WebSocket host
npm run dev        # the app, bound to 0.0.0.0
```

Vite prints two URLs. The one you want is the **Network** one:

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.42:5173/     <- this one
```

Everyone joins the same Wi-Fi, types that URL, and one person creates a room and
reads out the room code.

The dev server is configured with `host: true` precisely so that Network URL
exists — by default Vite binds to localhost only and phones cannot see it at all.
The port is pinned with `strictPort`, so if 5173 is busy the server fails
instead of quietly moving to 5174 and invalidating the URL you just read aloud.

You do not need to run the Node server separately if you are only using the
WebRTC transport between tabs — but for four real phones you do.

### If the phones cannot reach it

- **Same network?** Phones love silently staying on cellular. Check Wi-Fi is on
  and that it is the same SSID — many routers have separate 2.4GHz and 5GHz
  networks that do not talk to each other, and "guest" networks almost always
  isolate clients from one another on purpose.
- **Firewall.** On Fedora: `sudo firewall-cmd --add-port=5173/tcp --add-port=8787/tcp`
  (add `--permanent` to keep it across reboots). This is the most common cause.
- **Getting the URL onto four phones** is tedious to type. Generate a QR code
  for it — most terminals can, e.g. `qrencode -t ANSIUTF8 http://192.168.1.42:5173`.

---

## Running the dev server over HTTPS

**This matters more than it sounds like it does.**

`http://localhost` is treated by browsers as a *secure context*. `http://192.168.1.42`
is not. A large set of web APIs is only exposed in secure contexts, and
`RTCPeerConnection` is one of them.

The practical consequence: **the WebRTC transport cannot work on phones over
plain HTTP on your LAN.** Not "works slowly" — `RTCPeerConnection` is simply not
defined, and the code fails where it tries to construct one. The WebSocket
transport is unaffected and works fine over plain HTTP.

So if you are testing the P2P path on real phones, you need HTTPS. Three ways,
in increasing order of how well they work:

### 1. mkcert — recommended for LAN testing

[`mkcert`](https://github.com/FiloSottile/mkcert) makes a local certificate
authority and issues certificates from it.

```sh
mkcert -install
mkdir -p certs
mkcert -key-file certs/dev-key.pem -cert-file certs/dev-cert.pem \
       localhost 127.0.0.1 ::1 192.168.1.42   # <- your actual LAN IP
npm run dev
```

`vite.config.ts` picks up `certs/dev-cert.pem` + `certs/dev-key.pem`
automatically and switches to HTTPS. `certs/` is gitignored.

The catch: each phone must trust your local CA, or it will show a full-page
certificate warning. Copy `"$(mkcert -CAROOT)/rootCA.pem"` to the phone and
install it — on iOS that is a two-step dance (install the profile in Settings →
General → VPN & Device Management, **then** separately enable it under Settings →
General → About → Certificate Trust Settings). Android puts it under Settings →
Security → Encryption & credentials → Install a certificate → CA certificate.

Worth doing once. Tedious to do for four borrowed phones.

### 2. A tunnel — recommended for other people's phones

```sh
npm run dev
cloudflared tunnel --url http://localhost:5173
```

You get a public `https://something.trycloudflare.com` URL with a certificate
every phone already trusts, and it works from outside your network too. Nothing
to install on anyone's device.

`vite.config.ts` already allowlists `*.trycloudflare.com`, `*.ngrok-free.app`,
`*.ngrok.io` and `*.loca.lt` — without that, Vite 6's DNS-rebinding protection
rejects the tunnel's `Host` header and serves "Blocked request" instead of the
game. Add your own domain to `server.allowedHosts` if you use a different tunnel.

The catch: every asset round-trips through the tunnel, so it is slower than LAN,
and the 3D scene is not a small payload.

### 3. Just deploy it

Honestly the least friction for a game night. Real certificate, real URL, works
from anywhere, nothing to install. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Forcing the issue

- `VITE_DEV_HTTPS=1 npm run dev` — fail loudly if certs are missing rather than
  silently starting on HTTP.
- `VITE_DEV_HTTPS=0 npm run dev` — force plain HTTP even if certs exist.

---

## Transports

The game can move data between players two different ways. Both implement the
same `Transport` interface in [`src/net/transport.ts`](src/net/transport.ts), so
the rest of the app does not know or care which is in use.

| | `hosted` | `p2p` |
|---|---|---|
| How | Node WebSocket server relays every move | WebRTC data channels, phone to phone |
| Server's role | Authoritative relay, for the whole game | Introduces peers, then goes idle |
| Secure context needed | No | **Yes** — see above |
| Works across networks | Yes | Usually; needs TURN in bad NAT cases |
| Latency in one room | One hop to the server and back | Direct |

Set the backend with `VITE_TRANSPORT` in `.env.local` (copy `.env.example`):

```sh
VITE_TRANSPORT=hosted   # or p2p
```

`TransportKind` is designed to be switchable at runtime — from a URL parameter
or a settings toggle — so the two can be compared without a rebuild. Check the
app's setup code for whether a `?transport=` parameter is wired up, since that
is owned outside this config.

### Signalling, and the no-server mode

The `p2p` transport needs a signalling channel to introduce peers.
`createSignaling()` accepts:

- `wss://…` or `ws://…` — a real signalling server (the one in `server/`)
- `broadcast:otrio` — **no server at all.** Uses `BroadcastChannel` to signal
  between tabs of the same browser. Open four tabs, and you have four players
  on one machine. This is by far the quickest way to exercise the P2P code path
  and it needs neither HTTPS nor a running server.

Set it with `VITE_OTRIO_SIGNALING_URL`.

STUN/TURN configuration lives in `VITE_STUN_URLS` / `VITE_TURN_URLS` — see
`.env.example` and [`docs/WEBRTC.md`](docs/WEBRTC.md).

---

## Project layout

```
src/game/      Rules, board representation, win detection. Pure logic, no
               three.js and no DOM — which is what makes it testable.
src/net/       Transport interface, wire protocol, WebSocket + WebRTC backends.
src/scene/     The 3D board: geometry, materials, animation.
src/ui/        2D interface layered over the canvas.
src/store/     Shared client state.
server/        The Node WebSocket host. Run directly as TypeScript.
public/textures/  CC0 texture payload. Committed (~400K), not fetched at
               install time. `npm run textures` regenerates it.
docs/          Rules, WebRTC notes, deployment, texture licensing.
```

### Scripts

| | |
|---|---|
| `npm run dev` | Dev server, bound to the LAN |
| `npm run build` | Typecheck all three projects, then bundle to `dist/` |
| `npm run preview` | Serve the real production build, also on the LAN |
| `npm run typecheck` | `tsc -b --noEmit` across app, tooling and server |
| `npm run lint` | ESLint. Not part of `build` — see below |
| `npm run lint:fix` | Same, applying the safe auto-fixes |
| `npm run format` | Prettier, rewriting in place |
| `npm run format:check` | Prettier, reporting only |
| `npm test` | Vitest, node environment |
| `npm run server` | The WebSocket host |
| `npm run textures` | Re-download / re-process the textures (idempotent, offline-safe) |

`npm run preview` is the honest way to test on phones: the dev server serves
thousands of unbundled ES modules and behaves nothing like the deployed artifact
over mobile Wi-Fi.

---

## Build configuration notes

A few decisions in `vite.config.ts` and the tsconfigs that are worth knowing
before you change them.

**Three TypeScript projects, not one.** `tsconfig.app.json` (browser, DOM lib),
`tsconfig.node.json` (Vite config and scripts) and `tsconfig.server.json`
(the Node host) target genuinely different runtimes, and `tsconfig.json` is a
solution file that just references all three.

The server project uses `moduleResolution: "nodenext"` on purpose. `npm run server`
hands `.ts` files straight to Node, which strips the types and runs them as real
ESM — and under ESM, relative imports need a real file extension (`./rooms.ts`,
not `./rooms`). nodenext makes `tsc` report a missing extension at typecheck
time instead of the server dying with `ERR_MODULE_NOT_FOUND` on first boot.

**Chunking.** three.js gets its own chunk, `@react-three/*` and friends get
another, React a third. three.js is ~690kB raw / 177kB gzipped and only changes
when the dependency is bumped, so isolating it means game-code edits do not
force every phone to re-download the engine.

The order of the tests in `manualChunks` is load-bearing. `scheduler` and
`react-reconciler` look like r3f dependencies — r3f does pull them in — but
`react-dom` depends on `scheduler` too. Grouping them with r3f makes the react
chunk import the r3f chunk while the r3f chunk imports the react chunk, and
Rollup reports `Circular chunk: r3f -> react -> r3f`. The React branch
therefore has to be tested *first*. (This was caught by building a throwaway
three + drei page against this config, not in theory.)

**`base` is `'/'`, not `'./'`, and that matters for textures.**
`src/scene/textures.ts` builds its URLs at runtime from
`import.meta.env.BASE_URL` + `textures/<tier>/<file>`. With a relative base
those resolve against the current path, so the moment the app is served from a
nested URL every texture 404s. The hosts below rewrite unknown paths to
`index.html`, which makes nested URLs normal rather than exotic.

**Textures are never inlined.** `build.assetsInlineLimit` explicitly rejects
image, model and texture extensions. Base64 in a JS chunk costs ~33% extra
bytes, blocks the parser, and defeats HTTP caching.

**Strictness.** `strict`, plus `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
Deliberately *not* enabled: `noUncheckedIndexedAccess` (board cells are indexed
constantly) and `exactOptionalPropertyTypes` (the protocol types lean on
optional fields). Both are semantically invasive rather than mechanically
fixable; turn them on per-module later if you want them.

**Path aliases** (`@game/*`, `@net/*`, `@scene/*`, …) are defined in *two*
places that must agree: `resolve.alias` in `vite.config.ts` and `paths` in
`tsconfig.base.json`. TypeScript cannot read the Vite config, so adding an alias
to only one of them produces a project that typechecks and 404s, or vice versa.

---

## Offline and installing

The production build ships a service worker. A phone that has loaded the site
once can load it again with no network at all and get the home screen with
every asset already on the device.

This is `vite-plugin-pwa` (`generateSW` / Workbox) configured in
`vite.config.ts`. It is the only dependency added for it.

**It does not make the *game* playable offline on its own.** It guarantees the
code and assets are present; playing without a network is
`src/net/localTransport.ts`, which is a separate piece of work.

**Nothing was added to `index.html` or `src/`.** `injectRegister: 'auto'`
resolves to `'script'` when no source file imports the plugin's virtual module,
and the build-time `transformIndexHtml` then injects both the
`<link rel="manifest">` and `<script src="/registerSW.js">` before `</head>`.
If you ever `import` from `virtual:pwa-register` in application code, that
auto-injection stops and you own the registration by hand.

**What is precached.** Workbox's default `globPatterns` is
`**/*.{js,wasm,css,html}`, which for this app would produce something worse
than no offline mode: it loads, and then renders an untextured board, because
every texture under `public/textures` is `.webp` and its index is `.json`. The
pattern in `vite.config.ts` is therefore set explicitly. Source maps are
excluded on purpose — 3.9 MB of them, fetched only when devtools are open,
which is never the case with no network.

**The one failure mode worth knowing about** is that Workbox silently drops any
single file over `maximumFileSizeToCacheInBytes` — a console warning and a zero
exit code, which produces a build that reports success, installs on a phone,
goes offline and has no 3D engine. The default is 2 MiB and the `three` chunk
is 688,700 bytes, the only file within an order of magnitude of that line.

Two things guard it, and the second is the one that does the work:
`PRECACHE_MAX_FILE_BYTES` in `vite.config.ts` states the limit rather than
inheriting it, deliberately high at ~6.4× the largest chunk so that growth
never turns into a silent drop; and the `Report bundle sizes` step in
`.github/workflows/ci.yml` prints the precache total and **fails the build** if
`assets/three-*.js`, `index.html` or `textures/manifest.json` is not in the
generated manifest. A threshold catches nothing on its own — the assertion is
what turns a silent drop into a red build. Verified both ways on 2026-09-24:
it passes against the real `dist/sw.js`, and exits non-zero against a copy with
the `three` entry removed.

**Updates are automatic** (`registerType: 'autoUpdate'` → Workbox
`skipWaiting` + `clientsClaim`). A deploy replaces the cached shell on the next
visit with no "new version available" prompt to design and localise. The cost,
recorded because it is easy to rediscover as a mystery: the new worker takes
over tabs that are already open, and this app code-splits. A tab loaded *before*
a deploy that lazy-loads a chunk *after* it asks for a hash the new precache no
longer has and the host no longer serves. The window is one deploy wide and a
reload fixes it.

**The navigation fallback has an explicit denylist.** Unknown paths are served
the cached `index.html` so `/room/ABCD` works offline, except for the paths the
Node host owns: `/ws`, `/signal`, `/api`, `/healthz` and `/health`. These matter
in the one-container / one-origin shape (`Dockerfile`, `fly.toml`,
`render.yaml`, `railway.toml`) and under `npm run preview`, where the app and
the server share an origin.

Worth stating exactly how small the risk was, so nobody re-derives it in a
panic: Workbox only applies that fallback to requests whose mode is `navigate`,
and a WebSocket handshake is not a fetch and never reaches a service worker at
all — so a game socket could not have been swallowed mid-game either way. What
the denylist actually buys is those URLs staying reachable from the address bar
once a worker is installed, and cover for any future non-WebSocket `GET` under
`/api`.

**There are no icons in the manifest, and that is a gap, not an oversight.**
`public/` contains textures and nothing else: no logo, no favicon (the
`/favicon.svg` that `index.html` links has never existed in this repo), no
brand source anywhere outside `node_modules`. **Chrome will not offer to
install a PWA without an icon of at least 192px, so the app is not yet
installable on Android.** iOS "Add to Home Screen" still works, with a
screenshot for a tile — and note that iOS ignores manifest icons entirely for
that tile; it reads `<link rel="apple-touch-icon" sizes="180x180" href="…">`
from `index.html` and nothing else.

Adding artwork is a brand decision, not a build one. What is deliberately *not*
here is a `<link>` pointing at an icon file that does not exist: this repo
already carries one of those (`/favicon.svg`, linked since the first commit,
never added) and it fails as a silent 404 rather than an error. When a source
mark lands in `public/`, three things go in together: 192 / 512 / maskable
entries in the `manifest` block of `vite.config.ts`, a 180×180
`apple-touch-icon` PNG, and the one `<link>` in `index.html` that points at it.

One more known cost: a web manifest colour cannot be theme-aware, so
`theme_color` / `background_color` follow the same single light value
`index.html` already picked for its static `<meta name="theme-color">`. A
dark-mode user gets a light splash frame before first paint. There is no fix at
this layer.

---

## Linting and formatting

`eslint.config.js` is not a generic preset. Every rule it turns on or off maps
to something that actually went wrong while this was built, or to a rule in the
house standards. The reasoning is in the file, next to each rule.

The one worth knowing about is a small local rule, **`local/no-unbundlable-import`**.
It rejects any dynamic `import()` whose specifier is not a string literal, and
any that carries `@vite-ignore`. Both produce the same failure: the bundler
never follows the import, emits no chunk, and the app 404s at runtime from a
build that exited 0. That is how this project shipped a production bundle with
71 modules and no three.js in it. It is a custom rule rather than a text search
for `@vite-ignore`, because the codebase now contains several comments that
*explain* that bug, and banning the marker by text would flag the documentation
along with the disease.

Formatting is Prettier's job alone — `eslint-config-prettier` runs last and
switches off every stylistic ESLint rule, so the two cannot disagree.

**Lint is deliberately not part of `npm run build`.** A lint finding should not
stand between someone and a working artifact. It runs in CI instead.

### Honest state of it

- **`npm run lint`: 18 errors, 113 warnings.** All pre-existing, none
  build-breaking. The errors are 7 async functions passed to JSX attributes
  expecting `void`, 5 `eslint-disable` comments with no stated reason, 4
  type-only imports not marked `type`, plus two singletons. They belong to the
  UI, scene and animation owners rather than to this config.
- The warnings are mostly 63 genuinely redundant type assertions (spot-checked:
  `easeOutCubic as Easing`, where the value is already an `Easing`) and 15
  `react-hooks/exhaustive-deps`. Graded to warnings on purpose — a lint that
  fails with 167 errors on its first run is a lint everyone switches off.
- **No format pass has been run.** Prettier would rewrite **77 of 131 files**
  across every owner's directory at once. That belongs in a single isolated
  commit at a quiet moment, not mixed into feature work. Run `npm run format`
  when nobody else is mid-edit.
- Both CI steps are `continue-on-error` until the above is cleared, so the job
  reports findings without being red from its first run. Remove that once
  `npm run lint` is clean — the marker comment in the workflow says so.

Only the classic two React hook rules are enabled (`rules-of-hooks` as an
error, `exhaustive-deps` as a warning). `eslint-plugin-react-hooks@7` ships the
full React Compiler rule set in both its presets, which is a real adoption
decision with real work behind it; that belongs to the UI and scene owners, not
to the build config.

## Deployment

**Not ready to deploy.** `fly.toml`, `render.yaml`, `railway.toml` and the
`Dockerfile` are all written, but they assume the server serves the built
`dist/` — and it does not. A deploy in that shape starts cleanly, passes its
health check, holds WebSocket connections, and 404s the page. Which side moves
is an open decision; it is the first thing in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Vercel is a poor fit for the WebSocket half — its serverless functions are not
designed to hold a long-lived connection. That is covered honestly in the
deployment doc rather than papered over.

No credentials are committed anywhere. You supply your own.

---

## Verification status

Being straight about what has actually been observed working, because this was
built by several agents in parallel and "it compiles" is not the same as
"it runs".

Each claim below says *when* it was true, and where possible which commit it
was true at. That matters more than usual here: this tree moved repeatedly
while this section was being written, and several claims in it were already
stale within the hour. A verification note without a timestamp is worth very
little.

> ### Current state: green
>
> As of **2026-09-24 12:50**, `tsc -b --noEmit --force` reports **0 errors**,
> `npm run build` exits 0, and `npm test` is **165/165 in 6 files**. Run on a
> tree that also carried another author's uncommitted `src/net/protocol.ts`
> work, so treat it as "green including that", not "green without it".
>
> Service worker, same run: **29 precache entries (28 unique — the manifest is
> listed twice, at an identical revision, so Workbox dedupes it rather than
> throwing `add-to-cache-list-conflicting-entries`), 1,645,733 bytes
> (1.569 MB)**. Largest five, in bytes: `three` 688,700, `react` 238,032, app
> entry 210,379, `textures/hd/board_albedo.webp` 74,066,
> `textures/hd/table_normal.webp` 73,526. All 17 texture files are in it, and
> `assets/three-CoY_PLFB.js` was grepped out of `dist/sw.js` by name.
>
> **Not verified:** nobody has opened this in a browser, installed it, or put a
> device in airplane mode. Everything above is build output and emitted-file
> inspection.
>
> The block below is the older snapshot, kept because its chunk table and
> reasoning are still the reference:
>
> As of **2026-09-16 00:45**, `npm run typecheck` reports **0 errors**,
> `npm run build` exits 0, and `npm test` is **165/165**.
>
> The protocol change that this section previously described as in flight has
> landed on both sides. `PlayerColor = 0|1|2|3` is now first-class on the wire
> and severed from `Seat`, so the official 2-player game — each player
> controlling two colours and alternating every turn — is representable. The
> shared referee lives in `src/net/referee.ts` and both backends drive it.
>
> `npm run lint` still reports **18 errors and 113 warnings**, all pre-existing
> and none of them build-breaking. See "Linting and formatting".

**Verified by actually running it — as of 2026-09-16 00:45:**

- **`npm run build` succeeded.** Typecheck of all three projects plus the
  production bundle, exit 0, ~2.7s.
- **The test suite passed.** 172 tests across 6 files (`rules`, `engine`,
  `match`, `simulation`, `api`, `adapter`), 1.7s, all green. The test suite is
  the part least disturbed by the protocol change, since it exercises the
  engine rather than the wire format.
- **The texture payload ships.** All 17 files plus `manifest.json` land in
  `dist/textures/` with the `hd`/`sd` split intact.
- **The chunking works on the real application** (verified 2026-09-16 00:20,
  bundle-only build, 101 modules):

  | chunk | raw | gzipped |
  |---|---|---|
  | `three` | 688.60 kB | 176.80 kB |
  | `react` | 238.02 kB | 75.02 kB |
  | app entry | 76.46 kB | 25.21 kB |
  | `r3f` | 34.47 kB | 13.25 kB |
  | `Scene` (lazy) | 22.78 kB | 9.30 kB |
  | `vendor` | 3.22 kB | 1.25 kB |
  | CSS | 44.76 kB | 8.80 kB |

  three.js is isolated and cacheable, and the 3D scene splits into its own lazy
  chunk automatically. This holds independently of the protocol change above,
  which touches types rather than the module graph.

  An earlier revision of the chunk rules produced
  `Circular chunk: r3f -> react -> r3f`, caught by building a throwaway
  three + drei page against this config before pointing it at the app. Fixed
  and re-verified — see the note on ordering in "Build configuration notes".
- **`npm run typecheck` runs all three projects** and reports real errors
  (2s, uncached).
- **The server starts.** `node server/src/index.ts` boots on Node 24 with no
  flags — type stripping is on by default — binds, and serves.
- **`server/` can import `src/net/protocol.ts`** at runtime; that file is
  self-contained, and the import carries an explicit `.ts` extension.
- **The dev server is reachable over the LAN.** It starts in ~70ms, binds to
  all interfaces (`*:5173`), prints the Network URLs, and answers HTTP 200 on
  the LAN address as well as on localhost. So the "type this URL into four
  phones" flow above is real — what has *not* been done is typing it into an
  actual phone.
- **`npm run preview` serves the production build over the LAN**, and
  `/textures/hd/board_albedo.webp` returns 200 from it — so the built artifact
  and its asset paths are correct end to end.
- **The deployment configs are syntactically valid.** `fly.toml`,
  `railway.toml` (TOML), `render.yaml` and the CI workflow (YAML) all parse.
  That is *all* that has been checked about them — see below.
- **The lint rules fire on the bugs they were written for.** Verified against a
  throwaway file containing each pattern: a variable import specifier, a
  literal import carrying `@vite-ignore`, an unused parameter, an unjustified
  `any`, a floating promise and a swallowing `catch {}` were each reported —
  and a clean literal `import()` alongside them was correctly left alone.

**Known not to work yet:**

- **`main.tsx` still resolves the network transport at runtime, so it will not
  be bundled.** Half of a larger problem; the other half is now fixed, and the
  contrast is the useful part.

  Both `BoardStage.tsx` and `main.tsx` originally loaded their main dependency
  through a *variable* specifier marked `@vite-ignore`, so that each half of
  the app would compile before the other had landed:

  ```ts
  const mod = await import(/* @vite-ignore */ candidate.module);
  ```

  `@vite-ignore` tells the bundler not to follow the import. It emits no chunk
  and never rewrites the path, so in production the specifier resolves against
  the emitted chunk's URL (`/assets/…`), 404s, and the surrounding `catch`
  swallows it. You get the fallback board and a null transport, silently, from
  a build that exited 0. The measured proof was a production build with
  **71 modules and no `three` chunk at all**, for a 3D game.

  `BoardStage.tsx` has since collapsed to a literal
  `lazy(() => import('../../scene/Scene'))`, and the chunk table above is what
  that bought: three.js bundled, Scene split out on its own. `main.tsx` has not,
  because the module it probes for does not exist yet — the transport entry
  point is landing at **`src/net/index.ts`**, and `main.tsx` should import it
  literally once it does.

  The general rule, since this cost a while to diagnose: a specifier Vite cannot
  read statically is a dependency Vite will not ship.

- **`src/game/adapter.ts` has one import Node cannot resolve.** Line 68 imports
  `'../net/protocol'` without an extension. Under Node's ESM loader that is
  `ERR_MODULE_NOT_FOUND`, and `server/` now imports this file, so it matters.

  This is a single missed specifier rather than a systemic gap: the other 57
  relative imports across `src/game/*.ts` all carry `.ts`, as does
  `server/src/rules.ts`'s `'../../src/net/protocol.ts'`. The fix is to match
  them. `tsc` reports it as `TS2835` because `tsconfig.server.json` uses
  `nodenext` specifically to catch this class of error at typecheck time rather
  than at container start.

**Not verified, because it needs hardware and people:**

- Four real phones connected to one game. Nobody has done this.
- WebRTC between physical devices, over any network. The secure-context
  reasoning above is from the specification and is solid, but the code path has
  not been exercised phone-to-phone.
- TURN relay behaviour. No TURN server has been configured or tested.
- Any deployment — and worse than unverified, **the recommended shape is known
  broken**. The configs assume the server serves `dist/`; it serves no files at
  all. Verified by reading `server/src/index.ts`: no `OTRIO_STATIC_DIR`, no
  filesystem access, and an HTTP handler that answers `/healthz`, `/health` and
  `/` then 404s everything else. A deploy would look healthy from every angle
  and serve a 404 for the page. See the decision at the top of
  `docs/DEPLOYMENT.md`. This is exactly the class of bug that "written and
  reasoned about" misses and "verified by execution" catches — the configs were
  never run against the server they describe.
- Rendering performance on mobile GPUs.
- Whether the textures actually look right on the board. The files are present
  and committed; nobody has seen them applied to the 3D scene.
- **The end-to-end tests have never exercised the production build.** The
  Playwright suite drives `npm run dev`, so everything it proves is about the
  dev server's unbundled ES modules. The chunk splitting above — three.js on
  its own, React separate, the scene and both transports lazy — is verified by
  reading the build output, not by a browser having loaded those chunks in that
  order and rendered from them. Chunk-ordering bugs live exactly in that gap:
  the circular-chunk error described earlier would not have shown up in dev
  either.

  Closing it is two lines in `playwright.config.ts`: change the second
  `webServer` command from `npm run dev` to `npm run preview`, and point
  `BASE_URL` at `:4173`. Worth doing once before any deployment is trusted.

- **The CI workflow has never run.** GitHub Actions has never executed
  `.github/workflows/ci.yml` — the repository has no remote. Its steps are the
  same commands verified locally, but the workflow file itself is unexercised.
- **The container has never been built.** Docker is not installed on the
  machine this was assembled on, so `Dockerfile` has not been run even once.

**Toolchain rough edges — all three now fixed, recorded because the reasoning
still matters:**

- **`vitest` is now `^3`.** It was `^2.1.x`, which hard-depended on `vite@^5`
  while the app runs vite 6, so npm installed a second Vite nested under
  vitest. Verified resolved: there is now exactly one copy of Vite in the tree,
  and all 165 tests pass under 3.2.7. `vitest.config.ts` remains a separate
  file, but now for readability rather than necessity.
- **`ws` moved to `dependencies`.** The server imports it at runtime. The
  Dockerfile used to work around this by hand-copying `node_modules/ws`, which
  worked only because `ws` happens to have no transitive dependencies — a
  second one would have produced a container that built cleanly and died on its
  first import. It is now a plain `npm ci --omit=dev`.
- **`@types/node` is now declared.** It previously resolved only transitively,
  while two of the three tsconfigs name it in `types`.
