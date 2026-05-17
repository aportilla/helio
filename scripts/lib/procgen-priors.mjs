// Procgen priors — the data side of the body-catalog procgen pipeline.
//
// Mostly constants plus one merge helper. The Architect (in procgen.mjs,
// planned) reads these to sample per-system architecture: how many planets
// a star is likely to host, where they sit in orbit, what mass/radius mix
// is plausible at each insolation, how many moons each planet type carries.
// The Filler reads its own (smaller) prior set; this file is the
// Architect's tuning surface.
//
// === Realistic base, gameplay tune layered on top ===
// Sections we've intentionally biased away from physical realism for
// game-feel reasons keep two blocks side-by-side:
//   - `*_REALISTIC` — scientifically anchored against published exoplanet
//     statistics (Dressing & Charbonneau 2015 for M-dwarf occurrence;
//     Petigura et al. 2018 / Hsu et al. 2019 for Kepler FGK; Wright et al.
//     2012 for hot Jupiter rate). This block is what the universe
//     actually looks like as best we can tell.
//   - `*_TUNE` — sparse overrides, mentions ONLY the fields we're
//     deliberately pushing away from realistic for gameplay reasons. The
//     header comment on each TUNE block explains the player-visible
//     effect we're after.
// `mergeTunes()` deep-merges the two and that's what gets exported.
// Reverting a section to pure realism is a one-block deletion.
//
// Sections without a `*_TUNE` peer are exported directly as realistic —
// either we're satisfied with the calibration, or the field isn't yet
// known to need a thumb on the scale. Add the realistic/tune split when
// you start to push a section away from reality.
//
// === Bias assumption ===
// The catalog is treated as dramatically incomplete for every star. The
// Architect samples toward these target counts regardless of how many
// catalog rows already exist on a star, then anchors catalog rows into
// their slots and fills the rest. So PLANET_COUNT_BY_CLASS reflects
// expected TOTAL bodies (catalog + procgen), not just procgen extras.
//
// === Sampling conventions ===
// `{ mean, sd, min, max }` blocks describe a truncated normal:
// sample N(mean, sd), clamp to [min, max]. Round to integer where the
// field is a count. Where a log-normal is more physically accurate
// (orbital spacing ratios, planet mass), the comment calls it out and the
// Architect's sampler is expected to log-transform.
//
// === Versioning ===
// PROCGEN_VERSION is the seed-suffix hook. The Filler/Architect mix it
// into every PRNG seed; bumping it reseeds the entire galaxy without
// touching CSV ids. Per-generator version suffixes are layered on top.

// Deep merge a sparse `tune` over `base`. Plain objects are merged
// recursively (so a tune entry can override a single nested field without
// restating its siblings); everything else — primitives, arrays — is
// replaced wholesale. Use a named record (not an array) if you need
// partial overrides on what would otherwise be an ordered list.
function mergeTunes(base, tune) {
  const out = {};
  for (const key of Object.keys(base)) {
    const b = base[key];
    const t = tune[key];
    if (t === undefined) { out[key] = b; continue; }
    const bothObj = typeof b === 'object' && b !== null && !Array.isArray(b)
                 && typeof t === 'object' && t !== null && !Array.isArray(t);
    out[key] = bothObj ? mergeTunes(b, t) : t;
  }
  for (const key of Object.keys(tune)) {
    if (!(key in base)) out[key] = tune[key];
  }
  return out;
}

export const STELLAR_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'WD', 'BD'];

// ---------------------------------------------------------------------------
// System-level architecture
// ---------------------------------------------------------------------------

// Total expected planet count per stellar class (catalog + procgen,
// after bias correction).
//
// G mean=6 lands close to Sol (8 planets) while allowing room for systems
// with fewer detectable bodies. M mean=4 reflects TRAPPIST-1's 7 and the
// many M dwarfs with 2–3 detected; bias-corrected total around 4 is the
// Dressing & Charbonneau estimate. WD low because most planets are
// ejected or destroyed during the post-main-sequence phase; survivors are
// rare but documented.
// Per-companion planet-count suppression multiplier. Companions in tight
// stellar binaries have narrow stability windows for S-type (single-star
// circumstellar) planets, and most planetesimals get scattered out of the
// system during formation. Wang et al. 2014 and Kraus et al. 2016 measured
// ~50% planet-occurrence suppression for stellar companions inside ~50 AU,
// stronger for tighter pairs. Our cluster builder doesn't carry per-pair
// AU separation (it works in light-year space), so we use rank-in-cluster
// as a proxy: cluster members are dominantly co-located within ~50 AU
// once they share a sub-light-year position, so the suppression applies.
// Wide-separation companions (Proxima Cen ~13,000 AU from α Cen AB) would
// be exempt in reality but we don't distinguish them yet — accepted v1
// scope, may revisit with a sampled-separation lookup later.
//
// Primary = heaviest member (`cluster.members[0]`) — always 1.0, unchanged
// from independent-roll behavior. Secondary = 2nd-heaviest. Tertiary+ =
// anything past that. Singleton-cluster stars are 'primary' by default →
// no behavior change for ~82% of the catalog.
//
// Anchors: α Cen AB (G+K, ~11-36 AU binary) has zero confirmed planets
// despite extensive search; the 0.3 secondary rate produces a low but
// non-zero expected count that reads as "barren but not impossible."
// Kraus 2016's binary-suppression curve at <50 AU sits near 0.3-0.5.
export const COMPANION_PLANET_SUPPRESSION = {
  primary:       1.0,
  secondary:     0.3,
  tertiary_plus: 0.2,
};

const PLANET_COUNT_BY_CLASS_REALISTIC = {
  O:  { mean: 2,   sd: 1.5, min: 0, max: 5  },  // massive, short-lived; observation-limited
  B:  { mean: 2,   sd: 1.5, min: 0, max: 5  },
  A:  { mean: 4,   sd: 2,   min: 0, max: 8  },
  F:  { mean: 5,   sd: 2,   min: 1, max: 10 },
  G:  { mean: 6,   sd: 2,   min: 1, max: 12 },  // Sol = 8
  K:  { mean: 5,   sd: 2,   min: 1, max: 10 },
  M:  { mean: 4,   sd: 1.5, min: 1, max: 8  },  // TRAPPIST-1 = 7, compact common
  // WD: post-main-sequence ejection + tidal disruption destroys most
  // planets; surviving systems are very rare (~10 confirmed in the
  // literature). Debris disks are common but those aren't planets.
  WD: { mean: 0.1, sd: 0.4, min: 0, max: 3  },
  BD: { mean: 1,   sd: 1,   min: 0, max: 4  },  // compact, tight orbits when present
};

// Gameplay tune: cap every system at 8 planets. Sol sits at 8 and reads as
// a full system; pushing past that crowds the system-diagram row and the
// extra outer planets — usually neptunes/jupiters per the insolation-zone
// weights — add visual mass without adding decisions. A/M/O/B/WD/BD are
// already ≤ 8 in the realistic block, so only F/G/K need the clamp.
// The clamp lives on `max` only; means and SDs stay at their realistic
// values, so the distribution body is unchanged and the tune is pure
// upper-tail truncation. `generateSystem` and `generateOverlay` already
// apply `Math.min(countSpec.max, …)` to the sampled count.
const PLANET_COUNT_BY_CLASS_TUNE = {
  F: { max: 8 },
  G: { max: 8 },
  K: { max: 8 },
};

export const PLANET_COUNT_BY_CLASS = mergeTunes(
  PLANET_COUNT_BY_CLASS_REALISTIC,
  PLANET_COUNT_BY_CLASS_TUNE,
);

// Gameplay tune: cap the *sum* of planets across all members of a
// multi-star cluster, since gameplay presents a cluster as one system.
// No realistic peer — physical planet formation has no cluster-level
// budget; each star's count is independent (modulated by the realistic
// COMPANION_PLANET_SUPPRESSION above for binary-stability effects).
//
// Allocation is primary-first: the heaviest member (cluster.members[0])
// rolls under the per-star clamp as usual, the secondary's clamp tightens
// to whatever budget remains, then tertiary+. Singleton clusters (~82% of
// the catalog) see no change — their budget equals the per-star clamp.
export const MAX_PLANETS_PER_CLUSTER = 8;

