# Otrio design system

Tokens, theming and the responsive system. **You provide nothing here — you consume it.**

---

## Integration (two lines, one file)

In `main.tsx`:

```ts
import './styles/index.css'   // must be first
import './hooks/useTheme'     // optional: guarantees the theme is applied before first paint
```

There is **no ThemeProvider and no BreakpointProvider**. All three hooks use a module-scoped
store, so any component can call them and non-React code can use the imperative equivalents.

In `index.html`, the viewport tag must be exactly:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#e8ecf3" />
```

`viewport-fit=cover` is what makes `env(safe-area-inset-*)` report real numbers; without it iOS
returns 0 for all of them and the UI ends up under the notch. If the tag is missing or lacks it,
`useSafeArea` patches it at runtime — but fix the HTML. There is deliberately **no
`user-scalable=no`**: double-tap zoom is already handled by `touch-action`, and disabling pinch
zoom breaks the app for anyone who needs to magnify it. `theme-color` is updated automatically
when the theme changes.

---

## Files

| File | What it is |
|---|---|
| `tokens.css` | Every CSS custom property. Light on `:root`, dark in two blocks. |
| `reset.css` | Normalisation + the mobile full-screen-canvas handling. |
| `base.css` | Focus, selection, scrollbars, links, global reduced-motion. |
| `layout.css` | The responsive app shell (`.app-*` classes). |
| `utilities.css` | `u-` prefixed helpers. |
| `index.css` | Imports the above in order. This is the entry point. |
| `tokens.ts` | The same values, typed, for three.js and for logic. |
| `theme.ts` | `Theme` / `SceneTheme` objects + the drift checker. |
| `index.ts` | Barrel for the TS surface. |

---

## Colour tokens

Every token exists in both themes. CSS name = kebab-case of the TS key
(`player1Rim` → `--player-1-rim`).

**Surfaces** `--bg` `--surface-1` `--surface-2` `--surface-3`
`--surface-3` is the *lowest-contrast* surface; every foreground token is verified against it, so
anything legible on `--surface-3` is legible on the other two.

**Borders** `--border-subtle` (decorative, no guarantee) `--border-strong` (≥ 3:1 everywhere — use
this on anything interactive)

**Text** `--text-primary` `--text-secondary` `--text-muted` `--text-inverse`
All three clear 4.5:1 on all four surfaces. `--text-muted` is as light as it is allowed to get.

**Accent** `--accent` `--accent-hover` `--accent-active` `--accent-contrast` `--accent-soft`
UI chrome only. It never appears on the board next to a piece, which is why it can be a hue close
to a player colour without causing confusion.

**Status** `--success` `--warning` `--danger` `--info`, each with `-on` (text on the solid fill),
`-soft` (tinted background) and `-on-soft` (text on that background).

**Players** — six roles each, `--player-{1..4}-*`.

> **The CSS variables are 1-based; `PlayerIndex`/`PlayerColor` in TypeScript are 0-based.**
> `--player-1` is purple, which the engine calls colour `0`. Mapping:
> `--player-1` purple (N) · `--player-2` red (E) · `--player-3` green (S) · `--player-4` blue (W).
> Use `playerVar(index, role)` or the `u-player-${index + 1}` form rather than writing the number
> yourself — an off-by-one here is silent, you simply render another player's colour.

Picking the wrong *role* is the other usual way a palette quietly fails, so they are named by job:

| Role | CSS | Use for | Guarantee |
|---|---|---|---|
| base | `--player-N` | 3D piece material, swatch fill. **The identity.** | — |
| ui | `--player-N-ui` | HUD text, icons, thin strokes | ≥ 4.5:1 on every surface |
| rim | `--player-N-rim` | Piece outline in the 3D scene | ≥ 3:1 against the board |
| soft | `--player-N-soft` | Chip / active-row background | — |
| onSoft | `--player-N-on-soft` | Text on `soft` | ≥ 4.5:1 on `soft` |
| on | `--player-N-on` | Text on `base` | ≥ 4.5:1 on `base` |

**Where the four `base` hexes come from:** they are fixed by the official setup artwork
(`docs/RULES.md` §2.4 — purple north, red east, green south, blue west) and owned by
`src/scene/materials/palette.ts`. Index order matches `PLAYER_COLOR_NAMES` in `src/game/types.ts`,
so colour 2 is "green" everywhere. The other five roles are derived here from those same hues
(measured drift: ≤ 0.4°) at whatever lightness clears the contrast requirement.

Because those hexes were chosen to look right as lit plastic on a board — not as 12px text on a
panel — several derived roles land a long way from `base`. Light-mode green is an olive `#517400`
from a lime `#a2d733`; dark-mode purple is a lilac `#b877ff` from `#7237b8`. That is the role doing
its job. **Pair a `base` swatch with `ui` text** — the swatch carries identity, the text carries
legibility.

