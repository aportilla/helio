# scripts/ — star catalog tooling

Scripts for seeding, repairing, and extending the per-bracket CSVs in `src/data/`, plus the procgen pipeline that builds `src/data/catalog.generated.json`. ESM scripts run with `node scripts/<name>.mjs`. The build pipeline (`build-catalog.mjs`) and validation helpers (`check.mjs`, `audit-procgen.mjs`, `inspect-body.mjs`, `inspect-csv.mjs`) have npm aliases — everything else is invoked directly.

## Build pipeline architecture

### Catalog build pipeline

`src/data/*.csv` is the authoring surface — hand-edited, scraper-output, the source of truth. The runtime sees a precomputed JSON snapshot produced by `scripts/build-catalog.mjs`:

```
CSV (×7 stars + bodies.csv) ──► build-catalog.mjs ──► catalog.generated.json ──► stars.ts ──► consumers
                                (Node, no deps)        (gitignored)              (typed re-export)
```

The build script runs the full derivation pipeline that used to live in `src/data/stars.ts` at module load — CSV parsing, spectral-class normalization (with a derivation fallback when the class cell is blank: invert mass→class, else read class off absolute/apparent magnitude, so a row carrying measured physics but no observed type is recovered rather than dropped — `resolveSpectralClass` in `astrophysics.mjs`), mass priority chain (catalog value → mass-luminosity from V-mag → position-seeded jitter), radius-from-class-mass, pxSize mapping, hierarchical multi-star ring placement, cluster union-find + COM. It also parses `bodies.csv` (planets + moons + belts + rings), validates enums (`kind`, `source`, `surface_liquid_species`, `subsurface_ocean_species`; `biosphere_archetype` and `biosphere_complexity` are enum-validated downstream in the Filler since their `n/a`-vs-authored-vs-blank handling drives different paths), and joins each body to its host: planets and belts to a `Star.id`, moons and rings to another `Body.id` (which must be `kind=planet` — no sub-moons, no nested rings; rings are capped at one per planet). Sorted child-index lists land on `Star.planets[]`, `Star.belts[]`, and `Body.moons[]`, all ordered by semi-major axis; the per-planet ring (if any) sits on `Body.ring` as a singular index. A star row survives only if it yields both a position (numeric distance/RA/Dec) and a class; the genuinely unrecoverable (no class and nothing to infer one from) are reported as one categorized line, and `scripts/lint-star-csv.mjs` keeps them out of the CSVs in the first place. Bodies whose host doesn't survive are then warned-and-dropped rather than failing the build. Procgen then runs (see the next section), after which an emit-shape assertion (`assertBodyShape`) checks every emitted body's own-key set against the canonical `Body` shape — with per-kind omissions for the narrower belt/ring records — so a `makeBody` / `fillBody` / `BODY_*_FIELDS` lockstep drift fails the build loudly instead of shipping a malformed `Body`. The script writes a single JSON object `{ stars, clusters, bodies }` to `src/data/catalog.generated.json`. The runtime `stars.ts` is now a thin wrapper: imports the JSON, casts it to `readonly Star[]` / `readonly StarCluster[]` / `readonly Body[]`, builds the cluster k-d tree, and re-exports. In DEV builds the cast is followed by a fail-soft invariant pass that `console.warn`s on any `cls` outside `SpectralClass`, an out-of-range cluster/body index join, or a `kind`↔host discriminant mismatch the bare `as` cast would otherwise admit (mirrors `font-provider.ts`'s drift check; tree-shaken from production).

### Body procgen pipeline

The catalog gives us a hand-anchored core (catalog exoplanets + hand-seeded Sol). For a 4X game every star needs to be explorable, so the build runs procgen on top of the catalog before emitting the JSON, deterministic across builds.

Four layers, run in order. The detailed mechanics live in each file's module header — read those when working on a specific layer. This README only sketches the high-level shape and how the layers compose.

- **Architect** (`scripts/lib/procgen-architect.mjs`) — top-down system generation for stars with no catalog planets. Mass falls out of disk physics (Σ → M_iso → core × accretion × maybe-envelope → Otegi radius), orbits walk outward through period-ratio spacing, then `migratePass` may pull the innermost gas giant inward via a two-mode mixture (hot Jupiter vs stalled warm Jupiter). Moons via binomial sampling, rings via R² Roche cross-section, belts via per-context per-class rolls anchored to shepherding giants. See the module header for the per-stage chain.
- **Partial-system overlay** (`generateOverlay`) — for catalog-anchored stars (≥1 catalog planet, non-curated), samples the target planet count under `PLANET_COUNT_BY_CLASS` and walks outward from the outermost catalog orbit, adding procgen siblings via the same `buildPlanetCore` chain under a different salt prefix. Outer-only matches the RV/transit short-period detection bias. Also fires belt rolls that zero-catalog stars get for free. No migration on the overlay path — catalog anchors fix observed positions. Curated systems (Sol) are exempt.

  Both `generateSystem` and `generateOverlay` dispatch per-cluster, so two cluster-aware clamps fold into the sampled planet count: `COMPANION_PLANET_SUPPRESSION` scales secondaries / tertiaries down (binary-stability proxy via rank-in-cluster), and `MAX_PLANETS_PER_CLUSTER` caps the cluster total (since gameplay reads a cluster as one system). Catalog anchors are immovable — they reserve budget but are never pruned, so a cluster whose catalog total already exceeds the cap leaves companions with a zero procgen quota rather than dropping observed planets.
- **Moon + ring backfill** (in `scripts/build-catalog.mjs`) — for each catalog planet that arrived without moons / a ring in the CSV, calls the Architect's `generateMoons` / `generateRing` directly. Closes the "observed exoplanets almost never carry moon or ring coverage" detection-bias gap. Curated systems are exempt via `CURATED_SYSTEM_HOSTS` (Sol today) — their CSV silence is "really none," not "we don't know."
- **Filler** (`scripts/lib/procgen.mjs`, `fillBody`) — bottom-up derivation of every remaining `_unknowns` field, in dependency order. See the `procgen.mjs` module header for the per-pass list and the priors file for each pass's tuning surface. Notable choices: pre/post-atm biotic-productivity split (the carbon-aqueous productivity drives biotic O₂ lift in the atm step before the four post-atm archetypes run); surface liquid is multi-solvent — `salinity` settles pre-temp, then the temp/cover pass picks the dominant standing liquid across water / hydrocarbon / ammonia / nitrogen / sulfur (per `SOLVENT_PHASE`) and writes `surfaceLiquidFraction` + `surfaceLiquidSpecies`, with `subsurfaceOceanSpecies` for buried ice-shell oceans. Two further surface reads are derived purely for the label substrate (no CSV column, never fed back into physics): `surfaceFrostSpecies` — the dominant solid-volatile veneer a cold dry surface wears, drawn among the exotic volatiles (N₂/CH₄/CO₂/NH₃) the body is cold enough to freeze and genuinely holds, weighted by atmospheric abundance × a volatility cold-trap bias (`SURFACE_FROST`), with water as the bedrock floor — so a frozen world's label splits on the real frost (and a co-present N₂+CH₄ world can read either, the Triton-vs-Eris split) rather than guessing it or collapsing every cold world to nitrogen; and `carbonWorld` — a system-level flag (seeded off the host star, since the disk C/O ratio is shared) marking a dry rocky body in a carbon-rich (C/O>1) disk as a graphite/tar surface. A body's **type is not stored, and is never collapsed to one** — there is no `worldClass` field and no single classifier. Each consumer reads the physical axes it needs through the pure, non-exclusive predicates in `lib/body-traits.mjs` (`isGlacial`, `isIron`, `isGaian`, …): the label composes a multi-axis chip, the info card gates surface vs gaseous, procgen keys its gaseous gate, and the audits bucket distributions. A world that is both iron-rich and icy answers true to both predicates — no first-match precedence hides an axis.

**Priors live as data, not code.** `scripts/lib/procgen-priors.mjs` exports the entire tuning surface as plain JS objects — per-class planet counts, orbital geometry, four-zone bulk-composition specs, disk-physics constants (MMSN normalization, snow-line boosts, accretion efficiency, envelope ratio, disk-gas lifetime), migration mixture, moon binomial parameters, ring + belt occurrence, surface-cover thresholds, multi-solvent phase windows (`SOLVENT_PHASE`) + salinity + subsurface-ocean gates, atmosphere regimes, condensation rows (incl. the hot-giant IRON / TIO condensates), the giant intrinsic-heat model (`GIANT_INTRINSIC_HEAT`), biotic productivity factors, and the layered resource model (occurrence weights, scarcity tiers, pair affinity, motherlode + hostility shaping, deposit count, belt/ring differentiation — see "Resources as deposits" below). The "tune to taste" loop is editing values there and re-running `npm run build:catalog`. Values are anchored against published Kepler/TESS occurrence rates where available; comments call out the calibration source.

**Realistic vs. tune split.** Tables that have both a physics-anchored shape and a gameplay-driven override are kept as two distinct exports — `*_REALISTIC` carries the published-occurrence-rate baseline, `*_TUNE` carries the gameplay overlay, and `mergeTunes` produces the consumed export. `PLANET_COUNT_BY_CLASS` is the canonical example: the realistic block matches the Kepler-anchored distributions, the tune clamps `max` on the classes that would otherwise run past `MAX_PLANETS_PER_CLUSTER`. Separation keeps the science legible (and re-derivable) while making gameplay tunes obvious in diffs.

**Resources as deposits.** A body's six-field resource grid records its *notable mineral deposits*, not bulk composition. Planets and moons (`resourcesFor` in the Filler) and belts (the Architect's belt pass) each **draw two** resource types from a context-weighted occurrence table — `RESOURCE_OCCURRENCE` and `BELT_RESOURCE_OCCURRENCE` — via the shared `drawWeightedDeposits` (`prng.mjs`), rolling a context-scaled abundance per deposit and leaving the other fields at 0. **Rings draw one** (a ring is a single smeared disrupted body, not a field of distinct deposits — `RING_RESOURCE_*` weights + `RING_ABUNDANCE`). Drawing (rather than deriving six abundances from bulk physics) is what lets any resource pair co-occur and any resource define a world; per-resource base weights × context-axis multipliers (hot/cold, gaseous, tidal moon, host metallicity, …) re-express the physics as odds. Because the grid is deposits and not bulk, biosphere *substrate* reads (silicate/sulfur life) consult bulk composition via `bulkSilicate10` rather than the deposit grid — silicate rock is ubiquitous whether or not a world rolled a silicate deposit.

