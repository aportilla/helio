// Body traits — a library of pure, physics-derived predicates over a body's
// settled state. Replaces the single-string classifier: instead of collapsing a
// body's multi-axis physics to ONE archetype at the first matching branch and
// handing that lone string to every consumer, this exposes each physical bucket
// as an independent boolean. The buckets are NON-EXCLUSIVE and carry NO
// precedence — a metal-rich icy world answers true to both `isIron` and
// `isGlacial`, and each consumer composes the precedence IT needs (the label
// owns one noun cascade; the audits bucket by overlap). A single shared ordered
// cascade would just be the old classifier under another name, so the ordering
// deliberately lives in the callers, not here.
//
// Shared across the .mjs/.ts boundary via body-traits.d.mts, the same pattern
// prng.mjs / gas-potency.mjs use: imported by `scripts/` audits (Node) AND
// `src/` UI (Vite, plus dump-labels.mjs which Node type-strips). Pure,
// dependency-free, runtime-light, and type-strippable (no enums/namespaces) —
// it carries its own threshold table rather than pulling the whole
// procgen-priors surface into the browser bundle.
//
// Each predicate is one self-contained physical gate with no precedence between
// them — that is the point: overlapping gates re-expose the multi-axis truth a
// single-bucket type would hide. The gaseous predicates carry the gaseous-bracket
// guard; the terrestrial ones carry the terrestrial-bracket + has-temperature
// guard, so any predicate can be asked of any body and answers honestly in
// isolation.

// Classification thresholds — the single source of the gaseous/terrestrial
// radius bounds and the temperature/composition gates. procgen imports
// `gasDwarfRadius` for its own gaseous-bracket test (isGaseousBody), so the
// values live here once.
export const BODY_THRESHOLDS = {
  jupiterRadius:          8,     // R⊕; gas giant lower bound
  neptuneRadius:          3.5,   // Neptune-class lower bound
  gasDwarfRadius:         2,     // rocky / sub-Neptune boundary
  iceGiantTempCeilingK:   200,   // warm-vs-cold gate in the Neptune bracket
  hotJupiterTempFloorK:   700,   // gas giant hot enough to read "Hot Jupiter"
  veiledIceTempCeilingK:  300,   // cold ceiling for the ice-rich H2 dwarf gate
  veiledIceBulkWaterMin:  0.05,
  lavaTempFloorK:         1000,
  magmaOceanTempFloorK:   700,
  magmaOceanTectMin:      0.5,
  chthonianMassMin:       2.0,
  chthonianMetalMin:      0.4,
  // A stripped hot-Jupiter core reads as hot (close-in) — keyed on surface
  // temperature (a stored field) rather than insolation so the predicate needs
  // no host-star lookup, and the runtime label and build agree.
  chthonianTempFloorK:    900,
  ironMetalMin:           0.5,
  iceIceMin:              0.7,
  iceWaterCeiling:        0.1,
  carbonBulkVolatileMin:  0.10,
  oceanWaterFloor:        0.5,
  solidGiantMassMin:      1.5,
  solidGiantRadiusMin:    1.3,
  desertWaterCeiling:     0.05,
  desertIceCeiling:       0.05,
};

// Minimum surface-liquid cover that makes an exotic solvent a body's defining
// feature (mirrors procgen-priors MIN_SURFACE_LIQUID_COVER — a trace film isn't
// a Tholin/Brimstone world).
const MIN_SURFACE_LIQUID_COVER = 0.05;
// Thick organic smog (Titan tholin haze) reads as a Tholin world even when the
// lakes themselves are below the cover floor.
const THOLIN_HAZE_FLOOR = 0.5;
// Gaian temperate band — the surface-liquid-water window for "living world".
// Liquid floor tracks oceanWaterFloor so a Gaian is cleanly a living, temperate
// instance of a full water ocean (Earth), never a partial-cover promotion out
// of the rocky/desert bucket.
const GAIAN_TEMP_LO = 250;
const GAIAN_TEMP_HI = 330;
// A genuinely exposed magma ocean vs a crusted, volcanically-active world.
const MAGMA_OCEAN_EXPOSED_TEMP_K = 1100;
// Tidal volcanism (Io): a perpetually-resurfaced, tectonically-active body whose
// melt is driven by tidal heating, not insolation — so it sits well below the
// temperature melt floors yet is anything but dead. Detected by a near-fully-
// young surface + strong tectonics AND a cold surface; dry/rocky only (the icy
// equivalent reads as a (sub)glacial body with a cryovolcanic surface).
const TIDAL_VOLCANISM_SURFACE_AGE = 0.9;
const TIDAL_VOLCANISM_TECT_MIN = 0.8;
const TIDAL_VOLCANISM_TEMP_CEILING_K = 400;