⚠️ `SEAT_COLORS` in `src/net/protocol.ts` is a third, stale palette (red/blue/green/yellow). It is
being removed — colour is becoming a first-class `PlayerColor` on the wire rather than a function
of seat. **Do not derive anything from it.**

**Current player.** Put `u-player-2` on any container and everything inside can read
`--player-current`, `--player-current-ui`, `--player-current-soft`, `--player-current-on-soft`,
`--player-current-on`, `--player-current-rim` without knowing which player it is.

```tsx
<div className={`u-player-${playerIndex + 1}`}>
  <span className="u-swatch">{player.glyph}</span>
  <span style={{ color: 'var(--player-current-ui)' }}>{player.label}</span>
</div>
```

`.u-swatch` already carries the 1px `--border-strong` ring that gives a pale fill (lime green on white)
its required 3:1 boundary.

**Scene** `--scene-bg` `--board-base` `--board-line` — mirrored in `tokens.ts` for three.js.

---

## Other token groups

**Type** — fluid, interpolating from a 360px phone to a 1440px desktop, then clamping. No
breakpoint jumps in text size.
`--text-2xs` `--text-xs` `--text-sm` `--text-base` `--text-md` `--text-lg` `--text-xl` `--text-2xl`
`--text-3xl` `--text-display` · `--leading-{tight,snug,normal,relaxed}` ·
`--weight-{regular,medium,semibold,bold}` · `--font-sans` `--font-mono`

**Space** — fixed 4px scale, `--space-{0,px,1,2,3,4,5,6,8,10,12,16,20,24}`. Deliberately *not*
responsive, so `--space-4` means the same thing everywhere. Density lives in the layout tokens.

**Radius** `--radius-{xs,sm,md,lg,xl,2xl,pill,full}`

**Elevation** `--shadow-1` … `--shadow-5`. Composed from `--shadow-a/-b/-hi`, which are redefined
per theme — in dark mode `--shadow-hi` becomes a lit top edge, because a cast shadow alone reads as
nothing on a dark background.

**Motion** `--dur-{instant,fast,base,slow,slower,slowest}` ·
`--ease-{standard,decelerate,accelerate,overshoot}`. `prefers-reduced-motion` collapses every
duration globally in `base.css` — **do not check it yourself for CSS transitions.** You *do* need
to check it for three.js/react-spring: `useReducedMotion()`.

**Layering** `--z-{canvas,hud,panel,sheet,modal,toast,tooltip}`

**Glass** `--glass` `--glass-border` + `.u-glass`. Goes opaque automatically under
`prefers-reduced-transparency`.

**Focus** `--focus-ring-color`, and `:focus-visible` already draws a 3px ring app-wide. You should
not need to style focus at all.

---

## Theming

```ts
const { mode, preference, systemMode, isFollowingSystem, theme, setPreference, toggle, cycle } =
  useTheme()
```

- `preference` is `'light' | 'dark' | 'system'`; `mode` is the resolved `'light' | 'dark'`.
- The **preference** persists (`localStorage`), not the resolved mode. That is what makes the
  override work in both directions — a user on a dark OS who picks light gets light, and keeps it.
- `toggle()` flips to the opposite of what is currently showing. `cycle()` goes
  system → light → dark → system, for a three-state control.
- `setPreference('system')` clears the override.

Also available: `useThemeMode()`, `useThemeColors()`, and outside React
`getThemeMode()` / `setThemePreference()` / `toggleTheme()`.

### Ownership: there is exactly one theme preference

`src/hooks/useTheme.ts` is the **sole** reader and writer of the theme preference, and the sole
caller of `applyThemeAttributes` for theme purposes. Two stores writing `data-theme` means the
board can end up in a different mode from the chrome around it, depending on which wrote last.

`src/hooks/` sits below `src/store/`, so the dependency points that way: an app store delegating
down to the theme layer is fine; the theme layer reaching up into app preferences is not.

**Storage key — `otrio:theme-preference`**, value is the bare string `light`, `dark` or `system`
(absent means `system`). Exported as `THEME_STORAGE_KEY`; import it rather than retyping it.