The draw is shaped by composable, hoisted-as-data schemes (all in `procgen-priors.mjs`). All are **probabilistic** — they tilt odds, never gate, so any resource pair stays reachable — and all key off body / host-star *type*, never galaxy position (stars drift). `scripts/audit-procgen.mjs` guards each with a hard invariant (the `R`-series) so a knob retune can't silently collapse one:

- **Star-type identity** (`RESOURCE_BIAS_BY_CLASS`) — host spectral class tilts a system's character (M-dwarfs → volatile/icy frontier; metal-rich F/G/A → strategic-richer; white dwarfs → processed/exotic), so the galaxy-view star color reads as an economic signal.
- **Scarcity tiers** (`RESOURCE_TIER` + the tune base weights) — bulk (metals / silicates / volatiles, ubiquitous bread-and-butter) vs strategic (rare-earths / radioactives, scarce bottlenecks) vs exotic (the rare defining jackpot).
- **Bimodal abundance** (`RESOURCE_OCCURRENCE.abundance`) — most deposits trace-to-modest, with a rare high-grade *motherlode* tail that makes a world a landmark.
- **Pair affinity** (`RESOURCE_PAIR_AFFINITY`) — a conditional second-draw multiplier clusters synergistic resources (metal / heavy-element "high-tech keystone" worlds) and keeps the exotics jackpot lonely (a specialist outpost, not a do-everything hub).
- **Value-by-hostility** (`MOTHERLODE_HOSTILITY`) — motherlode odds scale up on hard-to-exploit worlds (hot / gaseous / young), so the richest lodes need tech to reach.
- **Keystone worlds** (`DEPOSIT_COUNT_DIST`) — a small minority carry three or four deposits: natural capital-site candidates.
- **Differentiation** (`BELT_DIFFERENTIATION`, `RING_DIFFERENTIATION`) — grounded in asteroid taxonomy: concentrated heavies require a parent body large enough to have melted and separated a metal core. A belt with a Vesta/Ceres-class largest body can roll an M-type metal/strategic character; a ring from a tidally-disrupted large differentiated moon (rare, host-mass-gated) is the *only* ring that carries rare-earths/radioactives — pristine ice/rock rings carry none, the physically-correct default.

