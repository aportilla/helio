# Planet render plan

Multi-phase roadmap for enriching the planet/moon disc renderer in the system view. Captures durable design intent — kept distinct from `README.md` (which documents the steady-state architecture) and from ephemeral session-scoped refactor docs (which stay out of the repo via `.git/info/exclude`).

Implementation lands incrementally; expect each phase to ship as one or two commits with a working browser smoke before moving on.

## Premise

Make planets and moons feel like *places* — distinct, beautiful, enticing — while preserving the pixel-crisp aesthetic and the primary-attributes-only data philosophy. Visual character emerges from the same fields gameplay reads. No separate "appearance" enum, no derived weights stacked on top of an already-emergent signal.

## Current state

Surface mode reads `worldClass`, `axialTiltDeg`, the six-scalar resource grid, atmosphere (top three gases + chromophore), `waterFraction`, `iceFraction`. Banded mode reads the same gases + chromophore + `axialTiltDeg`. Both share parity-aware pixel snap and the same sphere-projection foreshortening (`RING_MINOR_OVER_MAJOR` pole tilt) so a ringed body's bands and ring share one vantage.

Most-recent landings:
- **Phase 1.2 — biome stipple** driven by `biosphereArchetype × biosphereTier × hostStar.cls`. Earth's temperate land paints as dense green chlorophyll; M-dwarf carbon_aqueous worlds shift to deep purple (Kiang-style "Purple Earth"); K → rust-red; F/A → gold. Tier drives coverage density (microbial sparse, gaian dense). O/B/WD/BD hosts and prebiotic worlds suppress entirely.
- **Phase 1.1 — oceans + polar caps** from `waterFraction` + `iceFraction`. Earth reads as ocean-dominated with small caps; Europa fills white; Mars keeps a thin polar trim.
- **Albedo removed from the render path.** Body brightness is now genuinely emergent. The `body.albedo` field stays in the data model for now; pinned for removal pending refactor of the Stefan-Boltzmann temp derivation that still consumes it.

## Design principles

These are constraints every Phase entry must satisfy.

- **Primary attributes only.** Every visual feature is driven by a field that gameplay also cares about. No derived weights (the `albedo` mistake), no "appearance" enums layered on top of `worldClass`.
- **Pixel-crisp.** Every feature resolves to integer-pixel boundaries — no AA fringes, no sub-pixel positioning, no gradients. Use cell-based hashes for non-uniform regions; sphere-projected latitude for curved features; integer-px stair-stepped warps for irregular edges.
- **Mode-separated machinery.** Surface and banded are nearly-independent shader paths. A feature lives in one or the other (or is explicitly cross-cutting, like ring shadow).
- **Emergent brightness.** A body's overall brightness is what falls out of its rendered features — never multiplied by a stored albedo scalar. If a body looks "wrong-brightness," fix the palette hues or add a primary feature; don't add a darkening factor.
- **Determinism.** Per-body seeding via `hash32(body.id + ':' + field)`. Visuals stable across reloads and procgen regenerations. Bumping `PROCGEN_VERSION` reseeds everything without touching ids.

---

## New primary attribute: `surfaceAge`

A 0..1 scalar capturing how recently a body's surface has been geologically/dynamically refreshed. Introduced as a primary procgen attribute (not a derivation) so the renderer can read it directly.

### Motivation

Removing albedo from the render path sacrificed the Ganymede / Enceladus distinction — both `iceFraction=1`, both render fully white today. The signal that actually distinguishes them is *surface age*: fresh cryovolcanic ice on Enceladus vs ancient impact-darkened ice on Ganymede. Albedo encoded that observation indirectly; surface age captures it directly as the primary cause.

Surface age also unlocks Phase 1.4 (cratering): high-contrast pitted texture on old surfaces (Moon, Mercury, Callisto), smooth on young ones (Io, Europa, Enceladus, Earth).

### Semantics

- **1.0** — perpetually refreshed. Io's lava lakes, Enceladus's cryovolcanic plumes, Earth's plate-tectonics-refreshed crust within a few hundred Myr.
- **0.5** — mixed. Mars's old highlands + younger volcanic plains. Titan's atmosphere-weathered surface.
- **0.0** — ancient unmodified. The lunar highlands, Mercury, Callisto.

