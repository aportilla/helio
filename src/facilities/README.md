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
| `project.ts` | `projectBody` / `projectWorld` — THE adapter. With `resource-vocab.ts`, the **only** place in `src/` that imports the sim. |
| `index.ts` | Public barrel. |

Dependency direction: `project → registry → {abundance, resource-vocab, types,
tuning}`. Everything imports `Body` from `../data/stars` **as a type only**, so
nothing here drags the DOM-coupled catalog into a Node test.

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

`stock` is a one-time cold-start endowment. The projector is pure and used two
ways: at cold start `projectWorld` builds the full `PlanetSpec[]`; a mid-game
facility edit must become an **incremental sim mutation**, never a re-projection
(which would reset live stock and renumber `PlanetId`s). That reconciliation
lives in the deferred engine-bridge — the seam is shaped so the bridge can honor
it.

## Status

- **Shipped:** the registry + both seams. Eligibility (richness-gated mining
  bases), per-body build caps, and the sidebar's body-derived Add pills are live.
- **Dormant:** the running app does not yet instantiate the sim, so
  `projectWorld` is built and unit-tested but uncalled. `contribute` rates are
  **provisional** (the `EconResource` roster is app-internal and never
  serialized, so it is freely re-mappable).
- **Deferred:** wiring `projectWorld` into a live `EconomyEngine`, and the
  catalog → sim geometry/topology adapter (per-body transport nodes). See the
  plan §9 / §13 Phase 4.

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
