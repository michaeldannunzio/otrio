# UX — the standing checklist

Owner: Arthur. **Advisory, not normative** — `docs/RULES.md` is the only normative
document. Where this file and the rules disagree, the rules win and this file is wrong.

This is not a heuristics list. Every line below is here because it is a way *this*
product fails, on the evidence in `e2e/screenshots/`. Run it before you message me; if
everything here passes, your change is probably fine and you can ship it and tell me
after.

**Building offline mode?** The seven checks still apply unchanged. My positions specific to
one shared phone — the handoff, the board's orientation, the setup screen, and every string
that stops being true on one device — are in **"Offline mode"**, below the checks.

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

## Offline mode — one phone, 2–4 people

UI owner: Howard. Contract: Homer's, `git show 62ad566` (code) and `44adec7` (the shop-log
entry). Settled by Bob and not re-openable here: pass-and-play only, no AI, **no auto-save**,
**no lobby in local mode**, `impartialReferee: false`.

Everything below is **written and reasoned, not seen** — no browser, per the standing rule.
Every `file:line` was read on **2026-09-24**. Where I am inferring behaviour from a file that
does not exist yet (`localTransport.ts`), I say so at the site.

### The one fact the whole section turns on

`deriveLocalView` (`src/net/transport.ts:1071`) is fed the **active seat's** synthetic id, by
design — Homer's SINGLE-DEVICE BACKEND notes, and the helper's own doc comment says "who am I"
is a question with a moving answer here. So on one device:

    isMyTurn   is always true
    seat       moves 90 degrees' worth every handoff
    playerId   changes every handoff

None of those is a bug; the three of them are what makes a hot seat work without a second
referee. But **every UI element that reads them was written for a world where they are
constants**, and they now each say something that is true of a different mode. That is this
section. Nearly every fix below is in a *consumer*; any fix that reaches into `src/net/` is
the wrong fix.

### 1. The handoff moment — a pass gate. Not an interstitial, not the banner alone.

**Broken, and it is the first thing to fix.** `TurnBanner.tsx:73` is
``isMyTurn ? 'Your turn' : `${current.name}'s turn` ``. With `isMyTurn` always true, the banner
says **"Your turn" on every turn, for every player, all game, and never shows a name.** The
most-glanced element in the app stops distinguishing the two states it exists to distinguish,
in the only mode where the name is the entire point. Check 1 says colour + glyph + name, *all
three, always*. In local mode the label is the name — `Ada's turn`, never `Your turn` — and the
same goes for the assertive announcement at `:58-59`.

**Position: a pass gate between turns.** Howard proposed it; I agree, with three amendments. It
appears when `room.game.turn` changes seat and stays until the incoming player dismisses it.

- **It is not full-screen and it does not cover the 3×3.** Otrio has no hidden information, so
  an interstitial buys secrecy nobody needs and spends the one thing the incoming player
  actually needs: time reading a position of up to 27 pieces (`ResultOverlay.tsx:31`) that they
  last saw three turns ago. **The card goes in the bottom third, over the rail and the size
  picker** — which are useless to them until they start anyway — and leaves the board clear.
  Not "centred over a scrim": centred is over the board.
- **No timer, ever.** The dismissal *is* the handoff. Deliberate contrast with `ColourReveal`,
  which auto-dismisses at 6000 ms (`ColourReveal.tsx:92`) — right there, wrong here, because a
  timer that fires while the phone is still crossing the table has protected nothing while
  looking like it did.
- **Enforced in `placePiece`, not in pointer-events.** `TextBoard` is always in the DOM and
  always in the tab order (`GameScreen.tsx:130-134`), so a visual cover is defeated by
  Tab+Enter. One gate in the action covers the 3D tap, the flat board and the keyboard alike.
  Howard's call and it is right.

Content, in order: incoming seat's colour as a solid fill + glyph + name; "Pass the phone to
**Ravi**" as the largest type; in the 2-player game the due-colour chip, because under strict
alternation "you are purple and green" is not an instruction and "play green" is (check 4 —
`alternationNote()` is the model); one full-width button in the bottom third, "I'm Ravi — start
my turn".

**Why a gate at all, when a strong banner is cheaper.** Because `RULES.md` §4.3 is `[OFFICIAL]`
and absolute — *"Once a piece is placed, it cannot be moved"*, no capture, no undo, a placement
is final. `engine.ts:411` does export an `undo`, and `engine.ts:397-401` says in as many words
that it exists for reconciliation, not for players. So on one device the **outgoing** player,
still holding the phone, can make an irreversible move on behalf of the **incoming** one, and
there is no recovery path in the rules or in the code. That failure has no online analogue, and
it is the only reason I will spend a tap a turn.