The scalar represents the *fraction of the surface that is geologically young*, not literal age in years.

`null` for `kind in (gas_giant, ice_giant, gas_dwarf, belt, ring)` — no solid surface to age.

### Procgen pipeline

Add to `scripts/lib/procgen-priors.mjs`:

```js
export const SURFACE_AGE_BY_CLASS = {
  rocky:    { mean: ..., sd: ... },   // mostly old; resurfacing rare
  ocean:    { mean: ..., sd: ... },   // active oceans + tectonics likely
  desert:   { mean: ..., sd: ... },   // little resurfacing once dry
  ice:      { mean: ..., sd: ... },   // bimodal: dead vs cryovolcanic
  lava:     { mean: ..., sd: ... },   // by definition continuously molten
  // n/a for gas/ice giants — never sampled
};
```

Calibrate `mean` per class so the Sol-system curated values fall within one sigma of the class mean (sanity check via `audit-procgen.mjs`).

Filler in `scripts/lib/procgen.mjs`:
1. Sample base from `SURFACE_AGE_BY_CLASS` using `fieldPrng(body, 'surfaceAge')` (deterministic per body).
2. **Tidal lift for moons of giants.** If `kind === 'moon'`, the host is a giant, and `eccentricity > TIDAL_E_THRESHOLD`, lift toward 1.0 by `TIDAL_LIFT_AMOUNT × normalizedEccentricity`. Reflects the tidal-heating squeeze that drives Io and Enceladus.
3. Clamp to `[0, 1]`.

Compute order: must run after `worldClass`, `eccentricity`, and host resolution — consistent with the existing Filler order.

Eccentricity-only is the simplest defensible proxy. Real tidal heating scales as `M_host² · e² / a⁵`; for our catalog the host-mass term doesn't change ordering (gas giants all dominate the term), so we tabling the more elaborate formula until we see a counterexample.

### Hand-curated values for Sol

`bodies.csv` gains a `surface_age` column. Curated values for the eleven Sol planets/moons:

| Body | surface_age | Why |
|---|---|---|
| Mercury | 0.05 | Lunar-style cratered surface ~4 Gyr |
| Venus | 0.55 | Global volcanic resurfacing ~500 Myr ago |
| Earth | 0.70 | Plate tectonics resurfaces continuously |
| Luna | 0.05 | Lunar highlands ~4.4 Gyr |
| Mars | 0.20 | Old highlands dominate; young volcanic plains in patches |
| Io | 1.00 | Active lava resurfacing on observation timescales |
| Europa | 0.85 | Young ice shell, cycloid cracks |
| Ganymede | 0.30 | Old dark + younger grooved terrain mix |
| Callisto | 0.05 | Most heavily cratered body in Sol |
| Titan | 0.50 | Hidden surface but atmosphere-eroded, hydrocarbon lakes |
| Enceladus | 0.95 | Cryovolcanic plumes, fresh ice everywhere |

Procgen targets should be tuned so these eleven anchors aren't pulled outside their class prior.

### Renderer consumption

Plumbed identically to `aWaterFrac` / `aIceFrac`:

- `DiscPalette.surfaceAge: number` — default 0.5 when null (middle of the road, so missing data renders unobtrusively rather than as extreme young/old).
- Banded bodies and sub-`PROCEDURAL_TEXTURE_MIN_PX` discs force to 0.5 (cratering not applicable).
- Per-vertex `aSurfaceAge` attribute → `vSurfaceAge` varying.
- Consumed by Phase 1.4 cratering — see that section for the shader math.

### Migration checklist

1. Add `SURFACE_AGE_BY_CLASS` + tidal-lift constants to `procgen-priors.mjs`.
2. Add `surface_age` column to `bodies.csv` schema in `scripts/scrape-planets-from-stellarcatalog.mjs` and to the architect's emit list in `scripts/lib/procgen-architect.mjs`.
3. Implement `surfaceAgeFor(body)` in `procgen.mjs`; wire into the Filler in the correct order.
4. Update `Body` interface in `src/data/stars.ts` with `readonly surfaceAge: number | null`.
5. Update column mapping in `scripts/build-catalog.mjs`.
6. Hand-set Sol curated values in `bodies.csv`.
7. Add to `scripts/inspect-body.mjs` printout.
8. Add to `scripts/audit-procgen.mjs` distribution check.
9. Decide whether to surface in the system-view info card (likely not as a number — possibly as a derived category like "young / mixed / ancient" if a future gameplay system reads it).
10. Plumb to the renderer (`DiscPalette` + layers + shader) when Phase 1.4 lands.

