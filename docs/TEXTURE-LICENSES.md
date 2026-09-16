# Texture provenance and licensing

Every texture shipped in `public/textures/` is **CC0 1.0 Universal** — a public domain
dedication. **No attribution is required**, for any use, including commercial. We record
provenance here anyway, because knowing where an asset came from is useful independently of
whether the licence compels it, and because "we couldn't remember where this came from" is how
projects end up with assets they can't defend.

Licences were verified at the providers' own licence pages on **2026-09-15**. Nothing is
included whose licence could not be confirmed.

Machine-readable equivalent: `public/textures/manifest.json`, regenerated on every run of
`npm run textures`.

---

## Providers

### ambientCG — <https://ambientcg.com>

- **Licence:** Creative Commons CC0 1.0 Universal
- **Licence page:** <https://docs.ambientcg.com/license/>
- **Attribution required:** No
- **Verified wording:** *"All ambientCG assets are provided under the Creative Commons CC0 1.0
  Universal License. This applies to the downloadable asset files and the material preview
  renders shown for each asset on the site."* The page adds *"You don't need to give credit but
  I would of course appreciate it, if you did it anyways."*
- **Carve-outs:** None stated. The dedication is applied site-wide to asset files, which is why
  there is no per-asset licence field in their API.

### Poly Haven — <https://polyhaven.com>

- **Licence:** Creative Commons CC0 1.0 Universal
- **Licence page:** <https://polyhaven.com/license>
- **Attribution required:** No
- **Verified wording:** *"You can use our assets for any purpose, including commercial work"*,
  *"You can redistribute them"*, and *"You do not need to give credit or attribution when using
  them (although it is appreciated)."*
- **Carve-outs:** Site chrome only — *"All content on this website, excluding the CC0 assets
  themselves, is protected by intellectual property laws"* (logos, user avatars, example renders,
  page copy). **We use only asset files**, never previews or page imagery. The thumbnails
  consulted while choosing these textures were used for evaluation and are not redistributed.

Both providers apply CC0 at the site level rather than per asset. That is why neither API exposes
a per-asset licence field, and why the verification above is recorded per *provider*. If a future
asset comes from a provider with mixed licensing, verify and record it **per asset**.

---

## Assets

### 1. Board — `bamboo_veneer`

|  |  |
|---|---|
| **Source** | Poly Haven, *Bamboo Veneer* |
| **Page** | <https://polyhaven.com/a/bamboo_veneer> |
| **Licence** | CC0 1.0 Universal |
| **Author** | Jenelle van Heerden (all) |
| **Physical tile** | 1000 × 1000 mm |

Chosen to match `docs/RULES.md` §9, which pins the reference edition as a **carbonized bamboo**
board with recessed circular inlays and asks for "warm matte wood grain". The scan is natural
blonde bamboo; `src/scene/textures.ts` darkens it into the carbonized range with a colour
multiply (`tintedColor: '#c9a074'`), which is physically what carbonizing does — a heat treatment
that darkens the sugars. Keeping the shipped albedo faithful to the scan means the look is one
hex value away from adjustable.

| Map used | Source file | Ships as |
|---|---|---|
| Albedo | `bamboo_veneer_diff_1k.jpg` | `board_albedo.webp` |
| Normal (OpenGL) | `bamboo_veneer_nor_gl_1k.jpg` | `board_normal.webp` |
| Roughness | `bamboo_veneer_rough_1k.jpg` | `board_rough.webp` |

**Deliberately not used:**
- `bamboo_veneer_ao_1k.jpg` — measured **mean 98.7%, stddev 1.1%**. It is a white image. Flat
  veneer has no self-occlusion worth baking, and the occlusion that matters — inside the board's
  recessed piece slots — comes from geometry.
- `bamboo_veneer_arm_1k.jpg` — the packed AO/Rough/Metal map. Rejected because two of its three
  channels are dead weight here (AO is white, metalness is zero for a dielectric), and because
  lossy WebP is always 4:2:0, which would subsample exactly the channels that carry independent
  data. A greyscale roughness map is smaller *and* artefact-free.
- `nor_dx` — DirectX normal convention. three.js expects OpenGL (+Y up); the DirectX variant
  would invert the lighting so bumps read as dents.
- `Displacement` — no displacement or parallax in this renderer.

### 2. Table — `Fabric034`

|  |  |
|---|---|
| **Source** | ambientCG, *Fabric 034* (felt) |
| **Page** | <https://ambientcg.com/a/Fabric034> |
| **Licence** | CC0 1.0 Universal |
| **Author** | ambientCG (Lennart Demes) |
| **Physical tile** | Not published by the provider |

A genuine felt scan, and crucially a **near-neutral** one (measured saturation 0.03). That
neutrality is the reason it was chosen over the coloured fabric options: the same 11 KB of
texture tints cleanly to baize green, burgundy or charcoal via `material.color`, with no baked-in
hue to fight. The default is a deep card-table green.

| Map used | Source file | Ships as |
|---|---|---|
| Albedo | `Fabric034_1K-JPG_Color.jpg` | `table_albedo.webp` |
| Normal (OpenGL) | `Fabric034_1K-JPG_NormalGL.jpg` | `table_normal.webp` |
| Roughness | `Fabric034_1K-JPG_Roughness.jpg` | `table_rough.webp` |

**Deliberately not used:** `NormalDX` (wrong convention), `Displacement`, and the bundled
`.blend` / `.usdc` / `.mtlx` / `.tres` scene files.

### 3. Pieces — `Plastic010`