**What it costs on 360×640.** The gate costs nothing persistent — it is transient and sits where
the HUD already is. The banner, which stays, is already paid for: `.o-turn` has
`min-height: var(--hit-min)` (`ui.css:1247`); `--hit-min` is 44 px at `:root` (`tokens.css:94`)
but **48 px under `@media (pointer: coarse)`** (`layout.css:288-291`), so on a phone ≥48 px,
plus `--hud-pad: 12px` (`layout.css:49`) = **≥60 px of 640, 9.4 %, spent today** and more with a
notch. A full-screen interstitial costs **640 of 640 — 100 % — and hides the board** for as long
as it is up. That is the whole argument against it.

The four questions Howard flagged as mine:

- **Gate before the very first turn? No.** `ColourReveal` already runs at start and names the
  opener. Two overlays back to back before anyone has touched the board is worse than either.
  **But `ColourReveal` needs local copy** — 1b.
- **An outgoing "you're done" beat? No.** One panel, one action.
- **A "skip the pass screen" setting? No option at all.** House rule 7. If it turns out to be
  slow, that is data worth having; a setting added pre-emptively is one nobody ever turns off.
- **Assertive announcement? Yes** — "Pass the phone to Ravi. Ravi plays green." In hot seat the
  screen-reader user is the person holding the phone throughout. Make sure it **replaces**
  rather than joins the existing assertive "Your turn." at `TurnBanner.tsx:59`.

### 1b. `ColourReveal` in local mode: stop saying "you", start being the legend

`ColourReveal.tsx:79-80` says "You are Purple" and lists everyone else as *others* (`:109`). On
one phone that frames a shared board as one person's, and it only lands on the opener because
that is who `seat` happens to point at when it fires.

In local mode it is a **seating map**: "Ada is purple — top of the board. Bo is red — right." No
"you", no "others". It is then the legend for a board that never moves (see 2) — still once per
room, still skippable, still 6 s — and it earns its place more than it does online.

### 1c. The setup screen — reviewed as built (`LocalSetup.tsx`, read 13:20)

Howard landed this while I was writing, so this is a review rather than a prescription.
**The shape is right and I am not asking for it to change.** Count → names → Start, in one
card on `HomeScreen` rather than a second screen; `Segmented` for the count, matching
`maxPlayers` at `HomeScreen.tsx:171-181`; Start last and in the bottom third; no Ready step,
no room code, no spectator toggle. The header comment's reasoning — that the online lobby's
"colours are unknowable here" hedge does **not** carry over, because the count is chosen two
fields up — is the "unknowable, or unknowable *from here*?" question answered correctly, and
it belongs in the table further up this page.

Three things, in order of how much they matter.

1. **Broken, and cheap: Enter submits from any field** (`LocalSetup.tsx:133-135`). The
   `onKeyDown` handler is on every `Field`, so at four players a player who types seat 1's
   name and hits Enter — which `enterKeyHint` at `:128` has just told them means "next" for
   every field but the last — **starts the game immediately with three default names.** The
   hint and the behaviour disagree, and the behaviour is the destructive one. Enter should
   advance on every field but the last and submit only on the last, matching the hint that
   is already there.

2. **The name fields do not say they are name fields** (`:122-124`). `label` is
   `seatColourLabel(...)`, so the input's accessible name is "Purple" and its value is also
   "Purple". A screen-reader user hears *"Purple, edit text, Purple"* and is given no reason
   to think a person's name goes there — and a sighted user reading a text box labelled with
   a colour, pre-filled with that colour, has the same problem more quietly. Make the label
   say the job: **"Purple — who's playing?"**, or at two players **"Purple and green — who's
   playing?"**. The badge already carries the colour visually; the label should carry the ask.

3. **Default of 2: confirmed, do not overrule.** It is flagged at `:49-56` as an invented
   default per house rule 8, correctly, and it is the right one — two is the commonest
   pass-and-play case, and it is the count whose rules differ, so defaulting there puts the
   alternation sentence on screen instead of leaving it to be discovered.

Two smaller notes:

- **Defaulting a blank seat to its colour name is better than what I was going to ask for**
  (I had "Player 2"). Naming a seat "Red" means the turn banner, the badge and the board all
  say the same word, and `sanitizeName` is imported from the referee rather than
  reimplemented. Keep it.
