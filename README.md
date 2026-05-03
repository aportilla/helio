# Starmap

A 3D pixel-art visualization of the stars within ~20 light years of the Sun. Perspective camera orbiting a focused star, stellar discs sized by spectral class and depth-attenuated, drop-lines pinning each star to the galactic plane, all rendered in a deliberately chunky retro aesthetic.

Think 1980s starbase HUD: inline bitmap-font labels, cyan-on-near-black palette, hand-drawn-looking concentric range rings. The HUD chrome (title, scale bar, toggle buttons) renders as native pixel art inside the WebGL scene rather than as DOM elements.

## Stack

- **Vite 5** — dev server + build (`vite.config.ts` opens the browser on `npm run dev`)
- **TypeScript 5** — strict mode, `noUnusedLocals`/`noUnusedParameters`, `noEmit` (Vite handles emit)
- **Lit 3** — only used for the canvas host element and the one-shot boot splash
- **Three.js r170** — WebGL renderer, scene graph, shaders

No CSS framework, no state library, no testing framework yet.

## Scripts

```
npm run dev        # vite dev server, opens browser
npm run build      # tsc --noEmit + vite build → dist/
npm run preview    # serve dist/
npm run typecheck  # tsc --noEmit
```

## Project layout

```
index.html                  Vite entry — mounts <starmap-app>
src/
  main.ts                   Imports global styles + registers <starmap-app>
  styles.css                Body reset + boot-splash CSS variables
  components/               Lit web components (only the canvas host + boot splash now)
    starmap-app.ts          Root component; owns the canvas + StarmapScene instance
    starmap-boot.ts         Centered "INITIALIZING STELLAR CATALOG" splash
  scene/                    Three.js code — no DOM coupling beyond the canvas
    scene.ts                StarmapScene: camera, input, render loop, owns sub-objects
    grid.ts                 Concentric range rings + cross axes + galactic-centre arrow
    droplines.ts            Vertical pin from each star to the galactic plane
    stars.ts                gl.POINTS starfield with per-star size + color
    labels.ts               Bitmap-font overlay pass: star names, axis ticks, hover tooltip
    materials.ts            Pixel-snapped line ShaderMaterial + the stars shader
    hud.ts                  Pixel-art HUD (title, scale bar, toggle buttons)
                            rendered as a second orthographic pass after the main scene
  data/
    stars.ts                Star catalog (name, x/y/z in ly, spectral class, distance);
                            also computes star clusters and lookup
    pixel-font.ts           Inline Monaco 11px BDF data + canvas-texture text renderer
```

## Architecture notes

### Component / scene split

`StarmapApp` (the Lit root) is now minimal — it owns the canvas, mounts the boot splash, and instantiates `StarmapScene`. There's no UI plumbing between Lit and the scene: the title, scale bar, and toggle buttons all live inside `Hud` (a second orthographic pass at 1 unit = 1 buffer pixel) and are drawn with `Mesh + PlaneGeometry` so they share the rest of the scene's pixel grid.

The HUD captures pointer events first (in `StarmapScene.onPointerDown` / `onPointerMove` via `clientToHud()`), so clicking a button never starts a pan/orbit and hovering swaps the cursor to `pointer`. Button state is wired directly to scene internals through `hud.onToggle` and `hud.onAction` — no public API on `StarmapScene` is needed for the controls.

The `scene/` modules know **nothing about Lit or the DOM** beyond the `HTMLCanvasElement` they render into and `window` for size/input listeners. Don't add DOM queries in there — route data through callbacks or new methods on `StarmapScene`.

### Coordinate system