|  |  |
|---|---|
| **Source** | ambientCG, *Plastic 010* (smooth white) |
| **Page** | <https://ambientcg.com/a/Plastic010> |
| **Licence** | CC0 1.0 Universal |
| **Author** | ambientCG (Lennart Demes) |
| **Physical tile** | Not published by the provider |

`RULES.md` §9 asks for pieces that read as "slightly glossy, hard" injection-moulded plastic and
that "feel a bit cheap in the hand" next to the bamboo — that contrast is the artefact, so these
are deliberately not polished. The source roughness map has **mean 0.36**, which lands exactly
there without tuning.

| Map used | Source file | Ships as |
|---|---|---|
| Normal (OpenGL) | `Plastic010_1K-JPG_NormalGL.jpg` | `piece_normal.webp` |
| Roughness | `Plastic010_1K-JPG_Roughness.jpg` | `piece_rough.webp` |

**No albedo map, on purpose.** Piece colour is *player identity*. It comes from
`material.color`, and a baked albedo would either override it or muddy it. Every player's pieces
share one set of micro-surface maps and differ only in tint — which is also what makes the
nested tricolour bullseye (§9) read as one moulding in three colours rather than three different
materials.

The normal map is nearly flat (measured stddev **0.36%**) and encodes to **692 bytes**. It
contributes only a faint wobble in the specular highlight, which is precisely the cheap-moulding
cue we want, so it earns its space many times over.

---

## Processing

Performed by `scripts/fetch-textures.mjs` with ImageMagick, single-threaded and niced, one image
at a time.

- **Format:** WebP. AVIF was considered and rejected — the local ImageMagick has no AVIF
  delegate, and WebP's support floor (iOS 14+, all evergreen browsers) is already universal for
  this audience. There is no measurable win left for the sizes involved.
- **Quality:** albedo q84–88; normal maps **q90**; roughness q85–88.
  Normal maps get the higher setting because lossy WebP is always 4:2:0 chroma-subsampled, and a
  normal map's R/G channels are independent vector data rather than correlated colour. Measured
  on the felt normal at 1024px: q90 gave RMSE 3.82% at 459 KB versus near-lossless at 0% and
  2.2 MB — but dropping that map to 512px, where it is tiled 12× and mipmapping discards the
  fine detail anyway, cost 72 KB and looks better than the 1024 version in situ. Resolution,
  not encoder quality, was the right lever.
- **Roughness maps are converted to greyscale.** three.js samples `.g`; a greyscale WebP decodes
  to R=G=B, so the stored value survives, and removing chroma entirely means subsampling has
  nothing to damage.
- **Colour handling:** albedo is converted to sRGB; data maps are *relabelled* sRGB without
  conversion, so their bytes pass through untouched. Letting an image tool "helpfully" linearise
  a normal map is a classic way to wreck one.
- **Seams:** both tiling albedos were checked. Opposite-edge mean brightness matches to within
  0.02% (board) and 0.5% (felt), so they tile without banding.

## Payload

Two tiers ship. **Exactly one is ever downloaded** — `src/scene/textures.ts` picks from screen
size, device pixel ratio and the Save-Data hint, and it can be overridden.

| Tier | Resolution | Total | Budget |
|---|---|---|---|
| `sd` (phones, Save-Data) | 256–512 px | **71 KB** | 160 KB |
| `hd` (desktop, tablets) | 256–1024 px | **290 KB** | 460 KB |
| Both tiers on disk | | **371 KB** | — |

The four-phones-on-cellular scenario costs **71 KB of textures per device** — less than a single
hero JPEG on a typical marketing page. The budget is enforced in `fetch-textures.mjs` and the
script reports a failure if a future change exceeds it.

| File | `sd` | `hd` |
|---|---|---|
| `board_albedo.webp` | 16.1 KB | 72.3 KB |
| `board_normal.webp` | 0.8 KB | 6.5 KB |
| `board_rough.webp` | 9.1 KB | 38.2 KB |
| `table_albedo.webp` | 10.9 KB | 55.5 KB |
| `table_normal.webp` | 7.9 KB | 71.8 KB |
| `table_rough.webp` | 20.5 KB | 20.5 KB |
| `piece_normal.webp` | 0.2 KB | 0.7 KB |
| `piece_rough.webp` | 6.0 KB | 24.6 KB |

`table_rough` is identical in both tiers — it is already at the 256 px floor, below which a
roughness map stops carrying useful variation.

## Should these be committed?

**Yes.** At 371 KB for both tiers the repo cost is negligible, and committing buys real things:
a fresh clone runs textured with no network, CI is deterministic, and the game does not depend on
two third-party CDNs staying up. Regenerating from source needs ~12 MB of downloads, which is
exactly the cost we should pay once rather than per developer.

> **Note for whoever owns `.gitignore`:** it currently contains
> `public/textures/**/*.webp`, which excludes this entire payload. That rule was a sensible
> default when the payload was expected to be megabytes; at 371 KB the trade-off reverses.
> Adding `!public/textures/**/*.webp` after that block restores the intent. The other ignored
> binary formats can stay — this pipeline does not produce them.

## Adding a texture later

1. Confirm the licence **at the provider's licence page**, not from a search result or a mirror.
   If you cannot confirm it, do not use the asset.
2. Add the source to `SOURCES` in `scripts/fetch-textures.mjs` with its page URL, author and
   licence key, and add its outputs to `OUTPUTS`.
3. Add the file to `SURFACES` in `src/scene/textures.ts`. The fetch script cross-checks the two
   and fails loudly if they drift.
4. Record it here, including which maps you skipped and why.
5. Check the payload budget still passes. If it does not, reach for resolution before reaching
   for encoder quality — see above.
