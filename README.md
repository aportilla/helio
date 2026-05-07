# Starmap

A 3D pixel-art visualization of the stars within ~20 light years of the Sun. Perspective camera orbiting a focused star, stellar discs sized by spectral class and depth-attenuated, drop-lines pinning each star to the galactic plane, all rendered in a deliberately chunky retro aesthetic.

Think 1980s starbase HUD: inline bitmap-font labels, cyan-on-near-black palette, hand-drawn-looking concentric range rings. The HUD chrome (title, scale bar, settings trigger) renders as native pixel art inside the WebGL scene rather than as DOM elements. Display toggles, "Reset view", and a touch-input preference all live in a popover settings panel that opens from the bottom-right trigger.

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
    starmap-app.ts          Root component; owns the canvas + AppController instance
    starmap-boot.ts         Centered "INITIALIZING STELLAR CATALOG" splash
  scene/                    Three.js code — no DOM coupling beyond the canvas
    app-controller.ts       AppController: owns the WebGLRenderer + swaps which
                            view-mode scene is currently driving the canvas
                            (StarmapScene ↔ SystemScene)
    scene.ts                StarmapScene (galaxy view): camera, input, render loop
    system-scene.ts         SystemScene (close-up of one cluster): peer of
                            StarmapScene, lazily constructed on entry, disposed
                            on exit
    grid.ts                 Concentric range rings + cross axes + galactic-centre arrow
    droplines.ts            Vertical pin from each star to the galactic plane
    stars.ts                gl.POINTS starfield with per-star size + color
    labels.ts               Bitmap-font overlay pass: star names, axis ticks, selection reticle
    materials.ts            Pixel-snapped line ShaderMaterial + the stars shader
  ui/                       Pixel-art HUD widget toolkit + view-mode HUD
                            orchestrators. Each HUD renders in its own ortho
                            pass at 1 unit = 1 buffer pixel.
    widget.ts               Widget base: Mesh + PlaneGeometry + MeshBasicMaterial
                            + (optional) CanvasTexture + Bounds rect; one
                            owned-texture lifecycle for subclasses
    base-panel.ts           Repaint-on-state-change canvas-texture panel base
    panel.ts                Settings popover (sectioned rows: toggles + actions)
    icon-button.ts          Pre-built texture-pool button (off/hover/on/onHover)
    action-button.ts        Text pill button ("View System")
    painter.ts              Shared 2D primitives: surfaces, glyphs, close-X,
                            hamburger, left-arrow, etc.
    theme.ts                colors / sizes / fonts shared across widgets
    map-hud/
      index.ts              MapHud: title, scale bar, settings trigger + panel,
                            info card with close-X and "View System" button
      title.ts              Static top-left title block
      scale-bar.ts          Bottom-left scale bar (bar + 2 ticks + label)
      info-card.ts          Top-right cluster info card
    system-hud/
      index.ts              SystemHud: header bar + back button + reused InfoCard
      header-bar.ts         Full-width top bar with system name centered
  settings.ts               Persisted user preferences (localStorage, versioned
                            JSON blob, default-merging on read so the schema
                            can grow without invalidating old saves)
  data/
    stars.ts                Star catalog (name, x/y/z in ly, spectral class, distance);
                            also computes star clusters and lookup
    pixel-font.ts           Inline Monaco 11px BDF data + canvas-texture text renderer