### Open questions

- **Tidal lift formulation.** Eccentricity-only is the proposed starting point. If audit reveals weirdness (e.g. a low-e tidally-locked moon of a giant rolling "ancient" when intuition says it should be heated), revisit.
- **Sol curated values.** Verify against `audit-procgen.mjs` once Phase 1.4 lands; visual character is the final arbiter.

---

## Phase 1 — Terrestrial worlds feel alive (surface mode)

Goal: Earth, Mars, Europa, Titan, Mercury, Moon, Io, Enceladus all read as distinct, identifiable bodies at a glance. Phase 1.1 is the foundation; 1.2-1.4 layer character on top.

### 1.1 Oceans + polar caps (done)

Driven by `waterFraction` + `iceFraction`. Sphere-projected latitude (shared with banded mode) defines the cap region; coarse-cell hash defines ocean continents. See README §"Procedural disc texture" for the steady-state spec.

### 1.2 Biome stipple on temperate land (done)

**Why.** Earth's living biosphere is the single biggest "this is a place that matters" signal in our catalog. A flat hue shift on land cells risks reading as "different-colored rock" rather than "alive" — what makes Earth pop is the *tactile* impression of growth, not a uniform tint. A per-pixel stipple within biome-eligible land cells paints individual pixels in biome color over the underlying resource color, reading as moss / lichen / canopy growth. Tier drives coverage density (microbial sparse → gaian dense), so one dial covers the full life spectrum with one mechanism.

Color comes from two stacked tables: archetype picks the *pigment chemistry* hue, stellar class shifts that hue based on what wavelengths the host star actually delivers. Earth (G2V) lands on chlorophyll-green; an M-dwarf carbon_aqueous world lands near "Purple Earth" because pigments under red/IR-rich light evolve to absorb broadly and reflect less in the visible band (Kiang et al. on alien photosynthesis). M-dwarfs are ~60% of the catalog — without the stellar shift every alien biome would paint Earth-green, collapsing the visual distinction the data already encodes.

**Trigger.** All of:
- Surface mode
- `biosphereArchetype !== null` and `biosphereTier in (microbial, complex, gaian)` — prebiotic skipped (no visible biomass)
- Land cell only (not ocean, not ice)
- Temperate latitude — `|latSinS| < BIOME_LAT_MAX`, with a smoothstep taper toward the poles
- Disc radius ≥ `PROCEDURAL_TEXTURE_MIN_PX` — sub-threshold discs skip the stipple (would resolve as noise, not pattern)

**Data inputs.** `biosphereArchetype`, `biosphereTier`, `latSinS`, host star's `cls` (resolved CPU-side through `body.hostStarIdx`, or up the moon→planet chain for satellites).

**Palette — two layers.**

`BIOME_TINT_COLOR[archetype]` — base pigment hue assuming G-class light, hand-tuned in `disc-palette.ts`:

| Archetype | Base tint (G-class) | Why |
|---|---|---|
| carbon_aqueous | forest green | Earth's chlorophyll signature |
| subsurface_aqueous | null | Under-ice life doesn't reach the visible surface |
| aerial | null | Banded mode only — doesn't reach surface |
| cryogenic | methane-tinted ochre | Hydrocarbon-cycle biosphere |
| silicate | grey-green crystalline | Hypothetical mineral metabolism |
| sulfur | yellow-brown | Sulfur-cycle thermal-vent life |

`BIOME_STELLAR_SHIFT[cls]` — multiplicative hue rotation by host stellar class. Pigments absorb the wavelengths the star delivers; reflected color shifts accordingly.

