# House rules

Read this before writing code. It is loaded into every agent working in this
repo. It exists because ten agents on one tree produced specific, repeated
failures — each rule below is a fix for something that actually went wrong here,
not general advice.

## 1. Never fake a dependency to keep working

The single largest source of wasted effort in this project. Both instances
produced a **green build that could not run**:

- `main.tsx` / `BoardStage.tsx` imported the scene through a variable specifier
  marked `@vite-ignore` so each half could compile without the other. Vite emits
  no chunk for those, so three.js was never bundled. The import 404'd at runtime
  and a `catch` swallowed it. 71 modules transformed, for a 3D game.
- `server/src/rules.ts` bound the rules engine by **probing export names at
  runtime** and calibrating by trying argument orders. It could not bind, and
  failed at boot instead of at compile time.

Both were reasonable-looking stopgaps. Both converted a loud compile error into
a silent runtime failure, which is exactly backwards.

**If a module you need does not exist yet: stop and say so.** Name the module,
name the export shape you need, and escalate. Do not stub it, do not probe for
it, do not guess at it. Blocked and honest beats unblocked and fictional.

Corollary — **crash early.** A `catch` that hides a structural failure is worse
than no `catch`. If the scene cannot load, the app should say so, not quietly
render a fallback board forever.

## 2. Verify; do not trust a report

Files change under you. Tonight, three separate agents acted on stale reads and
two reported "missing" modules that existed. Before you rely on a claim about
another agent's file — including a claim from the coordinator — **open the
file**. `grep` is cheap. Rework is not.

When you report, say when you checked: *"verified at 00:04"* beats *"is"*.

## 3. One concept, one place

DRY, and specifically: a rule, a constant, or a piece of logic gets **one owner
and one definition**. What went wrong here:

- The room lifecycle (seat assignment, ready, rematch, forfeit, turn clock) was
  implemented twice — once in `PeerReferee`, once server-side — because both
  authors found their side empty.
- Player colours were defined **four** times, in four disagreeing palettes. The
  3D board and the 2D UI rendered different colours for the same player.
- Piece geometry was nearly derived twice before one author found the other's
  published constants and adopted them verbatim. That was the right call.

If you need a constant someone else owns, **import it**. If it isn't exported,
ask for it to be exported. Never copy a number across a module boundary; that is
a divergence with a delay fuse.

## 4. Contracts before implementations

An interface is owned by one agent and is the specification everyone else builds
to. `src/net/transport.ts` worked — the WebRTC implementation satisfied it with
zero cross-agent messages. `protocol.ts` did not, because it was written before
`docs/RULES.md` existed and had to be redesigned once the real rules landed.

Read the contract. Build to it exactly. If it cannot express what you need,
**say so and stop** — do not quietly narrow the feature to fit. Three agents
independently discovered the wire format could not represent official 2-player
Otrio; all three were right, and the format changed.

## 5. Orthogonality

Modules should be replaceable without touching their neighbours. Concretely
here: rules know nothing about rendering; the transport knows nothing about
React; animation is a *delta from truth* that always decays to zero, so a
dropped animation is harmless and a piece is always where the engine says it is.
That last design is the standard to match — it makes a whole class of bug
structurally impossible rather than merely avoided.

Ask of any module: *if I deleted this and rewrote it, how far would the blast
radius reach?* If the answer is "everywhere," it is wrong.

## 6. No speculative generality

Do not build the abstraction you might need. Do not add options nobody asked
for. Do not write a plugin system for two cases. The runtime name-probing in
`server/src/rules.ts` was 743 lines defending against version skew that cannot
exist between two modules in the same repo compiled by the same `tsc`.

Delete dead code rather than commenting it out. Remove a compatibility shim the
moment its other side lands.

## 7. Ask, early, in one message

Asking is cheap; a wrong assumption compounds for an hour. If a decision is the
user's to make — a rule the rulebook doesn't settle, a product tradeoff, a
dependency to add — escalate it with a recommendation and your reasoning.
Batch your questions; one clear message beats five.

**Where you invent a rule the source material does not specify, say so in a code
comment at the site, using those words.** `docs/RULES.md` §10.2 is an invented
rule and is marked as such. That is the standard.

## 8. Report honestly

Never claim something works that you have not run. This project has held that
line well and it must continue. Distinguish, every time:

    verified by execution  >  type-checked  >  parsed  >  written and reasoned about

A green `tsc` proves types, not behaviour. Say which one you have. "Written,
never run" is a perfectly good status; "working" when you mean "compiles" is not.

List what you could not verify and why. Rank your own least-confident work — the
provider agent's ranked list of six things it expected to fail was more useful
than its code.

## 9. Do not run builds

**Do not run `npm run build`, `vite build`, or `tsc`.** The machine hard
powers-off under fast CPU load ramps. One designated agent holds the build lock.

You may run: `node --check`, single-file `esbuild` parses, `python3 -m json.tool`,
`grep`/`cat`/`find`, and `nice -n 19 npx vitest run <your-own-directory>` if you
own tests. Anything heavier, ask.

## 10. Style

TypeScript strict. No `any` without a comment justifying it. Named exports.
Comments explain **why**, never what — the code already says what. A comment
that restates the line below it is noise; a comment recording why a constant is
`0.13` and what breaks if it changes is worth more than the code.

Keep functions short enough to hold in your head. If you cannot name it
precisely, it does too many things.