```

## Architecture notes

### Component / scene split

`StarmapApp` (the Lit root) is minimal — it owns the canvas, mounts the boot splash, and instantiates an `AppController`. The controller owns the shared `WebGLRenderer` and decides which view-mode scene's `tick()` loop is currently driving the canvas. Two peer scenes share the renderer: `StarmapScene` (galaxy view, the default) and `SystemScene` (close-up of one cluster, lazily constructed on entry, disposed on exit). Only one is running at a time.

There's no UI plumbing between Lit and the scenes: each scene owns its own HUD orchestrator (`MapHud` for galaxy view, `SystemHud` for system view), each with its own ortho pass at 1 unit = 1 buffer pixel. HUD widgets are built on `Widget` (Mesh + PlaneGeometry + MeshBasicMaterial + optional CanvasTexture) so HUD geometry shares the rest of the scene's pixel grid.

Each HUD captures pointer events first (in the scene's `onPointerDown` / `onPointerMove` via `clientToHud()`), so clicking a button or a panel row never starts a pan/orbit and hovering swaps the cursor to `pointer`. `MapHud` exposes `onToggle`, `onAction`, `onDeselect`, `onViewSystem`, and `onSettingsChanged` callbacks; `SystemHud` exposes `onBack`. The settings panel's touch-input row writes through `setSetting` in `src/settings.ts`. The scene reads `getSettings()` at gesture time (pull-on-read), so a flipped preference takes effect on the very next pointer event with no callback plumbing.

The `scene/` modules know **nothing about Lit or the DOM** beyond the `HTMLCanvasElement` they render into and `window` for size/input listeners. Don't add DOM queries in there — route data through callbacks or new methods on the scene.

### Coordinate system

Galactic cartesian, units in light years:
- **+X** points toward the galactic centre (where the `GALACTIC CENTRE` arrow points)
- **+Z** points toward the north galactic pole (the camera's up vector is fixed to `(0, 0, 1)`)
- The Sun sits at the origin

Star positions are approximated to ~0.5 ly from known distances + RA/Dec. That's plenty for visualization but **don't treat the catalog as scientifically authoritative**.

### Camera

`PerspectiveCamera`, FOV 45°. The camera orbits a 3D pivot point (`view.target`). Right-click on any star (no drag) snaps the pivot onto it; `view.target` lerps to the new star over ~400 ms (ease-in-out cubic) while yaw/pitch/distance stay frozen, so the camera glides over rather than swinging. WASD then translates the pivot in 3D (camera follows by the same vector, distance preserved) so the user can pan away from any star and orbit empty space — clicks set the pivot, keys drift it.

The orbit state lives in `view = { target, distance, yaw, pitch, spin }`. `distance` is the **camera-to-target orbit radius in light years** — closer = zoomed in. Wheel/pinch dolly the orbit in/out; bounds are `[4, 150]` ly. Initial focus = the Sun; the HUD's "reset view" snaps focus, distance, yaw, and pitch back to their defaults instantly (a snap, not a glide — animating four axes at once looks jolty).

Drop-lines now converge toward a vanishing point; under perspective, that's the honest depth cue and we lean into it. The half-plane dimming and the focused-star pivot do most of the orientation work that the parallel pins used to.

### System view

A close-up tactical view of one cluster lives in `SystemScene` (peer of `StarmapScene`, swapped in by `AppController`). Entry: clicking the **View System** pill button on the galaxy info card, or double-left-clicking a star. Exit: the back button in the system view's header bar, or `Escape`.

`AppController` owns the shared `WebGLRenderer` and the persistent `StarmapScene` instance. Galaxy view state — camera, selection, settings — lives on the `StarmapScene` instance, so the round-trip preserves it without any serialization: `enterSystem` calls `starmap.stop()` and constructs a fresh `SystemScene`; `exitSystem` disposes the system scene and calls `starmap.start()` again. The galaxy scene's `tick()` is paused, not torn down, so resuming is instant and the camera comes back exactly where the user left it.

`SystemHud` mirrors `MapHud`'s structure (own scene + ortho camera + composed widgets, `autoClear` off). It owns a full-width `HeaderBar` with the system name centered and a 1-px accent line along the bottom, an `IconButton` back-arrow on the left edge of the header, and reuses the galaxy view's `InfoCard` (no close-X — the back button is the exit) to list every cluster member.

The 3D scene inside `SystemScene` is currently a skeleton: an empty `Scene`, a `PerspectiveCamera` orbited via simple yaw/pitch on pointer drag, and `wheel` zoom. Future work fills in the cluster's stars as scaled-up disks; today the HUD chrome carries the view.

### Pixel-perfect rendering — the load-bearing constraints

The whole "pixel art" look depends on a stack of choices that all have to stay consistent:

1. **`renderer.setPixelRatio(devicePixelRatio / N)`** with `N = ENV_PX_PER_SCREEN_PX = 3` — the render buffer is sized so each render ("env") pixel becomes N×N physical pixels after the browser's `image-rendering: pixelated` nearest-neighbor upscale. The DPR-relative formula means the on-screen pixel size is consistent across retina (DPR=2) and non-retina (DPR=1) displays. Increasing N makes the look chunkier and reduces fragment work by 1/N². Critically, **all pixel-aware shader work must use `renderer.getDrawingBufferSize()` — NOT `window.innerWidth/Height`** — because the buffer is now smaller than the CSS viewport. `scene.ts` caches these as `bufferW`/`bufferH` in `resize()` and threads them into `setSnappedLineViewport`, `StarPoints.setPxScale`, `Labels.update`, and `Hud.resize`. Pointer math (raycast NDC, HUD click coords) uses cached `cssW`/`cssH` rather than `window.innerWidth/Height` for the same reason — the canvas may be a few CSS pixels smaller than the window after the integer-multiple rounding (next point).
   **Integer-multiple sizing is load-bearing.** The browser's nearest-neighbor upscale is only exactly N:1 when the target physical pixel count is divisible by N. `resize()` rounds CSS×DPR (the target physical dimension) DOWN to a multiple of N before calling `setSize`, then derives CSS and buffer dimensions from that. Without this rounding, a non-divisible window (e.g. 1366px wide at DPR=2 = 2732 physical px = 911 buffer × 2.999 upscale) gets one buffer column every ~911 columns squashed into 2 physical px instead of 3 — visible as a column of mangled pixels in any label that happens to sit on top of it, with the artifact "following" labels as the camera rotates and they cross fixed bad columns. Cost: up to N-1 physical px of black bezel on the right/bottom (invisible against the dark scene + matching body bg).
2. **Pixel-snapped line shader** (`snappedLineMat` in `materials.ts`) — the vertex shader rounds each projected vertex to the nearest integer screen pixel before rasterization. Eliminates sub-pixel shimmer on thin lines. Used for grid arcs, axes, the galactic-centre arrow, and the solid variant of droplines. A sibling `snappedDotsMat` does the same for 1-pixel `Points` (snapping each point's center to a pixel center so `gl_PointSize = 1` covers exactly one pixel) — used by the dotted dropline variant.
3. **Stars shader** (`makeStarsMaterial`) — `gl.POINTS` with a procedural circle in the fragment shader (no texture sampling, no AA fringe). The vertex shader rounds size to the nearest integer pixel count (so zoom transitions step 2→3→4→5…) and snaps the projected center to the pixel grid using a **parity-aware** snap: even sizes snap to a pixel boundary (integer window coord), odd sizes to a pixel center (half-integer). The snapped center is passed to the fragment shader as a varying `vCenter`. The fragment shader then computes its pixel-grid offset directly from `gl_FragCoord.xy - vCenter` — `gl_FragCoord.xy` is always integer+0.5, and `vCenter` is integer or half-integer, so the difference lands at clean pixel-spacing offsets symmetric about both axes by construction. **Don't use `gl_PointCoord`** for the discard test: its sub-pixel precision is implementation-defined and produces visibly asymmetric discs on some GPUs when the point center sits at sub-pixel positions. The discard threshold is the true Euclidean radius (`length(d) > vRadius`) so sizes 1/2/3 render as full squares and size 4 onward starts dropping corners — the natural pixel-disc progression. The pixel-snap math runs **after** the perspective divide (`clip.xy / clip.w`) so it works identically under ortho and perspective projection.
4. **Label overlay pass** (`Labels` in `labels.ts`) — labels are rendered in a second ortho pass at 1 unit = 1 buffer pixel, the same scheme as the HUD, rather than as 3D Sprites in the main scene. Each frame the cluster primary's world position is projected by the **main** camera; the result drives a `Mesh + PlaneGeometry` placement in the overlay scene, with the top-left corner snapped to an integer buffer pixel so every texel renders. Constant on-screen size keeps typography stable while the depth-attenuated stars do the depth-cueing work — depth-scaling labels on top of depth-scaling stars would just make distant labels illegible.
5. **HUD** (`MapHud` in `src/ui/map-hud/`, `SystemHud` in `src/ui/system-hud/`) — third ortho pass at 1 unit = 1 buffer pixel, rendered after the main scene and label overlay with `autoClear` toggled off. Geometry is `Mesh + PlaneGeometry + MeshBasicMaterial` (the `Widget` base in `src/ui/widget.ts`) so positions and sizes are integer pixel counts that match the rest of the scene's grid. The settings trigger is an `IconButton` backed by a four-texture pool (off / hover / on / onHover) swapped on hover and panel-open state. The settings panel and info card extend `BasePanel`: a single canvas texture rebuilt on state change (toggle flipped, hovered row changed, selection changed) — cheaper than maintaining one texture per row state because each panel is small and rebuilds run only on user input, not per frame.

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
- `(lines, opts?)` — multi-line with per-segment colors per line (`TextSegment[][]`)

Options:
- `box: true` — draws a bordered surface frame around the text (used by the hovered cluster label)
- `noHalo: true` — skip the dark halo normally painted around glyph edges. The halo helps text read against busy backgrounds but darkens a label's perceptual brightness; opt out when you want a label to color-match a nearby grid line (the `GALACTIC CENTRE` label uses this).

Also exports `drawPixelText(g2d, text, x, y, color)` so the HUD can compose text into its own canvases alongside borders/fills without going through `makeLabelTexture`.

If you need glyphs outside the current set, add a row to `FONT_GLYPHS` keyed by Unicode codepoint.

### Star color and size

- **`CLASS_COLOR`** in `src/data/stars.ts` — approximate blackbody color per spectral class (Mitchell Charity table). O/B/A trend blue, F/G white, K/M orange-red, WD pale blue, BD deep red. Color stays class-driven because it's a temperature signal, not a size one.
- **Per-star `pxSize`**, baked at module load by `radiusToPxSize(s.radiusSolar)`. Each catalog entry carries a `radiusSolar` value (measured where available — interferometry for Sirius A/B, Procyon A, Altair, Alpha Cen A/B, etc.; Chandrasekhar-derived for white dwarfs; main-sequence-relation estimates for the fainter M dwarfs). The mapping is `R^(1/3)` linear, anchored so Sirius B (0.0084 R☉) lands at pxSize 3 and Procyon A (2.048 R☉) at 18. The shader takes `pxSize`, scales by `uPxScale / 800` (the global size knob — bump that divisor to shrink all stars uniformly), applies the depth-attenuation factor, floors at 2 px, and rounds to integer.

Real radii in the catalog span ~250× (Sirius B → Procyon A), so a linear mapping would make WDs invisible and A-class dwarfs dominate. Cube-root compression takes that 250× range and maps it into a ~6× pixel range across `[3, 18]`: WDs 3–4 px, BDs/smallest M dwarfs ~7, Wolf 359 ~8, mid M dwarfs ~10, K dwarfs 12–13, the Sun ~14, F dwarfs ~16, A dwarfs 17–18. A `log10` mapping was tried first but over-compressed — it bunched M dwarfs and A dwarfs into ~11 vs ~18 px (a ~1.6× ratio), close enough that the brightest class barely stood out. Cube-root recovers roughly the same class spacing as the old per-class `CLASS_SIZE` table (~2× M-to-A) while keeping within-class variation: Wolf 359 (0.144 R☉) and Lalande 21185 (0.392 R☉) render as visibly different M dwarfs, which a class-keyed lookup couldn't express.

### Depth-attenuated star sizing

Under perspective, the stars vertex shader scales each disc by a depth factor derived from view-space distance (`REF_DIST = 50`, matching `DEFAULT_VIEW.distance`):
- Raw factor: `REF_DIST / dist`. At `REF_DIST` away the factor is 1 and the star renders at its `pxSize` value.
- **Asymmetric:** close-up side is cube-root-compressed (`pow(rawScale, 1/3)` when `rawScale > 1`), zoom-out side is linear. Linear close-up growth eats the screen — at orbit 5 ly a focused class-G star wants 10× growth and ends up dominating. Cube-root compression preserves the per-star ratio but tames absolute growth — orbit 5 → 2.15×, orbit 4 → 2.32×. The exponent (1/3) is the tuning knob: smaller = flatter close-up, larger = more growth. Zoom-out stays linear so distant fields shrink at the natural rate.
- Floored at 2 px so the smallest dwarfs stay visible at zoom-out. **No upper bound** — an upper clamp on the final size flattens the brightest entries into a single blob the moment any of them hit the cap.
- Computed per-vertex from `modelViewMatrix * position`, so it picks up both camera-to-target distance and each star's offset from the focus naturally.

White dwarfs (`pxSize ≈ 3`) hit the size-2 floor first as their depth crosses ~1.5 × `REF_DIST`.

### Star clusters

Stars within `CLUSTER_THRESHOLD_LY = 0.25` of each other (`buildClusters` in `src/data/stars.ts`) are grouped via union-find. Captures both ringed-out coincident binaries (Sirius A/B at the same source coords, post-processed onto a small ring) and curated hierarchical systems (Alpha Cen A/B + Proxima at ~0.20 ly apart, 40 Eridani A vs BC sub-pair, etc.). Each cluster has a **primary** (the heaviest member by `mass`, with `CLASS_SIZE` as a tie-breaker) and an ordered `members` list with the primary first.

`Labels` (in `src/scene/labels.ts`) renders one visible label per cluster — anchored at the primary's position, suffixed with ` +N` (in dim cyan) when the cluster has additional members. Hovering any star in a cluster swaps that cluster's label for a bordered-box variant (same text, same anchor, styled like the other surface boxes) and bumps it to a renderOrder above the reticle so it always paints clear of every other overlay element. Anchored at the primary so the emphasis doesn't twitch as you move between near-coincident dots; ignores the `show labels` toggle so a hover always produces feedback.

Lookup helpers exported alongside the catalog: `STAR_CLUSTERS: readonly StarCluster[]` and `clusterIndexFor(starIdx) => number`.

### Multi-star system layout (post-processing)

Source catalogs typically place binary/triple system members at exactly the same Cartesian coords because real inter-member separations (10–1000 AU) are far below our 0.01-ly precision. Two layered mechanisms make those systems read at zoom-in:

1. **Automatic ring distribution.** `expandCoincidentSets` in `src/data/stars.ts` detects 2+ stars at effectively-identical positions and distributes them on a small 3D ring (radius `MIN_VIS_LY = 0.04`). The ring's plane normal and starting phase are seeded per-system from the primary's name (FNV-1a → mulberry32), so every binary gets its own tilt instead of all of them lying along +X in the galactic plane (the prior look: a top-down view of half a dozen binaries reads as identical horizontal "= =" sausages). Members are still mass-sorted (heaviest → cluster primary for label/dropline anchoring), but the per-system random phase means the primary is no longer at any fixed direction within its ring. Triggered automatically — adding a new "X A" / "X B" pair to the catalog with identical coords just works, and a given system always renders the same way across reloads.
2. **Manual hierarchy.** Systems with known internal structure (a primary plus a wider companion or sub-pair) get explicit position offsets in `RAW_STARS`, marked with `// CURATED:` comments. Currently curated: Alpha Cen + Proxima (~0.20 ly), 40 Eridani A vs BC sub-pair (~0.08 ly), Gliese 570 A vs BC (~0.08 ly), 36 Ophiuchi AB vs C (~0.10 ly). The post-processor still rings any coincident members within those systems, so a curated A-vs-BC layout still gets the BC pair distributed on a tight ring.