// Inner/outer orbital bounds (AU) per stellar class.
//
// Inner edge: thermal-survival limit — closer than this and the body
// either tidally disrupts or vaporizes on geologically relevant
// timescales. Scales with stellar luminosity (∝ √L roughly).
//
// Outer edge: practical cutoff for what the game cares about. Real
// systems extend further (Oort cloud, scattered disc) but bodies past
// the gas-giant zone matter less for 4X gameplay.
//
// spacingRatio: period ratio between consecutive planets (P_n+1 / P_n).
// Sampled log-normal: exp(N(log(mean), sd)). Kepler multis cluster around
// 1.5–2.5; Sol's average is ~2.1. SD is in log space.
const ORBITAL_GEOMETRY_BY_CLASS_REALISTIC = {
  O:  { innerEdgeAu: 0.5,   outerEdgeAu: 80, spacingRatio: { mean: 1.9, sd: 0.3 } },
  B:  { innerEdgeAu: 0.3,   outerEdgeAu: 70, spacingRatio: { mean: 1.9, sd: 0.3 } },
  A:  { innerEdgeAu: 0.10,  outerEdgeAu: 60, spacingRatio: { mean: 1.9, sd: 0.3 } },
  F:  { innerEdgeAu: 0.05,  outerEdgeAu: 50, spacingRatio: { mean: 1.9, sd: 0.3 } },
  G:  { innerEdgeAu: 0.04,  outerEdgeAu: 40, spacingRatio: { mean: 1.9, sd: 0.3 } },
  K:  { innerEdgeAu: 0.03,  outerEdgeAu: 30, spacingRatio: { mean: 1.8, sd: 0.3 } },
  M:  { innerEdgeAu: 0.008, outerEdgeAu: 8,  spacingRatio: { mean: 1.6, sd: 0.3 } },
  WD: { innerEdgeAu: 0.005, outerEdgeAu: 5,  spacingRatio: { mean: 1.7, sd: 0.4 } },
  BD: { innerEdgeAu: 0.001, outerEdgeAu: 0.5, spacingRatio: { mean: 1.4, sd: 0.3 } },
};

// Gameplay tune: push the M-dwarf inner edge outward. M dwarfs are ~60%
// of the catalog and a 0.008 AU inner edge lets their tight spacing pack
// 3–4 planets all inside S>1.5 before reaching anywhere interesting —
// which is why 87.6% of all terrestrials end up hot-zone and 35% of
// procgen planets are `desert`. 0.02 AU is still inside Mercury-equivalent
// insolation around an M dwarf, but lets the spacing walk reach the
// temperate band more often, surfacing more habitable-zone worlds.
const ORBITAL_GEOMETRY_BY_CLASS_TUNE = {
  M: { innerEdgeAu: 0.02 },
};

export const ORBITAL_GEOMETRY_BY_CLASS = mergeTunes(
  ORBITAL_GEOMETRY_BY_CLASS_REALISTIC,
  ORBITAL_GEOMETRY_BY_CLASS_TUNE,
);

// Conservative habitable-zone bounds (AU). Not used at runtime — species
// tolerance computes habitability per-species. Included here so the
// Architect can bias the "temperate" insolation zone toward rocky worlds
// rather than (say) sub-Neptunes.
export const HABITABLE_ZONE_AU = {
  O:  [50,    100  ],
  B:  [20,     50  ],
  A:  [ 2.5,    4.0],
  F:  [ 1.3,    2.0],
  G:  [ 0.95,   1.4],  // Sol baseline
  K:  [ 0.4,    0.9],
  M:  [ 0.05,   0.3],
  WD: [ 0.01,   0.02],
  BD: [ 0.002,  0.01],
};

// ---------------------------------------------------------------------------
// Per-planet sampling
// ---------------------------------------------------------------------------

// Planet "type" taxonomy used only inside the Architect to sample mass
// and radius. The Filler later maps mass + radius + insolation onto the
// runtime WorldClass enum (rocky / ocean / ice / desert / lava /
// gas_dwarf / gas_giant / ice_giant). Types here are about mass/radius;
// world classes are about surface character.
export const PLANET_TYPES = ['hot_rocky', 'rocky', 'super_earth', 'sub_neptune', 'neptune', 'jupiter'];

// Type weights per insolation zone. Insolation = stellar_flux_at_planet
// in Earth units (Earth at 1 AU around Sol = 1.0).
//
// Architect samples a planet's type at orbital distance a by:
//   1. compute S = stellar_luminosity_LSun / a²
//   2. find the largest insolationMin <= S
//   3. multiply the zone's weights by the host's TYPE_MULTIPLIER_BY_CLASS
//   4. renormalize and sample from the weighted distribution
//
// Bands chosen so Mercury (S≈7) lands in 'warm', Earth (S=1) in
// 'temperate', Mars (S≈0.43) on the temperate/cool boundary, Jupiter
// (S≈0.037) in 'cool', Neptune (S≈0.001) in 'deep_cold'.
//
// Authored as a named record so the tune block can override a single zone
// without restating the others; exported as an array (hot→cold order) for
// the architect's largest-insolationMin-wins lookup. Insertion order is
// preserved by JS engines, so the export stays correctly ordered.
const TYPE_WEIGHTS_BY_INSOLATION_REALISTIC = {
  // Hot zone (S > 100): closer than Mercury. Hot rockies dominate;
  // hot Jupiters are famously rare — Wright et al. 2012 / Cumming et al.
  // 2008 / Mayor et al. 2011 converge on ~1% occurrence around Sun-likes,
  // which sets `jupiter` here at 0.01 once normalized over the zone.
  hot:       { insolationMin: 100,  weights: { hot_rocky: 0.45, rocky: 0.05, super_earth: 0.29, sub_neptune: 0.15, neptune: 0.05, jupiter: 0.01 } },
  // Warm (10–100): inner-system, Kepler's "radius valley" sits here.
  warm:      { insolationMin: 10,   weights: { hot_rocky: 0.05, rocky: 0.20, super_earth: 0.35, sub_neptune: 0.30, neptune: 0.07, jupiter: 0.03 } },
  // Temperate (0.5–10): habitable-adjacent for most stellar classes.
  temperate: { insolationMin: 0.5,  weights: { hot_rocky: 0,    rocky: 0.40, super_earth: 0.30, sub_neptune: 0.20, neptune: 0.07, jupiter: 0.03 } },
  // Cool (0.05–0.5): outer ice line — gas/ice giant zone for Sun-likes.
  cool:      { insolationMin: 0.05, weights: { hot_rocky: 0,    rocky: 0.20, super_earth: 0.15, sub_neptune: 0.20, neptune: 0.25, jupiter: 0.20 } },
  // Deep cold (<0.05): outer system; giants dominate.
  deep_cold: { insolationMin: 0,    weights: { hot_rocky: 0,    rocky: 0.10, super_earth: 0.05, sub_neptune: 0.15, neptune: 0.35, jupiter: 0.35 } },
};

// Gameplay tune: lift the temperate-zone rocky weight from 0.40 → 0.50.
// Combined with the M-dwarf inner-edge push above (more terrestrials
// reaching this zone in the first place), this is the main lever for
// η_Earth. Weights don't need to sum to 1 — sampleWeighted normalizes
// at draw time — so this just biases the categorical without renormalizing
// the realistic block's siblings by hand.
const TYPE_WEIGHTS_BY_INSOLATION_TUNE = {
  temperate: { weights: { rocky: 0.50 } },
};

export const TYPE_WEIGHTS_BY_INSOLATION = Object.values(mergeTunes(
  TYPE_WEIGHTS_BY_INSOLATION_REALISTIC,
  TYPE_WEIGHTS_BY_INSOLATION_TUNE,
));

// Per-stellar-class multipliers on the insolation weights above.
// M dwarfs are giant-poor (Dressing observed hot-Jupiter rate ~0.3%
// vs 1% around G stars) and skewed toward small worlds. A/B/O stars
// host more giants (disk masses scale with stellar mass). WD systems
// are weird — surviving close-in planets are typically rocky remnants
// of stripped giants.
//
// Applied as a per-type multiplier on the zone weights, then
// renormalized before sampling.
export const TYPE_MULTIPLIER_BY_CLASS = {
  O:  { hot_rocky: 0.3, rocky: 0.3, super_earth: 0.6, sub_neptune: 0.8, neptune: 1.3, jupiter: 1.5 },
  B:  { hot_rocky: 0.3, rocky: 0.3, super_earth: 0.6, sub_neptune: 0.8, neptune: 1.3, jupiter: 1.5 },
  A:  { hot_rocky: 0.5, rocky: 0.5, super_earth: 0.7, sub_neptune: 0.9, neptune: 1.3, jupiter: 1.5 },
  F:  { hot_rocky: 0.8, rocky: 0.8, super_earth: 0.9, sub_neptune: 1.0, neptune: 1.1, jupiter: 1.2 },
  G:  { hot_rocky: 1.0, rocky: 1.0, super_earth: 1.0, sub_neptune: 1.0, neptune: 1.0, jupiter: 1.0 }, // baseline
  K:  { hot_rocky: 1.0, rocky: 1.0, super_earth: 1.0, sub_neptune: 1.0, neptune: 0.8, jupiter: 0.7 },
  M:  { hot_rocky: 1.2, rocky: 1.2, super_earth: 1.0, sub_neptune: 0.8, neptune: 0.5, jupiter: 0.3 },
  WD: { hot_rocky: 0.3, rocky: 0.8, super_earth: 1.0, sub_neptune: 1.0, neptune: 0.8, jupiter: 0.5 },
  BD: { hot_rocky: 1.5, rocky: 1.2, super_earth: 0.8, sub_neptune: 0.5, neptune: 0.2, jupiter: 0.1 },
};