- **Once the board is pinned (2), add the side of the screen to each field** — "Purple —
  top". With a board that never rotates, that is a permanent fact about the screen and this
  is the earliest useful moment to learn it. Conditional on 2 landing; do not add it while
  the board still rotates, because it would be false three times in four.

### 2. Board orientation — pin it. And this is Howard's file, not Mario's.

**Decision: the board does not rotate between turns in local mode. Pin it to one constant seat
for the whole game.**

**First, the correction that changes the shape of the question.** This is not a feature to add;
it is one that is already on and has to be switched off. `BoardStage.tsx:136` passes
`seat={useNet((s) => s.seat)}` into the scene, and in local mode `s.seat` *is* the active seat.
So **as the code stands, the board already rotates 90° on every handoff.** And it is a hard
snap, not a tween: `Scene.tsx:390` sets `rotation={[0, yaw, 0]}` straight from
`boardYawForSeat(seat)` (`Board.tsx:410`, `((seat - SOUTH) * PI) / 2`), with no interpolation
anywhere on the path. **Doing nothing is not the neutral option.**

**And it does not need Mario.** `Scene`'s `seat` is an ordinary prop with a default of `SOUTH`
(`Scene.tsx:205`, `:418`). The only thing choosing a value for it is `BoardStage.tsx:136`, which
is `src/ui/**` — Howard's. Pinning is one expression in his own file: no camera work, no
`CameraRig` change, **no reason to spawn Mario and nothing here for Bob to unblock.** Both ends
of that seam read on 2026-09-24, which is most of what this role is for.

Three supporting arguments that were offered for the right answer do not survive that read, and
the right answer deserves the right reasons:

- It is **not a camera swing.** The camera and every light stay fixed and the *board* turns — a
  documented decision with a real reason (`CameraRig.tsx:29-41`: an orbiting camera gives the
  four seats four differently-lit boards, and one of them the worst one).
- It **does not force a re-fit.** `CameraRig` is fitted to `BOARD_BOUNDS.center` / `.halfExtents`
  (`Scene.tsx:374-375`), constants that do not depend on yaw, and the `framing: 'auto'` crossover
  is a function of viewport width only. Nothing refits.
- **`prefers-reduced-motion` would not catch it.** There is no animation to gate — it is an
  instantaneous jump. Which is arguably the worse of the two for a vestibular-sensitive player,
  and invisible to the media query.

**Why pinned is right on the merits:**

- Online the rotation models *you walked round the table*: the phone moved relative to the board.
  On one phone the phone did not move. A board jumping under a stationary viewer is that
  metaphor inverted.
- What the rotation buys online — "my arm is nearest me" — is bought here by the physical act of
  the pass. **The handoff is the seat cue.** It does not need a second one.
- It costs the thing hot seat is uniquely good at. Everyone watches the same screen all game, so
  every player builds a reading of the position while waiting. Otrio lines are read by
  orientation. Rotating the board between the moment a player last looked and the moment they
  act destroys exactly that reading.
- Storage arms: `framing: 'auto'` clips **horizontally only** — near and far arms survive whole,
  the two side arms clip to their inner ~23 % (`CameraRig.tsx`, his measured numbers). With a
  fixed board the same two arms are always the clipped ones and each player learns their own arm
  once. With per-turn rotation, *which* arms are clipped rotates through the players.

**Pin to `SOUTH`** — pass the constant, not the live seat. `boardYawForSeat(SOUTH)` is exactly
`0`, so the pinned board is the *unrotated* board, which is also `Scene`'s own documented
default. That gives, permanently:

    purple   north   top of the screen
    red      east    right
    green    south   bottom (nearest the camera)
    blue     west    left

which is **pixel-for-pixel the arm diagram `ColourReveal` already draws** (`ColourReveal.tsx:182-187`:
colour 0 top, 1 right, 2 bottom, 3 left). In the rotating case that diagram is wrong for three
players in four. Pinned, the reveal panel is a correct legend for the rest of the game — which is
why 1b matters, and why `SOUTH` rather than seat 0: seat 0 is *north*, so pinning there costs a
180° rotation away from the identity and hands one seat the privileged view on a device nobody owns.

**Load-bearing by accident, so it gets written down.** The `ColourReveal` arm diagram and the
pinned board agree only because `boardYawForSeat(SOUTH) === 0`. Nobody designed that agreement; I
found it by computing both ends. If anyone ever pins to a different seat, that diagram silently
stops describing the screen and nothing fails.

