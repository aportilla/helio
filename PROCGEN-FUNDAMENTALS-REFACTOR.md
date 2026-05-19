# Procgen fundamentals refactor

Working plan for moving the body Filler from a class-keyed pipeline to a fundamentals-first pipeline. Driven by the 2026-05-19 audit that found ~1,100 small airless bodies rendering liquid oceans, and the broader observation that `worldClass` is doing two incompatible jobs.

Status: design intent. No code changes yet; this doc is the spec the implementation will hit.

---

## Motivation

### The symptomatic bug

The current Filler classifies any small terrestrial in the temperate zone as `rocky` (because `OCEAN_MIN_MASS_EARTH` gates the `ocean` class to mass ≥ Mars), then reads `WATER_FRACTION_BY_CLASS.rocky` — a distribution anchored on Earth (mean ≈ 0.55, max 0.85). The result: a 0.05 M⊕ moon at 280 K gets ~50% water-cell coverage, which the renderer paints as liquid ocean (gated only on `globalness < 0.5`, i.e. T > ~225 K — no pressure or mass check). Roughly:

- ~14% of all planets/moons render liquid oceans on sub-Mars-mass bodies with sub-millibar atmospheres.
- ~20% render surface ice on bodies too warm to retain it without an atmosphere.
- Curated Sol anchors are correct because their CSV cells override the procgen.

### The structural cause

`worldClass` is consumed two ways:
- As a **label** — drives UI colors, palette mode (`isBandedAtmosphere`), tooltip text.
- As a **causal input** — keys the priors for `surfacePressureBar`, `waterFraction`, `iceFraction`, `tectonicActivity`, `rotationPeriodHours`, `magneticFieldGauss`, `surfaceAge`, `atm1..3`, `chromophoreGas`, `biosphere*`, the six-resource grid, and `albedo`.

The label job is fine — humans need a one-word handle. The causal-input job is the bug factory, because a class enum collapses an enormous physical state space into seven rows. `rocky` covers Earth, Mars, Mercury, Luna, Callisto, and every catalog terrestrial smaller than a super-Earth; one prior table can't honestly describe all of them.

Adding more class rows (`rocky_small`, `wet_desert`, `frozen_rocky_with_thick_atm`) doubles down on the bug rather than fixing it. The fix is to derive the surface properties from physical fundamentals, and let `worldClass` emerge at the end as a pure label.

---

## Target architecture

### Pipeline shape

Today:

```
Architect:   stellar context → planet_type → mass, radius, moons, rings
Filler:      mass, radius, insolation → worldClass → {pressure, water, ice, atm, biosphere, resources}
```

Target:

```
Architect:   stellar context → planet_type → mass, radius, bulk composition, moons, rings
Filler:      mass, radius, insolation, bulk composition →
                {atm retention, surface P, surface T, water cover, ice cover, ...}
             → worldClass (label, derived last)
             → label-keyed dispatch for biosphere/atm species/chromophore/resources
```

Key shift: the surface scalars (`waterFraction`, `iceFraction`, `surfacePressureBar`) become **physical derivations**, not class lookups. `worldClass` is computed after them, from them — it's the human-readable label for the joint state, not a causal upstream.

### New primary attributes on `Body`

Promote these from transient seeds / implicit-in-class to stored physical attributes:

- `bulkWaterFraction` — fraction of body mass that is H₂O (and other volatiles in solid/liquid/gas form). 0 for a Mercury-class iron world; ~0.0002 for Earth; ~0.5 for Europa; ~0.1 for a Hycean world's water mantle. Sampled at Architect time from formation distance + stellar metallicity. Persists; doesn't get re-rolled. Today this is the transient `water_budget` seed inside `worldClassFor`.
- `bulkMetalFraction` — silicate-vs-metal partitioning by mass. Earth ~0.32 (iron core); Mercury ~0.70; coreless silicate worlds ~0.05. Drives mean density, drives `resMetals` / `resSilicates` priors directly.
- `formationZoneAu` (optional, may be transient) — semi-major axis the planet formed at, before any migration. Used by Architect to set the volatile/metal budgets; usually equals `semiMajorAu` but hot Jupiters can have formed far out and migrated in.

`waterFraction` and `iceFraction` keep their current names and meanings (fraction of *surface* covered by liquid water / surface ice) but become derived, not sampled.

