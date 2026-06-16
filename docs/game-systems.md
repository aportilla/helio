# Game systems

This doc is the home for Helio's actual game-mechanics, save-state, and roadmap context as it grows — what's a real mechanic versus presentation scaffolding, how the three kinds of state are kept apart, and where things are headed. The detailed design docs live in `plans/` (gitignored) — see "Design docs" below.

Almost everything in this repo so far is the **map + system viewer** — the explorable shell. Actual game mechanics are only just starting; the status below tracks what's real.

**Where we are**

- **Explorable shell — mature.** The galaxy view (`StarmapScene`) and the close-up system view (`SystemScene`) are built out: ~1500 procgen star systems, 8000+ bodies, full disc / atmosphere rendering, hover inspection. This is content + presentation, not game state.
- **Economy sim — built, standalone, not wired.** A deterministic single-tier logistics core lives under `sim/` (read [the economy sim doc](../sim/README.md)). It runs and is tested in isolation; nothing in the browser app touches it yet. Design: `plans/4x-economy-plan-discrete-single-tier.md`.
- **Facility construction.** The first real *game* mechanic and the first real save: select a planet / moon / belt in the system view and place a **colony** or a **mining base** on it (Add buttons in a bottom bar), persisted across reloads. Every fact about a facility type now lives in one registry — [`src/facilities/`](../src/facilities/README.md): its save-key, label, Add-button order, body-eligibility, build cap, and its economic projection. Eligibility is real (a mining base needs extractable richness; one of each type per body), but the economic projection (`facility → PlanetSpec`) is **built and unit-tested yet dormant** — the running app doesn't instantiate the sim, so colonies/mines carry no live economy, cost, or ownership yet. Design: `plans/4x-facility-definitions-modularity-plan.md` (registry + seam), `plans/4x-facility-construction-plan-first-light.md` (the original placement UI).

**The save-state layering** (the one bone set carefully) — three kinds of state, three homes, kept apart on purpose:

- **Catalog / skeleton** — stars + bodies, the gitignored `catalog.generated.json`. Static *content*, regenerated from CSV; never a save.
- **Game state** — `src/game-state.ts`, a versioned `localStorage` JSON blob (`helio.game`) mirroring `settings.ts`. Stores player *intent*: placed facilities, keyed by the **stable** `Body.id` (resolved back to an index via `indexOfBodyId` in [the catalog data doc](../src/data/README.md)), with **skip-on-missing** load — a facility whose body a catalog rebuild dropped (a CSV id change or `PROCGEN_VERSION` bump) is discarded with a DEV warning, never fatal.
- **Sim state** — the economy sim's own bit-stable binary save (when wired). Deterministic, integer, `configHash`-guarded.

Facilities are deliberately **not** in the sim's save: the sim has no concept of bodies (only abstract economic nodes), and a facility stores no economic behavior. The projection that derives that behavior — `Body + Facility[] → PlanetSpec`, summing each body's facilities into one node — is now built in `src/facilities/project.ts` (dormant), so the save shape stays `{ bodyId, type }` and won't need reshaping; economic data is **recomputed at cold start, never persisted**. `STORAGE_KEY` is the single seam for the planned multi-slot saves.

**Reasonable next steps** (rough order, none committed):

- A selection rim visually distinct from the hover rim (today they share one).
- More facility types beyond `colony` / `mining-base` — now one `FacilityDef` object each; the bar shows one Add button per type the selected body can host, which will want a proper picker once the list grows past a handful.
- Wire the economy sim: the `facility → PlanetSpec` projection is built, so what remains is the catalog → sim geometry/topology adapter (per-body transport nodes, plan §9) and an engine-bridge that steps the sim, then read the per-body surplus/deficit back into the system view.
- Planet ownership / players, then build costs + build time.
- Multi-slot saves with a new-game / load-game splash (the `STORAGE_KEY` seam).

## Design docs

The detailed design docs live in `plans/` (gitignored):

- `plans/4x-economy-plan-discrete-single-tier.md`
- `plans/4x-economy-glossary.md`
- `plans/4x-facility-construction-plan-first-light.md`
- `plans/4x-facility-definitions-modularity-plan.md`