**Updated 13:3x — it is now two dependents, not one.** Howard's `LocalSetup` seat labels say
"Purple — top", so the setup screen's words depend on the same identity. Both sites are
commented, and Howard re-derived `boardYawForSeat(SOUTH) === 0` at both ends himself before
pinning rather than taking it from me — correctly, because it is now load-bearing for three
files and not just a review note.

### 3. The friendly-game badge — replace the section; do not flip the flag

`SettingsSheet.tsx:155-159` renders *"Friendly game — one of the phones is running the rules
rather than a server"* whenever `capabilities.impartialReferee` is false, which
`LOCAL_CAPABILITIES` makes true of local mode (`transport.ts:899`). "One of the phones" is false
when there is one phone.

**`impartialReferee` stays `false`. I am not proposing otherwise and nor should anyone else.**
Homer's reasoning at `transport.ts:869` is right — `true` claims an authority that is not there,
`false` only over-warns — and Bob has accepted it. Changing a capability flag that four call
sites read in order to fix one string is the wrong lever on the wrong file.

**But it should not merely be reworded either, because the section it lives in has nothing left
in it.** "This room" (`:136-174`) is three things: the latency line, the badge, and "Show the
room code". Howard has already hidden both the
latency line and the room code on `isLocalRoomCode` (verified 13:18), which is right and which
is exactly what leaves the heading standing over the badge alone. Rewording the badge leaves a heading over one sentence about a trust
relationship with no second party — on one device every player watches every move land, which is
a stronger guarantee than any badge can be.

**So replace the section.** Gate on `isLocalRoomCode(room.code)` — Homer's supported feature
detect — never on `capabilities.kind`, which is diagnostics-only and says so.

    heading   This game
    line 1    Everyone is playing on this phone.
    line 2    Nothing is saved — closing the app ends the game.

Line 2 is the one that earns its place, and it is there because of the PWA rather than in spite
of it. Charles's service worker makes the app open offline and behave like something installed
(`TEAM.md`, 12:55) — and installed apps are expected to resume. This one will not: the user
declined auto-save (Bob, 2026-09-24) and nothing persists room state (`grep -rn 'localStorage\|sessionStorage'
src/store src/ui` on 2026-09-24: **no hits**; only `prefsStore` persists, and only preferences).
A four-player game abandoned to a phone call is gone, and nothing on screen says so.

**Since written, confirmed at the source:** `localTransport.ts:89-93` states that seats 1..n-1
are minted fresh and **never persisted**. Combined with the grep above, "nothing is saved" is
now read from a positive claim at the owning site rather than only from an absence. Still not
watched dying in a real browser.

### 4. Splash colour — change one value, and it is not about themes

A manifest colour cannot be theme-aware: there is no media form for `background_color`, so "make
the splash theme-aware" is not a thing that can be done, and nobody should spend an hour finding
that out. Charles established this independently; it is confirmed here so it stops being
re-derived.

What is left is which population eats the flash, and that is **not** a coin flip. Two independent
arguments, same direction:

1. **The asymmetry.** A bright flash in a dark room is materially worse than a dark flash in a
   lit room — dark adaptation takes minutes, light adaptation seconds, and dark-mode users are
   disproportionately the ones in dark rooms. A light `background_color` puts the bad case on the
   population already in the dark.
2. **The icon's own ground is `#0b0e13`.** Against a light splash the icon is a dark tile pasted
   on near-white and reads as a mistake. Against its own ground the splash reads as one designed
   surface.

**So: `background_color` → `COLORS.dark.bg` (`#0b0e13`), imported not retyped, same as the icon.
`theme_color` stays light and matching `index.html`** — it tints browser chrome while the app is
running, which is a different job with a different neighbour. **The two values differing is
deliberate and needs a comment at the site saying so**, or the next person "fixes" the mismatch
and puts the flash back.

Do not build a theme-aware splash. It does not exist.

### 5. Everything else that would lie on one device

Grepped `impartialReferee`, `hostMigration`, `reconnect`, latency/`rtt` and the identity-derived
flags across `src/ui/**` and `src/store/**` on 2026-09-24. **Broken** = a player is misinformed.
**Noise** = merely pointless.