const W = BODY_THRESHOLDS;

// ─── Bracket membership ──────────────────────────────────────────────────────

// Gaseous bracket (radius ≥ gasDwarfRadius) — no accessible solid surface. The
// shared "is this a gas/ice giant?" source: info-card surface gating, atmosphere
// μ-factor, disc tint, and procgen pressure/biosphere gating all key off it.
// A pure radius-bracket test — every body at or above gasDwarfRadius has no
// accessible solid surface.
export function isGaseousBody(b) {
  return b.radiusEarth != null && b.radiusEarth >= W.gasDwarfRadius;
}

// Terrestrial bracket with a usable temperature — the precondition every
// surface predicate shares (the old terrestrial cascade ran only here; without a
// temperature the old classifier returned `unknown`).
function terr(b) {
  return b.radiusEarth != null && b.radiusEarth < W.gasDwarfRadius && b.avgSurfaceTempK != null;
}

// A body with enough settled physics to type at all — the negation is the old
// `unknown` (no radius, or terrestrial-bracket with no temperature).
export function isClassifiable(b) {
  return b.radiusEarth != null && (isGaseousBody(b) || b.avgSurfaceTempK != null);
}

// Liquid surface-water cover. H2O is just the water case of the generic
// surface-liquid model (surfaceLiquidSpecies / surfaceLiquidFraction), so "how
// wet with liquid water" is a projection of those fields, not a dedicated one:
// the dominant-liquid cover when the dominant solvent IS water, else zero. A
// world whose surface water has frozen reads zero here (that ice is
// iceFraction); a methane- or ammonia-sea world reads zero too (its liquid is
// not water). The single source every consumer that means "liquid water"
// reads — habitability, thermal buffering, the dry-surface gates.
export function liquidWaterCover(b) {
  return b.surfaceLiquidSpecies === 'water' ? (b.surfaceLiquidFraction ?? 0) : 0;
}

// ─── Gaseous family ──────────────────────────────────────────────────────────

// Veiled Ice — a small (sub-Neptune size), cold, water/ice-rich world beneath an
// opaque H2 envelope: a frozen mini-Neptune whose interior ices never melt into
// a surface ocean.
export function isVeiledIce(b) {
  return isGaseousBody(b) &&
    b.radiusEarth < W.neptuneRadius &&
    b.avgSurfaceTempK != null && b.avgSurfaceTempK < W.veiledIceTempCeilingK &&
    (b.bulkWaterFraction ?? 0) >= W.veiledIceBulkWaterMin &&
    b.atm1 === 'H2';
}

// Helium-dominated envelope (an evolved giant). Checked ahead of the Jovian /
// Neptune splits in the old cascade, so the other gaseous predicates exclude it.
export function isHelium(b) {
  return isGaseousBody(b) && b.atm1 === 'He' && b.atm2 !== 'H2' && b.atm3 !== 'H2';
}

// Jupiter-class gaseous envelope — the union of the old gas_giant + hot_jupiter
// (helium wins ahead of this branch, so it's excluded; veiled_ice can't reach
// jupiterRadius). This is the disc-tint predicate.
export function isGasGiant(b) {
  return isGaseousBody(b) && !isHelium(b) && b.radiusEarth >= W.jupiterRadius;
}

// A Jupiter-class giant hot enough to read "Hot Jupiter" (close-in / irradiated).
export function isHotGiant(b) {
  return isGasGiant(b) && b.avgSurfaceTempK != null && b.avgSurfaceTempK >= W.hotJupiterTempFloorK;
}

// Neptune-class cold giant (radius in [neptune, jupiter), below the ice ceiling).
export function isIceGiant(b) {
  return isGaseousBody(b) && !isHelium(b) &&
    b.radiusEarth >= W.neptuneRadius && b.radiusEarth < W.jupiterRadius &&
    b.avgSurfaceTempK != null && b.avgSurfaceTempK <= W.iceGiantTempCeilingK;
}

// Sub-Neptune / gas dwarf — the residual gaseous bracket: gaseous, not helium /
// veiled-ice / Jovian / ice-giant (the old `return 'sub_neptune'` fall-through).
export function isSubNeptune(b) {
  return isGaseousBody(b) && !isHelium(b) && !isVeiledIce(b) && !isGasGiant(b) && !isIceGiant(b);
}

// ─── Surface / subsurface-liquid family (terrestrial bracket) ────────────────

// Molten-sulfur seas (Io-class).
export function isBrimstone(b) {
  return terr(b) && b.surfaceLiquidSpecies === 'sulfur' &&
    (b.surfaceLiquidFraction ?? 0) >= MIN_SURFACE_LIQUID_COVER;
}

