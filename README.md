# Starmap

A 3D pixel-art visualization of the stars within ~20 light years of the Sun. Orthographic camera, log-scaled stellar discs colored by spectral class, drop-lines pinning each star to the galactic plane, all rendered in a deliberately chunky retro CRT aesthetic.

Think 1980s starbase HUD: VT323 / Share Tech Mono fonts, cyan-on-near-black palette, scanline overlay, hand-drawn-looking concentric range rings.

## Stack

- **Vite 5** — dev server + build (`vite.config.ts` opens the browser on `npm run dev`)
- **TypeScript 5** — strict mode, `noUnusedLocals`/`noUnusedParameters`, `noEmit` (Vite handles emit)
- **Lit 3** — web components for the HUD chrome (title, controls, scale bar, boot splash)
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
  styles.css                CSS custom props, body reset, font-family
  components/               Lit web components (HUD chrome only — no scene logic)
    starmap-app.ts          Root component; owns the canvas + StarmapScene instance
    starmap-title.ts        Top-left "NEARBY STARS" title block
    starmap-controls.ts     Bottom-right toggle buttons (labels/droplines/spin/reset)
    starmap-scale.ts        Bottom-left dynamic scale bar
    starmap-boot.ts         Centered "INITIALIZING STELLAR CATALOG" splash
  scene/                    Three.js code — no DOM coupling beyond the canvas
    scene.ts                StarmapScene: camera, input, render loop, owns sub-objects
    grid.ts                 Concentric range rings + cross axes + galactic-centre arrow
    droplines.ts            Vertical pin from each star to the galactic plane
    stars.ts                gl.POINTS starfield with per-star size + color
    labels.ts               Bitmap-font Sprites: star names, axis ticks, hover tooltip
    materials.ts            Pixel-snapped line ShaderMaterial + the stars shader
  data/
    stars.ts                Star catalog (name, x/y/z in ly, spectral class, distance)
    pixel-font.ts           Inline Monaco 11px BDF data + canvas-texture text renderer
