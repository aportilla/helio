# Future planning

Forward-looking design intent for parts of the codebase that don't exist yet — the simulation layer, the WASM port, save-state management, and desktop distribution. The boundaries are decided here so that future implementation has a target to hit.

This document is **distinct from ephemeral session-scoped planning artifacts** (refactor plans, scratch TODO lists, working notes from a single authoring session). Those live under `.git/info/exclude` and are never committed. This file is a durable architectural roadmap and is committed alongside `README.md`.

Implementation will happen incrementally; expect this document to shrink as decisions migrate into actual code, rather than grow.

## Simulation layer (`src/sim/`)

The current codebase is the **map-screen renderer**. The 4X simulation — empires, fleets, economy, research, turn resolution — will live in a separate `src/sim/` module designed for two future moves: (1) porting the hot path to Rust→WASM, and (2) running the whole thing inside an Electron (or Tauri) desktop wrapper for distribution.

### Module layout

```
src/sim/
  index.ts          Public API — the only module the rest of the app imports
  types.ts          Pure data types (no methods, no class instances)
  state.ts          SimState shape + factory
  orders.ts         Order union (player/AI inputs)
  events.ts         Event union (what came out of a turn)
  snapshot.ts       Read-only views the renderer consumes
  rng.ts            Deterministic PRNG (mulberry32 or PCG)
  systems/          Each subsystem advances state by one turn
    economy.ts
    research.ts
    movement.ts
    combat.ts
  serialize.ts      State ↔ Uint8Array
```

### Public API — five entry points

```ts
export function createGame(params: GalaxyParams): SimState;
export function advanceTurn(state: SimState, orders: Order[]): TurnResult;
export function snapshot(state: SimState): WorldSnapshot;
export function serialize(state: SimState): Uint8Array;
export function deserialize(bytes: Uint8Array): SimState;
```

All five are pure: no hidden globals, no I/O, no `Date.now()`, no `Math.random()`. This is what makes the module WASM-portable — every call is coarse-grained, takes flat data in, returns flat data out, no per-entity method calls crossing the boundary.

### State shape — structure-of-arrays

```ts
export interface SimState {
  turn: number;
  rngState: number;            // single u32, replaces Math.random
  galaxy: GalaxyTable;
  empires: EmpiresTable;
  fleets: FleetsTable;
}

export interface GalaxyTable {
  count: number;
  x: Float32Array;             // positions in light-years, galactic cartesian
  y: Float32Array;
  z: Float32Array;
  spectralClass: Uint8Array;   // enum index, not string
  ownerEmpire: Int16Array;     // -1 = unowned
  population: Uint32Array;
}
```

SoA over AoS for two reasons: (1) hot loops over `population[]` stay cache-friendly in JS *and* in WASM linear memory, and (2) `Float32Array` etc. can be handed to a WASM module by reference rather than re-marshalled.

### Orders and events as tagged unions

```ts
export type Order =
  | { kind: 'move-fleet'; fleetId: number; targetStarId: number }
  | { kind: 'colonize'; fleetId: number; starId: number }
  | { kind: 'build'; starId: number; buildingId: number }
  | { kind: 'research'; empireId: number; techId: number };

export type SimEvent =
  | { kind: 'fleet-arrived'; fleetId: number; starId: number }
  | { kind: 'colony-founded'; starId: number; empireId: number }
  | { kind: 'combat-resolved'; starId: number; winnerEmpire: number };

export interface TurnResult {
  state: SimState;
  events: SimEvent[];          // for animations + log UI
}
```

Tagged unions in TS map to integer-tagged structs in Rust without drama.

### The snapshot pattern (the load-bearing decoupling)

The renderer never holds a reference to `SimState`. It holds a `WorldSnapshot`:

```ts
export interface WorldSnapshot {
  turn: number;
  stars: StarSnapshot;
  fleets: FleetSnapshot;
}

export interface StarSnapshot {
  count: number;
  positions: Float32Array;
  ownerEmpire: Int16Array;
  flags: Uint8Array;           // hasColony, isCapital, contested, ...
}
```

Render code in `src/scene/stars.ts` already takes flat attribute arrays — it would get them from `snapshot()` instead of from `RAW_STARS`. When the sim later moves to WASM, `snapshot()` becomes "copy out of WASM linear memory into a JS-visible `Float32Array` view" and the render code never notices.

### Determinism rules