Curation guidance lives at the top of `src/data/stars.ts` — read the "FUTURE CURATION" comment block before adding new systems. Magnitudes (~0.08 for tight pairs, ~0.15–0.20 for wider companions) are visualization choices, not real-world separations.

### Grid half-plane dimming

The galactic plane is split into 4 quadrants by the cross axes. Each frame, `Grid.update()` figures out which **half** of the plane is "behind" the camera (based on which world axis the camera is more aligned with) and dims those two quadrants' arcs. The half-axes between quadrants dim only when **both** flanking quadrants are dim — otherwise the axis IS the boundary between the bright and dim halves, so it stays bright. The galactic-centre arrow on +X follows the same rule.

It's a subtle orientation cue that makes the depth of the 3D scene readable without explicit shading.

### Drop-line styling

One pin per cluster, anchored at the cluster's mass-weighted **center of mass** (`StarCluster.com`, computed once at module load in `buildClusters`). The Sun's cluster is excluded since its COM sits at the origin. Non-primary cluster members — Sirius B, Alpha Cen B, Proxima, the Gliese 570 BC pair, etc. — share the cluster's pin rather than getting their own. The COM (rather than the primary's position) makes a binary/triple read as one system whose pin emerges from the geometric middle of the ring rather than from one of its members. Two flavors exist per pin: a **solid** `Line` (one full-length segment) and a **dotted** `Points` whose vertices are baked at fixed world-Z intervals (`DOT_PERIOD_LY = 0.25`). Each frame `Droplines.update()` picks solid if the COM is on the same side of the plane as the camera, dotted if on the far side.