| Stellar class | Shift | Why |
|---|---|---|
| O, B | null (suppresses biome render entirely) | Stellar lifetime too short + UV-sterilizing |
| A | warm gold | Blue-dominant input → reflect red/orange |
| F | gold / yellow-tan | Subtle warm shift from G baseline |
| G | identity | Earth baseline — pigments calibrated to Sun's spectrum |
| K | rust-red | Red-shifted input; broader-band pigments shift visible reflectance toward red |
| M | deep purple | Red/IR-dominant input; broadband absorption → "Purple Earth" |
| WD, BD | null | Insufficient luminosity for a surface biosphere |

Combined per body: `biomeColor = BIOME_TINT_COLOR[archetype] · BIOME_STELLAR_SHIFT[hostStarCls]`, computed CPU-side in `buildDiscPalette`. Null when either table returns null (carbon_aqueous on an M-dwarf renders; subsurface_aqueous anywhere doesn't; anything on an O/B/WD/BD doesn't).

**Pipeline.**
- CPU-side in `buildDiscPalette`: derive `biomeColor` (as above) and `coverage = BIOME_COVERAGE_BY_TIER[tier]` (microbial sparse → gaian dense). Pack into `aBiomeColor: vec3` (zero when no biome applies) and `aBiomeCoverage: float` (0 when no biome applies).
- Shader, in the land branch only:
  - `taper = smoothstep(BIOME_LAT_MAX, BIOME_LAT_MAX - BIOME_LAT_RAMP, abs(latSinS))`
  - `effectiveCoverage = vBiomeCoverage * taper`
  - Per-fragment stipple hash on integer pixel coords with its own salt: `if (hash21(pixelCoord, BIOME_SALT) < effectiveCoverage) col = vBiomeColor`
  - Stipple replaces the underlying resource color at hit pixels (no blend — these are pixels of growth *on* rock, not a glaze over it).
- Applied *only* to the land branch — stipple over ocean would lock to the disc's pixel grid and read as wireframe; over ice would obscure the cap signal.

**Tuning anchors.**
- Earth (carbon_aqueous, gaian, G2V) — dense green stipple in the temperate band; polar cells unchanged; arctic cells smoothstep-tapered.
- A procgen K-dwarf carbon_aqueous gaian — rust-red stipple at gaian density. Reads as "alien Earth."
- A procgen M-dwarf complex carbon_aqueous — deep-purple stipple at complex density. "Purple Earth" world.
- A procgen F-dwarf complex carbon_aqueous — gold-tan stipple at complex density.
- A microbial-tier body — same color tables, sparse stipple. Visibly distinct from a tier-complex sibling.
- A prebiotic-tier body — no stipple (skipped at trigger).
- A 40-px disc — stipple skipped regardless of tier (sub-threshold resolution).

**Risk.**
- M-dwarf "deep purple" risks reading as "absent biome" rather than "dark biome." The shift table needs enough saturation that the stipple still pops against the underlying rocky resource cells — pick a hue closer to true violet than to black.
- Stipple, biome, cratering, and clouds all share the per-pixel hash space. The stipple salt must be distinct from all other surface-pass salts (see the cross-cutting salt budget below).
- Coverage curve for the three tiers is the load-bearing visual choice — too sparse and gaian reads as microbial; too dense and microbial reads as gaian. First pass should leave a clear visual gap between the three.

### 1.3 Clouds / dust haze

**Why.** Earth's clouds, Mars's dust storms, and any procgen surface body's chromophore aerosol layer should read as a separate layer *above* the ground rather than as another resource patch. Today the chromophore folds into the resource palette slot — it's "another color of patch" rather than "a thin layer above the surface." Hoisting it into its own pass gives the disc real depth — ground + above-ground in two layers.

**Trigger.** All of:
- Surface mode
- `chromophoreGas !== null` and `chromophoreFrac > 0`
- Cell not already ice (cap absorbs everything above; clouds-over-cap loses the cap signal)

**Data inputs.** `chromophoreGas` (color lookup via `CHROMOPHORE_COLOR` / `GAS_COLOR`), `chromophoreFrac` (density of cloud cells).

