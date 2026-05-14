// Body Filler — derives empty body fields from anchors + physics + small
// seeded PRNGs. Reads tuning knobs from procgen-priors.mjs. Pure functions;
// build-catalog.mjs wires the result into the JSON output.
//
// v1 scope: world_class, avg_surface_temp_k, surface_pressure_bar.
// Other fields are added incrementally as the rules firm up — atmospheric
// composition, resources, biosphere, flavor, etc.
//
// Each body's empties are tracked in `_unknowns` during CSV parse (cells
// that were literally blank, not 'n/a'). The Filler only fills fields in
// that set; 'n/a' cells stay null forever. `_unknowns` is stripped before
// JSON emit so the runtime sees a clean `T | null` shape.
//
// Per-field seeding: hash32(body.id + ':' + field + ':' + PROCGEN_VERSION).
// Bumping PROCGEN_VERSION reseeds the whole galaxy without changing CSV ids.

import { hash32, mulberry32 } from './prng.mjs';
import { PROCGEN_VERSION } from './procgen-priors.mjs';
import { insolation } from './astrophysics.mjs';

function fieldPrng(body, field) {
  return mulberry32(hash32(`${body.id}:${field}:${PROCGEN_VERSION}`));
}

// =============================================================================
// Physics helpers
// =============================================================================

const SIGMA_SB = 5.670374e-8;   // Stefan-Boltzmann constant (W/m²/K⁴)
const SOLAR_CONSTANT = 1361;    // Solar irradiance at 1 AU (W/m²)

// =============================================================================
// Per-field generators
// =============================================================================

// world_class is many-to-one from PLANET_TYPES (mass/radius taxonomy) onto
// the runtime surface-character enum. Mass/radius alone fixes the giant
// branches; terrestrial branches need insolation + a seeded water-budget
// proxy to choose rocky/ocean/desert/lava/ice.
//
// Returns null when anchors are missing — the Filler leaves the field null
// rather than guessing.
function worldClassFor(body, S) {
  const r = body.radiusEarth;
  if (r == null) return null;

  // Giants — pure mass/radius
  if (r >= 8) return 'gas_giant';
  if (r >= 3.5) {
    // Neptune-mass: warm version is gas_dwarf, cold is ice_giant.
    return (S != null && S > 0.1) ? 'gas_dwarf' : 'ice_giant';
  }
  if (r >= 2) return 'gas_dwarf';  // sub-Neptune

  // Terrestrial — gated on insolation.
  //
  // Lava is reserved for extreme insolation (sub-orbital roasting that
  // could plausibly liquefy the surface). Mercury (S≈6.7) and Venus
  // (S≈1.9) are both solid rocky, not lava — Io is lava but from tidal
  // heating, not stellar flux. v1 doesn't model tidal heating, so lava
  // worlds are rare and limited to brutally-close-in orbits.
  if (S == null) return null;
  if (S > 200) return 'lava';        // S=200 ≈ 0.07 AU around Sun-like
  if (S > 1.5) {
    // Hot rocky — Venus/Mercury class. Dry by default; occasional
    // water-bearing exceptions for hothouse worlds with retained volatiles.
    const r_w = fieldPrng(body, 'water_budget')();
    return r_w < 0.7 ? 'desert' : 'rocky';
  }
  if (S < 0.1) return 'ice';         // outer cold

  // Temperate band (0.1 < S < 1.5) — seeded water budget chooses surface.
  // 50% rocky (Earth-like), 30% ocean (water-rich), 20% desert (dry).
  const r_w = fieldPrng(body, 'water_budget')();
  if (r_w < 0.5) return 'rocky';
  if (r_w < 0.8) return 'ocean';
  return 'desert';
}

// Greenhouse offset (K) above radiative equilibrium, keyed on world_class.
// Crude — real greenhouse varies with pressure, composition, cloud cover.
// Venus's actual +500K is intentionally not modeled here; v1 keeps generic
// rocky/ocean/lava values that produce sensible surface temps for unknown
// worlds without requiring full atmospheric simulation.
const GREENHOUSE_K_BY_CLASS = {
  rocky:  33,    // Earth +33K
  ocean:  50,    // water vapor adds to Earth-class
  desert:  5,    // thin atmosphere, minimal greenhouse
  lava:   80,    // outgassed CO2 / SO2 — middle ground (v1 underestimates Venus)
  ice:     5,    // typically thin / no atmosphere
};

