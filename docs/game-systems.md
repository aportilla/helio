# Game systems

This doc is the home for Helio's actual game-mechanics, save-state, and roadmap context as it grows — what's a real mechanic versus presentation scaffolding, how the three kinds of state are kept apart, and where things are headed. The detailed design docs live in `plans/` (gitignored) — see "Design docs" below.

Almost everything in this repo so far is the **map + system viewer** — the explorable shell. Actual game mechanics are only just starting; the status below tracks what's real.

**Where we are**

- **Explorable shell — mature.** The galaxy view (`StarmapScene`) and the close-up system view (`SystemScene`) are built out: ~1500 procgen stars (grouped into ~1200 systems), 8000+ bodies, full disc / atmosphere rendering, hover inspection. The shell's rendering is content + presentation; game-state layers (like the economy's cargo-traffic overlay) ride on top of it.
- **Game shell — the persistent sidebar.** A right-edge sidebar (AppController-owned, present in both views, surviving the view switch) carries the **turn controls** at the top — a turn counter + Next Turn, the first turn-state, persisted in the save (Next Turn now steps the live economy sim, then the sidebar re-reads its balances) — over a per-view contextual region: the galaxy's civilization summary + selected-system details + View System/Focus, and the system view's selected-body facilities. The 3D content insets to its left rather than hiding behind it. Design: `plans/4x-sidebar-plan.md`.
- **Economy sim — wired and live.** A deterministic single-tier logistics core lives under `sim/` (read [the economy sim doc](../sim/README.md)). The app now drives it through `src/facilities/economy-bridge.ts`: each Next Turn steps it; placed facilities project into it (a **cluster is one economic node** — a system with a shared pool of bodies, so intra-cluster transport is free and only crossing between clusters costs jump range); and the economy reads back both as per-body / per-system surplus-deficit chips in the sidebar and as a live cargo-traffic overlay on the system diagram. Its full state persists across reloads. Design: `plans/4x-economy-plan-discrete-single-tier.md`.
- **Facility construction.** The first real *game* mechanic and the first real save: select a planet / moon / belt in the system view and place a **colony** or a **mining base** on it (Add pills in the right sidebar), persisted across reloads. Every fact about a facility type now lives in one registry — [`src/facilities/`](../src/facilities/README.md): its save-key, label, Add-button order, body-eligibility, build cap, and its economic projection. Eligibility is real (a mining base needs extractable richness; one of each type per body), and the economic projection (`facility → PlanetSpec`) is now **live**: a placed colony/mine projects into the running sim, accumulates stock turn over turn, and shows its per-resource balance in the sidebar (cost + ownership are still unbuilt). Design: `plans/4x-facility-definitions-modularity-plan.md` (registry + seam), `plans/4x-facility-construction-plan-first-light.md` (the original placement UI).

**The save-state layering** (the one bone set carefully) — three kinds of state, three homes, kept apart on purpose:

- **Catalog / skeleton** — stars + bodies, the gitignored `catalog.generated.json`. Static *content*, regenerated from CSV; never a save.
- **Game state** — `src/game-state.ts`, a versioned `localStorage` JSON blob (`helio.game`) mirroring `settings.ts`. Stores player *intent*: the current **turn** number (1-based; added without a version bump — reads merge over defaults) plus placed facilities, keyed by the **stable** `Body.id` (resolved back to an index via `indexOfBodyId` in [the catalog data doc](../src/data/README.md)), with **skip-on-missing** load — a facility whose body a catalog rebuild dropped (a CSV id change or `PROCGEN_VERSION` bump) is discarded with a DEV warning, never fatal.
- **Sim state** — the economy sim's own bit-stable binary save, now live: base64 under the separate `localStorage` key `helio.sim`, `configHash`-guarded (a catalog/scale/resource change cold-starts instead of mis-loading). Deterministic, integer.

Facilities are deliberately **not** in the sim's save: the sim has no concept of bodies (only abstract economic nodes), and a facility stores no economic behavior. The projection that derives that behavior — `Body + Facility[] → PlanetSpec`, summing each body's facilities into one node — lives in `src/facilities/project.ts` + `economy-bridge.ts`, so the `helio.game` save shape stays `{ bodyId, type }`. The derived economic *state* (stock, in-flight cargo, smoothing) **is** persisted — in the sim's `helio.sim` binary save, not recomputed-and-discarded — so a reload resumes the same economy; a mid-game build reconciles by `Body.id` rather than re-projecting, so it never zeroes accumulated stock. `STORAGE_KEY` is the single seam for the planned multi-slot saves.

**Reasonable next steps** (rough order, none committed):

- A selection rim visually distinct from the hover rim (today they share one).
- More facility types beyond `colony` / `mining-base` — now one `FacilityDef` object each; the sidebar shows one Add pill per type the selected body can host, which will want a proper picker once the list grows past a handful.
- Deepen the now-live economy: build costs + build time, glut/storage caps, trade-hub depot nodes, and a galaxy-view edge-flow overlay (the `digest.edgeFlows` read surface is ready; the 3D line layer isn't built).
- Planet ownership / players.
- Multi-slot saves with a new-game / load-game splash (the `STORAGE_KEY` seam).

## Design docs

The detailed design docs live in `plans/` (gitignored):

- `plans/4x-economy-plan-discrete-single-tier.md`
- `plans/4x-economy-glossary.md`
- `plans/4x-facility-construction-plan-first-light.md`
- `plans/4x-facility-definitions-modularity-plan.md`