It is deliberately a flat string and not a field inside a JSON bundle, because the pre-paint script
below is the most failure-sensitive code in the app — it runs before any module, cannot import, and
must never throw. One `getItem` and one comparison beats `JSON.parse(raw).state.theme`, which
couples the first paint to a store's schema version and partialise shape: rename a field and
dark-mode users get a flash of light with nothing failing loudly. Writes are atomic too, so
changing the theme cannot clobber a concurrent write to an unrelated preference.

**To delegate from another store**, keep no theme state and no `matchMedia` listener of your own:

```ts
import {
  getThemeSnapshot, setThemePreference, subscribeToTheme,
} from '../hooks/useTheme'

setTheme: (theme) => setThemePreference(theme),          // write
theme: getThemeSnapshot().preference,                    // seed
subscribeToTheme(({ preference, mode }) =>               // mirror
  setState({ theme: preference, mode })),
```

`subscribeToTheme` fires for *every* cause — an explicit set, the OS flipping while the preference
is `system`, and another tab changing it. That last one is why mirroring stores must subscribe
rather than only write, or two tabs of the same game drift apart. It is not called on subscribe;
seed with `getThemeSnapshot()`.

Do **not** also call `applyThemeAttributes` — the theme store already did, including `data-theme`,
`data-theme-pref`, `color-scheme` and the `theme-color` meta tag. Calling it directly paints the
DOM without telling the store, so the next change from anywhere else silently reverts you. In dev
that earns a one-time console warning naming the right call to make instead.

### Pre-paint script

This belongs in `index.html` and must run before any module, or a dark-mode user sees a flash of
light on every load. It is the one place the key is duplicated, so keep it matching
`THEME_STORAGE_KEY`:

```html
<script>
  (function () {
    var root = document.documentElement;
    try {
      var pref = localStorage.getItem('otrio:theme-preference');
      if (pref !== 'light' && pref !== 'dark') pref = 'system';
      var mode =
        pref === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
          : pref;
      root.setAttribute('data-theme', mode);
      root.setAttribute('data-theme-pref', pref);
      root.style.colorScheme = mode;
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = mode === 'dark' ? '#0b0e13' : '#e8ecf3';
    } catch (err) {
      /* Remove it rather than defaulting to light: with no `data-theme`,
         tokens.css resolves dark from `prefers-color-scheme` on its own, which
         is the correct answer on a dark device. Forcing 'light' here is the
         exact flash this script exists to prevent. */
      root.removeAttribute('data-theme');
    }
  })();
</script>
```

`<html data-theme="system">` as the authored default is fine — `tokens.css` matches dark via
`:root:not([data-theme="light"])`, so an unrecognised value behaves as "follow the OS".

**How it resolves in CSS**, in cascade order:

1. `:root` holds light — the no-JS default.
2. `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` — dark for dark-OS users,
   *applied before any JavaScript runs*, so there is no flash of light theme.
3. `:root[data-theme="dark"]` — explicit choice, beats a light OS.

The `:not([data-theme="light"])` in step 2 is the whole trick. Without it the media query keeps
winning and a dark-OS user can never get light.

---

## The 3D scene

three.js cannot read CSS custom properties. It reads the identical values from `tokens.ts`:

```tsx
import { useSceneTheme } from '../hooks/useTheme'

function Board() {
  const s = useSceneTheme()          // stable identity per mode — safe in deps arrays
  return (
    <>
      <color attach="background" args={[s.background]} />
      <fog attach="fog" args={[s.fog.color, s.fog.near, s.fog.far]} />
      <ambientLight color={s.lights.ambient.color} intensity={s.lights.ambient.intensity} />
      <directionalLight {...s.lights.key} castShadow />
      <Environment preset={s.environment.preset} environmentIntensity={s.environment.intensity} />
      <ContactShadows {...s.shadow} />
      <mesh>
        <meshPhysicalMaterial
          color={s.board.base}
          roughness={s.board.roughness}
          metalness={s.board.metalness}
        />
      </mesh>
    </>
  )
}
```

`SceneTheme` provides `background`, `fog`, `board`, `piece` (material parameters), `lights`
(`ambient`/`key`/`fill`/`rim`), `environment`, `shadow`, `toneMappingExposure`, `highlight`
(`hover`/`target`/`blocked`/`lastMove`/`winGlow` with opacities) and `players[]`.

Set `gl.toneMappingExposure = s.toneMappingExposure` — dark mode uses 1.15 so saturated pieces do
not sink into the dark board.

**Colour management.** Every string is an sRGB hex, which is what three.js expects.
`ColorManagement` is on by default in r152+ (this project is r171), so `new THREE.Color(hex)` and
the R3F `color` prop convert sRGB → linear for you. **Do not call `.convertSRGBToLinear()`** — that
double-converts and the scene comes out washed out.

