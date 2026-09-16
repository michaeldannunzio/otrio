# UX — the standing checklist

Owner: Arthur. **Advisory, not normative** — `docs/RULES.md` is the only normative
document. Where this file and the rules disagree, the rules win and this file is wrong.

This is not a heuristics list. Every line below is here because it is a way *this*
product fails, on the evidence in `e2e/screenshots/`. Run it before you message me; if
everything here passes, your change is probably fine and you can ship it and tell me
after.

> **Those screenshots are stale, and you should know how.** All 21 were taken before the
> scene was wired, so every one shows an empty board. Checks 1, 2, 3, 5 and 7 are about
> HUD and copy and stand as written. Anything I have said about the *board* — its size on
> a phone, the storage arms, piece legibility, the table colour — is **provisional** until
> a run exists with pieces in it.
>
> **All 21 are also light mode, and that is not a coverage gap — it is a specific unknown.**
> `BOARD_TINTS` is the same value in both themes on purpose; only the lighting moves. So
> every contrast figure on this page is albedo arithmetic for one rig, and the dark theme
> renders the same slab under a dimmer one. Two things to measure on the first dark frame,
> both currently carried by reasoning rather than a pixel: **board against cloth at 1.52:1**
> (Mario's number — below any luminance floor, relying on hue, the chamfer and the cast
> shadow to separate slab from table), and whether the rendered board sits above or below
> `RIM_BOARD_CEILING_LSTAR` once tone mapping has had its say. A colour-picker on a real
> frame beats every number here, and the `armColors` defect is the proof: contrast failures
> are exactly the class a light-only screenshot set cannot rule out.

---

## The product, in one paragraph

Four people are sitting around a physical table, each holding their own phone, playing a
board game they can all see the pieces of — except they can't, because the board is on
four separate screens. Everything hard about this product comes from that: state has to
be readable **at a glance, from arm's length, out of the corner of your eye**, while the
player is mostly looking at the other people. Nobody reads a HUD. They glance at it.

---

## The seven checks

*This section is the checklist — run it every time. Everything below it is background:
read it once, or when it bites.*

### 1. Can you tell whose turn it is in under a second, without reading?

The turn banner is the single most-glanced element in the app. Colour + glyph + name,
all three, always — never colour alone (a quarter of the table is `▲`/`■`/`●`/`◆`
because red-green is the most common colour deficiency and two of our four colours are
red and green).

**Nothing may overlap it.** Toasts are `position: fixed; top: 0` and land exactly on it
(`src/ui/ui.css`, `.o-toasts`); six of the twenty-one screenshots show the turn banner
occluded by a "X joined" toast. If your change adds anything at the top of the screen,
check it against `10-device-large-phone-412.png` first.

### 2. Is every word legible against the 3D board?

Text with no plate behind it sits on an arbitrary WebGL background. `--text-secondary`
is a token for `--surface`; on the green table it is mud. Compare `.o-sizes__hint`
("Placing Green. Pick a size, then a space.") with `.o-sizes__rule` directly below it —
same size, same weight, and only one of them is readable, because one has a
`--surface-2` pill behind it.

**Rule: any HUD text over the canvas gets a surface behind it, or it does not go there.**

### 3. Does it work in 360 px of width and 640 px of height?

Both are real: the small-phone profile is 360×640 CSS px. A HUD element that grows with
player count (the rail is 2–4 cards, 1–2 colours each) must be checked at **four
players**, not two.

The board must own the middle of the screen and the controls must be in the bottom
third, where a thumb reaches. Both halves of that matter — the fix that moves the
picker down is only half the job if the rail then eats the bottom 40 %.

### 4. Is the rule visible at the moment it bites?

Otrio has three win conditions and one rule that reads as a bug (2-player mandatory
colour alternation, §4.6). A player sitting on a winning placement they are not allowed
to make will conclude the board is broken, not that they have misread a rule.

So: **state the rule at the control, not in a help screen.** `alternationNote()` in
`src/store/colours.ts` is the model — one sentence, present tense, names the colour.
If you add a constraint the player can hit, it needs the same treatment.

### 5. Does a sighted player know what just happened?