// Mass and radius sampling specs per planet type.
//
// Mass in M⊕, radius in R⊕. Real distributions are log-normal; the
// Architect should sample log(value) ~ N(log(mean), sd / mean) and then
// clamp to [min, max]. (Quick approximation: linear normal works fine
// for low SD/mean ratios — fine for terrestrial types, less so for
// gas giants where SD ≈ mean.) Comments call out the calibration anchor.
export const PHYSICAL_SPEC_BY_TYPE = {
  // Mercury, Venus close-in analogs. Small + dense.
  hot_rocky:   { massEarth: { mean: 0.6, sd: 0.7, min: 0.05, max: 4  },
                 radiusEarth: { mean: 0.8, sd: 0.4, min: 0.3, max: 1.6 } },
  // Earth, Mars, Venus. The "Earth-like" prior.
  rocky:       { massEarth: { mean: 1.0, sd: 0.8, min: 0.1,  max: 4  },
                 radiusEarth: { mean: 1.0, sd: 0.4, min: 0.4, max: 1.8 } },
  // Kepler-22b, GJ 1214b-class. 1.5–2.5 R⊕, ambiguous composition.
  super_earth: { massEarth: { mean: 5,   sd: 3,   min: 1.5,  max: 12 },
                 radiusEarth: { mean: 1.7, sd: 0.4, min: 1.2, max: 2.5 } },
  // GJ 436b, K2-18b. The "mini-Neptune" plateau just above radius valley.
  sub_neptune: { massEarth: { mean: 12,  sd: 8,   min: 5,    max: 30 },
                 radiusEarth: { mean: 2.8, sd: 0.6, min: 2,   max: 4   } },
  // Uranus/Neptune analogs.
  neptune:     { massEarth: { mean: 25,  sd: 15,  min: 15,   max: 60 },
                 radiusEarth: { mean: 4.5, sd: 1,   min: 3.5, max: 6.5 } },
  // Jupiter through hot-Jupiter superjovians. SD ~ mean reflects the
  // wide spread; log-normal sampling recommended.
  jupiter:     { massEarth: { mean: 250, sd: 250, min: 60,   max: 3000 },
                 radiusEarth: { mean: 12,  sd: 3,   min: 8,   max: 20  } },
};

// Moon count per planet type. Sampled as Poisson(mean) and clamped to
// [0, max]. Poisson rather than truncated-normal because moon counts are
// non-negative integers with variance ≈ mean — the natural shape for a
// count process. A truncated-normal with mean near 0 would lift the
// observed mean ~10-20% above the prior (clamped negative draws round
// to 0, raising the post-clamp mean); see audit-procgen.mjs.
//
// Anchored to Sol: Jupiter (4 Galilean + many smaller; capped at 15
// "interesting" moons since the rest are <50 km irregular fragments),
// Earth (1), Mercury (0), Saturn (large + Titan + Enceladus).
//
// Hot-zone planets get fewer moons — tides strip them within ~Roche
// limit timescales. Outer gas giants accumulate moons from their disk +
// captured planetesimals.
export const MOON_COUNT_BY_TYPE = {
  hot_rocky:   { mean: 0,   max: 1  },  // Poisson(0) is degenerate-zero — Mercury/Venus
  rocky:       { mean: 0.5, max: 3  },  // Earth=1, Mars=2 (tiny), Venus=0
  super_earth: { mean: 1,   max: 4  },
  sub_neptune: { mean: 2,   max: 6  },
  neptune:     { mean: 4,   max: 10 },  // Uranus has 5 major
  jupiter:     { mean: 7,   max: 15 },  // Sol Jupiter ~4 Galilean
};

// ---------------------------------------------------------------------------
// Surface character thresholds (read by the Filler, not the Architect)
// ---------------------------------------------------------------------------

// Each body draws a seeded `r_w ∈ [0, 1)` ("water budget") that partitions
// the terrestrial space into rocky / ocean / desert by zone. Realistic
// values follow the rough consensus that temperate-zone worlds are roughly
// half rocky-like, with the remainder split between ocean-rich and desert.
// Hot-zone retention is a single threshold — most baked worlds lose their
// volatiles, but a small fraction (Venus-class hothouse) hangs onto enough
// water to read as rocky rather than desert.
const WATER_BUDGET_THRESHOLDS_REALISTIC = {
  // Hot zone (S > 1.5): `r_w < desertMax` → desert, else rocky.
  hot:       { desertMax: 0.7 },
  // Temperate zone (0.1 < S < 1.5): split into three with two cuts.
  //   r_w < rockyMax            → rocky (Earth-like)
  //   rockyMax ≤ r_w < oceanMax → ocean (water-rich)
  //   r_w ≥ oceanMax            → desert
  // Realistic: 50% rocky / 30% ocean / 20% desert.
  temperate: { rockyMax: 0.5, oceanMax: 0.8 },
};

// Gameplay tune: bring oceans up. They're visually striking and currently
// only 2% of all procgen planets — squeezed twice (only 12% of terrestrials
// reach the temperate zone, and only 30% of those become ocean). Shifting
// to 40/30/30 rocky/ocean/desert ≈ doubles the ocean rate at the source.
// Hot zone is left realistic — bumping hothouse-rocky too much would make
// inner-system worlds feel uniform.
const WATER_BUDGET_THRESHOLDS_TUNE = {
  temperate: { rockyMax: 0.4, oceanMax: 0.7 },
};

export const WATER_BUDGET_THRESHOLDS = mergeTunes(
  WATER_BUDGET_THRESHOLDS_REALISTIC,
  WATER_BUDGET_THRESHOLDS_TUNE,
);

// ---------------------------------------------------------------------------
// Universal orbital flavor
// ---------------------------------------------------------------------------

// These distributions don't vary by stellar class — they're per-body
// dynamics that physics doesn't strongly favor by host type. The
// Architect samples one of each per body it generates.

// Two-mode mixture: 95% of planets are near-circular ("peas in a pod"
// multis, dynamically settled by mutual interactions; Weiss 2018), 5%
// come from the long-tail (single-planet systems, scattered worlds,
// migrated hot Jupiters — HD 80606b sits at e=0.93, GJ 876d at e=0.025
// despite a same-system neighbor at e=0.32). A single normal can't
// capture this — it either undercounts the tail or overcounts the bulk.
// Sampled by sampleMixture in prng.mjs.
const ECCENTRICITY_REALISTIC = {
  primary:   { mean: 0.04, sd: 0.05, min: 0, max: 0.9, weight: 0.95 },
  secondary: { mean: 0.40, sd: 0.20, min: 0, max: 0.9, weight: 0.05 },
};

// Gameplay tune: cap the eccentric mode's max at 0.6. Real Kepler
// data extends to e=0.93 (HD 80606b) but for 4X gameplay a planet whose
// perihelion-to-aphelion insolation varies by 30× has habitability
// windows too short to design a colonization mechanic around. The 0.6
// ceiling keeps the dramatic-orbit flavor (still e=0.5 worlds, still
// noticeable seasons) while removing the unplayable tail. The bulk
// 95% near-circular mode is untouched.
const ECCENTRICITY_TUNE = {
  secondary: { max: 0.6 },
};

export const ECCENTRICITY = mergeTunes(ECCENTRICITY_REALISTIC, ECCENTRICITY_TUNE);

// Inclination off the host's invariant plane, degrees. Real systems are
// near-coplanar (sigma ~1–3°); the long tail covers misaligned hot
// Jupiters and dynamical perturbations.
export const INCLINATION_DEG = { mean: 0, sd: 2, min: 0, max: 30 };

