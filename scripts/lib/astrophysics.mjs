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
