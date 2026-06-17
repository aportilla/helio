# `src/facilities/` — the facility registry + the sim projection seam

The single source of truth for every facility type the player can build, and the
contract that turns placed facilities into economy-sim input. Adding a facility
is **one `FacilityDef` object plus one literal in the `FacilityType` union** — its
save-key, UI label, Add-button order, build cap, body-eligibility predicate, and
economic projection all flow from that one edit. This replaced a definition that
used to be smeared across `game-state.ts`, the system-view facilities UI, and
`system-scene.ts`.

> Durable design rationale (the why behind every decision here) lives in
> `plans/4x-facility-definitions-modularity-plan.md`. Roadmap / cross-system
> status lives in [docs/game-systems.md](../../docs/game-systems.md). This file
> describes the **shipped** package.

## The two seams

```
 player intent            src/facilities/                      economy sim (sim/)
 (helio.game save)   ┌─────────────────────────────┐          standalone, integer-only
 {bodyId, type}      │  FACILITY_DEFS — the registry │
      │              │                               │
 game-state.ts ──────┼─▶ UI seam: label · addOrder ·│──▶ panel + scene
      │              │   eligibility · build cap     │
 facilitiesOnBody()  │                               │
      │              │  sim seam: Body + Facility[]  │
      └──────────────┼─▶ ──projectBody/World──────── │──▶ PlanetSpec[] ──▶ makeWorld()
 catalog (read-only) │   = node ＝ contributors summed│
 Body physics ───────┼─▶ (richness inputs)           │
                     └─────────────────────────────┘
```

The architectural through-line: in the sim a **planet is the node and facilities
are its contributors**, read uniformly with no facility-type branch. So here a
**body is the node and each facility is a contributor** — a body's facilities'
contributions are **summed** into one `PlanetSpec`, and the kernel never sees
facility identity.

## Module layout (acyclic — leaves first)

| Module | Role |
|---|---|
| `types.ts` | `FacilityDef`, `FacilityType` (the frozen save union), `Contribution`, `ProjectionCtx`, `PlacedFacility`, and the `ContributionBuilder` / `emptyContribution` helpers. No sim, no DOM. |
| `tuning.ts` | Hoisted economic tunables (richness ramp, per-facility base rates). Symbol-named — referenced by name, never by value. |
| `resource-vocab.ts` | `EconResource` (const-object + derived union) and `appResourceTable()`, built via the sim's own `makeResourceTable`. The sim owns the table *type*; the app owns the *instance*. |
| `abundance.ts` | `abundanceMilli(body, res)` — integer-milli "site richness" from the catalog's 0..10 indices + 0..1 biotic scalars. The **single float→int floor** in the seam. |
| `registry.ts` | `FACILITY_DEFS` + derived lookups (`FACILITY_BY_TYPE`, `FACILITY_TYPES`, `ADD_ORDER`, `facilityLabel`), `FROZEN_FACILITY_IDS`, and a DEV module-load invariant. |
| `eligibility.ts` | `addableTypesFor(body, current)` — which Add buttons a body shows, gated by predicate **and** build cap. |
| `project.ts` | `projectBody` / `projectWorld` — THE projection adapter (body intent → `PlanetSpec`). Sim-importing, node-pure (catalog is type-only). |
| `sim-geometry.ts` | `buildGeometry` — catalog coords → the sim's integer geometry (the single float→int floor for transport). Sim-importing, node-pure. |
| `world-sync.ts` | `transplantLiveState` / `sameBodyIds` — the reconcile mechanics that preserve stock across a facility edit. Sim-importing, node-pure. |
| `economy-bridge.ts` | `EconomyBridge` — the live engine owner: build/restore/reconcile the world, step, persist (`helio.sim`), read back. The **app-glue** module: imports the sim AND the catalog (`BODIES`/`STAR_CLUSTERS`) + `localStorage`, so it is NOT node-testable (its pure parts live in the modules above). |
| `index.ts` | Public barrel. |

The sim is imported only from `project.ts`, `resource-vocab.ts`, `sim-geometry.ts`,
`world-sync.ts`, and `economy-bridge.ts` — all under this package, the one quarter
the boundary guard permits.

