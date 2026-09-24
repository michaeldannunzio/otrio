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

One agent holds it. Everyone else: see rule 13 in the house rules.

## Who to talk to

Per house rule 9 you may message a peer on **this project** directly. Copy the ID
exactly; subagents cannot call `ListAgents`, so this table is your address book.

**Roster rebuilt 2026-09-24.** The previous team did not survive the session
restart. An ID of `—` means that agent is **not live**: do not message it;
message Bob. IDs are filled in as agents spawn.

| Name | ID | Owns |
|---|---|---|
| Bill | — | `src/game/**` — rules engine |
| Homer | `ac1dfac207c303d32` | `transport.ts`, `protocol.ts`, `wsTransport.ts`, **`index.ts`** (the factory), `server/**` |
| Goku | `a53d975f59ed14319` | `rtcTransport.ts`, `signaling.ts`, `referee.ts`, **`localTransport.ts`** (+ one granted case-arm in `index.ts`) |
| Mario | — | `Scene/Board/Table/Lighting/CameraRig` |
| Garfield | — | `Piece.tsx`, `materials/**`, `geometry/**` |
| Bender | — | textures, `scripts/fetch-textures.mjs` |
| Marvin | — | `scene/animation/**` |
| Howard | `a491307867bc00d82` | `src/ui/**`, `src/store/**`, `App`/`main`/`index.html` |
| Linus | — | `src/styles/**`, theme/breakpoint/safe-area hooks |
| Charles | `a4e26f127b21bd5f6` | build, deploy, CI, README, **PWA + app icon** — **holds the build lock** |
| Calvin | — | `e2e/**`, `playwright.config.ts` — end-to-end and device tests |
| Milo | — | reporting — the dashboard. Not a code owner. |
| **Arthur** | `aca99db6fc242eb5a` | **UX review.** Owns `docs/UX.md` only. Check UX changes with him. |
| **Bob** | `main` | director. Escalate here. |

Good use: *"Goku — what exact shape is `RefereeHost`? I need to satisfy it."*
Bad use: *"Goku — shall we change the wire format?"* That is a proposal; send it
to Bob.

**Charles holds the build lock.** Do not ask a peer to run a build for you — that
is how the power cap gets bypassed by accident. Ask Bob.