// Axial tilt in degrees. Sol terrestrials span 0–25°; gas giants 3–28°;
// Uranus is 97° (single dramatic outlier). Sample from a mixture: most
// pick from N(20, 15), 5% from U(60, 180) for the dramatic cases.
// Architect can choose to implement the mixture or use this simpler form.
export const AXIAL_TILT_DEG = { mean: 20, sd: 20, min: 0, max: 180 };

// Orbital phase (starting angle around the orbit) — uniform 0..360. Each
// body picks its own so the diagrammatic system view doesn't comb-align.
export const ORBITAL_PHASE_DEG = { min: 0, max: 360 };

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

// Seed-suffix hook. The Filler and Architect mix this into every per-body
// PRNG seed: seed = hash32(body.id + field + PROCGEN_VERSION). Bumping
// the version reseeds the whole galaxy without changing CSV ids. Per-
// generator suffixes can be layered on top by individual generators that
// want to be re-rollable independently.
export const PROCGEN_VERSION = 'v6';

// ---------------------------------------------------------------------------
// Belts (asteroid / ice / debris) — system-level structural bands
// ---------------------------------------------------------------------------

export const BELT_CLASSES = ['asteroid', 'ice', 'debris'];

// Per-stellar-class occurrence probability for each belt class. Rolled
// independently per belt class — a system can host any combination of
// the three. Belts represent NOTABLE structural bands worth a player's
// attention (resource clusters, debris fields with stories), not every
// system's background Kuiper-analog. Sol's Main Belt counts as notable
// (named, hand-curated); Sol's Kuiper Belt does not. These rates are
// pulled down from the underlying physical occurrence stats by an order
// of magnitude — most stars have *some* belt structure, but only a
// minority host one that reads as a navigable / mine-able landmark in
// the game. Debris disks stay relatively elevated around A/B/F stars
// since the famous ones (Vega, Fomalhaut, β Pic) are notable for a
// reason: they're visually dramatic at our scale.
export const BELT_OCCURRENCE_BY_CLASS = {
  O:  { asteroid: 0.08, ice: 0.12, debris: 0.25 },
  B:  { asteroid: 0.10, ice: 0.15, debris: 0.22 },
  A:  { asteroid: 0.12, ice: 0.18, debris: 0.20 },
  F:  { asteroid: 0.18, ice: 0.18, debris: 0.12 },
  G:  { asteroid: 0.22, ice: 0.15, debris: 0.05 },
  K:  { asteroid: 0.22, ice: 0.15, debris: 0.05 },
  M:  { asteroid: 0.15, ice: 0.12, debris: 0.03 },
  WD: { asteroid: 0.05, ice: 0.05, debris: 0.02 },
  BD: { asteroid: 0.05, ice: 0.05, debris: 0.02 },
};

// Belt extent in AU, scaled by stellar luminosity (∝ √L roughly — the
// snow line and rocky-zone boundary both move outward with hotter
// stars). innerFrac / outerFrac are multiplied by the host's outerEdgeAu
// from ORBITAL_GEOMETRY_BY_CLASS to get the band's AU bounds. Mass is
// in M⊕, log-uniform between min and max.
//
// Asteroid: between the rocky and giant zones (0.05–0.10× outer edge).
// Ice: past the giant zone (0.75–1.20× outer edge — extends past
// the architect's planet-placement cutoff). Debris: a wide warm band
// straddling the planet zone (0.10–0.50×).
export const BELT_PLACEMENT = {
  asteroid: { innerFrac: 0.05, outerFrac: 0.10, mass: { min: 0.0001, max: 0.01 } },
  ice:      { innerFrac: 0.75, outerFrac: 1.25, mass: { min: 0.01,   max: 0.3  } },
  debris:   { innerFrac: 0.10, outerFrac: 0.50, mass: { min: 0.001,  max: 0.05 } },
};

// Resource priors per belt class. Sampled as truncated normals,
// rounded to integer, clamped [0, 10]. Asteroid belts skew metals/
// silicates; ice belts dominate on volatiles; debris fields sit in the
// middle with elevated exotics (processed-material proxy).
const BELT_RESOURCE_PRIORS_REALISTIC = {
  asteroid: {
    resMetals:        { mean: 7, sd: 2, min: 0, max: 10 },
    resSilicates:     { mean: 6, sd: 2, min: 0, max: 10 },
    resVolatiles:     { mean: 1, sd: 1, min: 0, max: 10 },
    resRareEarths:    { mean: 4, sd: 2, min: 0, max: 10 },
    resRadioactives:  { mean: 3, sd: 2, min: 0, max: 10 },
    resExotics:       { mean: 1, sd: 1, min: 0, max: 10 },
  },
  ice: {
    resMetals:        { mean: 1, sd: 1, min: 0, max: 10 },
    resSilicates:     { mean: 1, sd: 1, min: 0, max: 10 },
    resVolatiles:     { mean: 9, sd: 1, min: 0, max: 10 },
    resRareEarths:    { mean: 1, sd: 1, min: 0, max: 10 },
    resRadioactives:  { mean: 1, sd: 1, min: 0, max: 10 },
    resExotics:       { mean: 2, sd: 2, min: 0, max: 10 },
  },
  debris: {
    resMetals:        { mean: 4, sd: 2, min: 0, max: 10 },
    resSilicates:     { mean: 4, sd: 2, min: 0, max: 10 },
    resVolatiles:     { mean: 3, sd: 2, min: 0, max: 10 },
    resRareEarths:    { mean: 2, sd: 2, min: 0, max: 10 },
    resRadioactives:  { mean: 2, sd: 2, min: 0, max: 10 },
    resExotics:       { mean: 3, sd: 2, min: 0, max: 10 },
  },
};

// Gameplay tune: belts should be strategic mining targets that DOMINATE
// their resource niche, not generic "any-resource" sources roughly equal
// to planet surface mining. The realistic priors give a rocky planet
// (5/6/3/4/3/1) higher per-cell metal yield than an asteroid belt
// (7/6/1/4/3/1) once volumetric extraction factors in — so a player
// thinking "where do I send the mining fleet" picks planets every time
// and belts feel decorative. Bumps:
//   - asteroid resMetals 7→8 (asteroid belt = THE strategic metal source)
//   - ice resVolatiles 9→10 (ice belts = THE volatile source, max scale)
//   - debris resExotics 3→5 (debris fields = THE processed-material source)
// Each tune makes one belt class the unambiguous best option for one
// resource category. Other resources untouched.
const BELT_RESOURCE_PRIORS_TUNE = {
  asteroid: { resMetals:    { mean: 8  } },
  ice:      { resVolatiles: { mean: 10 } },
  debris:   { resExotics:   { mean: 5  } },
};

export const BELT_RESOURCE_PRIORS = mergeTunes(
  BELT_RESOURCE_PRIORS_REALISTIC,
  BELT_RESOURCE_PRIORS_TUNE,
);

// ---------------------------------------------------------------------------
// Rings — per-planet ring systems (0 or 1)
// ---------------------------------------------------------------------------

// Per-planet-type probability of having a ring system, and the
// conditional class weights when one exists. Dust rings are deliberately
// not modeled — the weights only cover the dramatic 'ice' (Saturn-style)
// and 'debris' (Uranus/Neptune-style, but more striking than Sol's faint
// versions) varieties that have visual + gameplay payoff.
//
// REALISTIC = physical-presence rates. Every outer giant in Sol has rings
// (Saturn iconic, Jupiter/Uranus/Neptune faint), and Schlichting & Chang
// 2011 estimate most giants outside ~5 AU should carry shepherded ring
// material. Realistic super-earth + rocky ring detections (J1407b, Saturn-
// class around super-earth-mass) anchor the lower end. These rates assume
// "any ring system at all, irrespective of how visible it is."
const RING_OCCURRENCE_BY_TYPE_REALISTIC = {
  hot_rocky:   { p: 0.005, weights: { ice: 0.0,  debris: 1.0  } },  // tidally disrupted; rare
  rocky:       { p: 0.01,  weights: { ice: 0.0,  debris: 1.0  } },
  super_earth: { p: 0.05,  weights: { ice: 0.30, debris: 0.70 } },
  sub_neptune: { p: 0.30,  weights: { ice: 0.75, debris: 0.25 } },
  neptune:     { p: 0.70,  weights: { ice: 0.80, debris: 0.20 } },
  jupiter:     { p: 0.80,  weights: { ice: 0.65, debris: 0.35 } },  // Sol giants = 4/4
};