Visibility is per-drop, not via `group.visible`: the master HUD toggle sets `masterVisible`, and the current selection sets `selectedCluster`. A drop renders when `masterVisible || drop.clusterIdx === selectedCluster` — so toggling droplines off still preserves the selected system's pin as a depth cue for whatever the user has the info card open on.

World-space dotting is the load-bearing choice. The previous screen-space dashed shader used a single global gap-scale uniform driven by the camera's orbit radius — fine for the focused dropline, but every other dropline got the same scale, so distant pins ended up with absurdly stretched gaps (or one orphan dash) any time the user zoomed in close to a near star. Baking dots as actual vertices at fixed world-Z spacing lets perspective do the scaling per-line: distant pins compress, near ones stretch, no per-frame uniform plumbing needed. Dot count along a line scales with `|star.z|`, so longer pins visibly carry more dots than shorter ones — a real depth cue rather than a synthesized one. The trade is sub-pixel aliasing at extreme distance (period < 1 px), accepted as graceful degradation.

The choice of `Points` over `LineSegments` for the dotted variant is a deliberate simplification: each dot is one vertex with `gl_PointSize = 1`, snapped to a pixel center. No endpoint pairs, no risk of zero-length segments dropping at extreme zoom, and the GPU's point-sprite fast path is cheaper than line rasterization for sub-pixel-thin output.

