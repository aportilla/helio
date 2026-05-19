// Shared physical-relation approximations used by the procgen Architect
// and Filler. Kept as one module so the two layers agree on derived
// quantities (insolation, luminosity); divergence here would mean the
// Architect's slot-zone choice doesn't match what the Filler reads when
// classifying world_class later.

// Stellar luminosity in solar units from mass in solar units.
// Piecewise empirical: M dwarfs follow a shallower relation than FGK+
// (Eker et al. 2015). The 0.43 M☉ break point is the conventional
// fully-convective boundary. There's a small (~30%) discontinuity at the
// break — accepted for v1 since neither side is exact.
export function luminositySun(massSun) {
  if (massSun == null || massSun <= 0) return null;
  if (massSun < 0.43) return 0.23 * Math.pow(massSun, 2.3);
  return Math.pow(massSun, 4);
}

// Insolation in Earth flux units (Earth at 1 AU around Sol = 1.0).
// Returns null when host mass or distance isn't available.
export function insolation(hostStarMass, aAu) {
  if (hostStarMass == null || aAu == null || aAu <= 0) return null;
  const L = luminositySun(hostStarMass);
  if (L == null) return null;
  return L / (aAu * aAu);
}

// Stellar metallicity proxy from spectral class. Returns a coarse [Fe/H]
// estimate (-0.5 to +0.3 dex) per spectral class typical-population
// mapping. Higher metallicity → more refractory + radioactive material
// available for planet building. Used by the Filler to scale
// rare-earths / radioactives resource priors.
//
// Anchors:
//   Sun (G2V): [Fe/H] = 0.0   (by definition Pop I solar reference)
//   M dwarfs:  bimodal — Pop I (~0.0) and Pop II (~-0.5). Mean ≈ -0.2.
//   K dwarfs:  Pop I bias, mean ≈ 0.0
//   F/G:       Pop I, mean ≈ 0.0 with scatter
//   A/B/O:     Pop I young, mean ≈ +0.1 (metal-enriched ISM)
//   WD:        progenitor-dependent, mean ≈ 0.0 with wide scatter
//   BD:        long-lived, mean ≈ -0.1 (older population skew)
//
// Returns the mean metallicity for the class as a deterministic scalar.
// Per-star variation handled by callers via seeded draws around this mean.
export function meanMetallicityForClass(cls) {
  switch (cls) {
    case 'O': return 0.10;
    case 'B': return 0.10;
    case 'A': return 0.05;
    case 'F': return 0.00;
    case 'G': return 0.00;
    case 'K': return -0.05;
    case 'M': return -0.20;
    case 'WD': return 0.00;
    case 'BD': return -0.10;
    default:  return 0.00;
  }
}

// Stellar age proxy from spectral class. Returns a representative age in
// Gyr. Massive hot stars are necessarily young (short main-sequence
// lifetimes); cool dwarfs span Gyr to hundreds of Gyr.
//
// Used by the Filler to compute radiogenic-resource decay (older bodies
// have depleted U/Th) and to inform formation-time context.
//
// Returns the typical mean age. Callers can layer per-star seeded
// scatter on top.
export function meanAgeForClass(cls) {
  switch (cls) {
    case 'O': return 0.005;   // 5 Myr — short MS lifetime
    case 'B': return 0.05;    // 50 Myr
    case 'A': return 0.5;     // 500 Myr
    case 'F': return 3;       // 3 Gyr
    case 'G': return 5;       // 5 Gyr (Sun is 4.6)
    case 'K': return 7;       // 7 Gyr
    case 'M': return 8;       // 8 Gyr (long-lived but mix of young/old)
    case 'WD': return 3;      // cooling age 3 Gyr typical
    case 'BD': return 5;      // 5 Gyr
    default:  return 5;
  }
}

// Dimensionless proxy for tidal-locking timescale, normalized so Earth = 1.
// The physical timescale is τ_lock ∝ a^6 / M_star^2 (the planet-side factors
// are weaker and don't vary much across our taxonomy). Earth at 1 AU around
// the Sun isn't locked over the age of the universe; Mercury (a=0.387) is;
// M-dwarf HZ planets at a~0.15 AU around 0.2 M☉ stars are deeply locked.
// Smaller proxy → faster locking → more likely locked.
//
// Returns null when inputs aren't available. The Filler maps the proxy to a
// log-interpolated locking probability so the rocky M-dwarf HZ catalog
// reads as mostly tide-locked while G-dwarf systems mostly aren't.
export function tidalLockProxy(hostStarMass, aAu) {
  if (hostStarMass == null || hostStarMass <= 0 || aAu == null || aAu <= 0) return null;
  return Math.pow(aAu, 6) / (hostStarMass * hostStarMass);
}
