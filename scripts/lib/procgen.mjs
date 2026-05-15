// Body Filler — derives empty body fields from anchors + physics + small
// seeded PRNGs. Reads tuning knobs from procgen-priors.mjs. Pure functions;
// build-catalog.mjs wires the result into the JSON output.
//
// Each body's empties are tracked in `_unknowns` during CSV parse (cells
// that were literally blank, not 'n/a'). The Filler only fills fields in
// that set; 'n/a' cells stay null forever. `_unknowns` is stripped before
// JSON emit so the runtime sees a clean `T | null` shape.
//
// Per-field seeding: hash32(body.id + ':' + field + ':' + PROCGEN_VERSION).
// Bumping PROCGEN_VERSION reseeds the whole galaxy without changing CSV ids.
//
// Generator dependency chain (run in this order in fillBody):
//   radiusEarth ← massEarth
//   worldClass  ← radiusEarth + insolation
//   avgSurfaceTempK ← worldClass + insolation + albedo
//   surfacePressureBar ← worldClass + massEarth
//   periodDays ↔ semiMajorAu (Kepler 3, bidirectional; needs host mass)
//   eccentricity, inclinationDeg, axialTiltDeg, orbitalPhaseDeg ← seeded draws
//
// The Kepler step is bidirectional so RV-discovery catalog rows (period
// known, axis unknown) and transit-discovery rows (axis known, period
// unknown) both fill out symmetrically.

import { hash32, mulberry32, sampleTruncated } from './prng.mjs';
import {
  PROCGEN_VERSION,
  ECCENTRICITY,
  INCLINATION_DEG,
  AXIAL_TILT_DEG,
} from './procgen-priors.mjs';
import { insolation } from './astrophysics.mjs';

function fieldPrng(body, field) {
  return mulberry32(hash32(`${body.id}:${field}:${PROCGEN_VERSION}`));
}

// =============================================================================
// Physics helpers
// =============================================================================

const SIGMA_SB = 5.670374e-8;   // Stefan-Boltzmann constant (W/m²/K⁴)
const SOLAR_CONSTANT = 1361;    // Solar irradiance at 1 AU (W/m²)

// Earth masses per solar mass. Used to convert planet mass to solar
// units for Kepler's third law applied to moons (whose "host" is their
// parent planet, not a star).
const EARTH_PER_SOLAR_MASS = 333000;

// =============================================================================
// Mass → Radius
// =============================================================================

// Piecewise mass-radius relation. Real distributions have scatter from
// composition (water vs. silicate vs. iron-rich); these power laws hit
// the mean of the observed cloud well enough that downstream worldClass
// classification lands in the right bucket for catalog rows missing
// radiusEarth.
//
//   M < 2 M⊕      → R = M^0.279         Otegi 2020 rocky line
//   2 ≤ M < 130   → R = 0.808 · M^0.589  Otegi 2020 volatile-rich / ice line
//   M ≥ 130       → R ≈ 11 R⊕            gas-giant plateau (degeneracy pressure)
//
// At 1 M_jup ≈ 318 M⊕ real Jupiter is ~11.2 R⊕; the plateau persists up
// to ~80 M_jup before brown-dwarf compression bends the curve back down.
// We don't model brown dwarfs as planets, so the flat plateau is fine.
export function radiusFromMass(massEarth) {
  if (massEarth == null || massEarth <= 0) return null;
  const m = massEarth;
  if (m < 2)   return Number(Math.pow(m, 0.279).toFixed(3));
  if (m < 130) return Number((0.808 * Math.pow(m, 0.589)).toFixed(3));
  return 11.0;
}

// =============================================================================
// Kepler period ↔ semi-major axis
// =============================================================================

// Kepler's third law in solar units: P² (years) = a³ (AU) / M (solar).
// Day form: P_days = 365.25 · √(a³ / M).
function keplerPeriodDays(aAu, hostMassSolar) {
  if (aAu == null || hostMassSolar == null || hostMassSolar <= 0) return null;
  return Number((365.25 * Math.sqrt(Math.pow(aAu, 3) / hostMassSolar)).toFixed(3));
}

// Inverse: a = ((P_years)² · M)^(1/3).
function keplerSemiMajorAu(periodDays, hostMassSolar) {
  if (periodDays == null || hostMassSolar == null || hostMassSolar <= 0) return null;
  const pYears = periodDays / 365.25;
  return Number(Math.pow(pYears * pYears * hostMassSolar, 1 / 3).toFixed(5));
}

// =============================================================================
// World-class taxonomy
// =============================================================================