Belt weights stay context-characterful (warm → metals, cold → volatiles); the planet tier tune keeps bulk common while strategics stay scarce.

**Shared physics.** `scripts/lib/astrophysics.mjs` carries the `luminositySun(M)` and `insolation(M, a)` approximations both layers consume, so the Architect's insolation-zone choice agrees with what the Filler reads when settling surface state. Piecewise mass-luminosity: `0.23 × M^2.3` below 0.43 M☉, `M^4` above — empirically calibrated against Proxima Cen.

**Determinism.** Each procgen value uses a per-(body, field, version) seed via `mulberry32(hash32(body.id + ':' + field + ':' + PROCGEN_VERSION))` (the PRNG helpers live in `scripts/lib/prng.mjs`). Two consecutive builds produce byte-identical output. Bumping `PROCGEN_VERSION` in `procgen-priors.mjs` reseeds the entire galaxy without touching CSV ids. Per-generator suffixes can be layered on top by individual rules that want to be re-rollable independently.

**Bias model.** The catalog is treated as dramatically incomplete for every star. Three procgen passes close the gaps against an unobserved-detection-bias model: the overlay adds outer planets RV/transit couldn't surface, the moon and ring backfill synthesizes per-planet satellites detection methods don't reach, and the overlay also rolls system-level belts so a catalog-anchored star isn't structurally barren next to its zero-catalog neighbor. Curated systems (Sol) bypass every backfill — their CSV silence is "really none," not "we don't know."

**Empty-system invariant.** A 4X game with thousands of "click to confirm nothing" stars feels barren, so after the architect + overlay passes run, `generateFloorBelt` (in `procgen-architect.mjs`) emits one trace cold debris belt for any non-curated star that ended up with both zero planets and zero belts. Physical framing: planet formation rarely sweeps a disc clean down to vacuum — a trace residual band of cold dust + km-scale parent bodies is the default end-state of every protoplanetary disc that doesn't get aggressively cleared. Mass is sampled in the lower half of the cold placement range and the parent-body scale is pinned to the dust-cascade `freeFloat` band, so the floor reads as "ancient trace debris" rather than competing with shepherded belts as a strategic mining target.