| Site | On one phone | |
|---|---|---|
| `HomeScreen.tsx:129` | Tagline: *"For two to four people, **one phone each**."* The first sentence anyone reads, false for half the product — and as of 13:17 it sits **six lines above a button that says "Play on this device"** (`:160-162`), so the screen now contradicts itself in one viewport. Suggest: *"…For two to four people, on one phone or on four."* | broken |
| `TurnBanner.tsx:58,73` | "Your turn", every turn, no name. See 1. | broken |
| `SettingsSheet.tsx:69-75` | "Your name" field. `setName` rejects `UNSUPPORTED` (Homer), but `prefs.setName` still updates the local store — so the field **appears to work and changes no seat name**. Silent success is the worst failure shape there is. Do not render it; seat names come from `seatNames` and change only by starting a new game. | broken |
| `SettingsSheet.tsx:149-153` | Latency: *"Connection quality unknown"* — nothing pings, `rttMs` stays `null` (`initialQuality()`, `transport.ts:363`), `gradeQuality(null)` → `'unknown'` (`:355`), and the sentence reads as a link being measured badly rather than as no link at all. **Already fixed** by Howard at 13:18, gated on `isLocalRoomCode`. Verified — and independently confirmed at the other end: `localTransport.ts:110-124` holds `initialQuality()` for the life of the transport and says so, having rejected `0` because it would read as "excellent", a measurement nobody took. | fixed |
| `SettingsSheet.tsx:169-173` | "Show the room code" — `joinRoom` rejects every input (Homer), and `isPlausibleRoomCode` is `false` for a local code, so the offer cannot work. **Already fixed** at 13:18. Verified. **But `RoomInfoSheet:194-208` still carries *"Anyone with this can join, if there is a free seat."*** — unreachable in local mode now, so harmless, and worth leaving exactly as it is rather than adding a branch for a path nobody can take. | fixed |
| `SettingsSheet.tsx:222-228`, `:240-244` (`LeaveSheet`) | Leave copy: *"the others keep playing without you"*, *"there is no reconnect window"*, *"your seat is held for a while"*, and for seat 0 *"Someone else will take over as host."* On one phone, leaving ends the game for everyone in the room, physically. Say that. | broken |
| `ResultOverlay.tsx:86,108` | `isWinner` compares to `selfId`, which at `finished` is seat 0 (Bob). **Seat 0 wins → "You win", no name. Any other seat → "<name> wins", correct.** A one-in-N inconsistency on the most photographed screen in the product. Always name the winner. | broken |
| `ResultOverlay.tsx:226-232` | **I was wrong here and the correction is worth more than the original.** I read the rematch copy as broken. Goku verified *by execution* that `RoomState.rematch` is never observable as a pending offer on this backend — `null` before the call and `null` after, because no turn of the event loop passes while it is partial. So `rematch.offered` is always `false` locally, the existing `!offered` branch already renders the plain "Play again" I asked for, and the two "waiting on someone" branches are **unreachable rather than wrong** — and still correct online. Changing them would have been a no-op locally and a regression online. **No change needed.** | my error |
| `PlayerRail.tsx:158-163` | A `ConnectionDot` on every card, all identical and permanently online, in the one component that must fit four cards into 360 px (its own comment budgets ~74 px each). Drop it; give the width to the name. | noise |
| `LobbyScreen.tsx` (all) | Not reached — Bob's "no lobby in local mode", the UI calls `startGame()` immediately. Make it **structurally** unreachable rather than conditionally silent; every line in it is wrong here. | — |
| `MoveLog.tsx:74-80` | *"Moves marked ~ were recovered after a reconnection."* Gated on `hasInferred`, which only a snapshot gap sets (`moveLogStore.ts:160`), and there are no gaps. **No change needed** — said out loud so nobody "fixes" it. | none |
| `useNarration.ts:40-95` | `playerJoined` / `playerLeft` / `playerReconnected` / `hostChanged`. None can fire. **No change needed.** | none |
| `useNarration.ts:155-159`, `copy.ts:36,46,257-261`, `ConnectionBanner.tsx` | *"Connection lost. Reconnecting."*, *"This device is offline. Reconnect to Wi-Fi or mobile data"*, *"your seat is being held"*. I had this as "ask Goku"; `localTransport.ts` landed, so I checked instead. **Every `setStatus` call site is `'connecting'`, `'connected'` or `'closed'` (`:440,441,471,472,698`) — `reconnecting` and `failed` are unreachable.** So none of this copy can render. **No change needed.** | none |

**One thing to watch, not yet a defect.** `connect()` pushes `'connecting'` and
`'connected'` onto the same queue back to back (`localTransport.ts:440-441`, and again at
`:471-472`), and `describeLink('connecting')` has `banner: true` — *"Connecting to the game…"*.
Whether that ever paints depends on whether both events flush before React renders, which I
have **not** run and cannot settle from a read. If a "Connecting to the game…" strip flashes
on starting a local game, that is where it comes from.