**Two things that must not be skipped:**

1. **Render the rim.** `players[i].rim` is an accessibility guarantee, not a style choice. No
   single board colour can clear 3:1 against all four fills: the green piece on the light board is
   1.53:1, and purple on the dark walnut is also 1.53:1. The rim clears 3:1 against the board for
   every player in both themes, so it is what makes the silhouette perceivable. Use it as an
   outline, a bevel edge, or the piece's underside.

   Dark-mode rims are derived against the **walnut** board (`#4a3a28`, L\* 25.7 — the lighter of
   the two plausible boards), so they also clear 3:1 against the darker `--board-base` `#232b38`.
   Measured: 3.02 / 3.55 / 7.58 / 5.06 on walnut; 3.95 / 4.64 / 9.90 / 6.61 on `--board-base`.
2. **Render the glyph.** `PLAYERS[i].glyph` (`● ▲ ■ ◆`) on the piece's top face. Colour separation
   is strong but it is never total — see the greyscale row below. This is the cheap redundancy that
   makes the design robust rather than statistically robust.

**Layout.** `useBreakpoint().layout` gives `{ panelStart, panelEnd, hudPad, controlSize }` in CSS
pixels. When a 320px sidebar is docked, offset the camera (or the board) by
`(panelStart - panelEnd) / 2` or the board sits half-hidden behind it.

`useReducedMotion()` — skip camera fly-throughs, piece bounce and the win celebration; jump to the
end state. CSS reduced-motion handling does not reach three.js.

`SPRING` in `tokens.ts` has react-spring configs: `snappy` (UI), `gentle` (camera/panels),
`drop` (a piece landing), `wobble` (win).

---

## Responsive

Six breakpoints. `xs` is the base — the design starts at a 360px phone and *adds*.

| | Width | What actually changes |
|---|---|---|
| `xs` | 0–479 | Board owns the screen. HUD is two floating overlays: a thin player strip on top, the current player's three piece sizes on the bottom. Everything else is a sheet. Mid-game controls sit in the bottom third, reachable one-handed. |
| `sm` | 480+ | Same shell, more room — player dots become named chips with piece counts. |
| `md` | 768+ | Tablet portrait. Panels exist but **overlay** rather than dock: taking 288px from 768px would leave the board smaller than on a phone. Sheets become centred dialogs. |
| `lg` | 1024+ | Panel **docks** — the board is offset, not covered. Full roster with piece inventories permanently visible. |
| `xl` | 1440+ | Second rail for the move log. Everything at once, no disclosure. |
| `xxl` | 1920+ | Wider panels; the UI caps at 2240px and centres. |

**Phone landscape** (`landscape` and ≤ 500px tall) overrides all of the above, because there the
constraint is *height*, not width: a top strip plus a bottom bar would eat ~40% of a 380px-tall
viewport. The overlays become 72px left/right rails where the thumbs already are, and `--hud-pad`
halves. Note this also catches a short desktop window, which wants the same treatment.

**Ultrawide** (≥ 2:1) caps the interface at `min(2240px, 150vh)` and centres it. The canvas stays
full-bleed underneath. Without the cap, on a 3440px display your piece tray and your opponent's sit
at opposite edges of peripheral vision.

**Touch** (`pointer: coarse`) raises `--hit-min` to 48px and grows `--control-size`.

```ts
const { name, width, height, orientation, isPhoneLandscape, isTouch, canHover,
        isUltrawide, density, prefersReducedMotion, layout,
        isAtLeast, isBelow } = useBreakpoint()

if (isAtLeast('lg')) return <DockedPanel />   // use for *different components*
return <Sheet />                              //   not for restyling one
```

Also: `useBreakpointName()`, `useIsAtLeast('lg')`, `useMediaQuery(q)`.
`density` is `'compact' | 'cozy' | 'comfortable'` — how much the HUD should show.

### Shell classes

```html
<div class="app-canvas"><!-- <Canvas/>: fixed, inset 0, full-bleed --></div>
<div class="app-shell">
  <aside class="app-panel-start"><!-- docked from lg --></aside>
  <main class="app-stage">
    <div class="app-hud-top">…</div>
    <div class="app-hud-bottom">…</div>
  </main>
  <aside class="app-panel-end"><!-- docked from xl --></aside>
</div>
```

`.app-shell` and `.app-stage` are `pointer-events: none` with children set back to `auto`, so you
can drag the board through the gaps between HUD elements. `.app-stage` already applies safe-area
padding. Panels are `display: none` below their breakpoint — render the same content in
`.app-sheet` instead.

