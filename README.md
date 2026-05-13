# Helio

The galaxy-map screen of **Helio**, a planned 4X space strategy game in the lineage of Ascendancy (1995).

A 3D pixel-art visualization of the stars within ~50 light years of the Sun. Perspective camera orbiting a focused star, stellar discs sized by spectral class and depth-attenuated, range rings + drop-lines lighting up around the cluster you've selected (the catalog reads as plain stars until you pick one to inspect), all rendered in a deliberately chunky retro aesthetic.

Think 1980s starbase HUD: inline bitmap-font labels, cyan-on-near-black palette, hand-drawn-looking concentric range rings. The HUD chrome (settings trigger, info card) renders as native pixel art inside the WebGL scene rather than as DOM elements. The settings trigger drops down a tabbed popover — **General** (auto-rotate, reset view), **Graphics** (display toggles, render-resolution chooser), **Controls** (touch input, plus a read-only keyboard / mouse reference).

## Stack

- **Vite 8** — dev server + build (`vite.config.ts` opens the browser on `npm run dev`)
- **TypeScript 6** — strict mode, `noUnusedLocals`/`noUnusedParameters`, `noEmit` (Vite handles emit)
- **Three.js r184** — WebGL renderer, scene graph, shaders

No CSS framework, no state library, no testing framework yet.

## Scripts

```
npm run dev        # vite dev server, opens browser
npm run build      # tsc + vite build → dist/   (tsconfig sets noEmit, so tsc just type-checks)
npm run preview    # serve dist/
npm run typecheck  # tsc --noEmit
```

## Project layout

One line per file — what it owns. Depth lives in the Architecture notes below; behavior overlaps (`grid.ts` choreography, `panel.ts` row kinds, etc.) are documented there, not here.

```
index.html                  Vite entry: inline splash markup + critical CSS, single <script> → main.ts
scripts/                    Star-data tooling — read scripts/README.md first
  README.md                 Workflow guide for star-data tasks
  scrape-wiki-stars.mjs     Initial-seeding Wikipedia → CSV scraper
  find-missing-stars.mjs    Diff a CSV against the catalog; --add inserts missing rows
  fill-from-stellarcatalog.mjs   Backfill empty cells from cached catalog detail pages
  sync-with-catalog.mjs     Assign stable id (catalog slug) + canonical name to every row
  expand-systems-from-catalog.mjs   Bind/add sibling rows from catalog <h2> sections
  import-system-from-catalog.mjs    Idempotent full rewrite of one system from its catalog page
  audit-unresolved.mjs      Categorize non-catalog rows as OVERLAP / NEAR / DISTINCT
  lookup-star.mjs           Ad-hoc: name (or distance range) → catalog URL
  lib/catalog-index.mjs     Shared catalog parsing, name matching, CSV, redirects
src/
  main.ts                   Bootstrap: fonts, canvas, AppController, splash dismissal
  styles.css                Body reset + canvas (splash CSS is inline in index.html)
  settings.ts               Persisted user preferences (versioned localStorage blob)
  scene/                    Three.js — no DOM coupling beyond the canvas
    app-controller.ts       AppController: owns shared WebGLRenderer; swaps active scene
    scene.ts                StarmapScene: galaxy view, tick loop, selection routing
    system-scene.ts         SystemScene: cluster close-up, lazily built/disposed
    input-controller.ts     InputController: classifies pointer/keyboard gestures into intents
    grid.ts                 Range rings + axes + galactic-centre arrow; ring expand/collapse choreography
    droplines.ts            Per-cluster vertical pins to the selected COM.z plane
    cluster-fade.ts         Distance fade thresholds shared by labels and droplines
    focus-marker.ts         view.target ring + dropline; fades in when pivot pans off anchors
    cluster-brackets.ts     Yellow corner brackets — selection arms + candidate dots
    stars.ts                gl.POINTS starfield with per-star size + color
    labels.ts               Bitmap-font overlay pass: star names + axis ticks
    materials.ts            Pixel-snapped line/dot ShaderMaterials + stars shader
    render-scale.ts         RenderScaleObserver: picks integer N for setPixelRatio(DPR/N)
  ui/                       Pixel-art widget toolkit + per-screen HUD orchestrators.
                            Each HUD renders its own ortho pass at 1 unit = 1 buffer pixel.
    widget.ts               Widget base: Mesh + plane + optional CanvasTexture lifecycle
    base-panel.ts           Repaint-on-state-change canvas-texture panel base
    panel.ts                Tabbed popover; toggle / action / keybinding / radio rows
    icon-button.ts          Texture-pool button (off / hover / on / onHover)
    action-button.ts        Text-pill button (off / hover / disabled)
    painter.ts              Shared 2D primitives: surfaces, glyphs, pill + segmented-pill buttons
    theme.ts                Colors, sizes, fonts shared across widgets
    hit-test.ts             'interactive' | 'opaque' | 'transparent' pointer-routing contract
    map-hud/
      index.ts              MapHud: settings trigger, panel, info card, action pills
      info-card.ts          Bottom-right cluster info card
    system-hud/
      index.ts              SystemHud: header bar + back button + reused InfoCard
      header-bar.ts         Full-width top bar with centered system name
  data/                     Star catalog + bitmap fonts. For data tasks see scripts/README.md.
    nearest-stars.csv       0–20 ly bracket; Wikipedia-seeded, hand-tunable
    stars-20-25ly.csv       20–25 ly bracket
    stars-25-30ly.csv       25–30 ly bracket
    stars-30-35ly.csv       30–35 ly bracket
    stars-35-40ly.csv       35–40 ly bracket; catalog-seeded (no Wikipedia source)
    stars-40-45ly.csv       40–45 ly bracket; catalog-seeded
    stars-45-50ly.csv       45–50 ly bracket; catalog-seeded
    stars.ts                Loads CSVs, derives positions/mass/radius, builds clusters + lookup
    kdtree.ts               Static 3D k-d tree backing nearest-cluster queries + pair scans
    BDF/<Family>/<n>.bdf    Bundled bitmap fonts (Monaco, EspySans, EspySansBold)
    bdf-font.ts             BDF parser + per-font canvas atlas renderer
    font-provider.ts        Typed FONTS catalog; lazy registration + DEV drift check
    pixel-font.ts           makeLabelTexture / drawPixelText composition helpers
```

## Architecture notes

### Bootstrap / scene split

`main.ts` is minimal — it imports the global stylesheet, parses the bundled BDF fonts, creates the canvas, instantiates an `AppController`, and dismisses the boot splash (held 350 ms, faded 600 ms). The controller owns the shared `WebGLRenderer` and decides which view-mode scene's `tick()` loop is currently driving the canvas. Two peer scenes share the renderer: `StarmapScene` (galaxy view, the default) and `SystemScene` (close-up of one cluster, lazily constructed on entry, disposed on exit). Only one is running at a time.