**Pipeline.**
- Drop the chromophore from the surface-mode resource palette slot (it now has its own pass). Land cells revert to top-3 resources by `dominantResources(body, 3)`.
- Add a second coarse-cell pass at `CLOUD_PATCH_PX` (independently tuned from `CONTINENT_GROUP × SURFACE_PATCH_PX`), with its own jitter and a salted hash decorrelated from continent + resource hashes.
- A cloud cell activates when `hash < cloudDensity`, where `cloudDensity = clamp(chromophoreFrac × CLOUD_VISIBILITY_BOOST, 0, CLOUD_MAX_COVERAGE)`. The boost mirrors `CHROMOPHORE_VISUAL_BOOST` (condensed-phase species punch above their molar fraction); the cap prevents an Earth-class body from going fully overcast.
- Activated cells paint `CHROMOPHORE_COLOR[gas] ?? GAS_COLOR[gas]` over whatever ground/biome/resource lay beneath.
- Cloud cells skip when `|latSinS| > 1 - vIceFrac` so the cap renders cleanly above.

**Tuning anchors.**
- Earth (H2O chromophore) — wispy scattered cover capping at `CLOUD_MAX_COVERAGE` ≈ 35%. Resource and biome hues read through the gaps.
- Procgen Mars-class (DUST chromophore from `CHROMOPHORE_BY_CLASS`'s desert branch) — rust-haze cells overlay the rust land. Subtle but adds atmospheric feel.
- Procgen Hycean (H2O chromophore on cold ocean world) — pale clouds over blue ocean, Earth's cold cousin.

**Risk.**
- Removing chromophore from the resource palette slot frees one slot. Land cells now pick from up to 3 resources only. Need to verify Earth and Mars-class bodies still read as themselves with the chromophore-out-of-palette configuration. Likely fine — Earth's top three (Volatiles, Silicates, Metals) cover its character; Mars's top three (Metals, Silicates, RareEarths) ditto.
- Clouds + biome + cratering all paint over the same cells. Pipeline order matters — see Open questions below.

### 1.4 Cratering / surface age

**Depends on** the new primary attribute `surfaceAge` plumbed. Cannot land until that is in.

**Why.** Restores the Enceladus/Ganymede distinction sacrificed when albedo left the render path — properly this time, via the primary attribute that *causes* the brightness difference rather than the derived measurement of it.

**Trigger.** Surface mode, every body. Effect amplitude tapers to zero as `surfaceAge → 1`.

**Data inputs.** `surfaceAge`, fragment's worley `winnerCell`.

**Pipeline.**
- After the cell-pick branches (resource / ocean / ice) have set `col`, apply a per-cell lightness perturbation:
  - `craterAmount = (1.0 - vSurfaceAge) * CRATER_MAX_AMPLITUDE`
  - `perturb = (hash11(winnerCell-salt) - 0.5) * 2.0 * craterAmount`
  - `col = clamp(col + vec3(perturb), 0.0, 1.0)`
- Uniform-RGB shift preserves hue; only lightness varies cell-to-cell.
- Apply to all surface branches (land / ocean / ice) — the effect reads as "old surface = pitted everywhere," not just on resource patches. Old icy moon (Callisto) gets mottled ice; old rocky body (Mercury) gets cratered iron-grey.

**Tuning anchors.**
- Moon (surfaceAge=0.05) — high amplitude, visible cell-to-cell mottling. Reads as cratered.
- Mercury (0.05) — same. Reads as ancient.
- Earth (0.70) — low amplitude, mostly smooth.
- Io (1.0) — zero amplitude, perfectly smooth land cells (lava resurfaces faster than craters accumulate).
- Enceladus (0.95) — near-zero. Disc reads as clean bright ice.
- Ganymede (0.30) — mid amplitude. Disc reads as mottled ice — distinct from Enceladus at a glance.

**Risk.** Cratering and biome tint share the cell hash space — salts must be distinct so a "lucky" cell doesn't go *both* ancient AND extra-biome-y by accident.

---

## Phase 2 — Gas giants get personality (banded mode)

Goal: make Jupiter, Saturn, Uranus, Neptune and procgen siblings read as distinct, characterful giants — not a flotilla of curved-band variants.

### 2.1 Banded storms

**Why.** Today's banded discs all read as tidy zonal flow. Real giants have non-band features: Jupiter's Great Red Spot, Saturn's hexagonal pole vortex, Neptune's Great Dark Spot. Approximate as 1–3 elliptical "spots" overlaid on the bands, positioned and colored from chromophore data.

**Trigger.** Banded mode AND `worldClass in (gas_giant, ice_giant, gas_dwarf)`. Venus-class banded rockies are excluded — they're banded because of thick atmosphere, not zonal-flow systems.

**Data inputs.** `chromophoreFrac` (storm density), per-body `vSeed` (storm positions and sizes).

**Pipeline.**
- `stormCount = clamp(round(chromophoreFrac × STORM_DENSITY_BOOST), 0, MAX_STORMS_PER_DISC)`. Bodies with no chromophore (e.g. pure H2/He near-transparent giant) get zero storms.
- Per storm, hash a position `(latSin, lonOffset)` and an `(semiLat, semiLon)` size from `(vSeed, stormIdx)`. Long-axis along longitude (Jupiter's GRS is ~3:1).
- Storm color: `CHROMOPHORE_COLOR[gas]` (the condensed-product hue — NH3 → NH4SH brown for Jupiter).
- Fragment test (in rotated band frame, after the tilt math runs): if inside the ellipse, paint storm color. Per-band lightness jitter still applies on top so the spot stays band-aligned in feel.
- Storms render in the rotated band frame so they tilt with the rest of the disc.

**Tuning anchors.**
- Jupiter (NH3 chromophore at small frac, large `CHROMOPHORE_VISUAL_BOOST`) — one Red Spot analog, mid-southern latitude.
- Saturn (NH3, lower frac than Jupiter) — 0 or 1 storm; matches Saturn's variable history.
- Uranus (no chromophore set, CH4 wins via potency but no chromophore slot) — zero storms. Matches Voyager's bland disc.
- Procgen Neptune-analog with stronger chromophore — one storm. GDS analog.

**Risk.**
- Ellipse silhouette stair-steps under the per-pixel discard test. Acceptable — matches the disc's own jagged rim under low size and the bands' undulating boundary.
- Storm + band overpaint order: storm replaces underlying band color in its footprint, doesn't blend. (Blend would smear the band-aligned read.)

### 2.2 Aurora pole tint ( DEFER FOR NOW - ASK AT THE END )

**Why.** Magnetic-field differentiation that the banded shader doesn't read today. Jupiter alone has a dramatic field; the others sit much lower. Aurora-tinted poles let the disc read this without text.

**Trigger.** Banded mode, `worldClass in (gas_giant, ice_giant, gas_dwarf)`, `magneticFieldGauss > AURORA_FIELD_THRESHOLD`.

**Data inputs.** `magneticFieldGauss`, plus the body's chromophore for the auroral color (real auroras are H emission lines; we approximate via the body's chromophore palette so a chromophore-less body gets a fallback to `palette0`).

**Pipeline.**
- `auroraStrength = smoothstep(AURORA_FIELD_THRESHOLD, AURORA_FIELD_FULL, magneticFieldGauss)`.
- `polarTaper = pow(abs(latSin), AURORA_POLE_EXPONENT)` — concentrates effect at the poles.
- After the band color pick: `col = mix(col, CHROMOPHORE_COLOR[gas] ?? palette0, auroraStrength × polarTaper × AURORA_TINT_AMOUNT)`.
- Pipeline order in banded mode (final spec): band pick → band lightness jitter → aurora tint → storms. Storms win at the poles when they overlap (the band-aligned spots paint last).

**Tuning anchors.**
- Jupiter — pronounced amber-brown lift at the poles (NH4SH chromophore color), matching the real auroral cap region.
- Saturn — faint tint, barely visible.
- Uranus / Neptune — subdued. Uranus's tilted-axis field is weird, but our static disc doesn't model the offset — accepted limitation.

**Risk.** Pipeline ordering with storms — codify in the shader to avoid drift.

---

## Phase 3 — Scene-level cinema

### 3.1 Ring shadow ( DEFER FOR NOW - ASK AT THE END )

**Why.** Ringed giants currently render with rings and bands but no interaction between them. A ring shadow line crossing the planet's disc is the single biggest visual cue that the ring is *physical*, not a sticker.

**Trigger.** A body has a non-null `ring` index.

**Data inputs.** Ring inner/outer radii (from the ring body), host `axialTiltDeg` (already in `vTilt`), the implicit star direction.

**Star direction is a project-wide decision** — picking one and committing to it for ALL system-view cinema (ring shadows now; future day/night terminator; etc.) is the load-bearing call. Recommendation: +X from the right edge of the screen, matching the layout's left-to-right "innermost to outermost" axis (the star is conceptually to the left of the leftmost body, but for shadow geometry "light comes from the star direction" reads consistently with that left-to-right narrative).

**Pipeline.**
- Plumb ring `innerPlanetRadii`, `outerPlanetRadii`, and the ring's `axialTiltDeg` (if it differs from the host's; today they share) as new disc attributes when the body has a ring; zero / `mode_off` flag when not.
- Per fragment on the disc, project the fragment's planet-local position onto the ring plane along the assumed star direction. If the projection's `r` falls within `[innerR, outerR]`, the fragment is in shadow.
- `col *= RING_SHADOW_AMOUNT` (multiplicative darken — preserves hue; just dims).
- Edge of the shadow follows the same `WARP_CHUNK_PX` stair-stepping the band boundaries use, so it reads as deliberate pixel-art rather than a thin smooth band.

