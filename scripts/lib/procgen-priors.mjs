// Procgen priors — the data side of the body-catalog procgen pipeline.
//
// Pure constants, no code. The Architect (in procgen.mjs, planned) reads
// these to sample per-system architecture: how many planets a star is
// likely to host, where they sit in orbit, what mass/radius mix is
// plausible at each insolation, how many moons each planet type carries.
// The Filler reads its own (smaller) prior set; this file is the
// Architect's tuning surface.
//
// Values are calibrated against published exoplanet statistics where
// possible (Dressing & Charbonneau 2015 for M-dwarf occurrence; Petigura
// et al. 2018 / Hsu et al. 2019 for Kepler FGK; Wright et al. 2012 for hot
// Jupiter rate) and adjusted toward Sol-like systems for the G/K bracket
// since Sol is our hand-curated reference. Numbers are game-balance
// defaults — the "tune to taste" knob lives here.
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
export const PLANET_COUNT_BY_CLASS = {
  O:  { mean: 2,   sd: 1.5, min: 0, max: 5  },  // massive, short-lived; observation-limited
  B:  { mean: 2,   sd: 1.5, min: 0, max: 5  },
  A:  { mean: 4,   sd: 2,   min: 0, max: 8  },
  F:  { mean: 5,   sd: 2,   min: 1, max: 10 },
  G:  { mean: 6,   sd: 2,   min: 1, max: 12 },  // Sol = 8
  K:  { mean: 5,   sd: 2,   min: 1, max: 10 },
  M:  { mean: 4,   sd: 1.5, min: 1, max: 8  },  // TRAPPIST-1 = 7, compact common
  WD: { mean: 0.5, sd: 0.8, min: 0, max: 3  },  // mostly debris remnants
  BD: { mean: 1,   sd: 1,   min: 0, max: 4  },  // compact, tight orbits when present
};

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
export const ORBITAL_GEOMETRY_BY_CLASS = {
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
export const TYPE_WEIGHTS_BY_INSOLATION = [
  // Hot zone (S > 100): closer than Mercury. Hot rocky and hot Jupiters.
  { insolationMin: 100, weights: { hot_rocky: 0.40, rocky: 0.05, super_earth: 0.25, sub_neptune: 0.15, neptune: 0.05, jupiter: 0.10 } },
  // Warm (10–100): inner-system, Kepler's "radius valley" sits here.
  { insolationMin: 10,  weights: { hot_rocky: 0.05, rocky: 0.20, super_earth: 0.35, sub_neptune: 0.30, neptune: 0.07, jupiter: 0.03 } },
  // Temperate (0.5–10): habitable-adjacent for most stellar classes.
  { insolationMin: 0.5, weights: { hot_rocky: 0,    rocky: 0.40, super_earth: 0.30, sub_neptune: 0.20, neptune: 0.07, jupiter: 0.03 } },
  // Cool (0.05–0.5): outer ice line — gas/ice giant zone for Sun-likes.
  { insolationMin: 0.05, weights: { hot_rocky: 0,   rocky: 0.20, super_earth: 0.15, sub_neptune: 0.20, neptune: 0.25, jupiter: 0.20 } },
  // Deep cold (<0.05): outer system; giants dominate.
  { insolationMin: 0,   weights: { hot_rocky: 0,    rocky: 0.10, super_earth: 0.05, sub_neptune: 0.15, neptune: 0.35, jupiter: 0.35 } },
];

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

// Moon count per planet type. Sample N(mean, sd), clamp to [0, max].
// Anchored to Sol: Jupiter (4 Galilean + many smaller; capped at 15
// "interesting" moons since the rest are <50 km irregular fragments),
// Earth (1), Mercury (0), Saturn (large + Titan + Enceladus).
//
// Hot-zone planets get fewer moons — tides strip them within ~Roche
// limit timescales. Outer gas giants accumulate moons from their disk +
// captured planetesimals.
export const MOON_COUNT_BY_TYPE = {
  hot_rocky:   { mean: 0,   sd: 0.2, max: 1  },
  rocky:       { mean: 0.5, sd: 0.7, max: 3  },  // Earth=1, Mars=2 (tiny), Venus=0
  super_earth: { mean: 1,   sd: 1,   max: 4  },
  sub_neptune: { mean: 2,   sd: 1.5, max: 6  },
  neptune:     { mean: 4,   sd: 2,   max: 10 },  // Uranus has 5 major
  jupiter:     { mean: 7,   sd: 3,   max: 15 },  // Sol Jupiter ~4 Galilean
};

// ---------------------------------------------------------------------------
// Universal orbital flavor
// ---------------------------------------------------------------------------

// These distributions don't vary by stellar class — they're per-body
// dynamics that physics doesn't strongly favor by host type. The
// Architect samples one of each per body it generates.

// Most planets are near-circular; eccentric (e > 0.3) is the long tail.
// Sol planets all have e < 0.21 (Mercury), most < 0.1.
export const ECCENTRICITY = { mean: 0.05, sd: 0.10, min: 0, max: 0.9 };

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
export const PROCGEN_VERSION = 'v1';