**Nothing in the UI reads `hostMigration` at all** — checked. `LeaveSheet` branches on `isHost`
instead, and that is where the false sentence actually appears. A capability nobody reads is not
a safety net.

**One accidental correctness, written down because the next person will delete it.**
`PlayerRail.tsx:53` derives `isSelf` from `selfId`, which changes every handoff, so the "You"
chip (`:177`) migrates to whichever card is active. On one device that is *true* — the holder is
the active player — and it works for a reason nobody chose. Keep it, and keep this note beside
it. It also means `is-self` and `is-turn` now always land on the same card and two visual
treatments stack: check that at four players on 360 px before assuming it reads as intended.

### 6. Leaving a local game — the copy and the flow (assigned by Bob, 2026-09-24)

**The mechanism is decided and I am not reopening it.** `leaveRoom` reads the code before
leaving and reloads when it was local (`actions.ts:97-110`); the reasoning at `:80-96` is
right, and the dead end it fixes is real — "Start a new game" would silently open another
hot-seat room carrying the previous game's seat names. It is also the only thing that could
fix it without racing `App.tsx`'s connect effect. Good.

What is not yet reviewed is what the player is told, and there are two problems.

**a. The copy is unchanged and every sentence in it is about remote play.** `LeaveSheet`
(`SettingsSheet.tsx:222-228`, `:240-244`) still says *"the others keep playing without you"*,
*"there is no reconnect window"*, *"your seat is held for a while"*, and for seat 0
*"Someone else will take over as host."* `onOneDevice` exists in this file already (`:64`) but
is only used at `:149` and `:169`; `LeaveSheet` does not take it. On one phone, leaving ends
the game for everyone in the room, physically, and then restarts the app. Say that, and say
the *effect* rather than the mechanism — "reload" is an implementation detail a player should
never have to hold:

    title        End the game?
    description  This ends it for everyone and goes back to the start screen.
                 Nothing is saved.

**b. The bigger one: after the game finishes, this button is not an exit — it is the only way
to start a different game, and it is dressed as a destructive action.** `ResultOverlay`'s
"Play again" is a rematch: same seats, same names, same count (`:199-203`). So changing the
player count, or who is playing, means going out through the `variant="danger"` button
labelled "Leave room" (`SettingsSheet.tsx:178-180`, `finished` branch) and coming back in via
"Play on this device". A primary, entirely safe flow is wearing the colour reserved for
irreversible ones, and its label describes a room the player has never thought about.

Split the label on `finished`, and drop the danger styling once there is nothing left to lose:

    mid-game    "End the game"        danger, keeps the two-tap confirm
    finished    "Start a different game"   plain, no confirm — the game is already over

That also gives the post-game screen the thing it currently lacks: a visible answer to "can we
play again with Ravi's sister?", which today is reachable only by guessing that a red button
called "Leave room" is the way forward.

**Check 7 applies here and is currently unmet** — the failure screen has to say what to do. So
does the success screen.

### 7. The icon/splash colour agreement — an invariant, because nothing enforces it

Charles raised this after applying the splash decision, and he is right to have flagged it
rather than left it to luck. Taking the UX half here; the build half is in the README.

**The invariant, stated so it can be cited rather than re-measured:**

> **The icon's ground and the PWA `background_color` are the same colour, and the icon's
> four wedge fills are the four canonical player identity fills.** Whatever those colours
> become, they move together. This is what buys the splash-to-icon seam; it is not an
> observation about today's hex values.

**Why it needs saying.** An SVG cannot import a TypeScript token, so `public/favicon.svg`
carries literals while the manifest imports from `tokens.ts`. Verified equal on 2026-09-24:
the SVG's single ground `#0b0e13` against `tokens.ts:238` `dark.bg: '#0b0e13'`.

**And it is wider than the ground.** The same `grep` shows the SVG also carries
`#7237b8`, `#e8501e`, `#a2d733`, `#1cafd2` — three uses each, one per piece. So the
agreement is held by hand at **five** points, not one, and the other four are the player
identity fills, which are exactly the values a theming change is most likely to touch.
`scripts/` contains only `fetch-textures.mjs`; **there is no generator that reads the token
and emits the icon**, so nothing mechanical connects the two ends.

**The failure mode is why this is a UX entry and not only a build one.** If someone retints
`dark.bg` and nobody re-exports the icon, the result is a dark tile on a *slightly* different
dark splash. That does not read as a palette change — it reads as a rendering bug, and it is
close to unattributable. If a player colour drifts instead, the launcher icon stops matching
the board it launches, which is an identity failure in the one artwork whose entire job is
identity.