// Stefan-Boltzmann equilibrium temperature plus a world_class greenhouse
// offset. Gas giants return cloud-top equilibrium temp (no surface).
function avgSurfaceTempFor(body, S) {
  if (S == null || body.worldClass == null) return null;
  const A = body.albedo ?? 0.3;
  const tEq = Math.pow((S * SOLAR_CONSTANT * (1 - A)) / (4 * SIGMA_SB), 0.25);
  const wc = body.worldClass;
  if (wc === 'gas_giant' || wc === 'gas_dwarf' || wc === 'ice_giant') {
    return Math.round(tEq);
  }
  return Math.round(tEq + (GREENHOUSE_K_BY_CLASS[wc] ?? 0));
}

// Baseline atmospheric pressure (bar) per world_class. Scaled by sqrt(mass)
// as a rough proxy for escape-velocity-driven retention (Earth=1, Mars
// ≈ 0.003 because of low mass, super-Earth at 5 M⊕ ≈ 2.2 bar baseline).
// Returns null for gaseous bodies — no defined surface.
const PRESSURE_BAR_BY_CLASS = {
  rocky:   1.0,    // Earth
  ocean:   1.5,    // thicker on average — more volatiles, water vapor
  desert:  0.01,   // Mars-class trace
  lava:   50,      // Venus-class outgassed CO2 atmosphere
  ice:     0.001,  // typically airless surface
};

function surfacePressureFor(body) {
  if (body.worldClass == null) return null;
  const baseline = PRESSURE_BAR_BY_CLASS[body.worldClass];
  if (baseline == null) return null;  // gas/ice giants land here — no surface
  const m = body.massEarth ?? 1.0;
  return Number((baseline * Math.sqrt(Math.max(m, 0.001))).toFixed(3));
}

// =============================================================================
// Filler entry point
// =============================================================================

// Returns a new bodies array with empties filled where possible. `_unknowns`
// is stripped from each body in the process. Bodies whose anchors don't
// support filling (missing mass/radius/host) keep their nulls.
export function fillBodies(bodies, stars) {
  return bodies.map(b => fillBody(b, bodies, stars));
}

function fillBody(b, allBodies, stars) {
  // Resolve host star + orbital distance from the star. Moons inherit
  // their parent planet's insolation (the moon's own semiMajorAu is
  // moon-around-planet, not moon-around-star).
  let hostStar = null;
  let aFromStar = null;
  if (b.kind === 'planet') {
    if (b.hostStarIdx != null) {
      hostStar = stars[b.hostStarIdx];
      aFromStar = b.semiMajorAu;
    }
  } else if (b.kind === 'moon') {
    if (b.hostBodyIdx != null) {
      const hostPlanet = allBodies[b.hostBodyIdx];
      if (hostPlanet && hostPlanet.hostStarIdx != null) {
        hostStar = stars[hostPlanet.hostStarIdx];
        aFromStar = hostPlanet.semiMajorAu;
      }
    }
  }

  const S = hostStar ? insolation(hostStar.mass, aFromStar) : null;
  const unknowns = new Set(b._unknowns ?? []);

  let { worldClass, avgSurfaceTempK, surfacePressureBar } = b;

  if (unknowns.has('worldClass')) {
    const w = worldClassFor(b, S);
    if (w != null) worldClass = w;
  }

  // Threading the freshly-set worldClass into downstream generators.
  const updated = { ...b, worldClass };

  if (unknowns.has('avgSurfaceTempK')) {
    const t = avgSurfaceTempFor(updated, S);
    if (t != null) avgSurfaceTempK = t;
  }

  if (unknowns.has('surfacePressureBar')) {
    const p = surfacePressureFor(updated);
    if (p != null) surfacePressureBar = p;
  }

  // Strip _unknowns; runtime sees only the public Body shape.
  const { _unknowns, ...rest } = updated;
  return { ...rest, worldClass, avgSurfaceTempK, surfacePressureBar };
}