Dependency direction: `project → registry → {abundance, resource-vocab, types,
tuning}`. Every module except `economy-bridge.ts` imports `Body` from
`../data/stars` **as a type only**, so the projection/geometry/reconcile logic
node-tests without dragging in the DOM-coupled catalog. `economy-bridge.ts` is the
deliberate exception — the app-glue layer that *does* load the catalog and
`localStorage` — which is why its pure mechanics live in `world-sync.ts` /
`sim-geometry.ts` where the tests can reach them.

## The projection (`project.ts`)

`projectBody(body, facilities, ctx)` returns one `PlanetSpec` (or `null` for a
body with no facility — not a sim node). It is a pure fold with **no
`switch (type)`**: flows (`production`/`consumption`/`stock`) **add**, while
`storageCeiling` **combines** (never adds — two uncapped sentinels summed would
wrap an `Int32Array` negative; see `combineCeiling`). A facility expresses
"no storage limit" as `0`; the projector translates that to the sim's uncapped
sentinel, so the registry never imports a sim value.

`projectWorld` allocates dense `PlanetId`s in the order of the `bodies` it's
given and returns the `bodyIdByPlanet[]` side-table the future flow visualization
resolves edges through. It **preserves** the caller's order rather than imposing
it — so callers **must** pass `BODIES` in canonical order (never a Map-derived
array), or the sim's seeded PRNG / replay would diverge.

### Cold start vs live edit

The projector is pure and used two ways. At cold start `projectWorld` builds the
full `PlanetSpec[]`. A mid-game facility edit must NOT reset the economy, so
`economy-bridge.ts` re-projects into a fresh world and then **transplants the live
state** — stock plus the smoothing/hysteresis it depends on — across by `Body.id`
(`world-sync.ts`): rates update, the larder survives. A plain reload instead
adopts the persisted world untouched (full fidelity, in-flight cargo kept) when
the facility set is unchanged. True in-place incremental mutation (carrying
in-flight cargo *through* an edit, not just a reload) stays a later refinement.

## Status

- **Shipped:** the registry + both seams, and the live engine bridge.
  `economy-bridge.ts` instantiates a real `EconomyEngine`, steps it on Next Turn,
  reconciles it after a facility edit (by `Body.id`, preserving stock), persists
  its full state to `localStorage` (`helio.sim`, `configHash`-guarded), and reads
  per-body / per-system balances back into the sidebar. Eligibility, build caps,
  and the body-derived Add pills are live.
- **Transport model:** a geometry node is a **cluster** — one system with a
  shared pool of bodies (`sim-geometry.ts` builds one node per cluster at its
  centre of mass; `clusterNodeOfBody` resolves a body to it). All bodies in a
  cluster trade freely over the sim's 1-turn self-leg; only crossing between
  clusters costs jump range. The sim's `system === node`, so a sim "system" is
  exactly one of our clusters.
- **Provisional:** the `contribute` rates and the `EconResource` roster — both
  app-internal and never serialized into `helio.game`, so freely re-mappable.
- **Deferred:** build cost / time, ownership, depot nodes, and the galaxy-view
  edge-flow overlay (the `digest.edgeFlows` read surface is ready; the 3D line
  layer is not built).

## Invariants & how they're enforced

- **Sim wall:** only `src/facilities/` imports the sim.
  `scripts/check-sim-boundary.mjs` (run by `npm run check`) fails the build on any
  other importer, and on any `sim/src` import that reaches back into the app.
- **Frozen save keys:** `FROZEN_FACILITY_IDS` is the localStorage contract; a
  test asserts the live key set is a superset, so renaming/removing a *shipped*
  id fails CI. A retired type stays as a `retired: true` tombstone def.
- **Determinism:** every float→int crossing in the seam is an explicit `Math.floor`
  in `abundance.ts`, so every value crossing into a `Contribution` is integer milli;
  `projectBody` only adds/combines integers.

Tests: `npm run test:facilities` (`src/facilities/test/`). Source is type-checked
by the app's `npm run typecheck`; the test files run under `node --test`
type-stripping (so `import type { Body }` is erased and the catalog never loads).