**Tuning anchors.**
- Saturn (procgen-equivalent, since our catalog's Saturn doesn't have a ring body today) — clear dark line across the disc, narrower at the equator (ring edge-on relative to assumed light) and broader where tilt projects the ring further.
- A Uranus-class high-tilt body — ring shadow runs near-vertical across the disc.

**Risk.**
- Star direction commitment is the biggest. Pick once; revisit only if Phase 3.2+ demands a different convention.
- Computing the shadow in the planet shader (we're darkening the *disc*, not the ring) — plumbing is straightforward but introduces per-disc conditional attributes (zero if no ring; set if ring).

---

## Demoted / dropped from the original brainstorm

- **Volcanic hot spots.** Io is the only catalog body that strongly triggers (lava class + tectonicActivity=1). Procgen lava worlds are rare. Fold into lava-class palette tuning later if it ever feels worth the dedicated machinery.
- **Temp-gradient palette.** Banded mode already encodes equator/pole variation via per-band picks. Surface-mode oceans gain little from a warm/cool tropical lerp once biome tint and clouds are in.

## Out of scope (would require new mechanics)

- **Day/night terminator.** Needs a sub-solar point on every body and a lighting model. The system view is intentionally a static screen layout (no orbit, no zoom); committing to a single light direction project-wide is the prerequisite — see Phase 3.1's note.
- **Animated rotation.** `rotationPeriodHours` is on every body but the renderer is static. Out of scope until the system view gains time semantics.
- **Vegetation density / canopy detail.** Below the resolution we're rendering at (40–120 px discs).

## Open questions (cross-cutting)

- **Phase 1 paint-order.** Three Phase 1 features (biome stipple, ocean override, ice cap override, cloud overlay, cratering) all paint over the resource cells. Proposed pipeline:
  ```
  resource cell pick → biome stipple → ocean override → ice cap override → cloud overlay → cratering
  ```
  Biome before ocean because biome only applies to land. Ocean before cap because the cap should still cover ocean at high lat. Clouds after cap means clouds skip the cap region (already in 1.3 trigger). Cratering last because it's a per-cell lightness shift that should apply to everything beneath it — including biome pixels (an old surface with sparse alien moss should still read as old AND mossy).

- **Hash-salt budget.** Each new feature adds one or two hash21 calls. Salts must be distinct so the same cell doesn't accidentally light up multiple features in correlation. Track allocated salts in a comment block at the top of the surface block.

- **`SURFACE_CHROMOPHORE_WEIGHT` after Phase 1.3.** Once chromophore exits the surface-mode palette slot, this constant becomes unused. Delete in the 1.3 commit.

- **Browser smoke between phases.** Each Phase entry should ship with a manual verification pass against the eleven Sol bodies before moving on — the data is anchored, the visual outcome is predictable enough to eyeball.