`bulkWaterFraction` is the load-bearing addition. Mercury (0) and Europa (~0.5) can't be told apart by mass + insolation alone; one extra primary axis fixes that and unlocks Hycean / waterworld / iron-world variety.

### Derivation formulas (replacing class tables)

These are the rough shapes; tuning lives in `procgen-priors.mjs` as named scalars.

**`atmosphericRetention(massEarth, avgSurfaceTempK, hostStarAgeBya)`** — probability the body holds a substantial atmosphere over Gyr. Models Jeans escape: returns a 0..1 retention scalar. Rough form: `sigmoid((v_escape / v_thermal − retention_threshold) / scale)`, where `v_thermal` uses surface T and the mean molecular weight of the candidate atmosphere. This replaces the per-class pressure baselines and the special-cased Titan branch — both fall out naturally. A 0.02 M⊕ body at 90 K retains an N₂ atm; the same body at 290 K does not.

**`surfacePressureBar(massEarth, atmosphericRetention, volatileBudget, tectonicActivity)`** — outgassing-balance: pressure scales with available volatiles released by interior activity, capped by retention. Replaces `PRESSURE_BAR_BY_CLASS × sqrt(mass)`. Sub-Mars bodies get ~0 bar unless cold-and-volatile-rich (Titan branch); large bodies in the inner zone outgas heavily (Venus); the same in the outer zone with a frozen surface retains less (less outgassing through ice crust).

**`surfaceLiquidWaterCover(bulkWaterFraction, avgSurfaceTempK, surfacePressureBar)`** — replaces `waterFractionFor`. Three gates compose:
- `bulkWaterFraction` — no water to cover with if there isn't any
- `surfacePressureBar ≥ TRIPLE_POINT_BAR` — below ~6 mbar, liquid is impossible at any T
- `T ∈ [273, boilingPoint(P)]` — below 273 K everything freezes; above the pressure-dependent boiling point everything vapors
The output is the cover fraction. Earth (high bulk water, 1 bar, 288 K) → ~0.7. Mars (low bulk water, 6 mbar, 210 K) → 0. Europa (high bulk water, 0 bar, 100 K) → 0 liquid. Hycean world (medium bulk water, 100 bar, 290 K) → ~1.0.

**`surfaceIceCover(bulkWaterFraction, avgSurfaceTempK, surfacePressureBar)`** — replaces `iceFractionFor`. Two regimes:
- Cold-trap ice (T < 273, any P including ~0) — surface ice can exist even on airless bodies. Coverage scales with `bulkWaterFraction × ice_temperature_factor(T)`. Mercury's polar ice (~0), Luna's PSR ice (~0.001), Europa (T=102, high bulk water → ~0.95).
- Polar cap ice (T > 273 mean, but min T at poles < 273, atm present) — gives Earth/Mars-class caps. Needs `surfacePressureBar ≥ TRIPLE_POINT_BAR` for stability.