---

## Mobile viewport rules

Handled for you in `reset.css`: document rubber-band, double-tap zoom, the 300ms click delay,
landscape font inflation, tap highlight, long-press callout, and text selection while dragging.

Four rules you have to follow:

1. **Never write `100vh`.** It is the *large* viewport on mobile Safari, so the bottom of your
   layout sits under the toolbar and cannot be tapped. Use `var(--vh-dynamic)` (`100dvh`, tracks
   the toolbars) or `var(--vh-small)` (`100svh`) when something must never be covered.
   `.u-vh` / `.u-min-vh` / `.u-vh-safe` do this for you.
2. **Scrollable regions need `.u-scroll`** (or `overscroll-behavior: contain`). Otherwise a flick
   that hits the end of a list scrolls the page behind it.
3. **Pad with safe areas.** `max(var(--safe-bottom), var(--space-4))` — `max()` so you keep a
   sensible minimum on devices with no insets. Or `.u-safe-*`. In *landscape* the notch moves to
   the side, so `--safe-left` / `--safe-right` matter too.
4. **Inputs must compute to ≥ 16px** or iOS zooms the page on focus. `reset.css` enforces this;
   do not override it downward.

`useSafeArea()` → `{ top, right, bottom, left, keyboard }` in px, when you need numbers rather than
CSS. `keyboard` is also published as `--keyboard-inset` (0px when no keyboard is up), which
`.app-hud-bottom` already uses to lift clear.

---

## Verified contrast

Generated and checked programmatically, not eyeballed. Worst case across **all four surfaces** in
each theme (WCAG 2.1: 4.5:1 body text, 3:1 non-text).

| | light (min) | dark (min) |
|---|---|---|
| `--text-primary` | 15.27 | 11.74 |
| `--text-secondary` | 6.54 | 6.34 |
| `--text-muted` | 4.88 | 4.90 |
| `--border-strong` | 3.01 | 3.00 |
| `--accent` | 4.51 | 4.52 |
| player `ui` (worst of 4) | 4.51 | 4.51 |
| player `rim` vs board | 3.00 | 3.02 |
| text on `soft` / on `base` | 4.50 | 5.36 |

### Player colour separation

Minimum CIEDE2000 across all six pairs, after simulating each vision type
(Machado/Oliveira/Fernandes 2009 at full severity). ΔE ≥ 15 is comfortably distinguishable; ΔE < 10
is a problem.

The `base` hexes are theme-independent, so these numbers apply to both themes.

| Vision | min ΔE | tightest pair |
|---|---|---|
| typical | 44.6 | purple–blue 45 |
| protanopia | 29.8 | red–green 30 |
| tritanopia | 17.5 | green–blue 17 |
| deuteranopia (~6% of men) | **15.4** | red–green 15 |
| achromatopsia (greyscale) | **9.7** | red–blue 10, green–blue 10 |

Purple/red/green/blue is close to the worst four-way set for red-green deficiency, which is why
these particular hexes were tuned rather than picked: every pair that converges in lightness
diverges on the blue-yellow axis that survives. The L\* ladder is 37 / 55 / 80 / 66.

**Greyscale (9.7) sits just under the ΔE 10 I would want**, and it is the one figure here that does
not clear its own bar. It is a property of the official hues, not of the derivation, and it is
covered by two non-colour channels rather than by shifting a hue: the glyph (●▲■◆) and the scene's
gloss-to-matte **finish ladder**, where the darkest piece is the glossiest and the lightest the most
matte. Both must be rendered.

| | key | seat | base | light `ui` | dark `ui` | glyph |
|---|---|---|---|---|---|---|
| P1 | purple | north | `#7237b8` | `#7237b8` | `#b877ff` | ● circle |
| P2 | red | east | `#e8501e` | `#c63100` | `#ff6430` | ▲ triangle |
| P3 | green | south | `#a2d733` | `#517400` | `#a2d733` | ■ square |
| P4 | blue | west | `#1cafd2` | `#00738c` | `#1cafd2` | ◆ diamond |

---

## Keeping CSS and TS in sync

`tokens.css` and `tokens.ts` hold the same 58 colour tokens per theme. There is no build step to
generate one from the other, so instead there is a runtime check: `verifyThemeSync()` diffs every
constant against the live computed value of its CSS custom property and logs a console error naming
any token that drifted. It runs automatically in dev on first paint, for both themes.

**If you change a colour, change it in both files.** You will hear about it immediately if you
don't.