- All randomness goes through `rngState` in `SimState`. The sim never calls `Math.random()`.
- No `Date.now()` / `performance.now()` inside `sim/`. Time is `state.turn`, full stop.
- If full cross-machine determinism becomes a goal (multiplayer, replay-from-save), game-affecting math should move to fixed-point integers — different CPUs handle `f32` denormals slightly differently. Worth flagging now even if the call gets deferred.

### What `scene/` is allowed to import from `sim/`

Only `snapshot()`, `WorldSnapshot`, and small enum tables (spectral class names, building names, etc.). Importing `SimState` into a scene file means the boundary has been broken.

### Open question — real stars vs procgen galaxy

Today's renderer draws the real-stars catalog (~100 stars within 20 ly). A 4X galaxy would be procgen, fictional, and probably 200–2000 systems. Either the sim owns a procgen galaxy (and the real catalog becomes a tutorial/sandbox scenario or is retired), or the sim seeds from the real catalog and procgens outward from Sol. Decision affects whether `RAW_STARS` in `src/data/stars.ts` survives or migrates into `sim/scenarios/`.

## UI input layering

The current pointer model is a one-step seam: each HUD orchestrator (`MapHud`, `SystemHud`) exposes `hitTest(bufX, bufY): 'interactive' | 'opaque' | 'transparent'` and the active scene queries it once per `pointermove` to decide whether the event reaches world picking. That handles the two consumers we have today (hover gating and click absorb on opaque chrome). It does **not** handle the consumers we know are coming.

### Trigger for promotion

Promote to a real router when the **first** of these lands:
1. A modal dialog (confirm prompts, diplomacy, rename — anything that should fully trap input until dismissed).
2. A tooltip-on-hover (informational popover that occludes visually but should NOT absorb hover from the layer below — the underlying widget should stay hovered).
3. A right-click context menu (popover that absorbs but auto-dismisses on outside-click).

Each of these sharpens the interface in a different direction; building the router before any of them exist would be guessing at semantics.

### Planned shape

```
src/ui/input/
  router.ts          InputRouter — owns the layer stack, walks top-down per event
  layer.ts           InputLayer interface
  focus.ts           FocusManager — keyboard focus stack (separate concern)
```

```ts
export interface InputLayer {
  hitTest(bufX: number, bufY: number): HitResult;          // existing contract
  onPointerMove?(bufX: number, bufY: number): void;
  onPointerDown?(bufX: number, bufY: number, e: PointerEvent): boolean;
  onPointerLeave?(): void;                                  // pointer left this layer
  // keyboard hooks added when FocusManager lands
}
```

`InputRouter.handlePointerMove(x, y)` walks the layer stack top-down. The first layer whose `hitTest` returns `'interactive'` or `'opaque'` is the owning layer; deliver the event to it, call `onPointerLeave` on every layer below that previously had the pointer, set the cursor to `pointer` iff the result is `'interactive'`. `'transparent'` falls through to the next layer. The bottom layer is always the world (`StarmapScene` / `SystemScene`), which receives the residue.

Layer priority order, in roughly the order we'll add them:

1. **Modal layer** — at most one modal at a time; its `hitTest` returns `'interactive'` inside the modal rect and `'opaque'` everywhere else. Outside-clicks are absorbed *and* dispatched as a "modal-dismiss" hint (each modal decides whether to honor it).
2. **Popover layer** — settings panel today; tooltips and right-click menus later. `'interactive'` inside, `'transparent'` outside (no scrim). Tooltips opt out of click-absorb so the underlying widget still receives clicks through the tooltip rect.
3. **HUD widgets** — info card, scale bar, title, action buttons, settings trigger. The current per-HUD `hitTest` becomes this layer's `hitTest`, unchanged.
4. **World** — `StarmapScene` / `SystemScene`. Catch-all bottom; star picking only fires here.

`AppController` owns the `InputRouter` instance — same lifecycle as the shared `WebGLRenderer`. Layer push/pop happens when modes change (entering system view replaces the map HUD layer with the system HUD layer) or when a popover/modal opens/closes.

### Keyboard focus (separate stack)

Pointer hit-testing and keyboard focus are orthogonal — pointer routes by *position*, keyboard routes by *who claimed focus*. `FocusManager` owns a key-consumer stack:

- A single stack of consumers; top of stack receives each key event first. If it returns `false` (didn't consume), the event walks down.
- The world is the bottom consumer. Its WASD/QE/space handlers only fire when nothing above consumed.
- Modals push themselves on open, pop on close — automatic focus trap.
- Future text input fields (rename ship, set production target) push themselves while focused; they consume W/A/S/D as letter input instead of camera pan.
- ESC is handled top-down (highest consumer wins): modal-dismiss > popover-dismiss > selection-clear > no-op.

Today the scene routes `keydown` directly. The migration is a single seam: replace the scene's `window.addEventListener('keydown', ...)` with `focusManager.handle(e)`, register the scene as the bottom consumer.

### What's deferred further

- **Tab navigation between widgets** (virtual highlight without mouse). Real but not urgent — strategy games rarely use Tab cycling.
- **Drag-and-drop layer** (fleet management, ship-design parts). Distinct enough from pointer routing that it deserves its own design pass when the first concrete consumer arrives.
- **Z-order conflicts within a single layer** (two popovers open at once). Stack discipline solves it for now (one popover at a time); revisit if a real use case emerges.

### Migration cost from today's state

Low. Each HUD's existing `hitTest` is already the future `InputLayer.hitTest` — we lift it under the router, we don't rewrite it. The scene's existing `pointer.has` gating moves into the router's `transparent`-falls-through walk. The `HitResult` type stays where it is.

## WASM port (deferred)

The simulation is intended to be portable to Rust→WASM via `wasm-bindgen` once profiling justifies it. The five-function public API and the SoA `TypedArray` state shape are the design choices that make this cheap later. The render layer (Three.js, HUD, fonts) stays JS/TS forever — calling Three.js from WASM crosses the JS↔WASM boundary on every draw and is *slower* than calling it from JS.

Where WASM is expected to actually pay off:
- Turn resolution / AI / economy simulation (the bulk of `sim/systems/`).
- Procedural galaxy generation.
- Spatial indexing (BVH / kd-tree) for click-picking against large star counts.
- Save/load serialization of large game state.

Where it would not help (and would hurt): rendering, scene-graph updates, anything already GPU-bound.

## Save states

Save management splits cleanly into two layers — and each layer has different concerns.

**Format (lives in `sim/`).** `serialize(state) → Uint8Array` and `deserialize(bytes) → SimState` are already the right interface — `Uint8Array` is environment-agnostic and maps directly to WASM linear memory later. **Reserve the first byte(s) for a format version number from day one.** Once a save ships, you've made a backward-compatibility promise; without a version byte you've made an *implicit* one you can't enforce. `deserialize` checks the version and runs migrations forward to current.

**Transport (lives outside `sim/`, e.g. `src/saves/`).** This is the part that's environment-specific:

- **Web build (itch.io HTML5):** `localStorage` is too small for 4X saves (5–10 MB browser cap). Use **IndexedDB** — async, multi-MB, structured.
- **Electron desktop:** real save files under `app.getPath('userData')`. Visible in the OS, backup-friendly, compatible with Steam Cloud.

Both sit behind a single interface so the sim never knows where saves physically live:

```ts
interface SaveStore {
  list(): Promise<SaveSlot[]>;
  read(id: string): Promise<Uint8Array>;
  write(id: string, bytes: Uint8Array): Promise<void>;
  delete(id: string): Promise<void>;
}

class IndexedDBSaveStore implements SaveStore { ... }    // web
class FilesystemSaveStore implements SaveStore { ... }   // electron
```

Slot management (autosave cadence, quicksave, named saves) is UI plumbing on top of `SaveStore` — not a sim concern.

**Bonus the determinism rules unlock.** If the sim is fully deterministic (RNG state in `SimState`, no wall-clock reads inside `sim/`), a save can optionally be **"initial seed + order log"** instead of a full snapshot. Tiny on disk, gives you replays for free. The catch is load time grows with turn count, so the usual hybrid is *snapshot every N turns + order delta since last snapshot*. Worth keeping in mind as a future option; probably not worth implementing until late.

## Desktop distribution (Electron wrapper)

The end-state delivery target is a desktop binary distributed on Steam and/or itch.io. Plan is to wrap the built `dist/` in **Electron**: largest binary (~80–150 MB per platform) but the most battle-tested ecosystem for indie web-tech games on Steam (auto-update, code signing, Steamworks SDK bindings). Tauri remains a smaller-binary alternative if Electron's footprint becomes a concern.

One change the codebase already needs whenever the wrapper happens:
- `vite.config.ts` has `base: '/starmap/'` for GitHub Pages. Desktop builds need `'./'` or `'/'` — gate behind a build env var.

itch.io HTML5 (zip of `dist/`, served in an iframe) remains a zero-effort intermediate distribution channel that doesn't require any wrapper at all.