Materials are **opaque** (`opaque: true` on `snappedLineMat`, equivalent on `snappedDotsMat`), not alpha-blended. With one pin per cluster the binary-stacking concern is mostly addressed at the data level, but opaque rendering also keeps each pixel exactly at `uColor` regardless of any incidental overlap with grid arcs, axes, or another pin happening to share screen pixels with this one — no two-line opacity-stacking artefacts where geometry happens to coincide.

Stars themselves are also rendered opaque (`transparent: false, depthWrite: true`) so closer stars correctly occlude further ones — without `depthWrite`, stars in a single `Points` geometry would render in attribute (catalog) order, ignoring camera-relative distance.

### Input

All input lives in `StarmapScene`.
- **Mouse / pen drag** (any button) = orbit (yaw/pitch). Always orbits regardless of the touch-input setting — single-button mice don't have a clean equivalent of two-finger gestures.
- **Single-finger touch drag** = orbit by default; pans the camera target along the camera's screen-aligned right/up axes when "Pan with single touch" is enabled in the settings panel. The setting is persisted via `localStorage` (see `src/settings.ts`) and read fresh per gesture, so toggling takes effect on the next pointer event.
- **WASD** = pan the orbit pivot parallel to the galactic plane (z=0). W/S move along the yaw heading (the camera's view direction projected onto the plane), A/D strafe perpendicular to it. Pitch is ignored on purpose: looking down at a star and pressing W glides over it instead of plunging into it. Camera and target translate together so the orbit radius is preserved. Pan rate scales with `view.distance` so the screen-space movement rate is consistent across zooms.
- **Q / E** = orbit left / right around the current pivot (yaw rate is constant in radians/sec).
- **Wheel** = zoom (orbit radius).
- **Two-finger touch gesture** = stays `'undecided'` (nothing applied) until either signal crosses its threshold:
  - **separation change** > 80 CSS px → commits to **pinch-zoom**, locks for the rest of the gesture
  - **midpoint Euclidean travel** > 40 CSS px → commits to **pan** (or **orbit** if "Pan with single touch" is on, swapping the two-finger and single-touch mappings together) and locks for the rest of the gesture

  Both metrics are scalar magnitudes so the heuristic is orientation-agnostic — the same numbers come out whether the fingers are stacked, side-by-side, or diagonal. The zoom threshold is doubled relative to pan because in a symmetric pinch *both* fingers contribute to separation change, so 80 px sep ≈ 40 px per finger ≈ comparable per-finger effort to a 40 px pan. Thresholds are well above touch-down jitter, so contact-stabilization noise can't lock a mode on its own — only deliberate motion crosses. When both signals cross in the same frame, the larger ratio (signal/threshold) wins; for the sepDelta gate specifically, an asymmetric pan along the separation axis (both fingers moving the same direction at different speeds) is filtered out via per-finger projection sign-checks so it can't fake a zoom.

Touch input is unified through Pointer Events, not a separate `touchmove` path. `pointers` (a `Map<pointerId, {x,y}>`) tracks every active pointer; while exactly one is down, drag = orbit-or-pan; the moment a second pointer lands, the single-finger gesture is abandoned and the two-finger gesture takes over (starting in `'undecided'`). Without this hand-off (the previous code ran `pointermove` orbit and `touchmove` pinch concurrently) iPad Safari pinches always came with an unwanted yaw/pitch jolt from the first finger's `pointermove` events. A third-or-later finger landing during an active two-finger gesture is tracked for clean lift-handling but does NOT reset the locked mode — palm contact mid-pinch shouldn't clobber the gesture. The canvas also sets `touch-action: none` so iOS doesn't claim the gesture for page pan/zoom before our handlers see it. `pointercancel` resets gesture state when the OS steals a pointer (palm rejection, etc).
- **Left-click on a star** (no/minimal drag, < 4 px movement) = select that star's **system** (a multi-star cluster is one selectable unit). Info card lists every member, reticle bracketing encloses every member's rendered disc, but the camera stays put — a follow-up click can then be captured as a double-click without fighting an in-flight focus glide.
- **Double-left-click on a star** = open the system view (close-up `SystemScene` for the clicked cluster). A second left-click on the same cluster within the double-click window fires `onViewSystem`; clicks on a different cluster or a timed-out gap restart the window.
- **Right-click on a star** (no/minimal drag) = select AND animate the orbit pivot to the cluster's center of mass — so right-clicking either component of a binary glides to the same vantage.
- **Spacebar** mirrors right-click on the current selection: glides the orbit pivot to the selected cluster's COM. No-op when nothing is selected (still calls `preventDefault` so the page doesn't scroll).
- **Hover** uses the same `Raycaster` against `gl.POINTS` (threshold 0.6 ly) as the click handlers — the hovered star promotes its cluster's label to the boxed hover variant in the label overlay.
- The info card's close-X (top-right corner) clears the selection. A **View System** pill button beneath the info card opens the system view for the selected cluster (alternative to double-clicking). The settings panel's close-X (top-right of its own box) closes the panel.

