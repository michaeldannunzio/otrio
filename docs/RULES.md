# Otrio — Normative Rules Specification

**Status:** Normative. Implementations MUST conform to sections 1–7. Section 8 is optional. Section 9 is
advisory (3D presentation). Section 10 records source conflicts and open decisions.

**Key words:** MUST / MUST NOT / SHOULD / MAY are used in the RFC 2119 sense.

**Confidence tags** appear on every rule:

| Tag | Meaning |
|---|---|
| `[OFFICIAL]` | Stated in the publisher's printed instruction sheet. |
| `[OFFICIAL-ART]` | Read directly off the publisher's instruction-sheet artwork (diagrams), not the prose. |
| `[CORROBORATED]` | Not in the rulebook prose, but stated consistently by two or more independent secondary sources. |
| `[DERIVED]` | Provable consequence of `[OFFICIAL]` rules plus the physical board. Reasoning given inline. |
| `[UNSPECIFIED]` | No source addresses it. We must decide. A recommendation is given and marked as our decision. |
| `[CONFLICT]` | Sources disagree. Resolution and reasoning given inline and in §10. |

---

## 0. Primary source

The normative source is the **Spin Master / Marbles printed instruction sheet for Otrio Deluxe (Wood)**,
internal document ID `T47308_0007_20103001_GML_IS_R5 (MAR_Otrio_Wood_S18)`, Adobe Illustrator print
production artwork dated 2019-06-16, 2 sheets, 20 languages.

- Retrieved as PDF from: <https://www.xslelut.fi/media/catalog/document/34401/6045064_MANUAL_Otrio_Wood.pdf>
- Byte-identical artwork mirrored at: <https://cdn.1j1ju.com/medias/74/af/cb-otrio-regle.pdf>

This is the actual print file for the sheet in the box, not a retelling. The full English text is
reproduced verbatim in **Appendix A**. Where this document quotes the rulebook, it quotes that text.

Cross-checked against: the inventor's own site <https://otrio.com/pages/how-to-play>;
Geeky Hobbies <https://www.geekyhobbies.com/otrio-rules/>;
Board Game Capital <https://www.boardgamecapital.com/otrio-rules.htm>;
Official Game Rules <https://officialgamerules.org/game-rules/otrio/>;
Vat19 <https://www.vat19.com/item/otrio>;
GeekDad <https://geekdad.com/2018/04/otrio-take-your-tic-tac-toe-game-into-the-third-dimension/>;
The Toy Insider <https://thetoyinsider.com/otrio-game-review/>;
Games for Young Minds <https://www.gamesforyoungminds.com/blog/2019/10/21/otrio>;
Polyhedron Collider <https://www.polyhedroncollider.com/2019/02/otrio-review.html>;
Yinz Buy <https://yinzbuy.com/otrio-board-game/>.

Attribution: *"Otrio™ was designed and developed in the U.S.A. by engineer and tinkerer Brady Peterson,
in collaboration with Marbles: Brain Workshop™."* — instruction sheet. Published by Spin Master Ltd.
BoardGameGeek entry: <https://boardgamegeek.com/boardgame/188465/otrio> (**note:** BGG served HTTP 403
to automated fetches during this research; its data was only reachable via search-engine summaries and
is therefore treated as weak corroboration only).

---

## 1. Board

### 1.1 Physical board shape `[OFFICIAL-ART]`

The physical board is **plus/cross shaped**, not square. Counting the recessed spaces in the
instruction-sheet artwork, it is a 5×5 grid with the four corner cells removed — **21 spaces total**:

```
        . . .              row 0:  3 spaces (north storage arm)
      . . . . .            row 1:  5 spaces
      . . . . .            row 2:  5 spaces
      . . . . .            row 3:  5 spaces
        . . .              row 4:  3 spaces (south storage arm)
```

These 21 spaces split into two kinds:

- **Playing area — 9 spaces.** The central 3×3 block, drawn on the board with a printed outline and
  labelled *"playing area!"* on the instruction sheet. This is the game board proper.
- **Storage spaces — 12 spaces.** The 3 in the north arm, 3 in the south arm, 3 in the west column,
  3 in the east column. These hold the players' unplayed pieces. `[OFFICIAL-ART]`

> **Implementation note.** The 12 storage spaces have **no gameplay function whatsoever**. Pieces MUST NOT
> be played into them and they MUST NOT participate in any win condition. They exist only as the
> physical piece reservoir. A digital version MAY render them (recommended for fidelity — they are how
> you see at a glance what each player has left) or MAY replace them with a side tray.

### 1.2 The playing grid `[OFFICIAL]` `[CORROBORATED]`