// Gameplay tune: rings are filtered by perception, not added by gameplay
// preference. Most physical ring systems are sub-pixel at our zoom and
// would only register as visual noise, so the tune REDUCES the realistic
// physical rate down to "rings the player can actually see and read as
// rings." Direction flipped from most tune blocks — usually a tune
// pushes AWAY from realistic toward game-feel; here, the realistic rate
// is more aspirational than perceptually useful, and the tune brings us
// back to "what the renderer can carry at this scale."
//
// Exception: super_earth gets bumped UP toward physical-presence (0.05 →
// 0.07) rather than filtered down. A ringed Earth-mass world is one of
// the most iconic "settle here, look at the sky" beats in SF, and at the
// previous 0.025 game rate we had zero ringed temperate Earth-analogs in
// the entire galaxy. At 0.07 the galaxy gets ~95 ringed super-earths,
// some fraction of which land in the temperate band — recurring enough
// to feel like a real planet-class rather than a paper rarity.
const RING_OCCURRENCE_BY_TYPE_TUNE = {
  hot_rocky:   { p: 0.002 },
  rocky:       { p: 0.005 },
  super_earth: { p: 0.07  },
  sub_neptune: { p: 0.06  },
  neptune:     { p: 0.20  },
  jupiter:     { p: 0.30  },
};

export const RING_OCCURRENCE_BY_TYPE = mergeTunes(
  RING_OCCURRENCE_BY_TYPE_REALISTIC,
  RING_OCCURRENCE_BY_TYPE_TUNE,
);

// Ring extent in multiples of the host planet's radius. Inner edge sits
// above the Roche limit (~1.1–1.5 R_p depending on density); outer edge
// inside the synchronous-orbit boundary for ice rings (Saturn's F ring
// ≈ 2.3 R_S, well inside synchronous). Debris rings are narrower (Uranus
// epsilon, Neptune Adams ≈ 2.0 R_p), reflecting their shepherded origin.
// iceFraction is set per class — Saturn ≈ 0.95; Uranus / Neptune ≈ 0.1.
export const RING_EXTENT = {
  ice:    { inner: { mean: 1.20, sd: 0.10, min: 1.05, max: 1.5 },
            outer: { mean: 2.30, sd: 0.20, min: 1.6,  max: 3.0 },
            iceFraction: { mean: 0.92, sd: 0.05, min: 0.6, max: 0.99 } },
  debris: { inner: { mean: 1.70, sd: 0.15, min: 1.3,  max: 2.1 },
            outer: { mean: 2.10, sd: 0.20, min: 1.5,  max: 2.8 },
            iceFraction: { mean: 0.15, sd: 0.10, min: 0,   max: 0.4 } },
};

// ---------------------------------------------------------------------------
// Surface composition — water / ice fraction per world class
// ---------------------------------------------------------------------------

// Fraction of surface covered by liquid water. Distinct from iceFraction
// (frozen surface water). Gas/ice giants and gas dwarfs are missing from
// the table on purpose — they have no surface and the Filler leaves both
// fields null for them.
//
// Anchored on Sol: Earth 0.71, Mars 0, Venus 0 (vaporized), Mercury 0.
export const WATER_FRACTION_BY_CLASS = {
  ocean:   { mean: 0.92, sd: 0.05, min: 0.6,  max: 0.99 },
  rocky:   { mean: 0.55, sd: 0.20, min: 0.10, max: 0.85 },  // Earth = 0.71
  desert:  { mean: 0.02, sd: 0.03, min: 0,    max: 0.10 },  // Mars-class
  ice:     { mean: 0,    sd: 0,    min: 0,    max: 0    },  // water is frozen — see ICE_FRACTION
  lava:    { mean: 0,    sd: 0,    min: 0,    max: 0    },  // vaporized
};

// Fraction of surface covered by water ice / frozen volatiles. Worlds in
// the `ice` class are surface-dominated by it (Europa 1.0, Ganymede 1.0,
// Enceladus 1.0); rocky worlds carry polar caps (Earth ~0.10); desert
// worlds carry trace caps (Mars ~0.02); ocean worlds get small caps too.
export const ICE_FRACTION_BY_CLASS = {
  ice:     { mean: 0.92, sd: 0.08, min: 0.5,  max: 1.0  },
  ocean:   { mean: 0.05, sd: 0.05, min: 0,    max: 0.20 },
  rocky:   { mean: 0.08, sd: 0.08, min: 0,    max: 0.30 },  // Earth = 0.10
  desert:  { mean: 0.02, sd: 0.03, min: 0,    max: 0.10 },  // Mars-class
  lava:    { mean: 0,    sd: 0,    min: 0,    max: 0    },
};

// ---------------------------------------------------------------------------
// Albedo — surface reflectivity 0..1
// ---------------------------------------------------------------------------

// Bond albedo by world class. Anchors: Mercury 0.07 (dark basalt), Earth
// 0.31 (mixed cloud + ocean + land), Mars 0.25 (red dust), Venus 0.77
// (thick clouds — outlier we don't fit), Jupiter 0.34, Saturn 0.34,
// Europa 0.67, Enceladus 0.99 (fresh ice).
//
// Note albedo feeds back into avgSurfaceTempK via Stefan-Boltzmann (already
// wired in procgen.mjs), so the temp pass must run AFTER albedo is filled.
export const ALBEDO_BY_CLASS = {
  rocky:     { mean: 0.30, sd: 0.10, min: 0.10, max: 0.55 },
  ocean:     { mean: 0.20, sd: 0.05, min: 0.10, max: 0.35 },
  desert:    { mean: 0.30, sd: 0.10, min: 0.10, max: 0.50 },
  ice:       { mean: 0.65, sd: 0.15, min: 0.30, max: 0.99 },
  lava:      { mean: 0.10, sd: 0.05, min: 0.05, max: 0.25 },
  gas_dwarf: { mean: 0.30, sd: 0.10, min: 0.15, max: 0.55 },
  ice_giant: { mean: 0.30, sd: 0.05, min: 0.20, max: 0.45 },
  gas_giant: { mean: 0.35, sd: 0.10, min: 0.15, max: 0.60 },
};

// ---------------------------------------------------------------------------
// Tectonic activity — scalar 0..1 proxy for ongoing geology
// ---------------------------------------------------------------------------

// Sol convention (hand-curated): Earth 0.8, Venus 0.6, Mars 0.1, Moon 0,
// Io 1.0 (tidally heated lava world). Driven by mass (bigger → warmer core,
// longer-lived) modulated by surface character. Gas/ice giants and gas
// dwarfs aren't in the table — null for them.
//
// Filler scales the per-class draw by sqrt(massEarth / Earth) so a 5 M⊕
// super-Earth ranks higher than a Mars-mass rocky world at the same class.
export const TECTONIC_ACTIVITY_BY_CLASS = {
  rocky:   { mean: 0.45, sd: 0.30, min: 0,    max: 1.0 },
  ocean:   { mean: 0.55, sd: 0.25, min: 0.05, max: 1.0 },  // plate tectonics ~ water present
  desert:  { mean: 0.15, sd: 0.20, min: 0,    max: 0.8 },  // mostly dormant
  ice:     { mean: 0.10, sd: 0.15, min: 0,    max: 0.6 },
  lava:    { mean: 0.85, sd: 0.15, min: 0.4,  max: 1.0 },  // active by definition
};

// ---------------------------------------------------------------------------
// Rotation period — hours, with probabilistic tidal locking
// ---------------------------------------------------------------------------

// Free-rotation per-class log-normal. Anchors: Earth 24, Mars 24.6,
// Jupiter 9.9, Saturn 10.7, Uranus 17, Neptune 16. Venus's 5832 h
// retrograde spin is the long-tail outlier — reachable through the sd
// but not the mode.
export const ROTATION_PERIOD_HOURS_BY_CLASS = {
  rocky:     { mean: 26, sd: 30, min: 8,  max: 200 },
  ocean:     { mean: 26, sd: 30, min: 8,  max: 200 },
  desert:    { mean: 26, sd: 30, min: 8,  max: 200 },
  ice:       { mean: 30, sd: 40, min: 8,  max: 300 },
  lava:      { mean: 24, sd: 30, min: 8,  max: 200 },
  gas_dwarf: { mean: 16, sd: 8,  min: 8,  max: 40  },
  ice_giant: { mean: 16, sd: 4,  min: 10, max: 24  },
  gas_giant: { mean: 11, sd: 3,  min: 8,  max: 20  },
};

