# Helio

The galaxy-map screen of **Helio**, a planned 4X space strategy game in the lineage of Ascendancy (1995).

A 3D pixel-art visualization of the stars within ~50 light years of the Sun. Perspective camera orbiting a focused star, stellar discs sized by spectral class and depth-attenuated, range rings + drop-lines lighting up around the cluster you've selected (the catalog reads as plain stars until you pick one to inspect), all rendered in a deliberately chunky retro aesthetic.

Think 1980s starbase HUD: inline bitmap-font labels, cyan-on-near-black palette, hand-drawn-looking concentric range rings. The HUD chrome renders as native pixel art inside the WebGL scene rather than as DOM elements — chiefly a persistent right **sidebar** (turn controls over a per-view contextual region: civilization + selected-system in the galaxy, the selected body's facilities in the system view) that the 3D content insets to the left of. A settings popover opens from the sidebar header — **General** (auto-rotate, reset view), **Graphics** (display toggles, render-resolution chooser), **Controls** (touch input, plus a read-only keyboard / mouse reference).

> This root README is the high-level map. Each subsystem keeps its own deep doc — see [Map of the codebase](#map-of-the-codebase) below; this file points into them rather than duplicating their detail.

## Stack

- **Vite 8** — dev server + build (`vite.config.ts` opens the browser on `npm run dev`)
- **TypeScript 6** — strict mode, `noUncheckedIndexedAccess`, `noUnusedLocals`/`noUnusedParameters`, `noEmit` (Vite handles emit)
- **Three.js r184** — WebGL renderer, scene graph, shaders

No CSS framework, no state library, no testing framework yet.

## Scripts

```
npm run dev            # vite dev server, opens browser (prebuilds catalog)
npm run build          # tsc + vite build → dist/   (prebuilds catalog; tsconfig sets noEmit, so tsc just type-checks)
npm run preview        # serve dist/
npm run typecheck      # tsc --noEmit (prebuilds catalog)
npm run build:catalog  # regenerate src/data/catalog.generated.json from src/data/*.csv
```

`build:catalog` is auto-run by `predev` / `prebuild` / `pretypecheck` hooks, so you only invoke it directly when iterating on a CSV mid-session and want to refresh the runtime without restarting the dev server.

The standalone economy sim has its own scripts — `npm run test:sim` and `npm run typecheck:sim` — see [sim/README.md](sim/README.md). The facility registry + sim-projection seam adds `npm run test:facilities` and `npm run check:boundaries` (the latter guards the standalone-sim import wall and is also part of `npm run check`) — see [src/facilities/README.md](src/facilities/README.md). `npm test` runs both test suites.

## The big picture

Helio runs as three layers:

1. **Catalog (skeleton)** — a precomputed snapshot of ~1500 nearby star systems and 8000+ bodies (`src/data/catalog.generated.json`, gitignored), built from hand-authored CSVs by `scripts/build-catalog.mjs` plus a deterministic procgen pipeline. Static content, regenerated from source, never a save. Build pipeline: [scripts/README.md](scripts/README.md); runtime API: [src/data/README.md](src/data/README.md).
2. **Browser app** — the Three.js galaxy + system views and their pixel-art HUDs (`src/scene/`, `src/ui/`). What the player sees. [src/scene/README.md](src/scene/README.md), [src/ui/README.md](src/ui/README.md).
3. **Economy sim** — a standalone, deterministic, integer-only logistics core (`sim/`), built and tested in isolation, then driven by the app through `src/facilities/economy-bridge.ts` (a placed facility projects into it; Next Turn steps it; surplus/deficit reads back into the sidebar). [sim/README.md](sim/README.md).

**Game state** — what the player has done — is a fourth, separate concern: a versioned `localStorage` JSON save (`src/game-state.ts`, key `helio.game`) that today holds placed facilities keyed by stable `Body.id`. It's deliberately kept apart from both the static catalog and the sim's deterministic binary save; the three never contain each other. The save-state layering and the game-mechanics roadmap live in [docs/game-systems.md](docs/game-systems.md).

## Cross-cutting commitments

Rules that hold across the whole codebase — know these before touching anything:

- **Pixel-crisp is the committed visual identity.** 1-px borders, bitmap fonts, dithering — no anti-aliasing, gradients, sub-pixel positioning, or DOM-rendered text inside the canvas. Find a pixel-crisp way to express an intent rather than softening the rules. Detail: [src/scene/README.md](src/scene/README.md) → "Pixel-perfect rendering".
- **`ColorManagement` is OFF.** Every hex value renders at exactly its sRGB value end-to-end; don't re-enable it without auditing every shader-vs-canvas color call site. Detail: [src/scene/README.md](src/scene/README.md) → "Color management is OFF".
- **Determinism in the data + sim layers.** Catalog procgen is byte-reproducible across builds (seeded PRNG + `PROCGEN_VERSION`); the sim is integer-only and bit-stable for same-machine save/replay. Keep float math out of those load-bearing paths.
- **`scene/` knows nothing about the DOM** beyond the `HTMLCanvasElement` it renders into and `window` for size/input listeners — route data through callbacks, not DOM queries.
- **UI is a peer of the scene, not chrome.** `src/ui/` houses *generic* primitives meant to serve the next five screens, not map-specific decoration. Detail: [src/ui/README.md](src/ui/README.md) → "UI subsystem".

## Map of the codebase

One deep doc per subsystem. Start in the root for orientation, then open the doc for the area you're working in.

| Area | What's there | Deep doc |
|---|---|---|
| `src/` (root) | Bootstrap (`main.ts`), `settings.ts` (user prefs), `game-state.ts` (the game save) | — (this README + [docs/game-systems.md](docs/game-systems.md)) |
| `src/scene/` | Three.js galaxy + system scenes, rendering, shaders, camera, input, selection | [src/scene/README.md](src/scene/README.md) |
| `src/ui/` | Pixel-art widget toolkit (`Widget`/`BasePanel`/painter/theme) + per-screen HUDs | [src/ui/README.md](src/ui/README.md) |
| `src/data/` | Runtime catalog API + types, cluster/naming model, bundled bitmap fonts | [src/data/README.md](src/data/README.md) |
| `src/facilities/` | Facility registry (one object per type) + the economy-sim projection seam + the live engine bridge | [src/facilities/README.md](src/facilities/README.md) |
| `scripts/` | Star-data tooling + the catalog/procgen **build pipeline** that emits the JSON | [scripts/README.md](scripts/README.md) |
| `sim/` | Standalone deterministic economy/logistics sim | [sim/README.md](sim/README.md) |
| `docs/` | Game-systems status, save-state model, roadmap | [docs/game-systems.md](docs/game-systems.md) |
| `plans/` | Detailed design docs (gitignored, ephemeral) | — |

## Planned architecture

Forward-looking, not yet built: a WASM port of the sim and desktop (Electron) distribution — each has decided boundaries but no committed roadmap doc, designed when concrete work on it begins. The economy sim and the save-state layer are already in progress; their status lives in [docs/game-systems.md](docs/game-systems.md). Session-scoped planning artifacts stay local-only in the gitignored `plans/` directory.

## Coding conventions

- TypeScript strict mode is on. Don't disable rules per-file; fix the type instead.
- The scene code uses **scratch `Vector3`/`Vector2` instances on `this`** to avoid per-frame allocations in the tick loop. When you add new per-frame math, reuse an existing scratch or add a new private one — don't `new Vector3()` inside `tick()`.
- Comments explain **why** (the load-bearing constraint, the surprising trade-off, the bug it works around). They don't restate what the code does. Match this style — a wall of comments above obvious code is noise; a one-line "uses floor not round because FP jitter at exact half-pixels would twitch" earns its keep.
- HUD sizes are in **env pixels** (1 env pixel = N physical pixels after the nearest-neighbor upscale, where N is the runtime-chosen scale — typically 3 on retina). When tweaking visual sizes, think in env pixels — e.g. a 9-physical-pixel-tall tick on retina is `SCALE_TICK_H = 3`. The token visually scales with the user's resolution preference and the underlying display, but its env-pixel value is fixed.