`useNarration` announces every move ("Grace played medium in the centre") — into a
**polite live region**, which no sighted player ever perceives. Look away for ten
seconds in a four-player game and there is currently no way to find out what changed.

If you build something that changes the board, ask who sees it: the screen-reader user,
the sighted user, or both. "Both" is the only correct answer.

### 6. Is `TextBoard` as good as the 3D board?

It is a first-class surface, not a fallback — it is what a keyboard user, a screen-reader
user, and anyone whose phone has no WebGL actually plays on. Two specific things it has
to survive:

- **A cell holding three rings of three different colours.** That is the normal end-state
  of a cell, not an edge case, and it has to be readable at the cell's real rendered size.
- **Being pinned open on a 360 px phone**, where it takes 13 rem off the stage.

Anything you add to the 3D board (a win highlight, a legal-move hint, a last-move marker)
needs an answer here too, or the keyboard player is playing a worse game.

### 7. Does the failure say what to do?

`src/ui/lib/copy.ts` is the standard and every user-facing sentence belongs in it. Say
what happened, then what to do. Never a bare disabled button — `startCheck`'s blockers
list is the pattern. A dropped phone in a four-player game is Tuesday, not a failure, and
the words should reflect that.

Check the failure screen is actually *visible*: `13-no-webgl-fallback.png` has correct,
well-written copy that is completely hidden behind the player rail and a toast.

---

## The recurring trap: "unknowable, or unknowable *from here*?"

Howard named this after it bit the same layer three times in one night, and it is the
single cheapest question on this page:

| What was believed | What was true | What it cost |
|---|---|---|
| A seat and a colour are the same thing | They are — in 3- and 4-player games | `reserves[seat]` returns the wrong tray in exactly the config tested last |
| The lobby cannot know a seat's colour | It cannot know the **count**; `buildShape` fixes the colour | A lobby that showed numbers when it could have shown identity |
| The second colour must be hedged | Only *whether*, not *which* — the pairs are a constant | "(+1 if two play)", which parses as a score |

Every one is a **true statement scoped too widely**, and every one had a narrower true
statement sitting one file away that nobody went looking for. Note the third: it was
written *in the same edit that fixed the second*.

So before you hedge, hide, or show a placeholder, ask: **is this fact unknowable, or
unknowable from where I happen to be standing?** If the answer is the second, go and get
it. A hedge is a cost paid by every player on every screen, forever, and it should be
paid for real uncertainty only.

This is also why I flag rather than assume: I made the same mistake in this review,
attaching a contrast figure to the wrong one of the two surfaces in a sentence.

## Things that are settled — do not re-open without Bob

- **The lobby shows seat numbers and no colours.** `PlayerView.colors` is empty until the
  game starts. Reasoning is in `LobbyScreen.tsx`. (I think the *primary* colour is
  predictable from the seat and could be shown; that is a proposal with Bob, not a change
  you should make.)
- **Board tint is `BOARD_TINTS` in `Board.tsx` for 3D, `tokens.ts boardBase/boardLine` for
  2D chrome.** Two values on purpose.
- **Placement is arm-a-size-then-tap-a-space**, not drag-from-a-3D-tray. Reasoning in
  `SizePicker.tsx`.
- **Toasts are not a live region.** `Announcer` speaks; toasts are the visual channel.

## The contrast trap, and what it teaches

Both halves of this were fixed on 16 Sep. It stays here because the *mistake* is the
reusable part, and I made it too.

**What happened:** the piece rim set was derived against `scene.board.base` `#f0f3f8` —
a near-white surface **the 3D scene has never rendered**. The board it actually renders
on was `#453626`. So purple sat at 1.31:1 in the shipped product, below the 3.0 floor,
and nothing caught it, because each side was internally consistent. Lightening the board
did not cause that; lightening the board is what *fixed* it.

**I read that note and reported it backwards** — I warned that lightening the board would
push purple to 1.31:1, when purple was already there and the change was the cure. Two
lessons, and the second is the one worth keeping:

1. A contrast figure means nothing without the pair it was measured against. Quote both.
2. **Check that both surfaces in a contrast pair are ones the product actually draws.**
   This project has two legitimate board colours — `tokens.ts boardBase` for 2D chrome,
   `BOARD_TINTS` for the 3D material — and deriving against the wrong one is silent.