// Tidal-locking probability ramps with `tidalLockProxy(M_star, a_AU)` from
// astrophysics.mjs. proxy ≤ proxyLocked → locked with probability ~1;
// proxy ≥ proxyFree → never locked. Log-interpolated between.
//
// proxyLocked 0.005 ≈ "locks within ~10 Myr around any host" (Mercury,
// M-dwarf HZ planets); proxyFree 2 ≈ "longer than the universe's age"
// (Earth = 1, Mars = 4.5 — already free-rotating in reality).
const TIDAL_LOCK_RANGE_REALISTIC = { proxyLocked: 0.005, proxyFree: 2.0 };

// Gameplay tune: tighten proxyLocked from 0.005 → 0.001. Astrophysically
// the M-dwarf HZ catalog SHOULD be near-universally tide-locked — orbital
// timescales there are short enough that synchronous rotation is the
// inevitable outcome. But M-dwarfs are 61% of our catalog and tide-locked
// terrestrials are colonization-hostile (eternal day/night, atmospheric
// freeze-out on the dark hemisphere, no dynamo-protective rotation). The
// tighter threshold means ~30% of M-dwarf HZ worlds break free into
// Earth-like rotation periods, opening the bulk of the catalog to
// playable colonization without invalidating Mercury or TRAPPIST-1b.
const TIDAL_LOCK_RANGE_TUNE = {
  proxyLocked: 0.001,
};

export const TIDAL_LOCK_RANGE = mergeTunes(TIDAL_LOCK_RANGE_REALISTIC, TIDAL_LOCK_RANGE_TUNE);

// ---------------------------------------------------------------------------
// Surface temperature extremes — min/max around avgSurfaceTempK
// ---------------------------------------------------------------------------

// Fractional swing around avgSurfaceTempK. Earth swing ~80 K on a mean of
// 288 K → frac ~0.28; Mars swing ~150 K on 210 K → frac ~0.71; Mercury
// swing ~600 K on 440 K → frac ~1.4; Venus swing ~5 K on 737 K → frac
// ~0.007 (thick atmosphere homogenizes; we don't fit Venus). Worlds with
// liquid water and thick atmospheres buffer hard; thin-atm worlds swing
// wildly.
//
// Filler: tMin = avg × (1 - swing/2), tMax = avg × (1 + swing/2). Modulated
// by axial tilt + eccentricity (more tilt → bigger swing — gives Uranus
// analogs extreme seasonal variation).
export const TEMP_SWING_FRAC_BY_CLASS = {
  rocky:     { mean: 0.25, sd: 0.10, min: 0.05, max: 0.60 },  // Earth-ish
  ocean:     { mean: 0.10, sd: 0.05, min: 0.05, max: 0.25 },  // ocean buffers
  desert:    { mean: 0.50, sd: 0.20, min: 0.20, max: 1.20 },  // Mars-class thin atm
  ice:       { mean: 0.20, sd: 0.10, min: 0.05, max: 0.50 },
  lava:      { mean: 0.10, sd: 0.05, min: 0.05, max: 0.25 },  // already saturated hot
  gas_dwarf: { mean: 0.05, sd: 0.03, min: 0.02, max: 0.15 },  // cloud-top temps stable
  ice_giant: { mean: 0.05, sd: 0.03, min: 0.02, max: 0.15 },
  gas_giant: { mean: 0.05, sd: 0.03, min: 0.02, max: 0.15 },
};

// ---------------------------------------------------------------------------
// Magnetic field — Gauss at surface
// ---------------------------------------------------------------------------

// Real anchors: Mercury 0.003, Mars 0.00006 (essentially dead), Earth 0.5,
// Jupiter 4.3, Saturn 0.2, Uranus 0.23, Neptune 0.14, Ganymede 0.007.
// Gas giants dwarf terrestrials because their fields are driven by deep
// metallic-hydrogen convection, not core dynamos.
//
// Filler: per-class base draw, multiplied by `tectonicActivity` for
// terrestrials (dead-core worlds → near-zero) and inversely scaled by
// `sqrt(rotationPeriodHours / 24)` (faster spin → stronger dynamo). Gas
// giants ignore both scalings — their field is convective, not core-driven.
export const MAGNETIC_FIELD_GAUSS_BY_CLASS = {
  rocky:     { mean: 0.4,  sd: 0.4,  min: 0,    max: 2.0 },
  ocean:     { mean: 0.5,  sd: 0.5,  min: 0,    max: 2.0 },
  desert:    { mean: 0.02, sd: 0.05, min: 0,    max: 0.5 },  // typically dead cores
  ice:       { mean: 0,    sd: 0,    min: 0,    max: 0   },  // small + dead
  lava:      { mean: 0.3,  sd: 0.3,  min: 0,    max: 1.5 },
  gas_dwarf: { mean: 0.4,  sd: 0.3,  min: 0.05, max: 1.5 },
  ice_giant: { mean: 0.2,  sd: 0.1,  min: 0.05, max: 0.5 },
  gas_giant: { mean: 2.5,  sd: 1.5,  min: 0.5,  max: 6.0 },  // Jupiter 4.3, Saturn 0.2
};

// Per-class multiplier on the dynamo scaling in magneticFieldGaussFor:
//   field = base × tectonicActivity × √(24/rot) × multiplier
// Realistic = 1.0 across the board — Mars (low tect, dead core) lands at
// near-zero G, Earth (high tect, 24h rotation) lands near base. Gas giants
// are unaffected by the tect/rot path so this multiplier doesn't apply
// to them in code; listed here for completeness.
const MAGNETIC_DYNAMO_MULTIPLIER_BY_CLASS_REALISTIC = {
  rocky: 1.0, ocean: 1.0, desert: 1.0, ice: 1.0, lava: 1.0,
  gas_dwarf: 1.0, ice_giant: 1.0, gas_giant: 1.0,
};

// Gameplay tune: habitability floor on water-bearing terrestrials. The
// realistic dynamo chain correctly produces Mars-class weak fields on
// most rocky worlds (tect ~0.5, rot ~26h → 0.48× multiplier on the base
// 0.4 G prior → mean rocky field ~0.19 G). That's astronomically right
// but means ~70% of rocky/ocean worlds have stripped atmospheres and
// hostile colonization conditions — the 4X player is bouncing off worlds
// they should be able to settle. Lifting rocky/ocean by 1.7× pulls the
// rocky mean to ~0.32 G — Earth's 0.5 G is now within one sd, not a 2σ
// outlier. Desert (Mars-class) stays untouched — dead cores should read
// as dead. Lava worlds also untouched — their fields are tidal-heating-
// driven, not relevant for colonization mechanics.
const MAGNETIC_DYNAMO_MULTIPLIER_BY_CLASS_TUNE = {
  rocky: 1.7,
  ocean: 1.7,
};

export const MAGNETIC_DYNAMO_MULTIPLIER_BY_CLASS = mergeTunes(
  MAGNETIC_DYNAMO_MULTIPLIER_BY_CLASS_REALISTIC,
  MAGNETIC_DYNAMO_MULTIPLIER_BY_CLASS_TUNE,
);

// ---------------------------------------------------------------------------
// Greenhouse offset (K above radiative equilibrium at 1 bar)
// ---------------------------------------------------------------------------

// Per-class greenhouse offset at 1 bar surface pressure. The Filler in
// procgen.mjs (avgSurfaceTempFor) multiplies by P_bar^0.3 so thin
// atmospheres get negligible boost and thick atmospheres approach
// Venus-class. Earth at P=1 gets the canonical +33 K.
const GREENHOUSE_K_BY_CLASS_REALISTIC = {
  rocky:  33,    // Earth +33K at 1 bar
  ocean:  50,    // water vapor adds to Earth-class
  desert:  5,    // thin atmosphere baseline
  lava:   80,    // outgassed CO2 / SO2; pressure scaling reaches Venus-class
  ice:     5,    // typically thin / no atmosphere
};

// Gameplay tune: nudge the rocky greenhouse from 33 → 40 K. A few
// percent of procgen rocky worlds land in the 240–270 K avg-temp range —
// astronomically "just past freezing" but unhabitable in 4X game terms.
// Earth-fitted realism puts the offset at exactly 33 K; the +7 K tune
// pulls those marginal rocky worlds across the 273 K threshold without
// breaking Earth (its pressure×offset chain still lands at 288 K within
// rounding once the pressure factor absorbs the bump). No tune on
// ocean/desert/lava/ice — none of those classes have the "just barely
// frozen" gameplay edge case that rocky does.
const GREENHOUSE_K_BY_CLASS_TUNE = {
  rocky: 40,
};