Galactic cartesian, units in light years:
- **+X** points toward the galactic centre (where the `GALACTIC CENTRE` arrow points)
- **+Z** points toward the north galactic pole (the camera's up vector is fixed to `(0, 0, 1)`)
- The Sun sits at the origin

Star positions are approximated to ~0.5 ly from known distances + RA/Dec. That's plenty for visualization but **don't treat the catalog as scientifically authoritative**.

### Camera

`PerspectiveCamera`, FOV 45°. The camera always orbits a focused star — the user can never look at empty space. Right-click on any star (no drag) to pivot the orbit onto it; `view.target` lerps to the new star over ~400 ms (ease-in-out cubic) while yaw/pitch/distance stay frozen, so the camera glides over rather than swinging.

The orbit state lives in `view = { target, distance, yaw, pitch, spin }`. `distance` is the **camera-to-target orbit radius in light years** — closer = zoomed in. Wheel/pinch dolly the orbit in/out; bounds are `[4, 150]` ly. Initial focus = the Sun; the HUD's "reset view" snaps focus, distance, yaw, and pitch back to their defaults instantly (a snap, not a glide — animating four axes at once looks jolty).

Drop-lines now converge toward a vanishing point; under perspective, that's the honest depth cue and we lean into it. The half-plane dimming and the focused-star pivot do most of the orientation work that the parallel pins used to.

### Pixel-perfect rendering — the load-bearing constraints

The whole "pixel art" look depends on a stack of choices that all have to stay consistent:

1. **`renderer.setPixelRatio(devicePixelRatio / N)`** with `N = ENV_PX_PER_SCREEN_PX = 3` — the render buffer is sized so each render ("env") pixel becomes N×N physical pixels after the browser's `image-rendering: pixelated` nearest-neighbor upscale. The DPR-relative formula means the on-screen pixel size is consistent across retina (DPR=2) and non-retina (DPR=1) displays. Increasing N makes the look chunkier and reduces fragment work by 1/N². Critically, **all pixel-aware shader work must use `renderer.getDrawingBufferSize()` — NOT `window.innerWidth/Height`** — because the buffer is now smaller than the CSS viewport. `scene.ts` caches these as `bufferW`/`bufferH` in `resize()` and threads them into `setSnappedLineViewport`, `StarPoints.setPxScale`, `Labels.update`, and `Hud.resize`. Pointer math (raycast NDC, HUD click coords) uses cached `cssW`/`cssH` rather than `window.innerWidth/Height` for the same reason — the canvas may be a few CSS pixels smaller than the window after the integer-multiple rounding (next point).
   **Integer-multiple sizing is load-bearing.** The browser's nearest-neighbor upscale is only exactly N:1 when the target physical pixel count is divisible by N. `resize()` rounds CSS×DPR (the target physical dimension) DOWN to a multiple of N before calling `setSize`, then derives CSS and buffer dimensions from that. Without this rounding, a non-divisible window (e.g. 1366px wide at DPR=2 = 2732 physical px = 911 buffer × 2.999 upscale) gets one buffer column every ~911 columns squashed into 2 physical px instead of 3 — visible as a column of mangled pixels in any label that happens to sit on top of it, with the artifact "following" labels as the camera rotates and they cross fixed bad columns. Cost: up to N-1 physical px of black bezel on the right/bottom (invisible against the dark scene + matching body bg).
2. **Pixel-snapped line shader** (`snappedLineMat` in `materials.ts`) — the vertex shader rounds each projected vertex to the nearest integer screen pixel before rasterization. Eliminates sub-pixel shimmer on thin lines. Used for grid arcs, axes, the galactic-centre arrow, and the solid variant of droplines. A sibling `snappedDotsMat` does the same for 1-pixel `Points` (snapping each point's center to a pixel center so `gl_PointSize = 1` covers exactly one pixel) — used by the dotted dropline variant.
3. **Stars shader** (`makeStarsMaterial`) — `gl.POINTS` with a procedural circle in the fragment shader (no texture sampling, no AA fringe). The vertex shader rounds size to the nearest integer pixel count (so zoom transitions step 2→3→4→5…) and snaps the projected center to the pixel grid using a **parity-aware** snap: even sizes snap to a pixel boundary (integer window coord), odd sizes to a pixel center (half-integer). The snapped center is passed to the fragment shader as a varying `vCenter`. The fragment shader then computes its pixel-grid offset directly from `gl_FragCoord.xy - vCenter` — `gl_FragCoord.xy` is always integer+0.5, and `vCenter` is integer or half-integer, so the difference lands at clean pixel-spacing offsets symmetric about both axes by construction. **Don't use `gl_PointCoord`** for the discard test: its sub-pixel precision is implementation-defined and produces visibly asymmetric discs on some GPUs when the point center sits at sub-pixel positions. The discard threshold is the true Euclidean radius (`length(d) > vRadius`) so sizes 1/2/3 render as full squares and size 4 onward starts dropping corners — the natural pixel-disc progression. The pixel-snap math runs **after** the perspective divide (`clip.xy / clip.w`) so it works identically under ortho and perspective projection.
4. **Label overlay pass** (`Labels` in `labels.ts`) — labels are rendered in a second ortho pass at 1 unit = 1 buffer pixel, the same scheme as the HUD, rather than as 3D Sprites in the main scene. Each frame the cluster primary's world position is projected by the **main** camera; the result drives a `Mesh + PlaneGeometry` placement in the overlay scene, with the top-left corner snapped to an integer buffer pixel so every texel renders. Constant on-screen size keeps typography stable while the depth-attenuated stars do the depth-cueing work — depth-scaling labels on top of depth-scaling stars would just make distant labels illegible.
5. **HUD** (`Hud` in `hud.ts`) — third ortho pass at 1 unit = 1 buffer pixel, rendered after the main scene and label overlay with `autoClear` toggled off. Geometry is `Mesh + PlaneGeometry + MeshBasicMaterial` so positions and sizes are integer pixel counts that match the rest of the scene's grid. Buttons are pre-built canvas textures (off / off-hover / on / on-hover) hot-swapped on state change.

If you add new scene geometry, route it through `snappedLineMat` for lines and the existing point-shader pattern for sprites — don't introduce vanilla `LineBasicMaterial` or `PointsMaterial`, they'll shimmer.

### Color management is OFF

`scene.ts` runs `ColorManagement.enabled = false` at module load and sets `renderer.outputColorSpace = LinearSRGBColorSpace` in the constructor. This is intentional and load-bearing.

The whole project's palette is hand-picked sRGB hex values (`0x1e6fc4`, `#5ec8ff`, etc.) intended to render at *exactly* those values on screen. With Three.js's default color management, two parallel paths (shader uniforms via `new Color(0x...)` vs canvas-texture pixels via `fillStyle = '#...'`) get different sRGB↔linear conversions and end up rendering at *different* on-screen colors — most visible where a `GALACTIC CENTRE` text label sits next to a grid ring drawn at the same hex. With management off, every hex value is the displayed value end-to-end, and there's no lighting math to break.

Don't re-enable color management without auditing every call site that mixes `new Color()` (in shaders) with canvas-rendered text textures.

### Bitmap font

`src/data/pixel-font.ts` ships an inline subset of **Monaco 11px** as BDF data (encoding, advance, bbox metrics, hex rows). Coverage: ASCII 32–126 (with no `[`, `]`, `\`, `^`, `_`, `` ` ``) plus `°` (degree), `·` (middle dot), `—` (em-dash), and `►` (custom right-pointer).

`makeLabelTexture(...)` is overloaded three ways:
- `(text, color, opts?)` — single line, single color
- `(segments, opts?)` — single line with per-segment colors (`TextSegment[]`)
- `(lines, opts?)` — multi-line, used by the cluster hover tooltip (`TextSegment[][]`)

Options:
- `box: true` — draws a bordered tooltip frame (used for the hover tooltip)
- `noHalo: true` — skip the dark halo normally painted around glyph edges. The halo helps text read against busy backgrounds but darkens a label's perceptual brightness; opt out when you want a label to color-match a nearby grid line (the `GALACTIC CENTRE` label uses this).

Also exports `drawPixelText(g2d, text, x, y, color)` so the HUD can compose text into its own canvases alongside borders/fills without going through `makeLabelTexture`.

If you need glyphs outside the current set, add a row to `FONT_GLYPHS` keyed by Unicode codepoint.

### Spectral-class lookups

Two lookup tables in `src/data/stars.ts`:
- **`CLASS_COLOR`** — approximate blackbody color per spectral class (Mitchell Charity table). O/B/A trend blue, F/G white, K/M orange-red, WD pale blue, BD deep red.
- **`CLASS_SIZE`** — direct visual pixel size per class at the reference resolution (uPxScale = 600, ≈ 1200 px-tall buffer): `O 28, B 22, A 18, F 14, G 12, K 10, M 8, BD 6, WD 3`. The shader scales by `uPxScale / 600`, multiplies by the per-frame `uZoomScale`, clamps to `[2, 28]`, and rounds to the nearest integer. To shrink/grow all stars uniformly, bump the divisor in `materials.ts` rather than re-tuning each class.

A previous version derived `CLASS_SIZE` from `CLASS_RADIUS` via `log10(R) * 1.6`, but the log-compression made K through B all render in the 8–12 px band — most stars looked interchangeable. Direct sizes give clean separation across the catalog.

### Depth-attenuated star sizing

Under perspective, the stars vertex shader scales each disc by a depth factor derived from view-space distance (`REF_DIST = 50`, matching `DEFAULT_VIEW.distance`):
- Raw factor: `REF_DIST / dist`. At `REF_DIST` away the factor is 1 and the star renders at its table size.
- **Asymmetric:** close-up side is cube-root-compressed (`pow(rawScale, 1/3)` when `rawScale > 1`), zoom-out side is linear. Linear close-up growth eats the screen — at orbit 5 ly a focused class-G star wants 10× growth and ends up dominating. Cube-root compression preserves the per-class ratio (28:22:…:8:6:3 is intact) but tames absolute growth — orbit 5 → 2.15×, orbit 4 → 2.32×. The exponent (1/3) is the tuning knob: smaller = flatter close-up, larger = more growth. Zoom-out stays linear so distant fields shrink at the natural rate.
- Floored at 2 px so the smallest dwarfs stay visible at zoom-out. **No upper bound** — an upper clamp on the final size flattens the largest classes into a single blob the moment any of them hit the cap.
- Computed per-vertex from `modelViewMatrix * position`, so it picks up both camera-to-target distance and each star's offset from the focus naturally.

Smallest stars (white dwarfs, table size 3) hit the size-2 floor first as their depth crosses ~1.5 × `REF_DIST`.

### Star clusters

Stars within `CLUSTER_THRESHOLD_LY = 0.25` of each other (`buildClusters` in `src/data/stars.ts`) are grouped via union-find. Captures both ringed-out coincident binaries (Sirius A/B at the same source coords, post-processed onto a small ring) and curated hierarchical systems (Alpha Cen A/B + Proxima at ~0.20 ly apart, 40 Eridani A vs BC sub-pair, etc.). Each cluster has a **primary** (the heaviest member by `mass`, with `CLASS_SIZE` as a tie-breaker) and an ordered `members` list with the primary first.

`Labels` (in `src/scene/labels.ts`) renders one visible label per cluster — anchored at the primary's position, suffixed with ` +N` (in dim cyan) when the cluster has additional members. Hovering any star in a cluster surfaces a multi-line tooltip listing every member with its class and distance, anchored at the primary's screen position so it doesn't twitch as you move between near-coincident dots.

Lookup helpers exported alongside the catalog: `STAR_CLUSTERS: readonly StarCluster[]` and `clusterIndexFor(starIdx) => number`.

### Multi-star system layout (post-processing)

Source catalogs typically place binary/triple system members at exactly the same Cartesian coords because real inter-member separations (10–1000 AU) are far below our 0.01-ly precision. Two layered mechanisms make those systems read at zoom-in:

1. **Automatic ring distribution.** `expandCoincidentSets` in `src/data/stars.ts` detects 2+ stars at effectively-identical positions and distributes them on a small ring in the XY plane (radius `MIN_VIS_LY = 0.04`). Heaviest at angle 0, others sorted by mass desc on equally-spaced angles. Visually merged at zoom-out, separated at zoom-in. Triggered automatically — adding a new "X A" / "X B" pair to the catalog with identical coords just works.
2. **Manual hierarchy.** Systems with known internal structure (a primary plus a wider companion or sub-pair) get explicit position offsets in `RAW_STARS`, marked with `// CURATED:` comments. Currently curated: Alpha Cen + Proxima (~0.20 ly), 40 Eridani A vs BC sub-pair (~0.08 ly), Gliese 570 A vs BC (~0.08 ly), 36 Ophiuchi AB vs C (~0.10 ly). The post-processor still rings any coincident members within those systems, so a curated A-vs-BC layout still gets the BC pair distributed on a tight ring.

Curation guidance lives at the top of `src/data/stars.ts` — read the "FUTURE CURATION" comment block before adding new systems. Magnitudes (~0.08 for tight pairs, ~0.15–0.20 for wider companions) are visualization choices, not real-world separations.

### Grid half-plane dimming

The galactic plane is split into 4 quadrants by the cross axes. Each frame, `Grid.update()` figures out which **half** of the plane is "behind" the camera (based on which world axis the camera is more aligned with) and dims those two quadrants' arcs. The half-axes between quadrants dim only when **both** flanking quadrants are dim — otherwise the axis IS the boundary between the bright and dim halves, so it stays bright. The galactic-centre arrow on +X follows the same rule.

It's a subtle orientation cue that makes the depth of the 3D scene readable without explicit shading.

### Drop-line styling

One pin per cluster, anchored at the cluster's primary star (the Sun's cluster is excluded since it's at the origin). Non-primary cluster members — Sirius B, Alpha Cen B, Proxima, the Gliese 570 BC pair, etc. — share their primary's pin rather than getting their own. This keeps tightly-coincident binary/triple systems from stacking near-identical pins on top of each other and matches the labelling model (one label per cluster, anchored at the primary). Two flavors exist per pin: a **solid** `Line` (one full-length segment) and a **dotted** `Points` whose vertices are baked at fixed world-Z intervals (`DOT_PERIOD_LY = 0.25`). Each frame `Droplines.update()` picks solid if the primary is on the same side of the plane as the camera, dotted if on the far side.

World-space dotting is the load-bearing choice. The previous screen-space dashed shader used a single global gap-scale uniform driven by the camera's orbit radius — fine for the focused dropline, but every other dropline got the same scale, so distant pins ended up with absurdly stretched gaps (or one orphan dash) any time the user zoomed in close to a near star. Baking dots as actual vertices at fixed world-Z spacing lets perspective do the scaling per-line: distant pins compress, near ones stretch, no per-frame uniform plumbing needed. Dot count along a line scales with `|star.z|`, so longer pins visibly carry more dots than shorter ones — a real depth cue rather than a synthesized one. The trade is sub-pixel aliasing at extreme distance (period < 1 px), accepted as graceful degradation.

The choice of `Points` over `LineSegments` for the dotted variant is a deliberate simplification: each dot is one vertex with `gl_PointSize = 1`, snapped to a pixel center. No endpoint pairs, no risk of zero-length segments dropping at extreme zoom, and the GPU's point-sprite fast path is cheaper than line rasterization for sub-pixel-thin output.

Materials are **opaque** (`opaque: true` on `snappedLineMat`, equivalent on `snappedDotsMat`), not alpha-blended. With one pin per cluster the binary-stacking concern is mostly addressed at the data level, but opaque rendering also keeps each pixel exactly at `uColor` regardless of any incidental overlap with grid arcs, axes, or another pin happening to share screen pixels with this one — no two-line opacity-stacking artefacts where geometry happens to coincide.

Stars themselves are also rendered opaque (`transparent: false, depthWrite: true`) so closer stars correctly occlude further ones — without `depthWrite`, stars in a single `Points` geometry would render in attribute (catalog) order, ignoring camera-relative distance.

### Input

All input lives in `StarmapScene`. The model is deliberately minimal — the camera is always orbiting a focused star, so panning and free-flying are not exposed.
- **Pointer drag** (any button) = orbit (yaw/pitch).
- **Wheel** = zoom (orbit radius). **Two-finger pinch** = zoom on touch.
- **Left-click on a star** (no/minimal drag, < 4 px movement) = select that star (info card + reticle) AND animate the orbit pivot to it.
- **Right-click on a star** (no/minimal drag) = select only — info card + reticle update, but the camera stays where it is. Useful for inspecting a star without losing your current vantage on another.
- **Hover** uses the same `Raycaster` against `gl.POINTS` (threshold 0.6 ly) as the click handlers — the hovered star drives the transient boxed tooltip in the label overlay.
- The info card's close-X (top-right corner) clears the selection.

There are no keyboard bindings. The HUD "reset view" button snaps focus back to the Sun + default yaw/pitch/distance.

## Coding conventions

- TypeScript strict mode is on. Don't disable rules per-file; fix the type instead.
- The scene code uses **scratch `Vector3`/`Vector2` instances on `this`** to avoid per-frame allocations in the tick loop. When you add new per-frame math, reuse an existing scratch or add a new private one — don't `new Vector3()` inside `tick()`.
- Comments explain **why** (the load-bearing constraint, the surprising trade-off, the bug it works around). They don't restate what the code does. Match this style — a wall of comments above obvious code is noise; a one-line "uses floor not round because FP jitter at exact half-pixels would twitch" earns its keep.
- Each Lit component is a single file, owns its own styles, and exports its tag name through `HTMLElementTagNameMap` so consumers get autocomplete.
- HUD sizes are in **env pixels** (1 env pixel = `ENV_PX_PER_SCREEN_PX = 3` physical pixels). When tweaking visual sizes, divide your physical-pixel target by 3 — e.g. a "9-physical-pixel-tall scale-bar tick" is `SCALE_TICK_H = 3`.
- No emojis in source unless explicitly part of the visual design.

## Things that are deliberately not here

- **No physically-accurate star positions or motions.** Catalog is for visualization, not navigation.
- **No panning or free-fly camera.** The view is always orbiting a star; the only way to look elsewhere is to right-click another star and let the focus glide over.
- **No keyboard navigation.** Removed alongside pan — drag, wheel, and left/right-click on a star are the whole input vocabulary.
- **Animation is restricted to autospin, the boot splash fade, and the focus-pivot lerp.** Don't add others without intent.
- **No texture-based stars or labels.** Everything is procedural / canvas-rasterized so the pixel-perfect look survives any zoom level.
