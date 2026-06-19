# Economy sim (standalone)

The deterministic logistics simulation for **Helio** — the single-tier
discrete-transfer economy from `plans/4x-economy-plan-discrete-single-tier.md`.

It is built **standalone**: a self-contained TypeScript module with its own
`tsconfig.json`, no dependency on the Three.js/Vite browser build or the catalog
pipeline — the import wall is one-directional and CI-enforced
(`scripts/check-sim-boundary.mjs`). The app reaches it through `sim/src/index.ts`,
imported only from `src/facilities/` (see [its doc](../src/facilities/README.md)),
where `economy-bridge.ts` now instantiates and steps a live `EconomyEngine`. It is
also exercised by `sim/test` and that seam's tests.

## Running

Node 23.6+ runs the strict TypeScript directly (native type stripping), and the
built-in test runner needs **zero runtime dependencies** — only the dev-only
`@types/node` for typing the runner.

```
npm run test:sim         # node --test over sim/test/**/*.test.ts
npm run typecheck:sim    # tsc -p sim/tsconfig.json  (src + tests, strict)
node --test sim/test/quantify.test.ts   # one file
```

The standalone tsconfig enables `erasableSyntaxOnly` (so Node can strip types
with no codegen — no `enum`/parameter-properties), `verbatimModuleSyntax` (forces
`import type`), and `allowImportingTsExtensions` (imports carry the `.ts` suffix,
as Node's loader requires).

## Module map

```
src/
  ids.ts            Branded id types (PlanetId/StarId/ResourceId/EdgeId/Turn/…) + constructors
  math.ts           Integer-only isqrt / ceilDiv / clampInt (float-free results)
  prng.ts           xoshiro128** integer PRNG (4-word serializable state) — net-new for bit-stable replay
  constants.ts      MILLI_PER_UNIT + the BalanceConfig tuning surface + integer emaStep
  resources.ts      TransportTier (Transportable/LocalOnly/Intangible) + ResourceMeta table
  geometry.ts       Static integer star coordinates + exact distance
  topology.ts       Jump graph, stable star-pair EdgeIds, multi-leg Dijkstra, append-only route table
  transfer-ring.ts  TransferRing (timing-wheel single source of truth) + derived EtaBuckets ledger
  world.ts          The SoA world (planets as v1 node-contributors) + builder
  produce.ts        P3 consume + same-body self-feed (demand-pull faucet: no silo, export minted on pull at P7); P7.5 residual consume — eat same-turn intra-cluster arrivals
  quantify.ts       P4 single authority: netDemand/exportable (faucet capacity + resting)/signed cover, hysteresis, inbound-within-H
  shortfall.ts      ShortfallReason codes + SHORTFALL_FIX + shortfallName (the unmet-demand taxonomy)
  allocate.ts       P6 greedy matcher: fan-in, source fair-share, CFL clamp (on capacity), starvation escalation, resolves shortfall reasons
  dispatch.ts       P7 conservation chokepoint: realize-on-pull mint (Pass 0), then interstellar mint/merge + ledger reserve OR instant same-node deposit (0-turn intra-cluster) — emits localTransfers
  arrivals.ts       P2 arrivals-first: deliver / continue / re-route at each star
  read-surface.ts   §4 ReadDigest (signed cover + edge flows) + getInTransitTo / explainShortfall
  invariants.ts     Conservation (no loss), no-negative-stock, ledger==in-flight (per-turn DEV asserts)
  serialize.ts      Bit-stable serialize/deserialize (+ configHash guard); derived caches rebuilt on load
  engine.ts         EconomyEngine.step() wires the turn pipeline (arrivals → produce/consume → quantify → allocate → dispatch → residual consume → commit); read-only queries
  index.ts          Public barrel
```

## What's built (v1 core) vs deferred

Mapped to the plan's `v1 / deferred / deleted` banner.

**Built (the transport core, end-to-end):**
- One-tier flow records, count ⊥ quantity; durable cargo; exact-integer
  conservation with no loss terms (§3.1, §3.6).
- Multi-leg routing over the jump graph: `rankCandidates`/`routeBetween`, the
  inline route table (`routeRef`/`hopIndex`/`finalArrival`), advance-in-place at
  each star, stable `EdgeId`s, route-cache invalidation on rebuild (§3.7, §11.4).
- 0-turn intra-cluster transfers: a same-node (same-star) order is deposited
  straight into the destination the same turn — never minted into the ring — so
  intra-system surplus covers deficit instantly and nothing is aloft at a resting
  boundary, while inter-cluster hauls keep their multi-turn transit. Provably
  balance-equivalent to the old 1-turn self-leg (deposit replaces a mint+arrival);
  `step()` exposes the moves via `localDelivered` + `getLocalTransfers()`, the
  read surface's intra-node analogue of `edgeFlows`. The deposit happens at P7,
  after P3 consume, so a post-dispatch **residual consume** (P7.5) eats it the same
  turn — an import-fed body's fill % reflects the arrival the turn it lands, not the
  next. This shifts an already-conserved unit from stock to consumed within the same
  window (mints nothing, touches neither ring nor ledger), so conservation,
  determinism, and the save format are unchanged. It fixes same-turn *consumption*,
  not same-turn *demand re-sizing* (the order is still quantified against pre-arrival
  stock — true pooling stays deferred).
- Re-home at each star — the *necessary* case (destination gone / onward path
  removed) — via monotonic ids + tombstones (§3.7, §11.8).
- ETA-bucketed inbound ledger with horizon H + merge-on-dispatch dedup (§3.2, §3.5).
- Greedy priority matcher: source fair-share, fan-in split proportionally across
  equal-distance sources (nearer tie-groups drawn first), one CFL outflow clamp,
  hysteresis deadband, starvation escalation, the four single-cause shortfall
  reasons (§5).
- Demand-pull (make-to-order) production: a producer is a FAUCET, not a tank. P3
  mints only the same-body self-feed; the export surplus is realized at the P7
  dispatch chokepoint, sized by what the matcher pulled and capped at the per-turn
  rating. A producer with no consumer makes nothing — no silo, no glut. `quantify`
  offers per-turn capacity (`netProd + resting`) as supply; the CFL clamp throttles
  a fraction of that capacity (not resting stock). The read surface exposes realized
  production/consumption per turn — the integers behind the display utilization %
  (made ÷ capacity) and fill % (ate ÷ demand) shown per body.
- Node-contributor seam: the matcher reads per-planet emissions uniformly, no
  facility-type branch (§6.0).
- Sim → read-surface one-way wall + the integer `ReadDigest` (signed cover +
  realized production/consumption rates) and the `getInTransitTo` /
  `explainShortfall` drill-downs (§4).
- Same-machine bit-stable serialize/replay + the conservation/ledger/no-negative
  invariant harness, asserted every turn (§10, §11).

**Deferred (earned back by a measured signal, per the banner):** the trade
hub/depot facility types (the node-contributor seam is in place for them), the
price field (P5), multi-input recipes, regime/telemetry classification, the
perf-governor active-flow degrade ladder (v1 uses a fixed pool that throws on
exhaustion), the slow integrator / oscillation detector, and scoped routing
bias/restriction policy.

## Known v1 simplifications (surfaced by review, deferred deliberately)

- **Merge-on-dispatch is within-turn only.** The §9 persistent `mergeIndex` on
  the ring (for O(1) cross-turn dedup) is not built; the ETA ledger is the
  primary record-count bound and the within-turn merge is the backstop. Its key
  is aligned with the ledger/guard so it can't mis-merge.
- **No strict-sink boundary test yet (§11 rule 13).** That test perturbs a
  *consumer's* RNG/wall-clock and asserts byte-identical saves — it needs the
  consumer/AI layer, which is deferred (§4.3). The sim side (integer-only,
  read-surface excluded from the save) is upheld by construction today.

## Invariants the tests pin (§11)

- **Conservation** is an exact integer equality with no loss terms — asserted
  every turn (`conservation.test.ts`).
- **`Σ inboundReserved == Σ in-flight`** — the ring is authoritative, the ledger
  is its rebuildable cache.
- **Flow balance**: `Σdispatched − Σdelivered − Σrerouted == in-flight`.
- **Determinism**: same seed + inputs → byte-identical save; a reload steps
  identically (`serialize-replay.test.ts`).
- **Invariant A**: a *ring* (inter-cluster) transfer departing turn T arrives ≥ T+1;
  intra-cluster moves are exempt — they deposit same-turn, never entering the ring.
- **Reachability ≡ route existence** — never a stored flag.
