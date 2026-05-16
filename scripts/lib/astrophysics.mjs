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
