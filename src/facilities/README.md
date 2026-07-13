# `src/facilities/` — the facility registry + the sim projection seam

The single source of truth for every facility type the player can build, and the
contract that turns placed facilities into economy-sim input (or, for a non-economy
facility like the `shipyard`, into a **capability** the rest of the game queries).
Adding a facility is **one `FacilityDef` object plus one literal in the
`FacilityType` union** — its save-key, UI label, display color (the sidebar +
on-body icon swatch, via `facilityColor`), Add-button order, build cap,
body-eligibility predicate, economic projection, any capability flags (e.g.
`enablesShipbuilding`, read via `facilityHasShipbuilding` to gate the Build-ship
action), and **the action-menu commands it grants** (`grants` — read by
`src/actions/bodies-to-actors` to derive a body's menu; a military / service
facility grants commands but contributes nothing to the sim) all flow from that
one edit.

> This file describes the **shipped** package; roadmap / cross-system status lives
> in [docs/game-systems.md](../../docs/game-systems.md).

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
 Body kind ──────────┼─▶ (eligibility gate only)     │
                     └─────────────────────────────┘
```

The architectural through-line: in the sim a **planet is the node and facilities
are its contributors**, read uniformly with no facility-type branch. So here a
**body is the node and each facility is a contributor** — a body's facilities'
contributions are **summed** into one `PlanetSpec`, and the kernel never sees
facility identity. A facility's contribution is **flat** — the same on every body;
no body physics scales it. The only thing a body's data gates is *eligibility*
(the structural `kind` check), never the economic output.

## Module layout (acyclic — leaves first)

| Module | Role |
|---|---|
| `types.ts` | `FacilityDef` (incl. `grants?` — the action-menu commands a facility provides, a type-only import of the `src/actions/` vocab), `FacilityType` (the frozen save union), `Contribution`, `ProjectionCtx`, `PlacedFacility`, and the `ContributionBuilder` / `emptyContribution` helpers. No sim, no DOM. |
| `tuning.ts` | Hoisted economic tunables (per-facility **flat** rates). Symbol-named — referenced by name, never by value. |
| `resource-vocab.ts` | `EconResource` (const-object + derived union) — the resource ids. **Sim-free** (a plain const), so importing the vocabulary never drags the sim. |
| `resource-table.ts` | `appResourceTable()` — the sim-built `ResourceTable` *instance* (rows must match the `EconResource` ordinals; `makeResourceTable` asserts it). The sim owns the table *type* + constructor, the app owns the instance. The one vocab-side module that **imports the sim**. |
| `registry.ts` | `FACILITY_DEFS` (each def declares its action `grants` **inline** — a type-only import of the `src/actions/` vocab + the accent palette) + derived lookups (`FACILITY_BY_TYPE`, `FACILITY_TYPES`, `ADD_ORDER`, `facilityLabel`), `FROZEN_FACILITY_IDS`, and a DEV module-load invariant. **Sim-free** — `contribute()` needs only the `EconResource` ids, not the table — so the action adapter that reads a body's grants stays sim-free too. |
| `eligibility.ts` | `addableTypesFor(body, current)` — which Add buttons a body shows, gated by predicate **and** build cap; plus `facilityHasShipbuilding(current)` — the registry-driven gate (the `enablesShipbuilding` flag) for the Build-ship action. |
| `project.ts` | `projectBody` / `projectWorld` — THE projection adapter (body intent → `PlanetSpec`). Sim-importing, node-pure (catalog is type-only). |
| `sim-geometry.ts` | `buildGeometry` — catalog coords → the sim's integer geometry (the float→int round for transport — `Math.round`, for symmetric error). Sim-importing, node-pure. |
| `world-sync.ts` | `transplantLiveState` / `sameBodyIds` — the reconcile mechanics that preserve stock across a facility edit. Sim-importing, node-pure. |
| `speculation.ts` | `cloneWorldForSpeculation` — deep-clone the live world via the save round-trip and step it once: the throwaway next-turn world that drives the predictive viz. Sim-importing, node-pure. |
| `flow-class.ts` | `classifyFlow` — pure within / from / to / through classification of one in-flight **ring** transfer relative to the viewed cluster (the 2×2 of src/dst-in-cluster, plus the relay-through case); `buildShipLanes` applies it per ring transfer, while internal lanes come from `localTransfers`. No sim, no DOM — unit-tested without a world. |
| `economy-read.ts` | `buildShipLanes` (the system-view cargo-overlay assembly: ring → outgoing/incoming/through, intra-cluster `localTransfers` → internal) + the M3 inbound fold (`intraInboundByResource` / `foldInboundNextTurn`). The bridge's pure read-back derivations, extracted so they unit-test on a hand-built world. Sim-importing, node-pure. |
| `economy-log.ts` | The DEV per-turn console digest: `captureArrivals` (pre-step ring scan for deliveries landing this turn), `intraArrivals` (the instant intra-cluster moves), and `buildTurnLog` (formats each body's realized production / consumption with the % of capacity·demand it ran at, plus every arrival's source → destination). Sim-importing, node-pure; the bridge calls it from `step()` behind `import.meta.env.DEV`. |
| `base64.ts` | `base64FromBytes` / `bytesFromBase64` — the byte↔base64 codec for the persisted sim-save blob. No sim, no DOM. |
| `economy-bridge.ts` | `EconomyBridge` — the live engine owner: build/restore/reconcile the world, step, persist (`helio.sim`), read back. The **app-glue** module: imports the sim AND the catalog (`BODIES`/`STAR_CLUSTERS`) + `localStorage`, so it is NOT node-testable (its pure parts live in the modules above). |
| `index.ts` | Public barrel. |

The sim is imported only from `project.ts`, `resource-table.ts`, `sim-geometry.ts`,
`world-sync.ts`, `speculation.ts`, `economy-read.ts`, `economy-log.ts`, and
`economy-bridge.ts` — all under this package, the one quarter the boundary guard
permits. The `registry` and `resource-vocab` are deliberately OUT of that set: the
facility defs (incl. their inline action `grants`) and the resource-id vocabulary stay
sim-free, so `src/actions/bodies-to-actors` can read a body's grants off `FACILITY_BY_TYPE`
without crossing the wall.

Dependency direction: `project → registry → {resource-vocab, types, tuning, ../actions/tuning}`;
`appResourceTable` (the sim-built instance) lives apart in `resource-table → resource-vocab`.
Every module except `economy-bridge.ts` imports `Body` from
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

Providers are demand-pull **faucets**: a `*_PRODUCE_MILLI` is a per-turn rating
the sim mints on pull, not a stockpile, so v1 facilities set **no**
`storageCeiling` (the `cap()` builder + `combineCeiling` stay as a future
warehouse/depot lever — a real larder cap — but no producer uses them today, and
the sim does not read the column as a production gate).

`projectWorld` allocates dense `PlanetId`s in the order of the `bodies` it's
given and returns the `bodyIdByPlanet[]` side-table the flow visualization
resolves edges through. It **preserves** the caller's order rather than imposing
it — so callers **must** pass `BODIES` in canonical order (never a Map-derived
array), or the sim's seeded PRNG / replay would diverge.

### Cold start vs live edit

The projector is pure and used two ways. At cold start `projectWorld` builds the
full `PlanetSpec[]`. A mid-game facility edit must NOT reset the economy, so
`economy-bridge.ts` re-projects into a fresh world and then **transplants the live
state** across by `Body.id` (`world-sync.ts`): the stock + smoothing/hysteresis
accumulators carry so rates update while the larder survives, **and in-flight
cargo carries through the edit too** — the transfer ring + route table remap by
`Body.id` (routes key on clusters, stable across edits), and cargo whose
destination body the edit removed lands as stock on a same-cluster holding planet
(mirroring `arrivals.reroute`), so conservation stays exact rather than the cargo
vanishing. A plain reload instead adopts the persisted world untouched (full
fidelity, in-flight cargo kept) when the facility set is unchanged.

### Ownership gate

The bridge's facility fan-in skips any body whose `ownerFactionId` (`game-state.ts`) isn't the
controlled faction: an enemy-held body's facilities never enter the player's projected economy. A
body with no ownership record defaults to player-owned, so this is a no-op until a body is flipped;
and because the gate runs at build/reconcile time (not per step), an ownership flip must go through
`syncFacilities` to take effect.

## Status

- **Shipped:** the registry + both seams, and the live engine bridge.
  `economy-bridge.ts` instantiates a real `EconomyEngine`, steps it on Next Turn,
  reconciles it after a facility edit (by `Body.id`, preserving stock), persists
  its full state to `localStorage` (`helio.sim`, `configHash`-guarded), and reads
  per-body / per-system balances back into the sidebar — plus the cargo lanes
  touching a cluster (`clusterFlows` live / `predictedClusterFlows` forecast →
  `ShipLane[]`) that drive the system-view ship-dot overlay. The lanes are assembled
  by `economy-read.ts` (`buildShipLanes`): **internal** (body→body) lanes come from
  the engine's `getLocalTransfers` (the instant intra-cluster reallocation, never
  ringed), while outgoing/incoming/through come from the transfer ring, classified by
  `flow-class.ts`. Eligibility, build caps, and the body-derived Add pills are live.
- **Speculative next-turn preview:** the bridge keeps a second, private,
  throwaway engine alongside `this.engine` — a clone of the live world stepped one
  turn ahead (`speculation.ts`), recomputed only on real-world change (ctor /
  syncFacilities / step) and never persisted. The system-view ship overlay draws
  *its* lanes (`predictedClusterFlows`), so a new provider's cargo appears the
  instant it's built and the stream never blanks across an edit (the speculative
  world re-dispatches every recompute); the sidebars read its digest for the
  forward-looking `++ inbound next turn` cue (`predictedCoverMilli` /
  `inboundNextTurnMilli` / `predictedNetMilli`, additive on the existing DTOs).
  The step logic is reused verbatim on a copy — same computation as the real Next
  Turn, run early.
- **Transport model:** a geometry node is a **cluster** — one system with a
  shared pool of bodies (`sim-geometry.ts` builds one node per cluster at its
  centre of mass; `clusterNodeOfBody` resolves a body to it). All bodies in a
  cluster trade freely **and instantly** — an intra-cluster move is delivered the
  same turn (0 turns of transit, never aloft; the sim's `dispatch` deposits a
  same-node order straight into the destination), so at a resting turn boundary no
  same-system cargo is in flight. Only crossing between clusters costs jump range
  and shows ships in transit. The sim's `system === node`, so a sim "system" is
  exactly one of our clusters.
- **Provisional:** the `contribute` rates and the `EconResource` roster — both
  app-internal and never serialized into `helio.game`, so freely re-mappable.
- **Deferred:** build cost / time, ownership, depot nodes, and the galaxy-view
  (3D) edge-flow overlay (the `digest.edgeFlows` read surface is ready; the 3D
  line layer is not built — distinct from the shipped system-view ship-dot overlay,
  which rides the speculative next-turn transfer ring, not the read digest).

## Invariants & how they're enforced

- **Sim wall:** only `src/facilities/` imports the sim.
  `scripts/check-sim-boundary.mjs` (run by `npm run check`) fails the build on any
  other importer, and on any `sim/src` import that reaches back into the app.
- **Frozen save keys:** `FROZEN_FACILITY_IDS` is the localStorage contract; a
  test asserts the live key set is a superset, so renaming/removing a *shipped*
  id fails CI. A retired type stays as a `retired: true` tombstone def.
- **Determinism:** the seam is integer-milli throughout. Facility contributions are
  flat integer constants (no float scaling), so the only float→int crossing left is
  the geometry round (`Math.round`) in `sim-geometry.ts` for symmetric coordinate
  error. `projectBody` itself only adds/combines integers.

Tests: `npm run test:facilities` (`src/facilities/test/`). Source is type-checked
by the app's `npm run typecheck`; the test files run under `node --test`
type-stripping (so `import type { Body }` is erased and the catalog never loads).