**Cell semantics.** Three states travel from CSV to JSON: empty (procgen target — Filler fills if anchors support it), `n/a` (not applicable — gas giants have no `ice_fraction`, airless worlds have no atmosphere composition), value (canonical, untouched). Empty and `n/a` both serialize as `null` at runtime; the distinction lives only in build time via a temporary `_unknowns` marker that `parseCsvBodies` attaches to each body, the Filler reads, and `fillBody` strips before emit.

**Why precompute.** The CSVs and parser ship to the browser today; precomputing replaces ~250 KB of CSV text + 200 lines of parser logic with a single derived JSON blob. The architectural payoff is bigger than the bytes: derivation logic stays in one Node-runnable file (no `?raw` imports, no `import.meta.env?.DEV` guards, no need for a Vite-aware test harness if we want to verify a derived value). The CSV is for authoring; the JSON is for runtime; they're connected by an explicit `npm run build:catalog` step.

**Why JSON, not TS.** No new dependencies (the build script is plain Node, no TS loader needed), Vite imports JSON natively, the artifact is debuggable in any editor. A TS module would have given autocomplete in the generated file itself, but nothing reads the generated file by hand.

**How it runs.** `predev` / `prebuild` / `pretypecheck` npm hooks fire `build:catalog` automatically before the corresponding command, so a fresh `npm ci && npm run dev` works without any explicit step. The same chain runs on CI for GitHub Pages (`npm run build` → `prebuild` → catalog → `tsc && vite build`). The generated JSON is gitignored; the CSV diff is the durable history of what changed.

**No hot-reload on CSV edits.** A CSV edit during a dev session doesn't propagate until you re-run `npm run build:catalog` (Vite then HMRs on the regenerated JSON). Accepted tradeoff for keeping the pipeline simple — there's no watcher.

**Pair-scan cost.** The KDTree-backed pair scans in `expandCoincidentSets` and `buildClusters` become brute-force O(n²) at build time (~1.1M ops on a 1500-star catalog, sub-millisecond). Avoids duplicating `kdtree.ts` into a Node-runnable `.mjs`. The k-d tree still exists at runtime, but only over `STAR_CLUSTERS` for per-frame `nearestClusterIdxTo` queries.

### Multi-star system layout (post-processing)

Wikipedia gives every member of a binary/triple system the same RA/Dec because real inter-member separations (10–1000 AU) are far below the resolution of the table's coordinates. After the equatorial-to-galactic conversion those members all land at the same 3D point. `expandCoincidentSets` in `scripts/build-catalog.mjs` detects 2+ stars at effectively-identical positions and rings them out across **two concentric rings keyed off the IAU component letter encoded in each row's `id` slug** — top-level letters (A, B, C, …) on an outer ring at `R_OUTER = 0.05` ly; sub-components (Aa/Ab; Ba/Bb) on a tighter inner ring at `R_INNER = 0.015` ly centered on the parent's outer slot. So Capella's Aa+Ab spectroscopic binary reads as a tight pair while H and L sit out on the outer ring, instead of all four landing at equal radii on one ring. The component letter is parsed from `id` rather than the colloquial `name` because `name` is presentational and often elides the letter ("Toliman", "Fomalhaut"); `id` is the canonical IAU-anchored slug, set up by `sync-with-catalog.mjs` to always carry the component as the trailing suffix. Both rings share one plane normal + start angle seeded per-system from the primary's id (FNV-1a → mulberry32), so each system gets its own tilt and renders identically across reloads.

Bare-slug primaries (e.g. `ab-doradus` with siblings `-ba`, `-bb`, `-c`) parse as implicit `[a]` — the bare row becomes the system's A component without needing a redundant `-a` suffix in the CSV. If any member's id suffix doesn't parse as a 1–2 lowercase-letter component (something malformed slipped through, a hand-edit broke the convention), the whole set falls back to the legacy single-ring distribution rather than producing a half-hierarchical placement.

Hierarchical systems where one component sits notably further out (Alpha Centauri's Proxima at ~0.21 ly from AB, 40 Eridani's BC sub-pair at sub-AU separations from A, etc.) read correctly without further intervention because Wikipedia gives each component its own RA/Dec where the separation is large enough to matter — Proxima ends up ~0.19 ly from the AB pair in our galactic Cartesian space, well within the cluster threshold but visibly offset.

**Known limitation:** the IAU letter convention doesn't always encode gravitational binding. Alpha Cen A/B/C parses as three equal top-level slots, but in reality AB is a tight pair and C (Proxima) is far — the catalog gives Proxima its own RA/Dec so this case is already handled outside `expandCoincidentSets`. Capella's H and L are likewise placed as independent outer-ring slots, though they're believed to be a bound pair. A future `parent_id` CSV override column would let these cases be hand-curated; deferred until the visual loss feels worth the schema churn.

## Source-of-truth policy

The CSVs in `src/data/` are **canonical**. Hand-edits are welcome and survive script runs.