The playing area is a **3×3 grid of 9 spaces**. This is implied by the rulebook's diagrams and by
*"(Rows can be horizontal, vertical or diagonal.)"*, and stated explicitly by
Games for Young Minds (*"a 3x3 grid, but each spot in that grid has three options for pieces: large,
medium, and small"*) and Polyhedron Collider.

**Canonical coordinates (our convention, for the implementation):**

```
(0,0) (0,1) (0,2)
(1,0) (1,1) (1,2)
(2,0) (2,1) (2,2)
```

`r` = row index 0..2 top-to-bottom, `c` = column index 0..2 left-to-right. `(1,1)` is the centre space.

### 1.3 Structure of a single space `[OFFICIAL-ART]` `[CORROBORATED]`

Every playing space contains **exactly three concentric slots**, one per piece size:

| Slot | Size | Physical form |
|---|---|---|
| outer | LARGE | outermost annular recess |
| middle | MEDIUM | intermediate annular recess, inside the large one |
| inner | SMALL | central circular recess / peg hole |

**A space therefore holds at most 3 pieces at once: exactly one LARGE, one MEDIUM and one SMALL.**

Each of the three slots holds **at most one piece**, and the three pieces in one space **need not be the
same colour** — that is the whole point of the game. `[CORROBORATED]` (Geeky Hobbies: *"You cannot play a
piece on a space that already has a piece of the same size on it."*; Toy Insider and Games for Young
Minds both confirm differently-sized pieces of different colours share a space.)

**Total slot count: 9 spaces × 3 sizes = 27 slots.** Corroborated by Yinz Buy: *"Otrio uses a system of
36 colored rings over 27 playing spots."*

**Canonical slot identity:** `(r, c, size)` where `size ∈ {SMALL, MEDIUM, LARGE}`.
A slot's state is either empty or occupied by exactly one piece of exactly one colour.

---

## 2. Pieces

### 2.1 Counts `[OFFICIAL]` for the total, `[CORROBORATED]` for the breakdown

- **36 playing pieces in total.** `[OFFICIAL]` — *"36 playing pieces"* / *"36 cercles"*.
- **4 colours × 9 pieces = 36.**
- **Per colour: 9 pieces — 3 SMALL, 3 MEDIUM, 3 LARGE.** `[CORROBORATED]` + `[OFFICIAL-ART]`

The `[OFFICIAL-ART]` confirmation: the *"What's Included"* graphic shows, for each of the four colours,
**three** bullseye icons stacked vertically, each icon being one large + one medium + one small piece
nested. 4 colours × 3 sets × 3 sizes = 36. The Setup graphic likewise shows each colour occupying
**3 storage spaces**, each storage space holding one nested set of three.

Geeky Hobbies states the same breakdown from the box:
*"12 Small Playing Pieces (3 of each color), 12 Medium Playing Pieces (3 of each color),
12 Large Playing Pieces (3 of each color)."*

> `[CONFLICT]` — resolved. Retailer listings (icecat, Amazon) render the contents as *"3 Red Pieces of
> Large, Medium and Small, 3 Green Pieces of Large, Medium and Small, …"*, which parses ambiguously and
> could be read as 3 pieces per colour (12 total). That reading is **wrong** — it contradicts the
> rulebook's stated 36 and the artwork. The correct parse is "3 red pieces in each of the sizes Large,
> Medium and Small". **Use 9 per colour.**

### 2.2 Useful derived counts `[DERIVED]`

There are **9 slots of each size** on the board (one per space) and **3 pieces of each size per colour**.
Therefore:

| Player count | Colours in play | Pieces in play | Slots | Consequence |
|---|---|---|---|---|
| 2 | 4 (two each) | 36 | 27 | 9 pieces are guaranteed to go unplayed; late-game skips are certain if play runs long |
| 3 | 3 | 27 | 27 | pieces and slots match **exactly**; a full board is exactly reachable |
| 4 | 4 | 36 | 27 | 9 pieces guaranteed unplayed; late-game skips certain |

Specifically, per size: 9 slots exist, and 3 colours × 3 = 9 pieces of that size exist in a 3-player game
(exact fit), versus 12 in a 4-player or 2-player game (3 surplus per size).

### 2.3 Shapes `[OFFICIAL-ART]` `[CORROBORATED]`

The user's assumption that all three are tori is **not quite right**:

- **LARGE** — an open ring / annulus (torus-like). `[OFFICIAL-ART]` `[CORROBORATED]`
- **MEDIUM** — a smaller open ring / annulus. `[OFFICIAL-ART]` `[CORROBORATED]`
- **SMALL** — a **solid** small disc / peg, with no hole. `[OFFICIAL-ART]` `[CORROBORATED]`

Evidence: the instruction-sheet artwork draws large and medium as unfilled rings and small as a **filled
dot**, in both the piece inventory graphic and all three win-condition diagrams. Two independent
hands-on reviews agree: GeekDad — *"a large ring, a smaller ring, and a peg"*; The Toy Insider —
*"big plastic rings, medium plastic rings, and small plastic pegs"*.

Vat19 loosely calls all 36 *"plastic rings"*; treat that as marketing shorthand, not a contradiction.

The three sizes **nest concentrically**: the small peg sits inside the medium ring's hole, and the medium
ring sits inside the large ring's hole, so all three occupy one space simultaneously without overlapping.

### 2.4 Colours `[OFFICIAL-ART]` with a flagged variation

The instruction-sheet artwork for the Deluxe/Wood edition shows four colours:

| Colour | Approximate hue | Board arm (per Setup artwork) |
|---|---|---|
| **Purple** | deep violet | North (top) |
| **Red** | bright red | East (right) |
| **Green** | lime / yellow-green | South (bottom) |
| **Blue** | cyan / turquoise | West (left) |

This gives the opposite pairs used by the 2-player rules: **purple↔green** (N/S) and **red↔blue** (E/W),
which is exactly what the rulebook says: *"(In the 2 player version, one player would be purple and
green, while the other player would be blue and red.)"*