// world_class is many-to-one from PLANET_TYPES (mass/radius taxonomy) onto
// the runtime surface-character enum. Mass/radius alone fixes the giant
// branches; terrestrial branches need insolation + a seeded water-budget
// proxy to choose rocky/ocean/desert/lava/ice.
//
// Returns null when anchors are missing — the Filler leaves the field null
// rather than guessing. Exported so the moon-backfill pass in
// build-catalog.mjs can derive a class inline without writing it to the
// body (the Filler does that authoritatively a step later).
export function worldClassFor(body, S) {
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

// World-class → Architect planet type, for moon-count lookup against
// MOON_COUNT_BY_TYPE. Terrestrial worlds split by mass: super-earths
// (>3 M⊕) retain more moons than Earth-class. Exported for the moon
// backfill pass.
export function planetTypeFor(worldClass, massEarth, S) {
  if (worldClass === 'gas_giant') return 'jupiter';
  if (worldClass === 'ice_giant') return 'neptune';
  if (worldClass === 'gas_dwarf') return 'sub_neptune';
  // terrestrial bucket
  if (S != null && S > 100) return 'hot_rocky';
  if (massEarth != null && massEarth > 3) return 'super_earth';
  return 'rocky';
}

// =============================================================================
// Surface character (temperature, pressure)
// =============================================================================

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
  // Resolve host + the mass that drives Kepler's third law for this body:
  //   planet → host star (solar masses)
  //   moon   → parent planet (Earth masses; convert to solar)
  // Insolation always traces up to the host star, so a moon inherits its
  // parent planet's stellar flux.
  let hostStar = null;
  let aFromStar = null;
  let hostMassSolar = null;
  if (b.kind === 'planet') {
    if (b.hostStarIdx != null) {
      hostStar = stars[b.hostStarIdx];
      aFromStar = b.semiMajorAu;
      hostMassSolar = hostStar.mass;
    }
  } else if (b.kind === 'moon') {
    if (b.hostBodyIdx != null) {
      const hostPlanet = allBodies[b.hostBodyIdx];
      if (hostPlanet) {
        if (hostPlanet.hostStarIdx != null) {
          hostStar = stars[hostPlanet.hostStarIdx];
          aFromStar = hostPlanet.semiMajorAu;
        }
        if (hostPlanet.massEarth != null) {
          hostMassSolar = hostPlanet.massEarth / EARTH_PER_SOLAR_MASS;
        }
      }
    }
  }

  const S = hostStar ? insolation(hostStar.mass, aFromStar) : null;
  const unknowns = new Set(b._unknowns ?? []);

  // Track filled values starting from the body's current state. Each
  // generator reads its dependencies from a working copy that includes
  // previously-filled values; that's how worldClass picks up the radius
  // we may have just derived two lines earlier.
  let { radiusEarth, worldClass, avgSurfaceTempK, surfacePressureBar,
        periodDays, semiMajorAu, eccentricity, inclinationDeg,
        axialTiltDeg, orbitalPhaseDeg } = b;

  if (unknowns.has('radiusEarth')) {
    const r = radiusFromMass(b.massEarth);
    if (r != null) radiusEarth = r;
  }

  const withRadius = { ...b, radiusEarth };

  if (unknowns.has('worldClass')) {
    const w = worldClassFor(withRadius, S);
    if (w != null) worldClass = w;
  }

  const withClass = { ...withRadius, worldClass };

  if (unknowns.has('avgSurfaceTempK')) {
    const t = avgSurfaceTempFor(withClass, S);
    if (t != null) avgSurfaceTempK = t;
  }

  if (unknowns.has('surfacePressureBar')) {
    const p = surfacePressureFor(withClass);
    if (p != null) surfacePressureBar = p;
  }

  // Kepler ↔ semi-major axis. Fill whichever side is missing when the
  // other side and the host mass are both available. Both unknown stays
  // both null.
  if (unknowns.has('periodDays') && semiMajorAu != null) {
    const p = keplerPeriodDays(semiMajorAu, hostMassSolar);
    if (p != null) periodDays = p;
  }
  if (unknowns.has('semiMajorAu') && periodDays != null) {
    const a = keplerSemiMajorAu(periodDays, hostMassSolar);
    if (a != null) semiMajorAu = a;
  }

  // Orbital flavor — pure seeded draws, no anchor dependencies. Each
  // field gets its own PRNG stream via fieldPrng so adding more
  // generators later doesn't shift existing values.
  if (unknowns.has('eccentricity')) {
    eccentricity = Number(sampleTruncated(fieldPrng(b, 'eccentricity'), ECCENTRICITY).toFixed(4));
  }
  if (unknowns.has('inclinationDeg')) {
    inclinationDeg = Number(sampleTruncated(fieldPrng(b, 'inclinationDeg'), INCLINATION_DEG).toFixed(2));
  }
  if (unknowns.has('axialTiltDeg')) {
    axialTiltDeg = Number(sampleTruncated(fieldPrng(b, 'axialTiltDeg'), AXIAL_TILT_DEG).toFixed(2));
  }
  if (unknowns.has('orbitalPhaseDeg')) {
    orbitalPhaseDeg = Number((fieldPrng(b, 'orbitalPhaseDeg')() * 360).toFixed(2));
  }

  // Strip _unknowns; runtime sees only the public Body shape.
  const { _unknowns, ...rest } = b;
  return {
    ...rest,
    radiusEarth, worldClass, avgSurfaceTempK, surfacePressureBar,
    periodDays, semiMajorAu,
    eccentricity, inclinationDeg, axialTiltDeg, orbitalPhaseDeg,
  };
}