```

## Architecture notes

### Component / scene split

`StarmapApp` (the Lit root) owns the canvas and instantiates `StarmapScene`. It bridges UI events from the toggle buttons (`@toggle-labels`, `@toggle-drops`, `@toggle-spin`, `@reset-view`) into method calls on the scene, and receives a `onScale` callback so the scene can push the current scale-bar step/width into the `<starmap-scale>` element each frame.

The `scene/` modules know **nothing about Lit or the DOM** beyond the `HTMLCanvasElement` they render into and `window` for size/input listeners. Don't add DOM queries in there — route data through the `StarmapSceneOptions` callback or new methods on `StarmapScene`.

### Coordinate system

Galactic cartesian, units in light years:
- **+X** points toward the galactic centre (where the cyan `► GALACTIC CENTRE` arrow points)
- **+Z** points toward the north galactic pole (the camera's up vector is fixed to `(0, 0, 1)`)
- The Sun sits at the origin

Star positions are approximated to ~0.5 ly from known distances + RA/Dec. That's plenty for visualization but **don't treat the catalog as scientifically authoritative**.

### Camera

`OrthographicCamera`, not perspective. This is intentional and load-bearing:
- Drop-lines must project as truly parallel vertical lines (the "pin to plane" geometry stops reading correctly under perspective).
- Matches the reference illustration's flat, technical-diagram feel.

The orbit-camera state lives in `view = { target, distance, yaw, pitch, spin }`. `distance` is the **frustum height in light years** — i.e. the zoom level. The camera position itself orbits a fixed sphere of radius 200 around `target`; zoom is handled entirely by widening or narrowing the ortho frustum bounds. Zoom is clamped to `[8, 200]` ly.

### Pixel-perfect rendering — the load-bearing constraints

The whole "pixel art" look depends on a stack of choices that all have to stay consistent:

1. **`renderer.setPixelRatio(devicePixelRatio / N)`** with `N = ENV_PX_PER_SCREEN_PX = 3` — the render buffer is sized so each render ("env") pixel becomes N×N physical pixels after the browser's `image-rendering: pixelated` nearest-neighbor upscale. The DPR-relative formula means the on-screen pixel size is consistent across retina (DPR=2) and non-retina (DPR=1) displays. Increasing N makes the look chunkier and reduces fragment work by 1/N². Critically, **all pixel-aware shader work must use `renderer.getDrawingBufferSize()` — NOT `window.innerWidth/Height`** — because the buffer is now smaller than the CSS viewport. `scene.ts` caches these as `bufferW`/`bufferH` in `resize()` and threads them into `setSnappedLineViewport`, `StarPoints.setPxScale`, and `Labels.update`.
2. **Pixel-snapped line shader** (`snappedLineMat` in `materials.ts`) — the vertex shader rounds each projected vertex to the nearest integer screen pixel before rasterization. The dashed variant patterns dashes in screen-pixel space (using snapped Y) so dashes stay aligned with the pixel grid. Used for grid arcs, axes, the galactic-centre arrow, and droplines.
3. **Stars shader** (`makeStarsMaterial`) — `gl.POINTS` with a procedural circle in the fragment shader (no texture sampling, no AA fringe). Sprite size is rounded to the nearest **even** integer so the disc has equal pixel-rows above/below center; an odd size leans 1px and looks asymmetric. The fragment uses `floor((gl_PointCoord - 0.5) * radius * 2) + 0.5` for hard stair-stepped edges.
4. **Label sprites** — bitmap-font glyphs drawn into a canvas at integer pixel coordinates, then uploaded as a texture with `NearestFilter` (both min + mag) and `generateMipmaps = false`. Each frame the sprite's world position is **snapped to the integer pixel grid** via `snapToPixelGrid` so 1 font pixel always lands on 1 screen pixel.
5. **Pixel snap uses `Math.floor`, not `Math.round`** — when a sprite projects to an exact half-pixel (e.g. the Sun at world origin → screen center), tiny FP jitter around 0.5 would flip rounding between frames and cause 1px twitch. Floor always rounds the same direction, keeping positions stable frame-to-frame.

If you add new scene geometry, route it through `snappedLineMat` for lines and the existing point-shader pattern for sprites — don't introduce vanilla `LineBasicMaterial` or `PointsMaterial`, they'll shimmer.

### Bitmap font

`src/data/pixel-font.ts` ships an inline subset of **Monaco 11px** as BDF data (encoding, advance, bbox metrics, hex rows). Coverage: ASCII 32–126 + `°` (degree), `·` (middle dot), `—` (em-dash), `►` (custom right-pointer for the GC arrow label).

`makeLabelTexture(text, color, opts?)` (or with a `TextSegment[]` for multi-color labels) renders into a canvas, optionally adds a 1px dark halo so labels read against any background, and returns a `CanvasTexture` plus its `w/h` in pixels. The `box: true` option draws a bordered tooltip frame instead (used for the hover tooltip).

If you need glyphs outside the current set, add a row to `FONT_GLYPHS` keyed by Unicode codepoint.

### Spectral-class lookups

Two lookup tables in `src/data/stars.ts`:
- **`CLASS_COLOR`** — approximate blackbody color per spectral class (Mitchell Charity table). O/B/A trend blue, F/G white, K/M orange-red, WD pale blue, BD deep red.
- **`CLASS_SIZE`** — derived from `CLASS_RADIUS` (reference radii in solar radii) via `4.4 + log10(R) * 1.6`. The log mapping turns the ~6-orders-of-magnitude range of real stellar radii into a readable visual spread; the shader then clamps the final pixel size to `[2, 28]`.

The Sun's `CLASS_SIZE` works out so its visual size matches the original prototype. Rebalance carefully if you add a new class.

### Grid half-plane dimming

The galactic plane is split into 4 quadrants by the cross axes. Each frame, `Grid.update()` figures out which **half** of the plane is "behind" the camera (based on which world axis the camera is more aligned with) and dims those two quadrants' arcs. The half-axes between quadrants dim only when **both** flanking quadrants are dim — otherwise the axis IS the boundary between the bright and dim halves, so it stays bright. The galactic-centre arrow on +X follows the same rule.

It's a subtle orientation cue that makes the depth of the 3D scene readable without explicit shading.

### Drop-line styling

Each star (except the Sun) gets a vertical line to the galactic plane. Two lines actually exist per star, sharing one geometry: a **solid** and a **dashed** version. Each frame `Droplines.update()` picks **solid** if the star is on the same side of the plane as the camera, **dashed** if on the far side.

Materials are **opaque** (`opaque: true` on `snappedLineMat`), not alpha-blended. The catalog has many binary and triple-star systems (Alpha Cen A/B, Sirius A/B, 40 Eridani A/B/C, Gliese 570 A/B/C, …) whose components share identical x/y/z coordinates. Their droplines therefore share identical geometry and rasterize to identical pixels. Under alpha blending those overlapping lines would stack — two coincident lines at opacity 0.85 render as ~0.978, three as ~0.997 — making binary/triple droplines visibly brighter than singles. Opaque rendering means each pixel is exactly `uColor` regardless of how many lines overlap.

The dashed shader's `discard` for gap pixels still works fine without transparency — `discard` just skips the pixel entirely, no blending involved.

Anchoring the dash phase: each dropline's dash pattern is phased from its own anchor's screen-Y (computed by re-projecting `(position.x, position.y, 0)` in the vertex shader and passing the result as a varying). If you used a global screen-Y instead, all droplines would share the same horizontal dash rows and create faint horizontal banding across the field.

### Input

All input lives in `StarmapScene`:
- **Pointer drag** = orbit (yaw/pitch). **Shift+drag or right-drag** = pan the target.
- **Wheel** = zoom (frustum height).
- **Two-finger pinch** = zoom on touch.
- **WASD** = pan target along screen axes; **Q/E** = yaw left/right.
- **Hover** uses a `Raycaster` against the `gl.POINTS` star object with `params.Points.threshold = 0.6` — the hovered star drives the boxed tooltip sprite in `Labels`.

## Coding conventions

- TypeScript strict mode is on. Don't disable rules per-file; fix the type instead.
- The scene code uses **scratch `Vector3`/`Vector2` instances on `this`** to avoid per-frame allocations in the tick loop. When you add new per-frame math, reuse an existing scratch or add a new private one — don't `new Vector3()` inside `tick()`.
- Comments explain **why** (the load-bearing constraint, the surprising trade-off, the bug it works around). They don't restate what the code does. Match this style — a wall of comments above obvious code is noise; a one-line "uses floor not round because FP jitter at exact half-pixels would twitch" earns its keep.
- Each Lit component is a single file, owns its own styles, and exports its tag name through `HTMLElementTagNameMap` so consumers get autocomplete.
- No emojis in source unless explicitly part of the visual design (the `►` glyph in the GC arrow label is the only current case, and it lives in the bitmap font).

## Things that are deliberately not here

- **No physically-accurate star positions or motions.** Catalog is for visualization, not navigation.
- **No animation other than autospin and the boot splash fade.** Keep it that way unless adding it intentionally.
- **No perspective camera.** Don't add one without first deciding what to do about drop-lines.
- **No texture-based stars or labels.** Everything is procedural / canvas-rasterized so the pixel-perfect look survives any zoom level.