> `[CONFLICT]` — unresolved, low impact. Retail listings describe other colour sets for other SKUs:
> Amazon Canada lists a *"Red, Green, Yellow and Blue"* Otrio (<https://www.amazon.ca/dp/B0BNM6RZ9V>)
> and a Walmart listing describes *"Red Green Orange Pieces"*. These are likely later or regional
> re-issues. **Decision: use purple / red / green / blue** as above — that is what the official artwork
> shows — but treat the palette as a cosmetic/theming concern, not a rules concern.

### 2.5 Players supported `[OFFICIAL]`

**2, 3 or 4 players.** *"For 2–4 players, ages 8+"*.

---

## 3. Setup

1. `[OFFICIAL]` *"Place the pieces in the outermost spaces on the board. Like colours should be placed
   together—so all the purple will be on one side, all the red on another, etc."*
   Each colour's 9 pieces fill the 3 storage spaces on one arm of the cross, 3 nested sets per arm.
2. **Colour assignment:**
   - **2 players** `[OFFICIAL]`: *"Each player selects two colours that are opposite each other on the
     board."* So one player takes purple + green, the other takes blue + red.
   - **3 players** `[OFFICIAL]`: *"Each player selects a colour. If only three are playing, one colour
     sits the game out."* Which colour sits out is `[UNSPECIFIED]`.
     **Decision: let the players (or the UI) choose freely; it is mechanically irrelevant** — all four
     colours are symmetric with respect to every rule, and the only asymmetry (arm position) affects
     nothing once play starts.
   - **4 players** `[OFFICIAL]`: *"Each player selects a colour."*
3. **The playing area starts empty.** `[OFFICIAL-ART]`

---

## 4. Turn structure

### 4.1 The only action `[OFFICIAL]`

On a turn a player performs **exactly one action: place one piece.**

*"Take turns placing pieces (one per turn) into the playing area."*

There is no other action type. No drafting, no rotating, no capturing, no scoring step.

### 4.2 Legality of a placement `[OFFICIAL]` + `[CORROBORATED]`

A placement of a piece of size `s` and colour `k` into space `(r,c)` is legal **iff all** of:

1. `(r,c)` is one of the 9 playing-area spaces (**not** a storage space). `[OFFICIAL]` — *"into the
   playing area"*.
2. The slot `(r, c, s)` is **empty**. `[CORROBORATED]` — *"You cannot play a piece on a space that
   already has a piece of the same size on it."* (Geeky Hobbies); also physically enforced by the board.
3. The player still holds at least one unplayed piece of colour `k` and size `s`.
4. Colour `k` is a colour the player controls, **and** satisfies the 2-player alternation constraint
   in §4.6 when applicable.

**Explicitly permitted:** placing into a space that already contains one or two pieces belonging to
**other players**, provided your size's slot is free. This is the core tactical mechanism of the game
(you block an opponent's concentric Otrio by taking one of the three slots in their space). `[CORROBORATED]`
by Geeky Hobbies, The Toy Insider, Games for Young Minds and Polyhedron Collider; entailed by the
rulebook's own diagrams, which show blocking play.

### 4.3 Pieces are permanent `[OFFICIAL]`

*"Once a piece is placed, it cannot be moved."*

Pieces are **never** moved, swapped, removed, replaced or returned to the reservoir for any reason, by
any player, at any point in the game. There is no capture and no undo in the rules. A placement is final.

### 4.4 Placement is mandatory when possible `[DERIVED]`

Rule *"If you can't play a piece, you skip your turn"* is stated as the **only** condition under which a
turn passes without a placement. Therefore a player who **has** a legal move **MUST** make one; voluntary
passing is NOT permitted.

### 4.5 No legal move `[OFFICIAL]`

*"If you can't play a piece, you skip your turn."*

The player's turn ends with no placement and play passes to the next player. **The game does not end.**
A player who skips one turn MAY be able to move on a later turn (the board only ever gains pieces, so in
practice once you are stuck for a given size you stay stuck for that size — but you may still hold
playable pieces of another size).

*When this happens:* you are stuck exactly when, for every size `s` of which you still hold a piece, all
9 slots of size `s` on the board are occupied. Given §2.2 this is **guaranteed to occur** late in any
2-player or 4-player game that does not end in a win.

### 4.6 The 2-player colour alternation constraint `[OFFICIAL]` — **important, and widely omitted**

*"Take turns placing pieces (one per turn) into the playing area, **alternating between your two
colours**."*

In a 2-player game a player **MUST** strictly alternate which of their two colours they play on
successive turns. It is not a free choice each turn.

This is easy to miss and most English summaries omit it, so it was verified against the other 19
language versions on the same official sheet, which are unambiguous and in one case explicitly modal:

| Language | Text | Gloss |
|---|---|---|
| Dutch | *"moeten daarbij telkens wisselen"* | "**must** switch **each time**" |
| Greek | *"εναλλάσσοντας κάθε φορά τα δύο χρώματα"* | "alternating the two colours **each time**" |
| Czech | *"přičemž pravidelně střídejte obě barvy"* | "**regularly alternate** both colours" |
| German | *"Wechselt dabei die Farben ab."* | "alternate the colours as you do so" (imperative) |
| Slovak | *"striedavo používajte svoje dve farby"* | "**alternately** use your two colours" |
| Italian | *"alternando tra i due colori"* | "alternating between the two colours" |
| Spanish | *"alternando sus dos colores"* | "alternating their two colours" |

`[CORROBORATED]` by Board Game Capital (*"each selects two colors, alternating between them"*).

> `[CONFLICT]` — see §10.1. The inventor's own site, <https://otrio.com/pages/how-to-play>, and Geeky
> Hobbies describe the 2-player game without any alternation requirement. **We follow the printed
> rulebook: alternation is mandatory** (it is the primary source, it is corroborated, and it is
> unambiguous in seven independently translated renderings). But **expose it as a configurable option**
> — see §10.1 for why this matters.

**Which colour do you start with?** `[UNSPECIFIED]`. **Decision: the player freely chooses their colour
on their first turn of the game; from then on it alternates deterministically.**

**What if the due colour has no legal move but the other colour does?** `[UNSPECIFIED]` — genuine gap.
See §10.2 for our recommendation.

### 4.7 Colours cannot be combined `[OFFICIAL]` + `[CORROBORATED]`

*"You can win with either of your colours."* — rulebook. The inventor's site states the negative
explicitly: *"You can win with either of your colors, but colors cannot be combined for a win."*
(<https://otrio.com/pages/how-to-play>)

**Every win condition is monochromatic.** A 2-player player's purple pieces and green pieces never
combine into a single Otrio.

### 4.8 Turn order and first player `[OFFICIAL]` for the physical game, `[UNSPECIFIED]` for digital

*"The youngest player goes first, and play proceeds clockwise."*
Tip: *"Be sure to alternate which player goes first!"*

"Youngest" is not implementable. **Decisions:**

- **Seating / turn order:** use the board's own clockwise arrangement,
  **Purple (N) → Red (E) → Green (S) → Blue (W) → Purple …** `[DERIVED]` from the Setup artwork.
  With 3 players, skip the absent colour and keep the remaining cyclic order.
  With 2 players, the two players alternate (their arms are opposite, so any clockwise walk alternates
  them anyway).
- **First player:** choose at random for a single game; **rotate the starting player between games** in
  a series, which is exactly what the official Tip advises.

---

## 5. Win conditions

### 5.1 Statement `[OFFICIAL]`

> **How To Win:** Get 3-in-an-"O" aka an Otrio! There are three different ways to get an Otrio:
> 1. Three same-sized pieces: big, medium or small
> 2. Three pieces in ascending *or* descending order
> 3. Three concentric pieces in the same space
>
> *(Rows can be horizontal, vertical or diagonal.)*

The user's three-family hypothesis is **confirmed exactly**, and **diagonals are explicitly included**
by the parenthetical, which appears verbatim on the official sheet and is reproduced in every one of the
20 languages. Corroborated independently by Geeky Hobbies (*"horizontally, vertically, or diagonally"*),
Vat19, Yinz Buy and Board Game Capital.

**All three families require all three pieces to be a single colour belonging to the claiming player.**

### 5.2 Lines `[OFFICIAL]`

A **line** is one of the **8** ordered triples of playing-area spaces:

```
rows:       (0,0)(0,1)(0,2)   (1,0)(1,1)(1,2)   (2,0)(2,1)(2,2)
columns:    (0,0)(1,0)(2,0)   (0,1)(1,1)(2,1)   (0,2)(1,2)(2,2)
diagonals:  (0,0)(1,1)(2,2)   (0,2)(1,1)(2,0)
```

3 rows + 3 columns + 2 diagonals = 8. Identical to tic-tac-toe.

### 5.3 W1 — Same-size line `[OFFICIAL]`

Player `P` wins if there exists a line `L` and a size `s` such that, for all three spaces in `L`, the
slot of size `s` holds a piece of a single colour controlled by `P`.

Formally: `∃ line L, ∃ s ∈ {S,M,L}, ∃ colour k ∈ colours(P) : ∀ cell ∈ L, occupant(cell, s) == k`.

`[OFFICIAL-ART]`: the sheet's diagram shows three **large** red rings on the main diagonal
`(0,0),(1,1),(2,2)`, labelled "Otrio!". This is the diagonal case confirmed pictorially.

### 5.4 W2 — Ordered-size line `[OFFICIAL]`

Player `P` wins if there exists a line `L = (a, b, c)` and a colour `k ∈ colours(P)` such that pieces of
colour `k` occupy one slot in each of `a`, `b`, `c`, and their sizes are strictly monotonic along the
line — i.e. `(SMALL, MEDIUM, LARGE)` or `(LARGE, MEDIUM, SMALL)`.

`[DERIVED]` **Equivalent and cheaper test:** the three occupied sizes are all different **and the middle
cell of the line holds the MEDIUM piece.** (If the three sizes are distinct, the sequence is monotonic
iff the medium is in the middle; `M,S,L` and `S,L,M` etc. are not monotonic and do **not** win.)

`[OFFICIAL-ART]`: the sheet's diagram shows two green examples on the same board —
top row small→medium→large (ascending, left to right) and bottom row large→medium→small (descending,
left to right), both labelled "Otrio!". This confirms that **both directions count** and that a line is
judged in either reading order, so "ascending" and "descending" are not two separate conditions in
practice — they are the two distinct physical placements of the same idea.

**Non-win examples worth writing a test for:** `MEDIUM, SMALL, LARGE`; `SMALL, LARGE, MEDIUM`;
`SMALL, SMALL, LARGE`; and any monotonic triple that is not single-coloured.

### 5.5 W3 — Concentric space `[OFFICIAL]`

Player `P` wins if there exists a space `(r,c)` and a colour `k ∈ colours(P)` such that **all three**
slots of that space — SMALL, MEDIUM and LARGE — hold pieces of colour `k`.

`[OFFICIAL-ART]`: the sheet's diagram shows a single space filled with a purple large ring + purple
medium ring + purple small peg, labelled "Otrio!".

Note this is per-**space**, not per-line; there are 9 such conditions, and the space need not be the
centre.

### 5.6 Total enumeration `[DERIVED]`

Per colour, the number of distinct winning piece-sets is:

| Family | Count | Working |
|---|---|---|
| W1 same-size line | 24 | 8 lines × 3 sizes |
| W2 ordered-size line | 16 | 8 lines × 2 orientations (S-M-L, L-M-S) |
| W3 concentric space | 9 | 9 spaces |
| **Total** | **49** | |

A precomputed table of 49 slot-triples per colour is the recommended win-check representation.

### 5.7 When the win takes effect `[OFFICIAL]`

*"Keep placing pieces until someone gets an Otrio!"* and *"When you get an Otrio, be sure to yell out
'Otrio!' You are the victor and your opponents should hear it."*

The game **ends immediately** at the moment an Otrio comes into existence. The announcement is a
table-manners instruction, not a precondition for the win — the sheet says "You **are** the victor",
present tense, independent of the shout.

> `[UNSPECIFIED]` **Auto-detect vs. claim.** The physical game relies on a human noticing. **Decision:
> auto-detect.** The engine MUST evaluate all win conditions after every placement and end the game
> immediately on the first Otrio. Do **not** require the player to "call" it. (A "call Otrio for bonus
> points" toggle would be a house rule, not the published game, and interacts badly with §6.1's
> impossibility proof.)

---

## 6. Game end, ties and edge cases

### 6.1 Two players winning simultaneously — **it cannot happen** `[DERIVED]`

The brief asks whether the official rules address a single placement completing win conditions for two
different players. **They do not, and they do not need to: the situation is structurally impossible.**

**Proof.** Assume the engine ends the game immediately on any Otrio (§5.7). Then before move *n* the
board contains no Otrio. Move *n* adds exactly **one** piece `p`, of exactly **one** colour `k`, and `k`
is a colour controlled by the mover. Any Otrio present after the move but not before must contain `p`
(every other piece was already on the board, and no piece is ever moved or removed — §4.3). Every win
condition is monochromatic (§4.7, §5.1). Therefore any newly created Otrio consists entirely of colour-`k`
pieces and belongs to the mover. **At most one player can win as a result of any single placement.** ∎

The 2-player two-colours case does not break this: the mover controls both colours, so whichever of
their colours completes, the winner is still the mover.

A single placement **can** complete **two or more Otrios at once for the same player** (e.g. a piece that
both completes a same-size row and finishes a concentric space). That is simply a win; there is no bonus
and no ambiguity. The engine SHOULD nonetheless report all completed conditions for the victory
animation.

The only way a physical game produces an apparent double win is if an earlier Otrio was **never
noticed** and play continued. Auto-detection eliminates that class of bug entirely.

**What the user may be remembering, and which is real:** Otrio very commonly produces positions where
*two different opponents each hold an unstoppable threat*, so whoever's turn arrives first wins, and
positions of **zugzwang** where every legal move hands an opponent the win. Both are genuine, frequent,
and require no special rule — they fall out of turn order. The rulebook's own Tips acknowledge this:
*"In a 3 or 4 player game, keep an eye on blocking the players that follow you, not the player
immediately before you."*

### 6.2 Draws / ties `[OFFICIAL]`

The rulebook **does** address ties, in all 20 languages:

> *"A tie is possible, but not likely. If you do end up in a tie, then pat each other on the back:
> You all win! Play again and beat each other this time!"*

Italian is the most explicit: *"In tal caso, tutti i giocatori vincono"* — "in that case, all players win".

`[DERIVED]` Given §6.1, a "tie" in Otrio can only mean **the game ending with nobody having made an
Otrio**. The terminal condition is therefore:

> **The game ends in a draw when no player has any legal move.**

Sufficient (and simpler) equivalent checks:
- all 27 slots are occupied; **or**
- for every player `P`, for every size `s` such that `P` still holds a piece of size `s`, all 9 slots of
  size `s` are occupied.

The engine MUST use the second, general form, because in 2- and 4-player games the board can deadlock
with slots still free (e.g. only SMALL slots remain and no one holds a SMALL piece — impossible with
starting inventories, but the general check costs nothing and is robust to variants).

**Decision:** report the result as `DRAW`. If the UI wants to honour the rulebook's tone it MAY present
it as "Everybody wins!", but the machine-readable result MUST be a draw with no winner. For a scored
series (§8.1) the rulebook does not say how to score a draw — see §10.3.

### 6.3 Turn passing does not end the game `[OFFICIAL]`

See §4.5. A skip is not a resignation and not a loss. Play continues round the table. The game ends only
per §5.7 (win) or §6.2 (no player can move).

### 6.4 Infinite loops `[DERIVED]`

Impossible. Every non-skipping turn strictly increases the number of occupied slots, which is bounded by
27, and pieces are never removed. Once every player is simultaneously unable to move, no future turn can
change that (the board is monotone). So the game always terminates, and the engine MAY safely evaluate
§6.2 after every turn (including skips) without risk of an endless skip cycle.

### 6.5 Resignation / abandonment `[UNSPECIFIED]`

Not addressed by any source. **Decision: an implementation concern, not a rules concern.** Handle as the
product requires; do not model it in the rules engine.

---

## 7. Summary of the state machine (implementation contract)

```
State:
  board      : slot[(r,c,size)] -> colour | EMPTY        # 27 slots
  reserve    : (colour, size) -> int                     # starts at 3 for every in-play colour/size
  players    : ordered list; each owns 1 colour (3-4p) or 2 opposite colours (2p)
  toMove     : player index
  dueColour  : colour | null      # 2-player alternation only; null on a player's first turn
  status     : IN_PROGRESS | WIN(player, [conditions]) | DRAW

Turn(player P):
  M = legalMoves(P)
  if M is empty:
      skip; advance toMove; advance P's dueColour (see §10.2); goto TerminalCheck
  P chooses m = (colour k, size s, space (r,c)) from M          # mandatory, §4.4
  board[(r,c,s)] = k ; reserve[(k,s)] -= 1
  if 2-player: dueColour[P] = other colour of P
  W = checkWins(k)                                              # 49 precomputed triples
  if W non-empty: status = WIN(P, W); halt                      # §5.7, §6.1
  advance toMove

TerminalCheck:
  if no player has any legal move: status = DRAW; halt          # §6.2
```

`legalMoves(P)` = all `(k, s, (r,c))` with `board[(r,c,s)] == EMPTY`, `reserve[(k,s)] > 0`,
`k ∈ colours(P)`, and (2-player only) `k == dueColour[P]` when `dueColour[P] != null`.

---

## 8. Optional and variant rules

All of the following are **optional**. The base game MUST be playable with all of them off.

### 8.1 Otrio Extreme — official alternative version `[OFFICIAL]`

> *"Games go fast! If you are playing a bunch in a row, why not make it extreme? Grab a pad of paper and
> grant one point to the winner of each game. Want to make things extra hard? Deduct one point for the
> player who failed to block the winner! First player to get to five points wins!"*

- Match play over multiple games. **+1** to each game's winner.
- Optional extra layer: **−1** to "the player who failed to block the winner".
- Match ends when a player reaches **5 points**.

> `[CONFLICT]` — minor. Geeky Hobbies renders the penalty as *"subtract one from the player immediately
> before the winner"*. The rulebook says *"the player who failed to block the winner"*. These are
> different: the rulebook's phrasing is judgement-based (whoever had the chance to block and didn't),
> Geeky Hobbies' is mechanical (the preceding seat). **Follow the rulebook's intent but implement the
> mechanical version** — "the player who took the turn immediately before the winning move" — because it
> is the only version a computer can adjudicate, and note the substitution in the UI. Also note this
> sits oddly with the rulebook's own Tip that you should block the players who *follow* you, not the one
> before you.

### 8.2 Centre-medium handicap — official tip `[OFFICIAL]`

> *"In a 2 player game, if the first player keeps winning, try making the middle circle in the middle
> space completely off-limits to both players."*

French confirms the reading precisely: *"vous pouvez interdire l'utilisation du cercle de la taille
intermédiaire dans l'espace central"* — forbid use of the **medium-sized** circle in the **central**
space.

**Implementation:** when enabled, the slot `(1, 1, MEDIUM)` is permanently unplayable for all players.
This reduces the playable slot count from 27 to 26 and removes some W1/W2/W3 triples from the win table.

### 8.3 Rotate the starting player — official tip `[OFFICIAL]`

*"Be sure to alternate which player goes first!"* Already adopted as our default for series play (§4.8).

### 8.4 There are no other official variants `[OFFICIAL]`

The instruction sheet contains exactly one section headed *"Alternative Version"* (§8.1) and three
*"Tips!"* (§8.2, §8.3, plus the blocking-strategy advice which is pure strategy, not a rule). Anything
else encountered online is a house rule.

---

## 9. Physical feel — notes for the 3D implementation `[OFFICIAL-ART]` / `[CORROBORATED]`

Not rules, but the things a 3D version should get right.

**Materials.** Two production lines exist:
- **Deluxe / Wood edition** (the one whose rulebook is our source): a **carbonized bamboo** board with
  recessed circular inlays, plus **plastic** pieces. GeekDad's hands-on review notes the contrast
  candidly — the board is lovely, and the plastic pieces *"feel a bit cheap in the hand"* by comparison.
  A 3D version should lean into the board's warm matte wood grain and give the pieces a slightly glossy,
  hard, hollow-sounding injection-moulded plastic character. That contrast **is** the artefact.
- **Standard edition:** a plastic play board. Same geometry.

**Board.** Cross/plus silhouette (§1.1) — do not substitute a plain square; the arms are visually
distinctive and they are where each player's remaining pieces live, which is real information.
Vat19 lists the bamboo product at **15⅓" × 15⅓" × 2¼"** (≈ 38.9 × 38.9 × 5.7 cm).
Each space is a set of three concentric **recessed** grooves, so pieces sit *into* the board rather than
on it, and the board reads as machined even when empty.

**Nesting.** The defining tactile fact: **large ring → medium ring nests inside it → small peg nests
inside that**, all three flush in a single space, forming a bullseye. When three colours occupy one
space the result is a tricolour target, and this is what the board looks like for most of the midgame.
Get the concentric clearances tight — the physical fit is snug, and Games for Young Minds specifically
notes *"the pieces fit snugly into the board"*.

**Proportions.** `[UNSPECIFIED]` — no source publishes piece diameters, and the instruction sheet
explicitly disclaims its own graphics: *"(Pieces and board are not to scale.)"*. **Do not derive
proportions from the rulebook artwork.** Derive them from the geometry instead: the large ring's outer
diameter must be slightly under the space pitch (so adjacent spaces don't collide); the medium ring's
outer diameter must clear the large ring's inner diameter; the small peg's diameter must clear the
medium's inner diameter. Ring wall thickness is the free parameter and should be roughly equal for large
and medium, which is what the artwork and product photos suggest.

**Height.** All three sizes are low — the pieces are flat rings and a short peg, not towers. The game
should read as an almost-flat board at a glance and only reveal its depth at a low camera angle.

**Sound/feel cues worth reproducing:** the small click of a piece dropping into its recess; the
distinctly different sound of the peg (solid) versus the rings (hollow).

---

## 10. Conflict register and decisions we must own

### 10.1 2-player colour alternation — **the most consequential open decision** `[CONFLICT]`

| Source | Position |
|---|---|
| Spin Master printed sheet (EN + 19 translations) | **Mandatory** strict alternation. Dutch: *"must switch each time"*. |
| Board Game Capital | Mandatory ("alternating between them"). |
| otrio.com (the inventor's site) how-to-play | Silent — describes 2-player colour ownership with no alternation rule. |
| Geeky Hobbies | Silent — "each controls two colors, can win with either". |

**Our call: mandatory alternation is the rule**, because the printed sheet is the primary source, it is
corroborated, and the translations are unanimous and in one case explicitly modal. The silent sources are
abridgements, not contradictions.

**Why the implementation team must care:** this is not cosmetic. Under mandatory alternation, each
2-player player's colour sequence is fully determined from their first move, which means the *set of
threats they can execute next turn* is halved, blocking becomes far more tractable, and the game's
2-player character changes substantially. Search-based AI branching factor is roughly halved. **Build it
as a flag (`twoPlayerStrictAlternation`, default ON) so we can A/B it, and surface it in the UI.**

### 10.2 2-player: due colour is stuck but the other colour is playable `[UNSPECIFIED]` — genuine gap

The rulebook gives two rules that collide and never says which wins: *"alternating between your two
colours"* and *"If you can't play a piece, you skip your turn"*. No source resolves it. The situation is
reachable in real play late in a 2-player game.

Two defensible readings:
- **(A) Strict:** "a piece" means a piece of the due colour; you skip, and alternation still advances
  (so next turn you are due the other colour).
- **(B) Permissive:** alternation is a preference that yields to legality; if the due colour is stuck you
  play the other colour instead.

**Recommendation: (A), with alternation advancing on a skip.** It keeps the alternation invariant
exact, it is the literal reading of both sentences in order, and it makes the state machine a pure
function of turn index. Implement **(B) as the fallback behaviour behind the same flag** as §10.1, so
that turning alternation off degrades gracefully. **Flag this to the product owner — it is a rule we are
inventing, not one we found.**

### 10.3 Scoring a draw in Otrio Extreme `[UNSPECIFIED]`

The rulebook says a tie means "you all win" and separately says Otrio Extreme awards 1 point to "the
winner of each game". It never says what a drawn game is worth. **Recommendation: award 0 to everyone
and replay** (the rulebook's own advice on a tie is *"Play again"*). Alternative — 1 point to everyone —
is defensible but can end a match on a draw, which feels wrong. **Our decision, not a found rule.**

### 10.4 Piece counts in retailer listings `[CONFLICT]`

**Resolved.** See §2.1. Use 9 per colour (3 of each size), 36 total.

### 10.5 Colour palette across editions `[CONFLICT]`

**Unresolved, cosmetic only.** See §2.4. Use purple / red / green / blue.

### 10.6 Small piece: peg or ring `[CONFLICT]`

**Resolved: solid peg.** See §2.3. Vat19's blanket "rings" is marketing shorthand; the official artwork
and two independent hands-on reviews all show or describe a solid peg with no hole.

### 10.7 Things no source could confirm

- **Exact piece dimensions.** Nobody publishes them. Section 9 gives a geometric derivation instead.
- **BoardGameGeek forum consensus on edge cases.** BGG blocked automated retrieval (HTTP 403 on both the
  game page and the XML API during this research), so BGG is cited only via search-engine summaries and
  should not be treated as verified.
- **Any official FAQ or errata.** None found. Spin Master publishes no Otrio FAQ; otrio.com (the
  inventor's storefront) now displays *"We are officially closed"*.
- **A prior computational solve.** The one public attempt
  (<https://barronwasteland.wordpress.com/2015/12/28/solving-otrio/>) is **invalid** — the author used
  the wrong 2-player rules (two colour sets total instead of four) and was corrected in the comments by
  the designer, Brady Peterson: *"we also figured out that w/ 2 players and using only 2 sets the first
  person can always win quickly."* Its conclusion ("player one cannot lose") does **not** apply to the
  real game. **Do not cite it as evidence about first-player advantage.** Whether real Otrio has a
  first-player advantage appears to be unsolved in public; the rulebook's own Tip §8.2 implies the
  designers believed a 2-player first-player edge exists.

---

## Appendix A — Official English rules text, verbatim

Transcribed from the Spin Master print artwork `T47308_0007_20103001_GML_IS_R5_EN` (see §0).
Reflowed from a multi-column layout; wording is unaltered.

> **Otrio™ DELUXE**
> **MAKE YOUR BRAIN SAY "O" !**
> For 2–4 players, ages 8+
>
> **What's Included:**
> 1 wood board + 36 playing pieces
> *(Pieces and board are not to scale.)*
>
> **Set Up:**
> Place the pieces in the outermost spaces on the board. Like colours should be placed together—so all
> the purple will be on one side, all the red on another, etc.
>
> **How To Play:**
> *(In the 2 player version, one player would be purple and green, while the other player would be blue
> and red.)*
>
> **For 2 players**
> Each player selects two colours that are opposite each other on the board. You can win with either of
> your colours. The youngest player goes first, and play proceeds clockwise. Take turns placing pieces
> (one per turn) into the playing area, alternating between your two colours.
>
> **For 3 or 4 players**
> Each player selects a colour. If only three are playing, one colour sits the game out. The youngest
> player goes first and play proceeds clockwise. Take turns placing pieces (one per turn) into the
> playing area.
>
> **Rules for Placing Pieces:**
> ❶ Once a piece is placed, it cannot be moved.
> ❷ If you can't play a piece, you skip your turn.
> ❸ Keep placing pieces until someone gets an Otrio!
>
> *A tie is possible, but not likely. If you do end up in a tie, then pat each other on the back: You all
> win! Play again and beat each other this time!*
>
> **How To Win:**
> Get 3-in-an-"O" aka an Otrio! There are three different ways to get an Otrio:
> ❶ Three same-sized pieces: big, medium or small
> ❷ Three pieces in ascending *or* descending order
> ❸ Three concentric pieces in the same space
> *(Rows can be horizontal, vertical or diagonal.)*
> When you get an Otrio, be sure to yell out "Otrio!" You are the victor and your opponents should hear it.
>
> **Tips!**
> ● Be sure to alternate which player goes first!
> ● In a 3 or 4 player game, keep an eye on blocking the players that follow you, not the player
>   immediately before you.
> ● In a 2 player game, if the first player keeps winning, try making the middle circle in the middle
>   space completely off-limits to both players.
>
> **Alternative Version: Otrio Extreme!**
> Games go fast! If you are playing a bunch in a row, why not make it extreme? Grab a pad of paper and
> grant one point to the winner of each game. Want to make things extra hard? Deduct one point for the
> player who failed to block the winner! First player to get to five points wins!
>
> Otrio™ was designed and developed in the U.S.A. by engineer and tinkerer Brady Peterson, in
> collaboration with Marbles: Brain Workshop™. All rights reserved.
> TM & © Spin Master Ltd. All rights reserved.

---

## Appendix B — Source index

| # | Source | URL | Used for |
|---|---|---|---|
| S1 | **Spin Master / Marbles official instruction sheet, Otrio Deluxe (Wood), doc `T47308_0007_20103001_GML_IS_R5`** | <https://www.xslelut.fi/media/catalog/document/34401/6045064_MANUAL_Otrio_Wood.pdf> | **Primary.** All `[OFFICIAL]` and `[OFFICIAL-ART]` claims. |
| S2 | Same artwork, mirrored | <https://cdn.1j1ju.com/medias/74/af/cb-otrio-regle.pdf> | Independent confirmation that S1 is the shipped sheet. |
| S3 | otrio.com — Unboxing & How to Play (inventor's site) | <https://otrio.com/pages/how-to-play> | 36 pieces; setup; "colors cannot be combined for a win"; skip-turn; no-moving. Silent on alternation. |
| S4 | otrio.com — Inventor's Edition | <https://otrio.com/> | Materials (walnut/concrete/rubberwood/bamboo); site now closed. |
| S5 | Geeky Hobbies — Otrio Rules | <https://www.geekyhobbies.com/otrio-rules/> | **Piece breakdown 12/12/12**; *"cannot play a piece on a space that already has a piece of the same size"*; diagonals; scoring variant. |
| S6 | Board Game Capital — Otrio Rules | <https://www.boardgamecapital.com/otrio-rules.htm> | 2-player alternation; bamboo board + 36 plastic pieces; three win families. |
| S7 | Official Game Rules — Otrio | <https://officialgamerules.org/game-rules/otrio/> | Outer-ring setup; youngest first, clockwise; skip on no legal move. |
| S8 | Vat19 product page | <https://www.vat19.com/item/otrio> | Bamboo board with recessed inlays; board dimensions; 36 plastic pieces in 4 colours; 20–30 min. |
| S9 | GeekDad review | <https://geekdad.com/2018/04/otrio-take-your-tic-tac-toe-game-into-the-third-dimension/> | *"a large ring, a smaller ring, and a peg"*; carbonized bamboo; plastic feels cheap vs board. |
| S10 | The Toy Insider review | <https://thetoyinsider.com/otrio-game-review/> | *"big plastic rings, medium plastic rings, and small plastic pegs"*; blocking; win families. |
| S11 | Games for Young Minds | <https://www.gamesforyoungminds.com/blog/2019/10/21/otrio> | *"a 3x3 grid, but each spot has three options: large, medium, and small"*; snug fit; crowded boards at 3–4p. |
| S12 | Polyhedron Collider review | <https://www.polyhedroncollider.com/2019/02/otrio-review.html> | 3×3 with 27 positions; *"place any one of your rings on any empty space… it can never be moved"*. |
| S13 | Yinz Buy | <https://yinzbuy.com/otrio-board-game/> | *"36 colored rings over 27 playing spots"*; ties possible but rarer than tic-tac-toe. |
| S14 | BoardGameGeek entry | <https://boardgamegeek.com/boardgame/188465/otrio> | Designer/publisher/player count. **HTTP 403 to automated fetch — weak corroboration only.** |
| S15 | "Solving Otrio", Barron Wasteland | <https://barronwasteland.wordpress.com/2015/12/28/solving-otrio/> | **Invalid analysis** (wrong 2-player rules), but its comment thread carries a direct statement from designer Brady Peterson. See §10.7. |
| S16 | Amazon / icecat retail listings | <https://www.amazon.com/Otrio-LE-Strategy-Based-Board-Game/dp/B07DJNV23H> , <https://icecat.biz/en/p/spin+master/6045065/> | Colour names (red/green/blue/purple); plastic play board SKU. Ambiguous piece-count phrasing — see §2.1. |
| S17 | Amazon CA alternate-colour SKU | <https://www.amazon.ca/Otrio-Yellow-Pieces-Player-Strategy-Based/dp/B0BNM6RZ9V> | Evidence of a red/green/yellow/blue edition. See §2.4. |