The boot splash itself (cyan dot + two pinging range rings) is **inlined in `index.html`** — markup in `<body>`, critical CSS in a `<head>` `<style>` block — so it paints on the first frame, before the JS bundle is fetched and parsed. The splash isn't waiting on `main.ts`; `main.ts` is just responsible for removing it once the scene is up.

There's no UI plumbing between the bootstrap and the scenes: each scene owns its own HUD orchestrator (`MapHud` for galaxy view, `SystemHud` for system view), each with its own ortho pass at 1 unit = 1 buffer pixel. HUD widgets are built on `Widget` (Mesh + PlaneGeometry + MeshBasicMaterial + optional CanvasTexture) so HUD geometry shares the rest of the scene's pixel grid.

Each HUD captures pointer events first (in the scene's `onPointerDown` / `onPointerMove` via `clientToHud()`), so clicking a button or a panel row never starts a pan/orbit and hovering swaps the cursor to `pointer`. `MapHud` exposes `onToggle`, `onAction`, `onDeselect`, `onViewSystem`, `onFocus`, and `onSettingsChanged` callbacks; `SystemHud` exposes `onBack`. `src/settings.ts` is the single source of truth for persisted user preferences — `singleTouchAction`, the display toggles (`showLabels`, `showDroplines`), and `resolutionPreference`. The blob is versioned; old saves are merged over fresh defaults on read so adding new fields can't invalidate them. `MapHud` seeds its in-panel toggle state from `getSettings()` at construction and writes through `setSetting()` on each flip; the scene seeds the renderer-side state (`Labels`, `Droplines`) from the same source so the HUD checkbox and the rendered geometry agree on first paint. For touch input and resolution, the scene reads `getSettings()` at gesture/resize time (pull-on-read), so a flipped preference takes effect on the next pointer event or resize with no callback plumbing — `onSettingsChanged` triggers a `resize()` so the resolution radio applies immediately rather than waiting for a window event. The `spin` toggle is intentionally NOT persisted — it's a session fidget, not a preference that should survive a refresh.

Each HUD also exposes `hitTest(bufX, bufY)` returning one of `'interactive' | 'opaque' | 'transparent'` (see `src/ui/hit-test.ts`). The scene queries it once per `pointermove` and only sets `pointer.has = true` when the result is `'transparent'`, so stars behind a button, panel, or info card body don't light up hover labels through the chrome above them. `'opaque'` covers visually-solid surfaces that aren't clickable (panel background, card body, disabled focus button) — they block scene picks and absorb clicks (so a mousedown on the card body doesn't start an orbit drag) without changing the cursor. `'interactive'` adds the cursor swap and dispatches the click. This three-way model is the seed of the layered input router described in [`FUTURE_PLANNING.md`](./FUTURE_PLANNING.md); each HUD's `hitTest` will become an `InputLayer` when modals / tooltips / context menus arrive.

The `scene/` modules know **nothing about the DOM** beyond the `HTMLCanvasElement` they render into and `window` for size/input listeners. Don't add DOM queries in there — route data through callbacks or new methods on the scene.

### UI subsystem

Helio is a 4X game — the galaxy map is the *first* screen, not the only one. Future siblings (research tree, fleet management, diplomacy, system inspector, ship designer, encyclopedia) will share the same `WebGLRenderer`, the same pixel grid, and the same widget toolkit. That's why `src/ui/` houses *generic* primitives — `Widget`, `BasePanel`, `IconButton`, `ActionButton`, the painter module, theme tokens, the `HitResult` contract — rather than map-specific HUD chrome. When proposing structure (file layout, base classes, orchestrators), think "what does this look like with five more screens" rather than just optimizing for the map. Defer until concrete consumers exist: full input router (today each HUD owns its own `hitTest` directly — see [`FUTURE_PLANNING.md`](./FUTURE_PLANNING.md)), keyboard focus stack, ScrollPanel, world-anchored placement, modal/tooltip/popover taxonomies. Build what current screens need; design only what the next one will.

### Settings panel

`src/ui/panel.ts` is the tabbed-popover widget; `MapHud` builds its spec each rebuild, anchors it to the top-right corner, and routes pointer events into it. Three tabs are wired today:

- **General** — `Auto-rotate view` (session-only `spin` toggle), `Reset view` (action).
- **Graphics** — `Show star labels`, `Show distance droplines` (persisted toggles), and a `Resolution` radio with `Low` / `Medium` / `High` options. The radio biases the auto-computed render N (see "Pixel-perfect rendering" point 1) and the panel disables any option that would clamp to a no-op at the current display.
- **Controls** — `Pan with single touch` (persisted), plus a read-only **Keyboard** + **Mouse** reference. The reference rows use the `keybinding` row kind: a key column in `colors.starName` (yellow) and a description column in `colors.textBody`, with the description column aligned across the section so multiple rows form a clean grid.

Width is measured across **all** tabs' contents at rebuild time (not just the active one) so switching tabs never resizes the panel — width flicker would be worse than a few wasted pixels on shorter tabs. Height is per-active-tab, so the panel grows/shrinks vertically as the user switches; that's fine because the bottom edge moves while the top-right anchor stays put.

Pointer events fan out through four parallel hit-test methods on `Panel`:

- **`hitTab`** — tab strip at the top.
- **`probeRadio`** — per-pill probing for radio rows. Returns `{ rowId, value, disabled }`; the orchestrator dispatches when not disabled and absorbs (returns `'opaque'` from `hitTest`) when disabled, so a click on a no-op option lands silently rather than falling through to the scene.
- **`hitRow`** — toggle / action rows only. Radios are intentionally excluded here because they sit inside row Y bands but only consume sub-rects, and a row-wide hit would absorb clicks in the gaps between pills.
- **`hitsBackground`** — final absorb for clicks/hovers anywhere on the panel surface that didn't match a more specific zone.

`paintSegmentedPill` (in `src/ui/painter.ts`) is the shared primitive for tab pills and radio pills — same selected/hover styling, with an optional `disabled` flag radios use and tabs ignore. Keeping them on one primitive eliminates drift if the look evolves.

The active tab resets to `general` each time the panel opens — most native settings dialogs behave this way, and persisting the last tab would mean a `settings.ts` schema bump for very little payoff.

### Coordinate system

Galactic cartesian, units in light years:
- **+X** points toward the galactic centre (where the +X arrow points)
- **+Z** points toward the north galactic pole (the camera's up vector is fixed to `(0, 0, 1)`)
- The Sun sits at the origin

Star positions are derived at module load from each Wikipedia row's RA/Dec/distance via the standard ICRS → galactic rotation matrix (J2000), so they're as accurate as Wikipedia's parallax-derived inputs. Don't treat the catalog as scientifically authoritative anyway — Wikipedia itself rounds aggressively, and our radii are derived from class + mass (not measured) since the upstream table doesn't carry a radius column.

### Camera

`PerspectiveCamera`, FOV 45°. The camera orbits a 3D pivot point (`view.target`). Single-click on any star (no drag) snaps the pivot onto it; `view.target` lerps to the new star over ~400 ms (ease-in-out cubic) while yaw/pitch/distance stay frozen, so the camera glides over rather than swinging. WASD then translates the pivot in 3D (camera follows by the same vector, distance preserved) so the user can pan away from any star and orbit empty space — clicks set the pivot, keys drift it.

The orbit state lives in `view = { target, distance, yaw, pitch, spin }`. `distance` is the **camera-to-target orbit radius in light years** — closer = zoomed in. Wheel/pinch dolly the orbit in/out; bounds are `[4, 150]` ly. Initial focus = the Sun; the HUD's "reset view" snaps focus, distance, yaw, and pitch back to their defaults instantly (a snap, not a glide — animating four axes at once looks jolty).

Drop-lines now converge toward a vanishing point; under perspective, that's the honest depth cue and we lean into it. The focused-star pivot does the orientation work that the parallel pins used to.

### System view

A close-up tactical view of one cluster lives in `SystemScene` (peer of `StarmapScene`, swapped in by `AppController`). Entry: clicking the **View System** pill button on the galaxy info card, or double-left-clicking a star. Exit: the back button in the system view's header bar, or `Escape`.

`AppController` owns the shared `WebGLRenderer` and the persistent `StarmapScene` instance. Galaxy view state — camera, selection, settings — lives on the `StarmapScene` instance, so the round-trip preserves it without any serialization: `enterSystem` calls `starmap.stop()` and constructs a fresh `SystemScene`; `exitSystem` disposes the system scene and calls `starmap.start()` again. The galaxy scene's `tick()` is paused, not torn down, so resuming is instant and the camera comes back exactly where the user left it.

`SystemHud` mirrors `MapHud`'s structure (own scene + ortho camera + composed widgets, `autoClear` off). It owns a full-width `HeaderBar` with the system name centered and a 1-px accent line along the bottom, an `IconButton` back-arrow on the left edge of the header, and reuses the galaxy view's `InfoCard` (no close-X — the back button is the exit) to list every cluster member.

The 3D scene inside `SystemScene` is currently a skeleton: an empty `Scene`, a `PerspectiveCamera` orbited via simple yaw/pitch on pointer drag, and `wheel` zoom. Future work fills in the cluster's stars as scaled-up disks; today the HUD chrome carries the view.

### Pixel-perfect rendering — the load-bearing constraints

**The pixel-crisp look is the committed visual identity** — not a stepping stone toward a softer aesthetic, and deliberately distinct from the organic-CG genre peers (Ascendancy, Master of Orion 2). If a future feature seems to want a gradient, an anti-aliased stroke, sub-pixel positioning, or DOM-rendered text inside the canvas, the answer is to find a pixel-crisp way to express the same intent (dithering, alternating-row tints, halo'd labels, palette swaps) — not to soften the rules. The painter primitives in `src/ui/painter.ts` and the theme tokens in `src/ui/theme.ts` encode this commitment; treat them as constraints, not defaults to grow past.

The whole "pixel art" look depends on a stack of choices that all have to stay consistent:

1. **`renderer.setPixelRatio(devicePixelRatio / N)`** where N is an integer in {1, 2, 3, 4} chosen at runtime by `RenderScaleObserver` (in `src/scene/render-scale.ts`) to land closest to a 72-DPI visual size for the current `devicePixelRatio` — typically 3 on retina (DPR=2) and 1 on a 1080p desktop (DPR=1). The render buffer is sized so each render ("env") pixel becomes N×N physical pixels after the browser's `image-rendering: pixelated` nearest-neighbor upscale. The user can bias N via the **Resolution** radio (`Low` = +1 chunkier, `Medium` = auto, `High` = −1 sharper); `effectiveScale(auto, pref)` clamps to {1..4}, and the panel disables options that would clamp to a no-op (e.g. `High` on a DPR=1 display, where auto is already 1). DPR boundary crossings (browser zoom, monitor swap, OS scale change) re-fire the observer so the auto N stays current. Increasing N makes the look chunkier and reduces fragment work by 1/N². Critically, **all pixel-aware shader work must use `renderer.getDrawingBufferSize()` — NOT `window.innerWidth/Height`** — because the buffer is now smaller than the CSS viewport. `scene.ts` caches these as `bufferW`/`bufferH` in `resize()` and threads them into `setSnappedLineViewport`, `StarPoints.setPxScale`, `Labels.update`, and `Hud.resize`. Pointer math (raycast NDC, HUD click coords) uses cached `cssW`/`cssH` rather than `window.innerWidth/Height` for the same reason — the canvas may be a few CSS pixels smaller than the window after the integer-multiple rounding (next point).
   **Integer-multiple sizing is load-bearing.** The browser's nearest-neighbor upscale is only exactly N:1 when the target physical pixel count is divisible by N. `resize()` rounds CSS×DPR (the target physical dimension) DOWN to a multiple of N before calling `setSize`, then derives CSS and buffer dimensions from that. Without this rounding, a non-divisible window (e.g. 1366px wide at DPR=2 = 2732 physical px = 911 buffer × 2.999 upscale) gets one buffer column every ~911 columns squashed into 2 physical px instead of 3 — visible as a column of mangled pixels in any label that happens to sit on top of it, with the artifact "following" labels as the camera rotates and they cross fixed bad columns. Cost: up to N-1 physical px of black bezel on the right/bottom (invisible against the dark scene + matching body bg).
2. **Pixel-snapped line shader** (`snappedLineMat` in `materials.ts`) — the vertex shader rounds each projected vertex to the nearest integer screen pixel before rasterization. Eliminates sub-pixel shimmer on thin lines. Used for grid arcs, axes, the galactic-centre arrow, and the solid variant of droplines. A sibling `snappedDotsMat` does the same for 1-pixel `Points` (snapping each point's center to a pixel center so `gl_PointSize = 1` covers exactly one pixel) — used by the dotted dropline variant.
3. **Stars shader** (`makeStarsMaterial`) — `gl.POINTS` with a procedural circle in the fragment shader (no texture sampling, no AA fringe). The vertex shader rounds size to the nearest integer pixel count (so zoom transitions step 2→3→4→5…) and snaps the projected center to the pixel grid using a **parity-aware** snap: even sizes snap to a pixel boundary (integer window coord), odd sizes to a pixel center (half-integer). The snapped center is passed to the fragment shader as a varying `vCenter`. The fragment shader then computes its pixel-grid offset directly from `gl_FragCoord.xy - vCenter` — `gl_FragCoord.xy` is always integer+0.5, and `vCenter` is integer or half-integer, so the difference lands at clean pixel-spacing offsets symmetric about both axes by construction. **Don't use `gl_PointCoord`** for the discard test: its sub-pixel precision is implementation-defined and produces visibly asymmetric discs on some GPUs when the point center sits at sub-pixel positions. The discard threshold is the true Euclidean radius (`length(d) > vRadius`) so sizes 1/2/3 render as full squares and size 4 onward starts dropping corners — the natural pixel-disc progression. The pixel-snap math runs **after** the perspective divide (`clip.xy / clip.w`) so it works identically under ortho and perspective projection.
4. **Label overlay pass** (`Labels` in `labels.ts`) — labels are rendered in a second ortho pass at 1 unit = 1 buffer pixel, the same scheme as the HUD, rather than as 3D Sprites in the main scene. Each frame the cluster primary's world position is projected by the **main** camera; the result drives a `Mesh + PlaneGeometry` placement in the overlay scene, with the top-left corner snapped to an integer buffer pixel so every texel renders. Constant on-screen size keeps typography stable while the depth-attenuated stars do the depth-cueing work — depth-scaling labels on top of depth-scaling stars would just make distant labels illegible.
5. **HUD** (`MapHud` in `src/ui/map-hud/`, `SystemHud` in `src/ui/system-hud/`) — third ortho pass at 1 unit = 1 buffer pixel, rendered after the main scene and label overlay with `autoClear` toggled off. Geometry is `Mesh + PlaneGeometry + MeshBasicMaterial` (the `Widget` base in `src/ui/widget.ts`) so positions and sizes are integer pixel counts that match the rest of the scene's grid. The settings trigger is an `IconButton` with hover-swap textures; the settings panel anchors directly to the trigger's corner so the panel's close-X lands on the burger's exact footprint, and the trigger is hidden while the panel is open — the X visually replaces the burger as the same-position toggle affordance. The settings panel and info card extend `BasePanel`: a single canvas texture rebuilt on state change (toggle flipped, hovered row changed, selection changed) — cheaper than maintaining one texture per row state because each panel is small and rebuilds run only on user input, not per frame.

If you add new scene geometry, route it through `snappedLineMat` for lines and the existing point-shader pattern for sprites — don't introduce vanilla `LineBasicMaterial` or `PointsMaterial`, they'll shimmer.

### Color management is OFF

`app-controller.ts` runs `ColorManagement.enabled = false` at module load and sets `renderer.outputColorSpace = LinearSRGBColorSpace` on the shared `WebGLRenderer` in the constructor. This is intentional and load-bearing.

The whole project's palette is hand-picked sRGB hex values (`0x1e6fc4`, `#5ec8ff`, etc.) intended to render at *exactly* those values on screen. With Three.js's default color management, two parallel paths (shader uniforms via `new Color(0x...)` vs canvas-texture pixels via `fillStyle = '#...'`) get different sRGB↔linear conversions and end up rendering at *different* on-screen colors — visible wherever a canvas-rendered text label sits next to a shader-drawn grid line, dropline, or arrow at the same hex. With management off, every hex value is the displayed value end-to-end, and there's no lighting math to break.

Don't re-enable color management without auditing every call site that mixes `new Color()` (in shaders) with canvas-rendered text textures.

### Bitmap fonts

The HUD draws from a catalog of Mac-classic bitmap fonts shipped as `.bdf` files under `src/data/BDF/<Family>/<size>.bdf`. Vite's `import.meta.glob('./BDF/**/*.bdf', { query: '?raw', eager: true })` bundles every file as a string at build time; `font-provider.ts` indexes them by `(family, size)` and parses lazily on first `getFont(spec)` request. A typed `FONTS` constant gives callers autocomplete:

```ts
import { FONTS } from './data/font-provider';
FONTS.Monaco[11]      // ok
FONTS.Monaco[999]     // ts error — no such size
FONTS.NotAFamily      // ts error — no such family
```

In DEV builds, a drift check warns if `FONTS` and the on-disk directory disagree — a typo in a typed entry, or a `.bdf` added without one (so callers can't autocomplete to it).

`initFonts()` (called once from `main.ts` before any label texture is built) eagerly parses **Monaco 11** so the first frame doesn't pay parse cost on the body font, and injects the custom `►` (U+25BA, used in info-card name lines) onto Monaco via `BdfFont.addGlyph()`. Coverage beyond that is whatever the `.bdf` source carries — printable ASCII for every font, plus the typical Mac symbol set (`°`, `·`, `—`, etc.) on most. MacRoman codepoints 128–255 are remapped to Unicode by glyph name (`degree` → U+00B0, `bullet` → U+00B7, `emdash` → U+2014); glyphs named `uniXXXX` carry their codepoint in the name.

`bdf-font.ts` builds one canvas atlas per font, with white-on-transparent pixels: white callers take a fast direct-blit path; other colors route through a per-call temp canvas with `source-in` tinting. Memory stays at one atlas per font regardless of how many colors are used.

The HUD's font selections live in `src/ui/theme.ts` — EspySans 20 for the title, EspySans 15 for card/panel headers, Monaco 11 for body text. Tweak the tokens there to swap fonts globally.

`makeLabelTexture(...)` (in `pixel-font.ts`) is overloaded three ways:
- `(text, color, opts?)` — single line, single color
- `(segments, opts?)` — single line with per-segment colors (`TextSegment[]`)
- `(lines, opts?)` — multi-line with per-segment colors per line (`TextSegment[][]`)

Options:
- `font: FONTS.Family[size]` — pick the font; defaults to Monaco 11
- `box: true` — draws a bordered surface frame around the text (general primitive; no current consumer in galaxy view, but kept available for HUD chrome)

Also exports `drawPixelText(g2d, text, x, y, color, font?)` so the HUD can compose text into its own canvases alongside borders/fills without going through `makeLabelTexture`.

To add a font, drop the `.bdf` at `src/data/BDF/<Family>/<size>.bdf` and add a typed entry to `FONTS` in `font-provider.ts`. To add a glyph that isn't in the source — like a custom UI symbol — parse the font and call `addGlyph(codepoint, glyph)` on it; the atlas rebuilds lazily on the next draw. The `►` injection in `initFonts()` is the canonical example.

### Star color and size

- **`CLASS_COLOR`** in `src/data/stars.ts` — approximate blackbody color per spectral class (Mitchell Charity table). O/B/A trend blue, F/G white, K/M orange-red, WD pale blue, BD deep red. Color stays class-driven because it's a temperature signal, not a size one.
- **Per-star `pxSize`**, baked at module load by `radiusToPxSize(s.radiusSolar)`. The Wikipedia source table doesn't carry a radius column, so each entry's `radiusSolar` is derived from class + mass at load time: Chandrasekhar `M^(−1/3)` for white dwarfs (anchored at ~0.012 R☉ for a 0.6 M☉ WD), a Jupiter-radius constant (~0.10 R☉) for brown dwarfs, and a rough main-sequence `M^0.8` anchored at the Sun (1 M☉ = 1 R☉) elsewhere. Loses the subgiant offset for entries like Procyon A; accepted regression for source-of-truth simplicity. The mapping is `R^(1/3)` linear, anchored so Sirius B-class WDs (~0.012 R☉) land near pxSize 3 and the largest A-class dwarfs (~2 R☉) near 18. The shader takes `pxSize`, scales by `uPxScale / 800` (the global size knob — bump that divisor to shrink all stars uniformly), applies the depth-attenuation factor, floors at 2 px, and rounds to integer.

Real radii in the catalog span ~250× (Sirius B → Procyon A), so a linear mapping would make WDs invisible and A-class dwarfs dominate. Cube-root compression takes that 250× range and maps it into a ~6× pixel range across `[3, 18]`: WDs 3–4 px, BDs/smallest M dwarfs ~7, Wolf 359 ~8, mid M dwarfs ~10, K dwarfs 12–13, the Sun ~14, F dwarfs ~16, A dwarfs 17–18. A `log10` mapping was tried first but over-compressed — it bunched M dwarfs and A dwarfs into ~11 vs ~18 px (a ~1.6× ratio), close enough that the brightest class barely stood out. Cube-root recovers roughly the same class spacing as the old per-class `CLASS_SIZE` table (~2× M-to-A) while keeping within-class variation: Wolf 359 (0.144 R☉) and Lalande 21185 (0.392 R☉) render as visibly different M dwarfs, which a class-keyed lookup couldn't express.

### Depth-attenuated star sizing

Under perspective, the stars vertex shader scales each disc by a depth factor derived from view-space distance (`REF_DIST = 50`). REF_DIST anchors the curve at the value the per-class table sizes were tuned against; it's intentionally decoupled from `DEFAULT_VIEW.distance` so the default framing can be tweaked without rescaling every disc.
- Raw factor: `REF_DIST / dist`. At `REF_DIST` away the factor is 1 and the star renders at its `pxSize` value.
- **Asymmetric:** close-up side is cube-root-compressed (`pow(rawScale, 1/3)` when `rawScale > 1`), zoom-out side is linear. Linear close-up growth eats the screen — at orbit 5 ly a focused class-G star wants 10× growth and ends up dominating. Cube-root compression preserves the per-star ratio but tames absolute growth — orbit 5 → 2.15×, orbit 4 → 2.32×. The exponent (1/3) is the tuning knob: smaller = flatter close-up, larger = more growth. Zoom-out stays linear so distant fields shrink at the natural rate.
- Floored at 2 px so the smallest dwarfs stay visible at zoom-out. **No upper bound** — an upper clamp on the final size flattens the brightest entries into a single blob the moment any of them hit the cap.
- Computed per-vertex from `modelViewMatrix * position`, so it picks up both camera-to-target distance and each star's offset from the focus naturally.

White dwarfs (`pxSize ≈ 3`) hit the size-2 floor first as their depth crosses ~1.5 × `REF_DIST`.

### Star clusters

Stars within `CLUSTER_THRESHOLD_LY = 0.25` of each other (`buildClusters` in `src/data/stars.ts`) are grouped via union-find. Captures both ringed-out coincident binaries (e.g. Sirius A/B share Wikipedia's RA/Dec, post-processed onto a small ring) and hierarchical systems where Wikipedia gives one component a different RA/Dec (Alpha Centauri's Proxima ends up ~0.19 ly from the AB pair after the equatorial-to-galactic conversion, well inside the threshold). Each cluster has a **primary** (the heaviest member by `mass`, with `CLASS_SIZE` as a tie-breaker) and an ordered `members` list with the primary first.

`Labels` (in `src/scene/labels.ts`) renders one visible label per cluster — anchored at the primary's position, suffixed with ` +N` (in dim cyan) when the cluster has additional members. Two textures per cluster are eagerly built at construction: a **plain** variant (cyan, warm-white for Sol) and a **yellow** variant (reticle yellow `#ffe98a`, matching the cluster brackets and the info-card star name). The yellow variant is shown when the cluster is selected OR is the active candidate (hover or focus-proximity — see "Cluster brackets"). Same dimensions, same anchor offset, so the swap is positionally invisible. Anchored at the primary so the emphasis doesn't twitch as you move between near-coincident dots.

Lookup helpers exported alongside the catalog: `STAR_CLUSTERS: readonly StarCluster[]` and `clusterIndexFor(starIdx) => number`.

### Cluster label visibility

When the master `show labels` toggle is on, cluster labels are gated by **two independent distance ramps** that multiply into a final opacity. Either FAR threshold hides the mesh outright (skipped, not drawn at zero alpha). Both thresholds live in `src/scene/cluster-fade.ts` so labels and drop-lines stay in lockstep — a tweak in one place propagates to both consumers.

- **Pivot ramp** — primary's distance to `view.target` (the orbit pivot). `PIVOT_FADE_NEAR`, `PIVOT_FADE_FAR`. Scopes the visible label set to the user's current point of interest.
- **Camera ramp** — primary's distance to the camera. `CAMERA_FADE_NEAR`, `CAMERA_FADE_FAR`. CAMERA_FADE_NEAR is deliberately set above PIVOT_FADE_FAR plus a "reasonably close" orbit radius so at close zoom every label that survives the pivot gate is also well inside the camera bubble — only the pivot gate effectively fires. As orbit distance grows past CAMERA_FADE_NEAR, stars exit the camera bubble and labels dim regardless of pivot.

A third **waymarker ramp** runs in parallel for a curated list of bright, well-known stars (`WAYPOINT_STAR_IDS` in `data/stars.ts` — Sol, Rigil Kentaurus, Sirius A, Procyon A, Altair, Vega, Arcturus). Polarity is *reversed* from the two ramps above: keyed to **the camera's distance from Sol** (`camera.position.length()` — Sol sits at origin), waypoint labels stay invisible below `LABEL_WAYPOINT_HIDE_BELOW = 30` ly, fade in linearly, and are fully visible at `LABEL_WAYPOINT_SHOW_ABOVE = 90` ly. Camera-from-Sol — rather than orbit distance — surfaces waymarkers whether the user got "far from home" by zooming out *or* by panning the pivot far from Sol while still zoomed in. The waypoint and per-label opacities combine via `max()` each frame, so a waypoint inside the pivot bubble doesn't blink out between the regular `PIVOT_FADE_FAR` / `CAMERA_FADE_FAR` thresholds and HIDE_BELOW. Effect: as the camera leaves Sol's neighborhood, every label disappears *except* this small set of named anchors — navigation landmarks for orienting in unfamiliar territory.

Selection and candidate (which subsumes hover — see "Cluster brackets") **bypass all three ramps and the master `show labels` toggle**, so the yellow variant is always visible. Both states are first-class focus state — "what's selected" and "what spacebar would select" — not environmental decoration. With labels off, the yellow promotion is the only feedback that pointing at a star (or panning past it) registered. Waypoint stars still respect the master toggle when in their plain (non-candidate, non-selected) state — turning labels off hides everything plain, including waymarkers.

### Multi-star system layout (post-processing)

Wikipedia gives every member of a binary/triple system the same RA/Dec because real inter-member separations (10–1000 AU) are far below the resolution of the table's coordinates. After the equatorial-to-galactic conversion those members all land at the same 3D point. `expandCoincidentSets` in `src/data/stars.ts` detects 2+ stars at effectively-identical positions and distributes them on a small 3D ring (radius `MIN_VIS_LY = 0.04`). The ring's plane normal and starting phase are seeded per-system from the primary's name (FNV-1a → mulberry32), so every binary gets its own tilt instead of all of them lying along +X in the galactic plane (the prior look: a top-down view of half a dozen binaries reads as identical horizontal "= =" sausages). Members are still mass-sorted (heaviest → cluster primary for label/dropline anchoring), but the per-system random phase means the primary is no longer at any fixed direction within its ring. Triggered automatically — adding a new "X A" / "X B" pair to the catalog with identical coords just works, and a given system always renders the same way across reloads.

Hierarchical systems where one component sits notably further out (Alpha Centauri's Proxima at ~0.21 ly from AB, 40 Eridani's BC sub-pair at sub-AU separations from A, etc.) read correctly without further intervention because Wikipedia gives each component its own RA/Dec where the separation is large enough to matter — Proxima ends up ~0.19 ly from the AB pair in our galactic Cartesian space, well within the cluster threshold but visibly offset.

### Range rings + drop-lines (selection-driven)

Both the rings (in `Grid`) and the per-cluster drop-lines (`Droplines`) are gated on the current selection. With nothing selected the entire subsystem is hidden — the catalog reads as plain stars, no chrome. Click a cluster and:

- The grid `Group` (rings at radii 5/10/15/20 ly + cross axes + galactic-centre arrow) translates onto that cluster's COM and becomes visible. The arrow continues to point galactic +X, just from the new anchor — "from here, that way is the centre."
- Every other cluster's drop-line lights up, terminating at the selected cluster's altitude (`STAR_CLUSTERS[selected].com.z`). Visualizes other systems' Z offsets relative to the one under inspection.
- The selected cluster's own drop-line collapses onto the plane (`dz = 0`) and is hidden by `DEGENERATE_PLANE_DIST` — no zero-length pin pointing at itself. Sol gets a real pin whenever a non-Sol cluster is selected.

Deselect (info-card close-X, ESC, or click off in empty space) → everything fades out and hides again.

#### Sequential per-ring expand/collapse on selection change

Selection changes don't pop — the grid choreographs ring visibility so the frame settles into the new position rather than appearing all at once:

- **Expand** — innermost ring fires first, then the next two rings step outward, and the outermost ring + cross axes + galactic-centre arrow share the final step so the +X arrow caps the frame at full extent. Stagger is `RING_STAGGER_EXPAND_MS = 100` per step; total ~300 ms across 4 steps. Each ring (and the axes/arrow group) is a discrete on/off visibility flip — no per-element opacity ramp.
- **Collapse** — reverses the order so the outermost ring (paired with axes + arrow) is the first thing to disappear, working back to the innermost. Faster stagger (`RING_STAGGER_COLLAPSE_MS = 80`) because the user has already moved their attention elsewhere.

`Grid` owns the choreography end-to-end. Public surface is `setSelection(com | null)` + `update(now)`; the scene routes selection but doesn't drive any per-tick animation state.

Two internal frames (A/B) let an old selection's collapse run concurrently with a new selection's expand on a swap — both render together for the overlap window. On a rapid third-click while both frames are mid-animation, the older frame is snapped to its terminal state and reused for the fresh expand; the newest selection always gets a clean expand from step 0 while the most-recent previous selection keeps its collapse running. Re-passing the active selection's exact COM is a no-op (avoids restarting the animation on a re-click).

Drop-lines currently snap on/off with selection state (`setFade(0)` on deselect, `setFade(1)` on select) rather than ramping in lockstep with the rings — the cross-fade state machine that previously coupled them lived in `scene.ts` and was retired with this split. Restoring grid/dropline lockstep is a follow-up.

#### Per-drop visibility

`Grid` is just a translated `Group`; selection writes `group.position` and toggles `group.visible`. One pin per cluster, anchored at the cluster's mass-weighted **center of mass** (`StarCluster.com`, computed once at module load in `buildClusters`). Non-primary cluster members — Sirius B, Alpha Cen B, Proxima, the Gliese 570 BC pair, etc. — share the cluster's pin rather than getting their own. The COM (rather than the primary's position) makes a binary/triple read as one system whose pin emerges from the geometric middle of the ring rather than from one of its members. Two flavors exist per pin: a **solid** `Line` (one full-length segment) and a **dotted** `Points` whose vertices live in a pre-allocated `MAX_DOTS_PER_PIN = 500` buffer (`DynamicDrawUsage`). Z-values are rewritten in place when the selection plane shifts, at fixed world-Z intervals (`DOT_PERIOD_LY = 0.25`), and `setDrawRange` slices the active count — avoids reallocating attributes on every selection change. Each frame `Droplines.update()` picks solid if the COM is on the same side of the plane as the camera, dotted if on the far side (`camera.position.z >= planeZ`).

Visibility is per-drop, not via `group.visible`. Composed gating, in this order:
- **Selection gate** (the outer one): no selection → every drop hidden, early return.
- **Global fade gate**: `globalFade <= 0` → every drop hidden. Today the scene snaps `globalFade` between 0 and 1 with selection state, so this is effectively a redundant guard alongside the selection gate; the multiplier is preserved for the planned restoration of grid/dropline lockstep, where it will once again ramp.
- **Master HUD toggle** sets `masterVisible`. When off, only the hovered cluster renders its pin (the selected cluster's own pin is degenerate, hidden anyway).
- **Hover** (pointer over any star in the cluster) **always** shows that cluster's pin at full opacity, bypassing the master toggle and fade ramps (still subject to `globalFade`).
- **Pivot + camera distance fades** apply to every other rendered pin, keyed to the cluster *primary's* position (not the COM, so the pin and its label flip in/out together at the same camera distance). Thresholds live in `src/scene/cluster-fade.ts` (shared with labels) — fade is keyed to `view.target` (the orbit pivot), not the locked rings, so "what's near where the camera is currently looking" still applies even after the user pans the pivot away from the selection.

World-space dotting is the load-bearing choice. The previous screen-space dashed shader used a single global gap-scale uniform driven by the camera's orbit radius — fine for the focused dropline, but every other dropline got the same scale, so distant pins ended up with absurdly stretched gaps (or one orphan dash) any time the user zoomed in close to a near star. Baking dots as actual vertices at fixed world-Z spacing lets perspective do the scaling per-line: distant pins compress, near ones stretch, no per-frame uniform plumbing needed. Dot count along a line scales with `|com.z - planeZ|`, so longer pins visibly carry more dots than shorter ones — a real depth cue rather than a synthesized one. The trade is sub-pixel aliasing at extreme distance (period < 1 px), accepted as graceful degradation.

The choice of `Points` over `LineSegments` for the dotted variant is a deliberate simplification: each dot is one vertex with `gl_PointSize = 1`, snapped to a pixel center. No endpoint pairs, no risk of zero-length segments dropping at extreme zoom, and the GPU's point-sprite fast path is cheaper than line rasterization for sub-pixel-thin output.

Materials are cloned **per drop** (~70 ShaderMaterial instances total) so each pin can carry its own `uOpacity` for the fade ramps. Both solid and dotted are alpha-blended; with one pin per cluster and clusters at non-coincident COMs there's no opacity-stacking concern in practice.

Stars themselves are also rendered opaque (`transparent: false, depthWrite: true`) so closer stars correctly occlude further ones — without `depthWrite`, stars in a single `Points` geometry would render in attribute (catalog) order, ignoring camera-relative distance.

### Focus-point marker

A small ring at `view.target` plus an optional dropline down to the selection plane (`FocusMarker` in `src/scene/focus-marker.ts`). Renders whenever the pivot has been panned past a small lateral threshold off the nearest "anchor" cluster — the selection COM when a cluster is selected, the nearest cluster COM otherwise. Hidden by default on initial load (pivot on Sol) and whenever the pivot sits on/near a star; fades in linearly as the user pans into empty space between systems. The ramp is a pure function of `|view.target − anchor COM|`, so the marker tracks frame-by-frame with no animation state.

The dropline portion exists only when a cluster is selected (that's the only state where a plane exists to drop to); the ring renders alone otherwise. The dropline reuses the same `DOT_PERIOD_LY` spacing and same camera-side-of-plane solid/dotted swap as the per-cluster drop-lines (`droplines.ts`) so the depth language stays uniform across the scene. The ring is colored to match the grid rings so it reads as a small companion to them rather than a different element class.

Suppressed entirely during the focus glide — while `view.target` is in transit toward a newly-selected cluster's COM, the "where am I looking" hint would just trail the camera as it zooms in and read as noise. `StarmapScene` threads its `focusAnimating` flag into `FocusMarker.update()` for this check.

### Cluster brackets — selection + candidate

Yellow corner brackets enclosing a cluster's rendered-disc bbox live in `src/scene/cluster-brackets.ts` (`ClusterBrackets`). Two instances render simultaneously into the labels overlay scene:

- **Selection brackets** (`style: 'arms'`) — full L-corner reticle around the currently-selected cluster. Anchored on the cluster's COM (which is exactly where `view.target` parks after focus completes) and sized as a square large enough to enclose every member's rendered disc — single-member clusters collapse to a tight box, binaries/triples grow symmetrically around the COM. Anchoring on the COM rather than the per-frame member bbox midpoint pins the bracket to the same NDC-(0,0) short-circuit `Labels.projectToBuffer` uses, so sub-pixel FP noise in the matrix math can't twitch the reticle 1 px laterally while the camera orbits. Cleared when the selection clears.
- **Candidate brackets** (`style: 'dots'`) — single-pixel corners (same color, same brightness, same corner positions as the selection arms) around the *candidate* cluster. The dot corners sit exactly where the arms would, so promoting a candidate to selection grows arms outward from the same dots with no positional shift.

**Only one candidate at a time.** The candidate slot is filled by, in priority order:

1. **Hover** — pointing at a star promotes its cluster to candidate. Independent of `focusAnimating` (cursor location is real regardless of camera motion).
2. **Focus-proximity** — when nothing is being hovered, the nearest cluster to `view.target` fills the slot once the pivot has been panned past `FOCUS_MARKER_NEAR` off it. Suppressed during the focus glide (pivot is in transit, not parked off a star) and when the nearest cluster IS the current selection. `FOCUS_MARKER_NEAR` is shared with the focus marker so both indicators turn on/off together as the user pans off a star.

When hover ends, the candidate falls back to whatever the focus-proximity branch yields (or nothing). Both branches honor "candidate != selection" — no point bracketing what's already selected. Visibility is binary — snap on / snap off, no fade ramp.

The same candidate index drives **three** consumers each tick: candidate brackets (dot corners), labels (yellow text promotion + fade-bypass — see "Cluster label visibility"), and the spacebar handler (F is bound separately — see "Input").

Nearest-cluster lookup is centralized in `nearestClusterIdxTo(x, y, z)` in `src/data/stars.ts`, backed by a static 3D k-d tree over `STAR_CLUSTERS` keyed on COM (`src/data/kdtree.ts`). `StarmapScene.tick()` runs it once per frame and shares the result with `FocusMarker` (anchor when nothing is selected) and the candidate-bracket gating. The same tree class also backs the load-time pair scans in `buildClusters` (over post-expansion `STARS`) and `expandCoincidentSets` (over pre-expansion star positions) via `pairsWithin`, so the spatial work at module load scales O(n log n) with the catalog.

### Input

Input is split between two modules. `InputController` (`src/scene/input-controller.ts`) owns every pointer/keyboard listener, classifies the gesture (orbit drag, pinch zoom vs pinch pan, click vs drag, double-click, touch long-press, held-key set), and dispatches high-level intents through an `InputHandlers` callback bundle. `StarmapScene` implements those handlers — view-state mutation (orbit/pan/zoom/held-key physics), selection logic, focus-glide, and the per-tick raycast for hover. Pure camera math (`applyOrbitDelta`, `applyTouchPan`, `zoomBy`) and selection routing stay in the scene; the controller never reads or mutates view state directly.

The behaviors below describe the user-facing intent — which gesture maps to which camera/selection action.
- **Mouse / pen drag** (any button) = orbit (yaw/pitch). Always orbits regardless of the touch-input setting — single-button mice don't have a clean equivalent of two-finger gestures.
- **Single-finger touch drag** = orbit by default; pans the camera target along the camera's screen-aligned right/up axes when "Pan with single touch" is enabled in the settings panel. The setting is persisted via `localStorage` (see `src/settings.ts`) and read fresh per gesture, so toggling takes effect on the next pointer event.
- **WASD** = pan the orbit pivot parallel to the galactic plane (z=0). W/S move along the yaw heading (the camera's view direction projected onto the plane), A/D strafe perpendicular to it. Pitch is ignored on purpose: looking down at a star and pressing W glides over it instead of plunging into it. Camera and target translate together so the orbit radius is preserved. Pan rate scales with `view.distance` so the screen-space movement rate is consistent across zooms.
- **Z / X** = sink / lift the orbit pivot along world up (the galactic plane normal). Same camera-follows-target translation and `view.distance`-scaled rate as WASD, so the view drops below or rises above the plane without changing orbit radius.
- **Q / E** = orbit left / right around the current pivot (yaw rate is constant in radians/sec).
- **Wheel** = zoom (orbit radius).
- **Two-finger touch gesture** = stays `'undecided'` (nothing applied) until either signal crosses its threshold:
  - **separation change** > 80 CSS px → commits to **pinch-zoom**, locks for the rest of the gesture
  - **midpoint Euclidean travel** > 40 CSS px → commits to **pan** (or **orbit** if "Pan with single touch" is on, swapping the two-finger and single-touch mappings together) and locks for the rest of the gesture

  Both metrics are scalar magnitudes so the heuristic is orientation-agnostic — the same numbers come out whether the fingers are stacked, side-by-side, or diagonal. The zoom threshold is doubled relative to pan because in a symmetric pinch *both* fingers contribute to separation change, so 80 px sep ≈ 40 px per finger ≈ comparable per-finger effort to a 40 px pan. Thresholds are well above touch-down jitter, so contact-stabilization noise can't lock a mode on its own — only deliberate motion crosses. When both signals cross in the same frame, the larger ratio (signal/threshold) wins; for the sepDelta gate specifically, an asymmetric pan along the separation axis (both fingers moving the same direction at different speeds) is filtered out via per-finger projection sign-checks so it can't fake a zoom.

Touch input is unified through Pointer Events, not a separate `touchmove` path. `pointers` (a `Map<pointerId, {x,y}>`) tracks every active pointer; while exactly one is down, drag = orbit-or-pan; the moment a second pointer lands, the single-finger gesture is abandoned and the two-finger gesture takes over (starting in `'undecided'`). Without this hand-off (the previous code ran `pointermove` orbit and `touchmove` pinch concurrently) iPad Safari pinches always came with an unwanted yaw/pitch jolt from the first finger's `pointermove` events. A third-or-later finger landing during an active two-finger gesture is tracked for clean lift-handling but does NOT reset the locked mode — palm contact mid-pinch shouldn't clobber the gesture. The canvas also sets `touch-action: none` so iOS doesn't claim the gesture for page pan/zoom before our handlers see it. `pointercancel` resets gesture state when the OS steals a pointer (palm rejection, etc).
- **Left-click on a star** (no/minimal drag, < 4 px movement) = select that star's **system** (a multi-star cluster is one selectable unit) AND animate the orbit pivot to the cluster's center of mass — so clicking either component of a binary glides to the same vantage. Info card lists every member, reticle bracketing encloses every member's rendered disc. The shared action lives in `selectAndFocusCluster()` so future hooks can route through it.
- **Double-left-click on a star** = open the system view (close-up `SystemScene` for the clicked cluster). A second left-click on the same cluster within the double-click window fires `onViewSystem`; clicks on a different cluster or a timed-out gap restart the window. The first click's focus glide is in flight when the second click lands, but the system-view transition disposes the starmap scene and kills the glide along with it.
- **Right-click on a star** and **touch long-press on a star** (single finger held still for 500 ms, < 8 px drift) = **placeholder hooks** that currently `console.info` and otherwise do nothing. The wiring is held alive (contextmenu suppression, long-press timer with movement-cancel + suppression of the trailing tap) so a future game action can be slotted in by editing the body of `fireLongPress` or the right-click branch in `onPointerUp` — no need to rebuild the timer state machine or button-discrimination logic.
- **Spacebar** = "advance to the candidate." If candidate brackets are visible (hovered cluster, or pivot panned off the selection onto another cluster — see "Cluster brackets"), switches selection to that cluster and glides the pivot to its COM. Falls back to re-focusing the current selection when no candidate is shown. Spacebar always calls `preventDefault` so the page doesn't scroll.
- **F** = "back to selection." Always re-focuses the currently-selected cluster's COM, ignoring any candidate. No-op when nothing is selected. `Cmd/Ctrl/Alt+F` is left alone so the browser's find shortcut still works. Mirrors the **Focus** pill button on the info card.
- **Hover** uses the same `Raycaster` against `gl.POINTS` (threshold 0.6 ly) as the click handlers — the hovered star promotes its cluster to **candidate** state, which paints dot-corner brackets around it (see "Cluster brackets") and swaps its label to the yellow variant. Hover wins over focus-proximity for the candidate slot, so pointing at a star always overrides whatever the keyboard pan happened to drift near — **as long as the cursor is fresh.** The moment any WASDQEZX key fires, the pointer is marked stale and stops driving hover; the next pointermove un-stales it. Without this gate, a cursor parked over a star in a dense field would pin the candidate there while the keyboard pans the pivot past other clusters, flickering against the focus-proximity branch. Releasing keys does NOT unstale — the cursor has to actually move — so the candidate can't snap back onto a static cursor after the user stops keying.
- The info card's close-X (top-right corner) clears the selection. The card sits in the bottom-right; the **View System** and **Focus** pill buttons sit in a fixed row beneath it, anchored to the screen edge so their position holds even as the card grows or shrinks with cluster size. View System opens the system view for the selected cluster (alternative to double-clicking). Focus mirrors the **F** key — glides the orbit pivot to the selected cluster's COM, ignoring any candidate, and is disabled (dim border + dim text, click absorbed but not dispatched) while the pivot already sits there. The settings panel's close-X sits at the burger trigger's exact footprint (top-right corner), so clicking the same screen position closes the panel just like clicking the burger opened it.

**ESC** dismisses the current selection in galaxy view (info card + reticle), the same as clicking the card's close-X. In system view, ESC exits back to the galaxy view (same as the back button in the header). "Reset view" in the settings panel snaps focus back to the Sun + default yaw/pitch/distance. Held-key state is cleared on `window.blur` so a key whose keyup got swallowed by alt-tab doesn't leave the camera drifting.

## Planned architecture

Forward-looking design intent — the simulation layer (`src/sim/`), WASM port, save-state management, and desktop (Electron) distribution — lives in [`FUTURE_PLANNING.md`](./FUTURE_PLANNING.md). That document describes parts of the codebase that don't exist yet but whose boundaries are already decided, so implementation has a target to hit. It is durable architectural intent, distinct from session-scoped planning artifacts (which stay local-only via `.git/info/exclude`).

## Coding conventions

- TypeScript strict mode is on. Don't disable rules per-file; fix the type instead.
- The scene code uses **scratch `Vector3`/`Vector2` instances on `this`** to avoid per-frame allocations in the tick loop. When you add new per-frame math, reuse an existing scratch or add a new private one — don't `new Vector3()` inside `tick()`.
- Comments explain **why** (the load-bearing constraint, the surprising trade-off, the bug it works around). They don't restate what the code does. Match this style — a wall of comments above obvious code is noise; a one-line "uses floor not round because FP jitter at exact half-pixels would twitch" earns its keep.
- HUD sizes are in **env pixels** (1 env pixel = N physical pixels after the nearest-neighbor upscale, where N is the runtime-chosen scale — typically 3 on retina). When tweaking visual sizes, think in env pixels — e.g. a 9-physical-pixel-tall tick on retina is `SCALE_TICK_H = 3`. The token visually scales with the user's resolution preference and the underlying display, but its env-pixel value is fixed.
- No emojis in source unless explicitly part of the visual design.