// Hydrocarbon lakes and/or thick organic (tholin) smog (Titan-class).
export function isTholin(b) {
  return terr(b) && b.surfaceLiquidSpecies === 'hydrocarbon' &&
    ((b.surfaceLiquidFraction ?? 0) >= MIN_SURFACE_LIQUID_COVER ||
      (b.hazeAerosols?.THOLIN ?? 0) >= THOLIN_HAZE_FLOOR);
}

// Living, temperate water world (Earth-class garden world).
export function isGaian(b) {
  return terr(b) && b.surfaceLiquidSpecies === 'water' &&
    (b.surfaceLiquidFraction ?? 0) >= W.oceanWaterFloor &&
    b.biosphereComplexity === 'complex' &&
    b.avgSurfaceTempK >= GAIAN_TEMP_LO && b.avgSurfaceTempK < GAIAN_TEMP_HI;
}

// Full ammonia / ammonia-water ocean.
export function isAmmoniaSea(b) {
  return terr(b) &&
    (b.surfaceLiquidSpecies === 'ammonia_water' || b.surfaceLiquidSpecies === 'ammonia') &&
    (b.surfaceLiquidFraction ?? 0) >= W.oceanWaterFloor;
}

// Buried ice-shell ocean under a frozen (liquid-free) surface (Europa-class).
export function isSubglacialOcean(b) {
  return terr(b) && b.subsurfaceOceanSpecies != null &&
    (b.surfaceLiquidFraction ?? 0) < MIN_SURFACE_LIQUID_COVER;
}

// A full standing liquid-water ocean (the base-cascade ocean, distinct from the
// living Gaian and the exotic-solvent seas it overlaps).
export function isOcean(b) {
  return terr(b) && (b.surfaceLiquidFraction ?? 0) >= W.oceanWaterFloor;
}

// ─── Base terrestrial family ─────────────────────────────────────────────────

// Stripped hot-Jupiter core — hot, massive, metal-dominant.
export function isChthonian(b) {
  return terr(b) && b.avgSurfaceTempK >= W.chthonianTempFloorK &&
    (b.massEarth ?? 0) >= W.chthonianMassMin &&
    (b.bulkMetalFraction ?? 0) >= W.chthonianMetalMin;
}

// A surface hot enough to run molten (lava world).
export function isLava(b) {
  return terr(b) && b.avgSurfaceTempK >= W.lavaTempFloorK;
}

// Silicate volcanism — either an insolation-warmed crusted melt below the
// exposed-magma temperature, or tidal volcanism (young, tectonic, cold, dry).
export function isVolcanic(b) {
  if (!terr(b)) return false;
  const T = b.avgSurfaceTempK;
  const tect = b.tectonicActivity ?? 0;
  const warmMelt = T >= W.magmaOceanTempFloorK && tect >= W.magmaOceanTectMin &&
    T < MAGMA_OCEAN_EXPOSED_TEMP_K;
  const tidal = (b.surfaceAge ?? 0) >= TIDAL_VOLCANISM_SURFACE_AGE &&
    tect >= TIDAL_VOLCANISM_TECT_MIN &&
    T < TIDAL_VOLCANISM_TEMP_CEILING_K &&
    (b.iceFraction ?? 0) < W.iceIceMin;
  return warmMelt || tidal;
}

// Metal-dominant bulk (an iron world).
export function isIron(b) {
  return terr(b) && (b.bulkMetalFraction ?? 0) >= W.ironMetalMin;
}

// Frozen volatile world under an opaque envelope — ice-rich surface, volatile
// (carbon) bulk outweighing water.
export function isFrostbound(b) {
  return terr(b) && (b.iceFraction ?? 0) >= W.iceIceMin &&
    liquidWaterCover(b) < W.iceWaterCeiling &&
    (b.bulkVolatileFraction ?? 0) > (b.bulkWaterFraction ?? 0) &&
    (b.bulkVolatileFraction ?? 0) >= W.carbonBulkVolatileMin;
}

// An ice-mantled world (high surface ice, low liquid water) that isn't the
// volatile-bulk Frostbound case.
export function isGlacial(b) {
  return terr(b) && (b.iceFraction ?? 0) >= W.iceIceMin &&
    liquidWaterCover(b) < W.iceWaterCeiling;
}

// A massive, large terrestrial — the band real astronomy calls a "super-Earth".
export function isSuperEarth(b) {
  return terr(b) && (b.massEarth ?? 0) >= W.solidGiantMassMin &&
    b.radiusEarth >= W.solidGiantRadiusMin;
}

// A dry rock — no surface water or ice (the old desert gate).
export function isDesert(b) {
  return terr(b) && liquidWaterCover(b) < W.desertWaterCeiling &&
    (b.iceFraction ?? 0) < W.desertIceCeiling;
}