**Warm + airless** = 0 ice (Mercury equatorial regions, Luna's sunlit surface, a small warm rocky in the temperate zone). This is the bug the audit caught.

**`worldClass(...)`** — pure label. A small switch over the derived state:

```
if mass ≥ GAS_GIANT_MASS                     → 'gas_giant'
if mass ≥ NEPTUNE_MASS and S ≤ 0.1            → 'ice_giant'
if mass ≥ SUB_NEPTUNE_MASS                    → 'gas_dwarf'
if surfaceLiquidWaterCover ≥ 0.5              → 'ocean'
if surfacePressureBar < AIRLESS_THRESHOLD and waterFraction < 0.05 and iceFraction > 0.5
                                              → 'ice'   # see "Adding new labels" below
if avgSurfaceTempK ≥ LAVA_TEMP                → 'lava'
if waterFraction < 0.05 and iceFraction < 0.05 → 'desert'
else                                          → 'rocky'
```

Same seven labels (or extended; see below) — the change is that they're computed from physics, not voted on by a seeded coin-flip up front.

### What stays class-keyed

These tables stay class-keyed but consume the *derived* class, so they keep their authoring ergonomics without driving the bugs:

- **Atmosphere species** (`ATMOSPHERE_GASES_BY_CLASS`, `ATMOSPHERE_GASES_COLD_OVERLAY`) — gas mixes are dispatched per class. Once the class is computed honestly from physical state, the dispatch reads the right row.
- **Chromophore decision tree** (`CHROMOPHORE_BY_CLASS`) — same. The gates inside each branch (insolation, biosphere, tier) stay; they're physics already.
- **Biosphere table** (`BIOSPHERE_BY_CLASS`) — what archetypes are even available for a class. Stays class-keyed because designer intent ("subsurface_aqueous needs Europa-like conditions") is cleanest expressed there. The class it reads is now physically correct.
- **Resource priors** (`PLANET_RESOURCE_PRIORS_BY_CLASS`) — same logic, now reads `bulkMetalFraction` indirectly via the derived class. Could later read `bulkMetalFraction` directly for more variety; not in scope here.
- **Renderer-side palette** (`WORLD_CLASS_COLOR`, `WORLD_CLASS_TINT`) — class as label, exactly what these are for.

The line is: class as a **dispatcher to designer-authored tables** stays. Class as a **proxy for a physical scalar** dies.

---

## Planet variety this unlocks

The point of going fundamentals-first isn't just to fix the bug — it's to let the catalog naturally cover the realistic planet types our solar system doesn't have but the literature says exist. Each emerges from a region of the (mass, insolation, bulk water, bulk metal, age) hypercube that the current class taxonomy collapses or excludes.

| Type | Sol analog | Fundamentals that produce it | Currently |
|---|---|---|---|
| **Hycean world** | none | mid mass (2–8 M⊕) + outer-temperate insolation + high `bulkWaterFraction` (0.05–0.3) + thick H₂ atm | falls into `sub_neptune` or `ocean`, neither right |
| **Super-Earth waterworld** | none | high mass (3–8 M⊕) + temperate + very high `bulkWaterFraction` (>0.3) | becomes `ocean` but bulk water capped by Earth-anchored prior |
| **Iron world** / Super-Mercury | Mercury (small) | any mass + high `bulkMetalFraction` (>0.6) + low `bulkWaterFraction` | indistinguishable from generic `rocky` |
| **Coreless silicate world** | none | any mass + very low `bulkMetalFraction` (<0.1) + moderate water | indistinguishable from generic `rocky` |
| **Carbon planet** | none | high `bulkMetalFraction` for C/SiC, very low water, around metal-poor host | not modeled; needs a `carbon_dominated` composition flag |
| **Chthonian planet** | none | originally gas giant mass + extreme insolation + atmosphere stripped (low retention) | currently impossible — gas_giant class locks atmosphere on |
| **Snowball world** | (Earth historically) | temperate insolation + high albedo (high `iceFraction`) + thin atm | not modeled — globalness keys off T only, no runaway-albedo bistability |
| **Tidally locked eyeball** | none | rocky mass + temperate insolation + tidal lock + moderate water | structurally not modeled — no day/night surface differentiation today |
| **Frozen super-Earth** | none | high mass + cold zone + high bulk water | currently `ocean` or `ice_giant` depending on radius cutoff |
| **Helium planet** | none | post-stripped sub-Neptune, low H retention but He retained | needs atmosphere composition from retention physics, not class lookup |
| **Magma ocean world** | (early Earth) | high mass + extreme insolation OR strong tidal heating + young surface age | partially: `lava` class fires only on extreme insolation, not tidal heating |
| **Steppe / Arrakis world** | (drier Mars) | small mass + low bulk water + moderate insolation | currently `desert`, but desert is too broad — covers Mars, hot rockies, and these |

Several of these need primary attributes we don't yet sample (tidal heating budget, atmospheric escape history, formation-zone metallicity). The refactor doesn't have to deliver all of them — the **architectural payoff is that adding any one becomes a local change** to the Filler, not a new row in seven class tables.

### Adding new labels

The label set is currently seven (`rocky | ocean | desert | lava | gas_dwarf | gas_giant | ice_giant`). Once class is derived, adding labels is cheap and lossless. Realistic candidates:

- `ice` — formerly removed (see README), but with fundamentals-first it could come back as a *derived* label for high-iceFraction + low-waterFraction + airless bodies (Europa/Callisto/Ganymede). The reason it was removed was that class-as-input made it overload `surfaceAge`, `atm`, and biosphere downstream; class-as-label has none of that coupling.
- `hycean` — H₂ atm + deep ocean + temperate. Distinct rendering (banded mode with ocean-blue palette) and distinct biosphere prior.
- `iron` — high `bulkMetalFraction` rocky. Distinct resource grid (metals-dominant), distinct renderer palette.
- `super_earth` (currently a `PlanetType`, not a `WorldClass`) — large rocky, distinct enough to deserve its own UI handle.

Each new label is: one entry in `WorldClass` union, one row in `WORLD_CLASS_COLOR`, one branch in the derived `worldClass()` function, optional rows in `BIOSPHERE_BY_CLASS` / `ATMOSPHERE_GASES_BY_CLASS` / etc. No prior table needs to grow unless designer intent specifically calls for it.

---

## Refactor sequencing

Five phases, each landable independently with smoke-tests against the Sol anchors as the regression gate. Sol bodies should stay byte-identical (or shift by ≤ 1 K / ≤ 0.01 fraction) across each phase — they're the calibration.

### Phase 1 — Promote `bulkWaterFraction` to a primary attribute

- Add `bulkWaterFraction` to `Body` (`stars.ts`) and the CSV parser.
- Hand-curate values on the eleven Sol anchors (Earth ~0.0002, Europa ~0.5, Mars ~0.0001, Mercury 0, Callisto ~0.5, Titan ~0.5, …). These are the Sol values from the literature.
- Architect samples a value for every procgen body from a `formation_zone` prior. Inside the frost line: low bulk water (≤0.001). Outside: log-uniform (0.01–0.5).
- Filler: no change yet — `waterFractionFor` and `iceFractionFor` keep their class-keyed behavior. This phase only adds the attribute.
- Audit-procgen learns to report the new distribution.

Verify: `npm run build:catalog` produces byte-identical surface fields for every body that had its `bulkWaterFraction` curated to match the prior's implicit Earth-anchor.

### Phase 2 — Replace `surfacePressureFor` with retention physics

- Add `atmosphericRetention(...)` in `procgen.mjs`.
- Replace `surfacePressureFor` with retention × outgassing.
- Delete `PRESSURE_BAR_BY_CLASS`, `PRESSURE_BAR_COLD_BASELINE`, and the special-case Titan branch — all subsumed by the formula.
- Add `ICE_THICK_ATM_*` priors as the outgassing parameters where needed.

Verify: Sol anchors stay within ≤ 5% of current pressures. Mars 0.006 bar, Earth 1.013 bar, Venus 92 bar, Titan 1.45 bar all reproducible.

### Phase 3 — Replace `waterFractionFor` and `iceFractionFor` with surface-state derivations

- Rewrite both as functions of `(bulkWaterFraction, avgSurfaceTempK, surfacePressureBar)`.
- Delete `WATER_FRACTION_BY_CLASS` and `ICE_FRACTION_*` priors. Replace with `TRIPLE_POINT_BAR`, `ICE_TEMPERATURE_*`, etc. — physical constants, not class rows.
- This is the phase that fixes the audit bug. Re-run the small-airless-with-ocean / small-airless-with-warm-ice queries; both should drop to ≈ 0.
- Renderer needs no changes — it's already gated on temperature; now the upstream fractions are also honest.

Verify: Sol anchors match within ≤ 0.05 absolute on water/ice fractions. Audit-procgen confirms zero small-airless ocean renders.

### Phase 4 — `worldClassFor` becomes a pure derived label

- Rewrite `worldClassFor` to read the *already-computed* surface state, not the water-budget seed.
- Reorder the Filler: compute mass/radius/temp/pressure/water/ice first, then derive `worldClass` from them.
- All downstream consumers (biosphere, atmosphere, chromophore, resources) are unchanged — they just see a more honest class.

Verify: Sol classes unchanged (Earth `rocky`, Europa `ocean`, Mars `desert`, …). Some procgen bodies will shift class — that's the *intent*; sample 20 random reclassifications and confirm they make sense.

### Phase 5 — Add `bulkMetalFraction` + new labels (optional, incremental)

- Add `bulkMetalFraction` to `Body`, sample it in the Architect from a metallicity proxy.
- Wire resource priors to read it directly (more variety in metals/silicates distribution).
- Add the new derived labels (`ice`, `hycean`, `iron`, …) one at a time, each behind its own threshold.

Each new label is one branch in the derived `worldClass()` function. No cascading data-model churn.

---

## Consequences

### What gets easier

- **Bugs like "small airless body renders ocean" become impossible by construction** — the cover fractions read directly from the physics.
- **Adding a new planet type is local** — Hycean worlds are one label + one renderer palette row + one biosphere gate, no new prior tables.
- **Curation becomes self-checking** — if a CSV row sets `bulkWaterFraction=0.1` on Mercury, the Filler will derive ice/water/pressure that don't match Mercury's reality, and the regression gate catches it.
- **The CSV authoring story stays the same** — empty cells still mean "Filler please fill," typed `n/a` still means "not applicable," typed value still wins.

### What gets harder

- **Tuning loses the per-class knob** — today bumping `WATER_FRACTION_BY_CLASS.ocean.mean` is a one-line tune. Going forward, tuning ocean coverage means tuning `bulkWaterFraction` priors at the Architect step or tuning the temperature/pressure curves in the formulas. We mitigate this by keeping the `*_REALISTIC` / `*_TUNE` split — `mergeTunes` continues to apply, just over the formula's named scalars.
- **Joint-distribution testing matters more** — class-keyed code lets you check each row independently. Formula-derived code can have surprising joint outputs ("most temperate-zone bodies end up as desert because retention didn't fire enough"). `audit-procgen` needs to grow joint reports (insolation × mass × outcome class).
- **PROCGEN_VERSION bumps churn the whole catalog** — each phase bumps PROCGEN_VERSION, reseeding all procgen bodies. Sol anchors are immovable; procgen siblings shift. This is intentional and acceptable, but worth noting before each landing.
- **The CSV cells `worldClass` becomes anomalous** — once the class is derived, a human-set CSV `worldClass` either overrides the derivation (and risks lying about the body) or gets dropped. Recommendation: keep it as an *override-with-warning* (audit-procgen flags mismatches between CSV value and what the derivation would have produced). Curated Sol anchors are still allowed to be authoritative, but the warning surfaces drift.

### What doesn't change

- The Architect's `PlanetType` enum and `PHYSICAL_SPEC_BY_TYPE` stay exactly as-is. They're an Architect-time mass-distribution sampler, not a downstream causal class.
- The renderer's `worldClass`-keyed consumers (`disc-palette.ts`, banded-mode detection) keep reading the field — it just now contains an honest label.
- Sol curation remains the source of truth. Curated bodies bypass procgen as today.
- `MOON_COUNT_BY_TYPE`, `RING_OCCURRENCE_BY_TYPE`, belt generation — all unchanged. Architect-side concerns.

---

## Open questions

- **`bulkWaterFraction` for moons** — does it inherit from the host planet (Galilean moons formed in Jupiter's circumplanetary disk vs. captured Triton) or get sampled independently? Sol shows both patterns. Probably a per-moon roll with a small host-correlation term; details deferred to Phase 1 implementation.
- **Tidal heating** — surfaces age and atmospheric retention both depend on it, especially for outer-moon volcanism (Io) and subsurface oceans (Europa, Enceladus). Currently a one-liner in `surfaceAgeFor`. Promoting it to a primary attribute is appealing but out of scope for this refactor; flag as Phase 6 candidate.
- **Formation migration** — hot Jupiters didn't form at 0.05 AU. If we want them to carry their formation-zone composition (more water than an in-situ inner-system body), `formationZoneAu` needs to be stored, not just a transient. Decision deferred until Phase 5; current insolation-based composition sampling is the simpler interim.
- **`worldClass` from CSV** — keep as override-with-warning, or treat as advisory and always derive? Leaning toward override-with-warning so Sol curation stays authoritative, but the warning is what catches drift.
- **Snowball-Earth bistability** — albedo runaway means a temperate-zone body with enough initial ice cover can latch into a globally frozen state at the same insolation as a habitable sibling. Honest modeling requires a stable/unstable equilibrium check on the temp ↔ ice ↔ albedo loop. Out of scope; can ship later as a small post-derivation pass.

---

## Out of scope

- Renderer changes. The shader already gates on the derived fractions correctly (modulo a missing pressure gate on `liquidOceanHere`, which becomes a no-op once the fractions are honest). One-line cleanup post-Phase 3.
- Belt / ring compositions. They have their own resource grids and don't go through the surface cascade.
- Gameplay layer (combat, economy, colonization). The refactor preserves the `Body` shape's public API; consumers don't need to know the derivation changed.
- The `simplify` / `dry-run` pass on `procgen-priors.mjs` after the class tables shrink. Worth doing after Phase 4 lands but not blocking.