**ESC** dismisses the current selection in galaxy view (info card + reticle), the same as clicking the card's close-X. In system view, ESC exits back to the galaxy view (same as the back button in the header). "Reset view" in the settings panel snaps focus back to the Sun + default yaw/pitch/distance. Held-key state is cleared on `window.blur` so a key whose keyup got swallowed by alt-tab doesn't leave the camera drifting.

## Coding conventions

- TypeScript strict mode is on. Don't disable rules per-file; fix the type instead.
- The scene code uses **scratch `Vector3`/`Vector2` instances on `this`** to avoid per-frame allocations in the tick loop. When you add new per-frame math, reuse an existing scratch or add a new private one — don't `new Vector3()` inside `tick()`.
- Comments explain **why** (the load-bearing constraint, the surprising trade-off, the bug it works around). They don't restate what the code does. Match this style — a wall of comments above obvious code is noise; a one-line "uses floor not round because FP jitter at exact half-pixels would twitch" earns its keep.
- Each Lit component is a single file, owns its own styles, and exports its tag name through `HTMLElementTagNameMap` so consumers get autocomplete.
- HUD sizes are in **env pixels** (1 env pixel = `ENV_PX_PER_SCREEN_PX = 3` physical pixels). When tweaking visual sizes, divide your physical-pixel target by 3 — e.g. a "9-physical-pixel-tall scale-bar tick" is `SCALE_TICK_H = 3`.
- No emojis in source unless explicitly part of the visual design.