- The Wikipedia scraper refuses to overwrite an existing CSV without `--force=1`.
- The stellarcatalog filler **only fills empty cells** — it never overwrites a populated one.
- When upstream Wikipedia data is wrong or incomplete, fix it in the CSV by hand. The CSV wins.

If a CSV gets corrupted (e.g. by a scraper bug), the recovery path is to clear the affected fields, then re-run the filler — stellarcatalog acts as the canonical remote source for re-establishing broken records.

## Scripts at a glance

| Script | Purpose |
|---|---|
| `scrape-wiki-stars.mjs` | Initial-seed a CSV from a Wikipedia "List of star systems within X-Y light-years" table. |
| `find-missing-stars.mjs` | Compare a CSV against the local stellarcatalog listing; report (or `--add`) stars present in the catalog but absent from the CSV. |
| `fill-from-stellarcatalog.mjs` | For rows missing some field, fetch the star's stellarcatalog detail page and fill empty cells. Cached on disk. |
| `sync-with-catalog.mjs` | Sweep all CSVs against the catalog: assign each row a stable `id` (catalog slug) and rewrite `name` to the catalog's primary, with component-letter preservation and a hardcoded skip-list for known regressions. Default dry-run; `--apply` to write. |
| `expand-systems-from-catalog.mjs` | For every row whose `id` is a catalog primary slug ending in `-a`, fetch the primary's detail page, parse `<h2 class='title'>` blocks for sibling components, and (a) update existing sibling rows' ids to the canonical convention or (b) add missing sibling rows with the catalog-derived spectral class + mass + the primary's RA/Dec. Default dry-run; `--apply` to write. **Largely superseded by `import-system-from-catalog.mjs`** for new system additions; kept for incremental id-suffix migrations on existing data. |
| `import-system-from-catalog.mjs` | Take a primary catalog slug and rewrite all CSV rows for that system from the catalog's detail page. The catalog is the source of truth for everything: per-component display names, spectral_class, mass, V magnitudes from each `<h2 class='title'>` section; position fields (distance/RA/Dec/parallax) from the primary's section, inherited by all siblings (so the renderer's `expandCoincidentSets` rings them as one cluster). Hand-curated names (Toliman, Guniibuu) and existing field values are preserved when the catalog is silent or wrong. Default dry-run; `--apply` to write. |
| `audit-unresolved.mjs` | Read-only report. Categorize every row whose id isn't a literal catalog slug as OVERLAP / NEAR / DISTINCT based on 3D distance to the nearest catalog-matched row. Useful for spotting truly orphaned rows after sync + expand. |
| `lint-star-csv.mjs` | Flag every star-CSV row the build can't use — no numeric position, or no spectral class and no mass/magnitude to infer one (the same `resolveSpectralClass` predicate `build-catalog.mjs` runs). Exit 1 if any. `--prune` rewrites the CSVs with those rows removed. Run after scrape/fill/hand-edit; wired into `check.mjs`. |
| `lookup-star.mjs` | Resolve a star name (or distance range) to a stellarcatalog URL. Useful for ad-hoc poking. |
| `scrape-planets-from-stellarcatalog.mjs` | Read-only walk over the cached star detail pages; write `src/data/bodies.csv` with one row per exoplanet listed in each system-structure table (semi-major axis, mass M⊕, radius R⊕, period days). Resolves the host star from the planet's catalog name (so Proxima's planets land on `alpha-centauri-c`, not on Alpha Cen A's page slug). Default dry-run; `--apply` to write, `--force` to overwrite. |
| `lib/catalog-index.mjs` | Shared helpers: catalog HTML parsing, name normalization + variant generation, per-component section parsing for detail pages, CSV (de)serialization. Imported by the other scripts. |
| `lib/prng.mjs` | Shared seeded-RNG primitives: FNV-1a `hash32`, `mulberry32`, Box-Muller `sampleNormal`, truncated-normal `sampleTruncated`. Lifted into one module so the procgen Architect and Filler derive identical seeds from the same id strings and sample from the same distributions. |
| `lib/astrophysics.mjs` | Shared physical-relation approximations (`luminositySun(M)`, `insolation(M, a)`) used by both the procgen Architect and Filler. Piecewise mass-luminosity (M dwarfs vs FGK+). Also `resolveSpectralClass` — the build + lint's shared "class from the catalog string, else inferred from mass or magnitude" predicate. |
| `lib/procgen-priors.mjs` | Data file — the entire tuning surface for body procgen. Per-class planet counts, orbital geometry, insolation-zone weights, type multipliers, mass/radius specs, moon counts, belt occurrence + placement, ring occurrence + extent, and the layered resource model (occurrence weights, star-type bias, scarcity tiers, pair affinity, motherlode + hostility shaping, deposit count, belt/ring differentiation). No code, just exports. Edit + re-run `npm run build:catalog`. |
| `lib/procgen-architect.mjs` | System Architect — top-down procgen. For each star with zero catalog planets, samples a full planetary system (planets + moons + rings + belts) from the priors. Also exports `generateOverlay` (partial-system overlay — adds outer procgen siblings + system belts to catalog-anchored stars) and `generateMoons` / `generateRing` (per-planet backfill on catalog rows). |
| `audit-procgen.mjs` | Procgen distribution report **+ hard-gate invariants**. Reports observed planet count per stellar class, planet-type mix, ring rates by host type, moon counts by type, belt rates by stellar class, and the resource-model distributions (presence/tier, pair coverage, abundance + hostility, per-class lean, deposit count) — each with a z-score against its prior. Ends with structural invariants (`B`-series render/procgen defects, `R`-series resource-scheme guarantees) that **exit 1** on violation, so a bad prior tweak fails the build. Run after `npm run build:catalog`. Alias: `npm run audit:procgen`. |
| `check.mjs` | Validation umbrella for the iterative edit loop. Runs `lint-star-csv` → `build:catalog --strict` → `tsc --noEmit` → `audit-procgen` in sequence and fails fast on the first non-zero exit. Catches dead CSV rows, schema regressions, type errors, and out-of-envelope distribution shifts in one command. Alias: `npm run check`. |
| `inspect-body.mjs` | Pretty-print one body's post-procgen record from `catalog.generated.json` — host, orbital geometry, every firing `body-traits` predicate (the multi-axis trait list) / extent, atmosphere, biosphere, resources, derived icyness (belts + rings), moons + ring (planets). Suggests near-matches on typo. Alias: `npm run inspect:body <id>` (e.g. `inspect:body saturn-ring`). |
| `dump-labels.mjs` | Read-only. Dump every composed body label (planets + moons) across the whole galaxy by importing the *real* `composeWorldLabel` from `src/ui/system-hud/body-label.ts` (Node strips the types), so the printed text is identical to the BodyInfoCard's. Default prints an analytical summary — full label-frequency table, per-archetype label variety, word-frequency, and a collision spotlight (the most-repeated labels with example bodies + their physics). `--all` dumps every body grouped by archetype; `--examples=N` widens the spotlight; `--csv` emits one machine-readable row per body. Foundation for tuning the label vocabulary. |
| `inspect-csv.mjs` | Pretty-print one row from a CSV (`bodies.csv` by default; `--csv=<path>` overrides) with column names spelled out and the three CSV-side cell states distinguished — literal value, `(n/a)` (does-not-apply), `(empty — procgen)` (Filler target). Useful when authoring curated rows or verifying column alignment after a schema tweak. Alias: `npm run inspect:csv <id>`. |
| `lib/procgen.mjs` | Body Filler — bottom-up procgen. Walks empty cells in topological order: `radiusEarth` from a mass-radius relation, then surface state (`avgSurfaceTempK`, `surfacePressureBar`, surface-liquid cover/species), then `periodDays ↔ semiMajorAu` via Kepler's third law (bidirectional, so RV and transit discoveries both round-trip), then orbital flavor (eccentricity / inclination / axial tilt / orbital phase). Exports `radiusFromMass` for the moon-and-ring backfill pass to reuse. Imported by `build-catalog.mjs`. A body's *type* is neither stored nor collapsed to one — consumers read its physical axes through `lib/body-traits.mjs`'s pure predicates. Belts and rings bypass the Filler — their structural fields are baked at architect time, not derived from physics. |

The local stellarcatalog listing defaults to `~/Documents/catalog.html` (override with `--catalog=PATH` on any script that uses it). The cache for fetched detail pages lives at `.cache/stellarcatalog/` (gitignored).

## Validation workflow

After editing priors, the architect, the Filler, the runtime body schema, or `bodies.csv`:

```bash
npm run check               # lint-star-csv + build:catalog --strict + tsc --noEmit + audit-procgen
```

That's the universal "did I break anything" sweep. The audit step prints z-scores per (prior × observed) cell — anomalies are marked `*` when statistically significant, so an out-of-envelope distribution surfaces above sample noise.

When validating that a *specific* body landed the right values:

```bash
npm run inspect:body saturn-ring       # post-procgen record from catalog.generated.json
npm run inspect:csv  saturn-ring       # raw CSV row (literal / n/a / empty distinguished)
```

`inspect:body` reads the snapshot the runtime ships, so what's printed is what the renderer + info card see. `inspect:csv` reads the authoring source — use it to confirm column alignment after a schema tweak or to verify that a curated row hasn't drifted into stale enum values that the validator would reject.

## Common workflows

### Bootstrap a new distance bracket from the catalog

Best when the bracket is far enough out that Wikipedia's table is sparser than stellarcatalog's coverage (true from ~30 ly outward).

```bash
# 1. Empty CSV with the canonical header
echo "id,name,distance_ly,constellation,ra_deg,dec_deg,spectral_class,mass_msun,app_mag,abs_mag,parallax_mas" \
  > src/data/stars-40-45ly.csv

# 2. Append every catalog star in [40, 45] ly (range inferred from filename;
#    populates the id column from the catalog slug)
node scripts/find-missing-stars.mjs --csv=src/data/stars-40-45ly.csv --add

# 3. Fetch each detail page and fill RA/Dec, mass, magnitudes, etc.
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-40-45ly.csv --needs=any

# 4. Pull in sibling rows for any multi-star primaries the bootstrap added
node scripts/expand-systems-from-catalog.mjs --apply

# 5. Drop faint rows the catalog couldn't give a class or position (the build
#    would skip them anyway). Review the report, then prune.
node scripts/lint-star-csv.mjs
node scripts/lint-star-csv.mjs --prune

# 6. Wire into the build pipeline:
#    - add `'stars-40-45ly.csv'` to the `SOURCES` array in scripts/build-catalog.mjs
#    - run `npm run build:catalog` to regenerate src/data/catalog.generated.json
#      (stars.ts reads only that JSON snapshot — there is no per-CSV ?raw import)

# 7. Update README's project layout to mention the new file
```

### Bootstrap a new distance bracket from Wikipedia (closer brackets)

The 0-30 ly Wikipedia tables are well-curated and worth using as the seed. Two known table layouts are baked into the scraper as `--schema` profiles.

```bash
# 1. Scrape the upstream Wikipedia table
node scripts/scrape-wiki-stars.mjs \
  --page='List_of_star_systems_within_15–20_light-years' \
  --schema=20-25 \
  --out=src/data/stars-15-20ly.csv

# 2. Fill anything Wikipedia left blank
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-15-20ly.csv --needs=any

# 3. Sweep up catalog stars Wikipedia missed entirely
node scripts/find-missing-stars.mjs --csv=src/data/stars-15-20ly.csv --add
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-15-20ly.csv --needs=any

# 4. Pull in sibling rows for any multi-star primaries
node scripts/expand-systems-from-catalog.mjs --apply

# 5. Drop faint rows the catalog couldn't give a class or position
node scripts/lint-star-csv.mjs --prune

# 6. Wire into the build pipeline as above (add to SOURCES in
#    build-catalog.mjs, then `npm run build:catalog`)
```

The two known schemas are `--schema=nearest` (11-col, used by "List of nearest stars") and `--schema=20-25` (9-col, used by every "List of star systems within X-Y light-years" page). If a future Wikipedia page uses yet another column layout, add a profile to the `SCHEMAS` dict in `scrape-wiki-stars.mjs`.

### Find what's missing

```bash
# How many catalog stars in a CSV's distance bracket aren't in any of our CSVs?
node scripts/find-missing-stars.mjs --csv=src/data/stars-25-30ly.csv

# Override the auto-detected range
node scripts/find-missing-stars.mjs --csv=src/data/stars-25-30ly.csv --range=20,30
```

The matcher checks against names from **all** CSVs in `src/data/` (not just the targeted one), because catalog distances are rounded to 1 decimal and a star at 25.045 ly shows up as "25" — without cross-CSV matching every boundary star false-positives.

### Fill missing fields on rows we already have

```bash
# Default: rows missing RA/Dec
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-30-35ly.csv

# Other targeting
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-30-35ly.csv --needs=mass
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-30-35ly.csv --needs=any

# Faster throttle (default is 500ms between fresh fetches; cache hits are free)
node scripts/fill-from-stellarcatalog.mjs --csv=PATH --throttle=200

# See what would change without writing
node scripts/fill-from-stellarcatalog.mjs --csv=PATH --needs=any --dry-run
```

`--needs` accepts `radec`, `mass`, `class`, `app_mag`, `parallax`, `any`. In every mode the script fills *all* empty fillable cells once a page is fetched — `--needs=mass` will incidentally fill any missing RA/Dec on the same row. The flag controls only which rows trigger a lookup.

### Sync names + ids with the catalog

After any bracket changes (new bootstrap, hand-edits, reseeded data), run sync to canonicalize ids and align display names with the catalog's primary names.

```bash
# Dry-run across all CSVs in src/data/
node scripts/sync-with-catalog.mjs

# Apply
node scripts/sync-with-catalog.mjs --apply
```

The script:
- Adds the `id` column if missing (schema migration).
- Sets each row's id to the catalog slug (e.g. `fomalhaut-a`, `gliese-1`), with sibling components getting `<primary-stem>-<letter>` (e.g. `sirius-b`).
- Rewrites `name` to the catalog primary, preserving component letter when ours has one and the catalog primary doesn't.
- Honors a hardcoded `SKIP_RENAMES` set for known regressions (Barnard's Star, Luyten's Star, Keid, Achird, Alsafi, Guniibuu, Rigil Kentaurus, etc.) — these still get ids, just keep their display names. Add to that set in the script when a new regression is found.

### Expand multi-star systems

For each row whose `id` is a catalog primary slug, fetches the primary's detail page and uses the `<h2 class='title'>` sections as the source of truth for what siblings exist. Either updates an existing CSV row's id to the canonical convention, or appends a new sibling row populated with the catalog-derived spectral class + mass + the primary's RA/Dec.

```bash
node scripts/expand-systems-from-catalog.mjs            # dry-run
node scripts/expand-systems-from-catalog.mjs --apply
```

Run after sync, and any time you add new primaries to a CSV. The script handles three matching paths in priority order: (1) canonical id match, (2) name-variant overlap with letter-suffix equality, (3) RA/Dec proximity to the primary with letter-suffix equality. A small `KNOWN_COMPONENT_ALIASES` map covers IAU proper names like Toliman that don't carry a component letter at all.

### Audit unresolved rows

Read-only sanity check after sync + expand:

```bash
node scripts/audit-unresolved.mjs
```

Buckets every row whose id isn't a literal catalog slug into OVERLAP (within 0.05 ly of a catalog row — usually a constructed sibling id), NEAR (within 0.5 ly), or DISTINCT (further). DISTINCT is the watchlist: those rows have no nearby catalog primary at all, meaning the catalog genuinely lacks the entry.

### Repair a corrupted CSV

When a scraper bug or upstream edit produces wrong data:

```bash
# 1. Fix the underlying scraper bug if it was one
# 2. Re-scrape (the scraper refuses to overwrite without --force)
node scripts/scrape-wiki-stars.mjs --page=... --schema=... --out=src/data/stars-NN-MMly.csv --force=1

# 3. Re-run the catalog filler to repopulate (cache makes this instant)
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-NN-MMly.csv --needs=any

# 4. Optionally re-add stars Wikipedia missed
node scripts/find-missing-stars.mjs --csv=src/data/stars-NN-MMly.csv --add
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-NN-MMly.csv --needs=any

# 5. Drop any rows the catalog couldn't class or place
node scripts/lint-star-csv.mjs --prune
```

For partial repair (a few corrupt rows in an otherwise good CSV), hand-clear the bad cells and run `fill-from-stellarcatalog.mjs --needs=any` — only the empty cells get refilled.

When the corruption is upstream (the catalog has two slugs for the same physical star and one of them has wrong RA/Dec/distance — see `wise-2220-3628` vs `wise-j22205531-3628174` for the canonical example), add an entry to `STALE_SLUG_REDIRECTS` in `lib/catalog-index.mjs`. `loadCatalog` then drops the stale entry from the returned list and folds its primary + aliases into the canonical's alias list, so subsequent runs of every script land on the good entry.

### Ad-hoc lookups

```bash
# What's the catalog URL for these stars?
node scripts/lookup-star.mjs "Barnard's Star" "Rigil Kentaurus" "GJ 1227"

# Every catalog entry between 6 and 8 ly
node scripts/lookup-star.mjs --range=6,8

# Diff: which rows in a CSV are missing some field?
node scripts/lookup-star.mjs --csv=src/data/stars-25-30ly.csv --missing=class
```

### Bootstrap planet data

Separate data axis from the star CSVs: `src/data/bodies.csv` holds one row per planet (and later, per moon) with `host_id` joining back to a star id. The cached stellarcatalog star pages already carry a system-structure table with semi-major axis, mass (M⊕), radius (R⊕), and period (days), so the bootstrap doesn't fetch anything — it reads the cache.

```bash
# Dry-run: print every parsed planet with its resolved host and stats
node scripts/scrape-planets-from-stellarcatalog.mjs

# Write src/data/bodies.csv (refuses to overwrite without --force)
node scripts/scrape-planets-from-stellarcatalog.mjs --apply --force
```

Disks and belts are filtered out (they share the `exoplanet.php` link but use a different icon). Hosts are resolved from the planet's catalog name, not the cache filename, so a planet listed under Alpha Centauri A's page that actually orbits Proxima lands on `alpha-centauri-c`. Slug-derived candidates win over display-name lookup because the CSV carries duplicate display names ("Gliese 49" appears as the name of two different stars) but ids are unique.

Hand-curated rows (Sol's planets and moons, plus any further hand-additions) live in `bodies.csv` alongside the scraper output. **Re-running the scraper overwrites the whole file** — a merge story doesn't exist yet, so don't re-run --apply if you've hand-edited rows since the last scrape. Recovery is `git checkout` on the file. Procgen runs downstream (inside `build-catalog.mjs`, against the parsed CSV — not against `bodies.csv` directly) so it never touches the authoring surface; see `lib/procgen-priors.mjs` for the tuning knobs.

## Notes

- **Cache**: `fill-from-stellarcatalog.mjs` writes each fetched HTML page to `.cache/stellarcatalog/<slug>.html`. Subsequent runs against the same star are instant. Delete the cache to force re-fetch.
- **Throttle**: defaults to 500ms between live fetches. Cache hits don't sleep. Lower for impatience, raise to be polite to stellarcatalog.com.
- **Name matching**: the shared library generates name variants (case + diacritics + GJ↔Gliese ↔ Greek-letter spellings + possessive forms + trailing-component-letter). When a lookup fails, the matcher's variant set is the first place to look — see `variants()` in `lib/catalog-index.mjs`.
- **Catalog file**: defaults to `~/Documents/catalog.html` (a saved copy of stellarcatalog.com's "all stars" listing). All scripts that read it accept `--catalog=PATH`.