export const GREENHOUSE_K_BY_CLASS = mergeTunes(
  GREENHOUSE_K_BY_CLASS_REALISTIC,
  GREENHOUSE_K_BY_CLASS_TUNE,
);

// ---------------------------------------------------------------------------
// Atmosphere composition — top-3 gases per world class
// ---------------------------------------------------------------------------

// Each world class lists candidate gases with weights. The Filler samples
// without replacement until it has 3 (or until the class runs dry), then
// renormalizes those three fractions to sum to 1.0 — with a per-body
// seeded perturbation so two identical-class worlds don't look identical.
//
// Anchors: Mars 0.95 CO2 / 0.027 N2 / 0.016 Ar (the abiotic-rocky baseline);
// Venus 0.965 CO2 / 0.035 N2; Titan 0.95 N2 / 0.05 CH4; Jupiter 0.90 H2 /
// 0.10 He / trace CH4. Earth's 0.78 N2 / 0.21 O2 is the OUTLIER, not the
// rocky template — O2 at that concentration is a biosignature, produced
// by photosynthesis. Abiotic rocky worlds carry O2 only as a photolysis
// trace (sub-percent). See ATMOSPHERE_O2_BIOTIC_LIFT below for the
// biosphere-conditional uplift.
//
// Sterile of atmosphere = mean=0 columns are excluded entirely (e.g. ice
// worlds rarely carry meaningful atmospheres; their `atm*` stays null).
export const ATMOSPHERE_GASES_BY_CLASS = {
  rocky:     { N2: 5, CO2: 3, Ar: 1, H2O: 1, SO2: 0.5, O2: 0.05 },  // Mars/Venus-like absent life
  ocean:     { N2: 5, H2O: 2, CO2: 1, Ar: 0.5, O2: 0.05 },
  desert:    { CO2: 5, N2: 2, Ar: 1, SO2: 0.5, H2O: 0.3 },  // Mars-class
  ice:       { N2: 4, CH4: 2, CO: 0.5, H2: 0.3 },  // Titan/Triton-class — usually trace
  lava:      { SO2: 4, CO2: 3, H2O: 1, N2: 0.5 },  // Venus / Io-class outgassed
  gas_dwarf: { H2: 6, He: 3, CH4: 0.5, NH3: 0.2 },
  ice_giant: { H2: 6, He: 3, CH4: 0.5, NH3: 0.2 },  // CH4 colors Uranus/Neptune
  gas_giant: { H2: 8, He: 2, CH4: 0.2, NH3: 0.1 },
};

// O2 weight multiplier applied to `rocky`/`ocean` worldClass atmospheres
// when the host carries oxygenic-photosynthesis-grade biosphere. Without
// life, O2 stays at its trace photolysis weight (~0.05); with `complex`
// or `gaian` carbon_aqueous life, weight × 60 ≈ 3, restoring Earth-class
// O2 fractions on planets that should actually have them. Microbial
// carbon_aqueous gets a partial lift (×15 ≈ 0.75) to model early-Earth
// "Great Oxidation transition" worlds where O2 is rising but not dominant.
export const ATMOSPHERE_O2_BIOTIC_LIFT = {
  carbon_aqueous: { microbial: 15, complex: 60, gaian: 60 },
};

// Worlds whose atmosphere is typically too thin to report. `ice` worlds
// like Europa or Pluto carry trace atmospheres but they're not load-bearing
// for surface chemistry; the Filler skips atm fill when surfacePressureBar
// is below this floor.
export const ATMOSPHERE_MIN_PRESSURE_BAR = 0.01;

// ---------------------------------------------------------------------------
// Resources — six 0..10 scalars per world class
// ---------------------------------------------------------------------------

// Same scale and shape as BELT_RESOURCE_PRIORS. Rocky/desert ranks high
// on metals + silicates (Earth = 5/6/7/5/4/0 — though earth's volatiles
// is anomalously high from oceans). Oceans tilt toward volatiles. Ice
// worlds dominate volatiles. Lava worlds get metals + rare earths
// (geological smelting concentrates them). Gas giants/ice giants carry
// deep-atmosphere helium-3 and exotic isotopes — modeled as elevated
// volatiles + exotics.
export const PLANET_RESOURCE_PRIORS_BY_CLASS = {
  rocky: {
    resMetals:        { mean: 5, sd: 2, min: 0, max: 10 },
    resSilicates:     { mean: 6, sd: 2, min: 0, max: 10 },
    resVolatiles:     { mean: 4, sd: 2, min: 0, max: 10 },
    resRareEarths:    { mean: 4, sd: 2, min: 0, max: 10 },
    resRadioactives:  { mean: 3, sd: 2, min: 0, max: 10 },
    resExotics:       { mean: 1, sd: 1, min: 0, max: 10 },
  },
  ocean: {
    resMetals:        { mean: 3, sd: 2, min: 0, max: 10 },
    resSilicates:     { mean: 3, sd: 2, min: 0, max: 10 },
    resVolatiles:     { mean: 8, sd: 2, min: 0, max: 10 },
    resRareEarths:    { mean: 2, sd: 2, min: 0, max: 10 },
    resRadioactives:  { mean: 2, sd: 2, min: 0, max: 10 },
    resExotics:       { mean: 2, sd: 2, min: 0, max: 10 },
  },
  desert: {
    resMetals:        { mean: 5, sd: 2, min: 0, max: 10 },
    resSilicates:     { mean: 7, sd: 2, min: 0, max: 10 },
    resVolatiles:     { mean: 1, sd: 1, min: 0, max: 10 },
    resRareEarths:    { mean: 4, sd: 2, min: 0, max: 10 },
    resRadioactives:  { mean: 4, sd: 2, min: 0, max: 10 },
    resExotics:       { mean: 1, sd: 1, min: 0, max: 10 },
  },
  ice: {
    resMetals:        { mean: 1, sd: 1, min: 0, max: 10 },
    resSilicates:     { mean: 1, sd: 1, min: 0, max: 10 },
    resVolatiles:     { mean: 9, sd: 1, min: 0, max: 10 },
    resRareEarths:    { mean: 1, sd: 1, min: 0, max: 10 },
    resRadioactives:  { mean: 1, sd: 1, min: 0, max: 10 },
    resExotics:       { mean: 3, sd: 2, min: 0, max: 10 },
  },
  lava: {
    resMetals:        { mean: 7, sd: 2, min: 0, max: 10 },
    resSilicates:     { mean: 5, sd: 2, min: 0, max: 10 },
    resVolatiles:     { mean: 1, sd: 1, min: 0, max: 10 },
    resRareEarths:    { mean: 6, sd: 2, min: 0, max: 10 },
    resRadioactives:  { mean: 6, sd: 2, min: 0, max: 10 },
    resExotics:       { mean: 3, sd: 2, min: 0, max: 10 },
  },
  gas_dwarf: {
    resMetals:        { mean: 1, sd: 1, min: 0, max: 10 },
    resSilicates:     { mean: 1, sd: 1, min: 0, max: 10 },
    resVolatiles:     { mean: 8, sd: 2, min: 0, max: 10 },
    resRareEarths:    { mean: 1, sd: 1, min: 0, max: 10 },
    resRadioactives:  { mean: 1, sd: 1, min: 0, max: 10 },
    resExotics:       { mean: 5, sd: 2, min: 0, max: 10 },
  },
  ice_giant: {
    resMetals:        { mean: 1, sd: 1, min: 0, max: 10 },
    resSilicates:     { mean: 1, sd: 1, min: 0, max: 10 },
    resVolatiles:     { mean: 9, sd: 1, min: 0, max: 10 },
    resRareEarths:    { mean: 1, sd: 1, min: 0, max: 10 },
    resRadioactives:  { mean: 1, sd: 1, min: 0, max: 10 },
    resExotics:       { mean: 6, sd: 2, min: 0, max: 10 },
  },
  gas_giant: {
    resMetals:        { mean: 0, sd: 0, min: 0, max: 10 },
    resSilicates:     { mean: 0, sd: 0, min: 0, max: 10 },
    resVolatiles:     { mean: 9, sd: 1, min: 0, max: 10 },  // He-3 etc.
    resRareEarths:    { mean: 0, sd: 0, min: 0, max: 10 },
    resRadioactives:  { mean: 0, sd: 0, min: 0, max: 10 },
    resExotics:       { mean: 7, sd: 2, min: 0, max: 10 },  // metallic-hydrogen layer
  },
};