The structural fix is worth copying: rims now key off a published
`RIM_BOARD_CEILING_LSTAR = 34` in `tokens.ts` rather than off any board hex, so the scene
can retint freely below the ceiling without a round-trip between owners. **A published
limit beats a standing agreement between two files.**

It paid off a second time within the hour. Mario could write "pass `players[i].rim`" in a
prop doc **without knowing what board the caller would draw it against**, because the
guarantee travels with the set. That is the difference between a measurement (true of one
pair, on one day) and an invariant (true of every caller, forever). Reach for the second.

The part worth being precise about: the invariant is what made the fact **citable by
someone else**. Howard corrected his own call site off Mario's prop doc, without either of
them talking to the other. A measurement in one agent's head could never have done that —
it would have needed a conversation, and the conversation is the thing that doesn't happen.

**Publish intermediate figures, not conclusions.** Same family, and the sharpest version
of it. Linus found a wrong conclusion inside a file he cannot see, using four numbers
Mario had published and nothing else — three were internally consistent, the fourth wasn't,
and the discrepancy turned out to be a modelling difference neither of them knew existed
(45° chamfer normals vs vertical faces; the board has both). He never needed to replicate
the lighting rig.

"The edge is fine in both themes" is unfalsifiable by a peer. `0.909 / 0.895 / 2.172 /
2.154` hands them the tools to disprove it. **A constant beats an agreement; a figure beats
an assertion.** Both turn "ask the owner" into "check the number," which is the only thing
that scales past about three people.

## If someone asks for a lighter board again

They already did once — it is what started this review — so assume it recurs.

**Lightening is free to L\* 36 and expensive past it, and the expense is not contrast.**
The full ladder is in `Board.tsx` above `BOARD_TINTS`; the short version:

| L\* | |
|---|---|
| 31.1 | where it is now — deliberately under the ceiling, margin for tone mapping |
| 34 | the published ceiling (`RIM_BOARD_CEILING_LSTAR`). Free. |
| 36 | the real wall. Costs only red's rim chroma. Ask theming. |
| 38 | **a cliff, not a gradient** |

At 38, green's rim is pushed into its own fill (L\* 79.9) and has to jump *over* it to
L\* 91 — a pale yellow-green that stops reading as the green player's colour.

So past 36 the honest framing is **"this trades the green player's visual identity for
board lightness."** That is a product call and it goes to Bob. It must not be absorbed as
a derivation detail by whoever happens to pick up the request, which is exactly how it
would disappear.

**Name the backdrop, every time.** I told Mario the green player's arm bar had to stay
legible against the table cloth. The bars are inlaid in the *board slab* — his own comment
says so, and I had read it. Purple's bar measures 1.26:1 against the board, so the check
was worth running and I aimed it at the wrong surface. A contrast claim needs both halves
named or it is noise.

**And check the seam.** That defect was live: `Board.tsx` documents `armColors` as
requiring `rim`, `BoardStage.tsx` passes `base`. Mario was right about his file, Howard
was right about his, and each had a current-but-stale read of the other's. Neither could
see it from where they stood. When a value crosses an ownership boundary, somebody has to
look at both ends on the same day — that is a large part of what this role is for.

**Still open, and it's a hue question, not a contrast one:** the table felt is now themed
(`TABLE_TINTS` in `Table.tsx`) but it is still green, and green is also a *player* colour.
The scan is near-neutral and takes any tint, so it is a one-value change whenever someone
decides. Nobody has seen it rendered with pieces on the board yet.

---

## How to use me

Message me with the screenshot or the diff and the one question you actually have.
I answer in minutes; a review that takes longer than the change blocks the shop.

I will always separate **broken** (a player cannot do the thing) from **preference**
(I would do it differently). The user has good taste and will overrule me on the second
category, which is correct — so I will never dress one up as the other.

Every review I write ends with **what not to touch** — the things that are already good,
named specifically. Bob asked for that in all of them and he's right to: knowing which
parts are load-bearing and finished is rarer and more useful than another list of
complaints, and it stops a later change quietly undoing a solved problem.

I own this file and nothing else. I do not edit source.