**Recommendation, and it is Charles's lane, not mine:** this wants the treatment he already
gave the precache manifest — *"a number here catches nothing; a failing build does."* Either
generate the SVG from `tokens.ts`, or assert at build time that the five literals still match
their tokens. A documented agreement between two files is the thing this page keeps finding
at the bottom of defects; a published limit or a failing build is what replaces it.

### 8. `.app-hud-bottom` is a ROW in portrait, and `.o-game__bottom` has no rule at all

Howard asked me for one number — `.app-hud-bottom`'s height at 360×640 with four players —
to close the "is the pass panel proud of the bottom HUD?" question with a subtraction instead
of a browser. Going to get it, the premise did not survive. Three facts, each verified
2026-09-24:

1. **`.o-game__bottom` has no CSS rule anywhere in the repo.** It is applied at
   `GameScreen.tsx:118` (`className="app-hud-bottom o-game__bottom"`). `grep -rn "o-game"`
   across `src/styles/*.css` and `src/ui/*.css` returns only `.o-game`,
   `.o-game[data-textboard='open']` and `.o-game__menu`. No `__bottom`.
2. **The base rule sets no `flex-direction`** — `layout.css:119-125` is `display: flex;
   align-items: center; gap: var(--hud-gap); width: 100%`, so the initial value `row` applies.
3. **The only `flex-direction: column` for it is landscape-only** — inside
   `@media (orientation: landscape) and (max-height: 500px)` at `layout.css:251`, the block
   whose own comment reads *"Overlays stack vertically inside their rail."*

**So at 360×640 portrait the player rail and the size picker are laid out side by side, not
stacked.** Both are `width: 100%` flex items (`.o-rail`, `.o-sizes`), so each shrinks to
roughly `(360 − 2×12 padding − 8 gap) / 2 ≈ 164 px`.

**Why that matters beyond Howard's subtraction.** `.app-hud-bottom`'s height then becomes
`max(rail, picker)` rather than their sum — so his 150–180 px estimate is likely high, and the
pass panel is *more* proud of the bottom HUD than he assumed, not less. His arithmetic was
sound; the model underneath it was not, and neither of us would have caught that from the
panel's own numbers.

**Is the row intended?** I cannot settle it, and I am not going to assert a defect I cannot
prove. It forks cleanly:

- **`.o-game__bottom` is a dead class**, the row is deliberate, and `.o-rail__list`'s
  `flex-wrap: wrap` is what absorbs four cards into ~164 px — as two rows of two.
- **`.o-game__bottom` is a missing rule**, and the intended column layout has been silently
  absent.

**The evidence leans to the second.** `PlayerRail`'s own header comment budgets *"~74px"* per
card and says *"Four cards at ~74px fit a small phone with room to spare"* — 4 × 74 = 296 px,
which is true at the full 360 px and false at 164 px. That comment was written by someone who
expected the rail to own the width, i.e. expected a column. If they were right, four cards
currently wrap to two rows on every phone in portrait, which is also the single most likely
explanation for the bottom third feeling crowded.

**This is check 3 with a name** — *"the fix that moves the picker down is only half the job if
the rail then eats the bottom 40 %."* A wrapped two-row rail is exactly how it eats it.

**Owner: Howard** (`.o-game__bottom` would live in `src/ui/ui.css`; `layout.css` is Linus's and
needs no change either way). It is one grep to settle and it gates a figure two other people
are now reasoning from, so it is worth settling before the screenshot pass rather than after.

### What not to touch

- **`deriveLocalView` and the three moving values.** They are the design, not a leak.
- **`impartialReferee: false`.** Settled, and for the right reason.
- **The turn banner's structure** — colour fill, `ColourBadge`, glyph, due-colour chip, clock,
  `role="status"`, and the live-region split with `Announcer`. Only the *label* is wrong in local
  mode. It is the best-built thing in the HUD: change one string.
- **`SizePicker`'s "state the rule at the control"** (`:146-150`, `alternationNote()`). The
  2-player alternation rule matters *more* in hot seat, where two people share one screen and one
  of them is about to be told they may not make a winning move.
- **`TextBoard` always in the DOM and in the tab order.** It is exactly why the pass gate belongs
  in `placePiece`. Do not make it conditional to simplify the gate.
- **`framing: 'auto'`.** Enabled on measurement, and the reason the board is playable at 360 px at
  all. Pinning the seat does not touch it.