// ---------------------------------------------------------------------------
// Biosphere — two orthogonal axes: archetype × tier
// ---------------------------------------------------------------------------

// Tiers form an ordered ladder (none < prebiotic < microbial < complex <
// gaian); the runtime can answer "is there any life here?" with a tier
// check and "what kind?" with the archetype check. Sterile worlds carry
// tier=`none` and archetype=null.
export const BIOSPHERE_TIERS = ['none', 'prebiotic', 'microbial', 'complex', 'gaian'];

// All recognized archetypes. Each describes a distinct biochemistry /
// habitat combination — see BIOSPHERE_BY_CLASS for which can appear where.
export const BIOSPHERE_ARCHETYPES = [
  'carbon_aqueous',      // Earth-standard, water + carbon
  'subsurface_aqueous',  // ice-shell ocean (Europa, Enceladus)
  'aerial',              // gas-giant atmospheric (Sagan's floaters)
  'cryogenic',           // methane/ethane solvent (Titan-hypothesized)
  'silicate',            // crystalline mineral metabolism (speculative SF)
  'sulfur',              // sulfur-cycle / thermal vent biology
];

// Per-(worldClass, archetype) rolls. `gate` constrains which insolation
// zone the host body must sit in for this archetype to even consider
// appearing; `occurrenceRate` is P(this archetype takes hold | gate
// satisfied); `tierWeights` is the conditional distribution over non-`none`
// tiers when it does. Each eligible archetype rolls independently per
// body; multiple hits get resolved by highest tier (ties → archetype
// listed earlier wins, so put rarer/more-evocative archetypes first).
//
// Realistic block uses literature-derived rates where possible:
//   - carbon_aqueous: 30-40% of temperate rocky/ocean worlds carry life of
//     SOME tier. Within published f_life envelopes (Lineweaver 2007,
//     Schulze-Makuch & Irwin 2008, Catling & Kasting 2017 — pessimistic
//     ~1%, optimistic ~50%; we sit on the optimistic-but-defensible side).
//   - subsurface_aqueous: Europa/Enceladus/Ganymede make this the most
//     defensible "exotic habitat." Hand & Carlson 2017 estimate "a few
//     percent" of icy moons may host subsurface oceans with chemistry.
//     3% is conservative-optimistic.
//   - sulfur: extension of Earth's chemoautotrophic thermal-vent biology.
//     Real-but-rare; 1-3% is a reasonable extrapolation.
//   - silicate, cryogenic, aerial: speculative SF tropes, no astrobiology
//     consensus or examples. Realistic estimates are <0.1%. We keep them
//     non-zero so the discovery moment exists at all, but they're
//     deeply rare without the gameplay tune.
const BIOSPHERE_BY_CLASS_REALISTIC = {
  rocky: {
    silicate:       { gate: 'hot',       occurrenceRate: 0.001, tierWeights: { prebiotic: 0.70, microbial: 0.25, complex: 0.05 } },
    sulfur:         { gate: null,        occurrenceRate: 0.01,  tierWeights: { microbial: 1.00 } },
    carbon_aqueous: { gate: 'temperate', occurrenceRate: 0.30,  tierWeights: { prebiotic: 0.55, microbial: 0.30, complex: 0.12, gaian: 0.03 } },
  },
  ocean: {
    sulfur:         { gate: null,        occurrenceRate: 0.02,  tierWeights: { microbial: 1.00 } },
    carbon_aqueous: { gate: 'temperate', occurrenceRate: 0.40,  tierWeights: { prebiotic: 0.45, microbial: 0.30, complex: 0.18, gaian: 0.07 } },
  },
  desert: {
    silicate:       { gate: 'hot',       occurrenceRate: 0.001, tierWeights: { prebiotic: 0.70, microbial: 0.25, complex: 0.05 } },
    carbon_aqueous: { gate: 'temperate', occurrenceRate: 0.05,  tierWeights: { prebiotic: 0.80, microbial: 0.20 } },
  },
  ice: {
    subsurface_aqueous: { gate: null,    occurrenceRate: 0.03,  tierWeights: { microbial: 0.85, complex: 0.15 } },
    cryogenic:          { gate: null,    occurrenceRate: 0.005, tierWeights: { prebiotic: 0.80, microbial: 0.20 } },
  },
  lava: {
    silicate:       { gate: null,        occurrenceRate: 0.005, tierWeights: { prebiotic: 0.65, microbial: 0.30, complex: 0.05 } },
    sulfur:         { gate: null,        occurrenceRate: 0.03,  tierWeights: { microbial: 1.00 } },
  },
  gas_dwarf: {
    aerial:         { gate: null,        occurrenceRate: 0.001, tierWeights: { microbial: 0.85, complex: 0.15 } },
  },
  ice_giant: {
    aerial:         { gate: null,        occurrenceRate: 0.0005, tierWeights: { microbial: 0.90, complex: 0.10 } },
  },
  gas_giant: {
    aerial:         { gate: null,        occurrenceRate: 0.001, tierWeights: { microbial: 0.85, complex: 0.15 } },
  },
};

// Gameplay tune: two layers of adjustment over realistic biosphere.
//
// (1) Exotic-archetype boost. Speculative archetypes (silicate, cryogenic,
//     aerial) get bumped 5–50× so they actually appear in a playthrough.
//     Carbon archetypes stay near their literature rates — they don't
//     need an occurrence boost to be interesting; their interest comes
//     from the tier-distribution shift below.
//
// (2) Tier-distribution shift on carbon_aqueous (rocky + ocean). The
//     realistic tail is prebiotic-heavy because Earth itself was prebiotic
//     for ~1 Gyr — astronomically that's where most worlds sit at any
//     snapshot. But from a 4X discovery lens, "organic chemistry without
//     replicating life" is the LEAST interesting tier; the player wants
//     complex+gaian finds as recurring rewards, not once-per-galaxy
//     unicorns. Realistic rocky tier split (55/30/12/3) becomes
//     35/30/25/10; ocean (45/30/18/7) becomes 25/30/30/15. Galaxy goes
//     from ~25 complex + ~11 gaian to ~46 complex + ~21 gaian — about
//     2× the mid-to-late game discovery surface area without inflating
//     the "any life" rate. Desert untouched (a desert world that supports
//     gaian biology would re-class to rocky/ocean by the time it
//     mattered, so the tier cap holds).
//
// (3) Aerial gas-world bump. Gas-giant atmospheric biospheres are a
//     visually-distinctive category (different from any rocky-world
//     life — they show up in atmospheric readouts, not surface). Pushing
//     gas_dwarf 5%→8% and gas_giant 5%→10% adds ~30 more aerial worlds
//     across the galaxy, making them a recurring exploration beat rather
//     than a rare curiosity. Ice_giant stays at the lower 2% (Uranus/
//     Neptune-class atmospheres are colder and less hospitable than
//     warmer gas dwarf / gas giant interiors).
const BIOSPHERE_BY_CLASS_TUNE = {
  rocky: {
    silicate: { occurrenceRate: 0.005 },
    sulfur:   { occurrenceRate: 0.02 },
    carbon_aqueous: {
      tierWeights: { prebiotic: 0.35, microbial: 0.30, complex: 0.25, gaian: 0.10 },
    },
  },
  ocean: {
    sulfur:   { occurrenceRate: 0.03 },
    carbon_aqueous: {
      tierWeights: { prebiotic: 0.25, microbial: 0.30, complex: 0.30, gaian: 0.15 },
    },
  },
  desert: {
    silicate: { occurrenceRate: 0.01 },
  },
  ice: {
    subsurface_aqueous: { occurrenceRate: 0.08 },
    cryogenic:          { occurrenceRate: 0.04 },
  },
  lava: {
    silicate: { occurrenceRate: 0.03 },
    sulfur:   { occurrenceRate: 0.05 },
  },
  gas_dwarf: { aerial: { occurrenceRate: 0.08 } },
  ice_giant: { aerial: { occurrenceRate: 0.02 } },
  gas_giant: { aerial: { occurrenceRate: 0.10 } },
};

export const BIOSPHERE_BY_CLASS = mergeTunes(
  BIOSPHERE_BY_CLASS_REALISTIC,
  BIOSPHERE_BY_CLASS_TUNE,
);

// Gate insolation ranges. `temperate` matches the Architect's "habitable
// adjacent" band; `hot` matches inner-system rocky/desert worlds where
// silicate biochemistry might find energy gradients.
export const BIOSPHERE_GATE_INSOLATION = {
  temperate: { min: 0.1, max: 1.5 },
  hot:       { min: 1.5, max: 200 },
};
