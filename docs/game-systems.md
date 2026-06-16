# Game systems

This doc is the home for Helio's actual game-mechanics, save-state, and roadmap context as it grows — what's a real mechanic versus presentation scaffolding, how the three kinds of state are kept apart, and where things are headed. The detailed design docs live in `plans/` (gitignored) — see "Design docs" below.

Almost everything in this repo so far is the **map + system viewer** — the explorable shell. Actual game mechanics are only just starting; the status below tracks what's real.

**Where we are**

- **Explorable shell — mature.** The galaxy view (`StarmapScene`) and the close-up system view (`SystemScene`) are built out: ~1500 procgen star systems, 8000+ bodies, full disc / atmosphere rendering, hover inspection. This is content + presentation, not game state.
- **Economy sim — built, standalone, not wired.** A deterministic single-tier logistics core lives under `sim/` (read [the economy sim doc](../sim/README.md)). It runs and is tested in isolation; nothing in the browser app touches it yet. Design: `plans/4x-economy-plan-discrete-single-tier.md`.
- **Facility construction — first light.** The first real *game* mechanic and the first real save: select any planet / moon / belt in the system view and place a **colony** or a **mining base** on it (side-by-side Add buttons in a bottom bar), persisted across reloads. Both are placement markers today — no economy, no cost, no ownership; the two types exist to seed economy-state experiments (a colony will project to a consumer node, a mining base to a producer). Design: `plans/4x-facility-construction-plan-first-light.md`.

**The save-state layering** (the one bone set carefully) — three kinds of state, three homes, kept apart on purpose:

- **Catalog / skeleton** — stars + bodies, the gitignored `catalog.generated.json`. Static *content*, regenerated from CSV; never a save.
- **Game state** — `src/game-state.ts`, a versioned `localStorage` JSON blob (`helio.game`) mirroring `settings.ts`. Stores player *intent*: placed facilities, keyed by the **stable** `Body.id` (resolved back to an index via `indexOfBodyId` in [the catalog data doc](../src/data/README.md)), with **skip-on-missing** load — a facility whose body a catalog rebuild dropped (a CSV id change or `PROCGEN_VERSION` bump) is discarded with a DEV warning, never fatal.
- **Sim state** — the economy sim's own bit-stable binary save (when wired). Deterministic, integer, `configHash`-guarded.

Facilities are deliberately **not** in the sim's save: the sim has no concept of bodies (only abstract economic nodes on stars), and a colony stores no economic behavior. When the economy is wired, a colony *projects* into the sim's existing node-contributor seam (`facility → PlanetSpec`), so the save shape stays `{ bodyId, type }` and won't need reshaping. `STORAGE_KEY` is the single seam for the planned multi-slot saves.

**Reasonable next steps** (rough order, none committed):

- A selection rim visually distinct from the hover rim (today they share one).
- More facility types beyond `colony` / `mining-base`; the bar lists one Add button per type today, which will want a proper picker once the list grows past a handful.
- Wire the economy sim: a catalog-star → sim-geometry-index adapter + the `facility → PlanetSpec` projection, then read the sim's per-system surplus/deficit back into the system view.
- Planet ownership / players, then build costs + build time.
- Multi-slot saves with a new-game / load-game splash (the `STORAGE_KEY` seam).

## Design docs

The detailed design docs live in `plans/` (gitignored):

- `plans/4x-economy-plan-discrete-single-tier.md`
- `plans/4x-economy-glossary.md`
- `plans/4x-facility-construction-plan-first-light.md`