### The app icon (reviewed for Charles, 2026-09-24)

Reviewed from the figures and the geometry, **not from a rendered frame** — no browser.
Geometry as specified: 512 viewBox, margin 24, ring width 56, gaps 24, peg radius 72 → outer ring
232→176, medium 152→96, peg 72. Internally consistent (96 − 24 = 72).

- **Green/blue adjacency at 1.52 — leave it, no spoke.** At 192 px (scale 0.375) the bands are
  21 px and the gaps 9 px; everything resolves and hue does the job for two large adjacent
  fields. At 32 px (scale 1/16) the bands are **3.5 px**, the gaps **1.5 px** and the peg **9 px
  across** — a 3.5 px arc has no internal structure for a contrast ratio to separate, so 1.52 is
  not the binding number there; the 1.5 px gap is. The mark degrades to a multicoloured ring,
  which is distinctive and fine. Also worth noting the *common* deficiency: red/green are the
  adjacent pair that matters most for deuteranopia and they are the healthier 2.20.
- **The four-wedge singularity at the centre — leave it.** At 192 px the peg is 54 px and the
  singularity is a few pixels. At 32 px it is a 9 px disc that reads as a filled dot, which is
  what a peg *is*. Benign failure mode; do not pick a favourite colour to fix it.
- **`base`, not `rim` — and this is the important one.** `rim` carries a published contrast
  guarantee *against the board* (`RIM_BOARD_CEILING_LSTAR = 34`). The icon's ground is `#0b0e13`,
  which is not the board. Using `rim` there would be spending a guarantee measured against a
  different surface — **the exact defect documented in "The contrast trap" above**, with the sign
  flipped. `base` is the identity fill, the icon's job is identity, and the published figures
  (2.72 / 5.15 / 11.33 / 7.47) are measured against the surface actually drawn. Keep `base`.
- **Purple at 2.72 is a floor, not a compromise, and the search is closed.** Against pure black it
  tops out at 2.95; no ground reaches 3.00. Recorded here so nobody re-opens it.

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

**A hex does not identify a role — and this is not a corner case, it is three colours in four.**
Charles hit this writing the icon guard: the icon's purple `#7237b8` matches **both**
`light.player1` and `light.player1Ui`, so a hex match cannot tell you which field it came from.
Binding his assertion to the wrong one would have passed that day and failed on the next
retint, for a reason nobody reading the test could see. He checked instead of assuming, which
is the only reason it was caught.

Verifying it, I found the collision is wider than either of us thought. Computed from
`tokens.ts` on 2026-09-24:

| | light base | light Ui | dark base | dark Ui | collides |
|---|---|---|---|---|---|
| purple | `#7237b8` | `#7237b8` | `#7237b8` | `#b877ff` | **in light** |
| red | `#e8501e` | `#c63100` | `#e8501e` | `#ff6430` | never |
| green | `#a2d733` | `#517400` | `#a2d733` | `#a2d733` | **in dark** |
| blue | `#1cafd2` | `#00738c` | `#1cafd2` | `#1cafd2` | **in dark** |

So **three of the four collide, and not in the same theme** — purple in light, green and blue
in dark, red never. That distribution is the dangerous part: whichever theme you happen to
check in, you get a *different* wrong answer about which colours are safe to identify by hex,
and one colour always looks like it proves the rule.

**But there is a clean discriminator, and it is worth having rather than leaving this as a
hazard.** No `playerNUi` is theme-independent — all four move between light and dark — while all
four `playerN` base fills are identical in both themes. So **theme-independence uniquely
identifies the identity fill**, for every colour, even though a hex match fails for three of
four. That is exactly what Charles's guard asserts first, which makes it sound for a slightly
stronger reason than he claimed: it is not that purple happens to be theme-independent, it is
that *only* the base fills are, so the property is a decision procedure rather than a spot check.

The practical form, which is the same lesson as "name the backdrop" one level up:
**cite the role, never the value.** `players[i].rim` is checkable; `#a2d733` is not, because it
is two different roles depending on which theme you read it in. Anything in this file or in a
comment that pins a claim to a hex rather than a token name is already ambiguous for three
players in four.

**And a set is not a count.** Same guard, exercised in both directions on a scratch copy: change
one literal and the colour-set check fails; **delete an entire quadrant and the set check still
passes**, because the remaining wedges still contain every expected colour. Only counting the
fills catches it. A three-quarters icon with a perfect palette is exactly the kind of green
check this page exists to distrust.

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
