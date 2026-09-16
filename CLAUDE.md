# Otrio — project notes

House rules live in `~/.claude/CLAUDE.md` and apply here. This file is only what
is specific to this project. (Keeping one copy of the rules, per rule 4.)

## What it is

The board game Otrio, in 3D, for 2–4 players across phones to ultrawide.
Vite + React + TypeScript + react-three-fiber. Two interchangeable network
backends: a hosted WebSocket server and WebRTC peer-to-peer.

## The rules are normative and sourced

`docs/RULES.md` is derived from the actual Spin Master print-production artwork
for the shipped instruction sheet, cross-checked against 10+ sources, with every
claim tagged `[OFFICIAL]` / `[CORROBORATED]` / `[DERIVED]` / `[UNSPECIFIED]`.
**The user's requirement is that the game follow Otrio's rules exactly.** Read it
before making any gameplay decision, and do not simplify a rule to fit a data
structure — three agents hit that wall and the data structure changed instead.

Three facts that contradict what most summaries say:

- The board is **cross-shaped** — a central 3×3 playing area plus 12 storage
  spaces on four arms. Storage has no gameplay function.
- The **small piece is a solid peg**, not a small ring. Only large and medium are
  annuli.
- **2-player means each player controls two colours** and must alternate every
  turn. This is why `PlayerColor` is first-class on the wire and severed from
  `Seat`.

## Ownership

| Area | Files |
|---|---|
| Rules engine | `src/game/**` — pure, no framework, no `Math.random` |
| Wire protocol + hosted backend | `src/net/{transport,protocol,wsTransport}.ts`, `server/**` |
| P2P + shared referee | `src/net/{rtcTransport,signaling,referee}.ts` |
| 3D scene | `src/scene/{Scene,Board,Table,Lighting,CameraRig}.tsx` |
| Pieces + materials | `src/scene/{Piece.tsx,materials/**,geometry/**}` |
| Textures | `scripts/fetch-textures.mjs`, `public/textures/**`, `src/scene/textures.ts` |
| Animation | `src/scene/animation/**` |
| 2D UI + store | `src/ui/**`, `src/store/**`, `src/App.tsx`, `src/main.tsx`, `index.html` |
| Theme + responsive | `src/styles/**`, `src/hooks/use{Theme,Breakpoint,SafeArea}.ts` |
| Build, deploy, docs | `vite.config.ts`, `tsconfig*.json`, `.github/**`, `README.md` |

`src/net/referee.ts` is **shared** — both backends drive it. It owns the engine→wire
projection. There must not be a second one.

## Identity model — the thing most likely to trip you

`PlayerColor = 0|1|2|3` is a **colour** (purple, red, green, blue — fixed by the
rulebook artwork, seated N/E/S/W). `Seat` is a **participant**. They coincide in
3- and 4-player games and diverge in official 2-player. Pieces on the board are
owned by a *colour*; forfeits and turns belong to a *seat*.

`reserves` is length 4, indexed by colour; colours not in play read `{0,0,0}`.
Iterate `colorsInPlay`, never assume `0..n`.

Colour `0` is falsy. Always `cell.small !== null`, never `if (cell.small)`.

## Build lock

One agent holds it. Everyone else: see rule 10 in the house rules.

## Who to talk to

Per house rule 9 you may message a peer on **this project** directly. Copy the ID
exactly; subagents cannot call `ListAgents`, so this table is your address book.

| Name | ID | Owns |
|---|---|---|
| Bill | `a5404e88b42c69129` | `src/game/**` — rules engine |
| Homer | `a19a40a6872d83adb` | `transport.ts`, `protocol.ts`, `wsTransport.ts`, `server/**` |
| Goku | `ab27bd79adcca7c8e` | `rtcTransport.ts`, `signaling.ts`, `referee.ts` |
| Mario | `a377f6e782c62dfba` | `Scene/Board/Table/Lighting/CameraRig` |
| Garfield | `aacca3871733f9c6c` | `Piece.tsx`, `materials/**`, `geometry/**` |
| Bender | `a73d9d7fc1b2fed59` | textures, `scripts/fetch-textures.mjs` |
| Marvin | `a4a88a2fc4c3a4011` | `scene/animation/**` |
| Howard | `af8c15b6768b97ef7` | `src/ui/**`, `src/store/**`, `App`/`main`/`index.html` |
| Linus | `a78e0b322ec7de6d0` | `src/styles/**`, theme/breakpoint/safe-area hooks |
| Charles | `a6d24039a5212c08f` | build, deploy, CI, README — **holds the build lock** |
| Calvin | `a98444110db8bd1d9` | `e2e/**`, `playwright.config.ts` — end-to-end and device tests |
| Milo | `a9105f4258ebc5241` | reporting — the dashboard. Not a code owner. |
| **Arthur** | `a650dd36c969fd96a` | **UX review.** Owns `docs/UX.md` only. Check UX changes with him. |
| **Bob** | `main` | director. Escalate here. |

Good use: *"Goku — what exact shape is `RefereeHost`? I need to satisfy it."*
Bad use: *"Goku — shall we change the wire format?"* That is a proposal; send it
to Bob.

**Charles holds the build lock.** Do not ask a peer to run a build for you — that
is how the power cap gets bypassed by accident. Ask Bob.
