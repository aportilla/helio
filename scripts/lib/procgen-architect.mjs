// System Architect — top-down sampling of planetary systems for stars
// with no catalog bodies. Reads priors from procgen-priors.mjs; emits
// new body records (planets + their moons) ready to concatenate with
// the catalog-sourced rows before attachBodies + fillBodies.
//
// One pure entry point: generateSystem(star) → Body[]. Determinism via
// per-(star, slot, field) seeds; PROCGEN_VERSION mixed in so bumping it
// reseeds the whole galaxy.
//
// v1 fills anchors (semiMajorAu, massEarth, radiusEarth, periodDays) plus
// flavor (eccentricity, inclination, axial tilt, orbital phase). Surface
// character, atmosphere, resources, biosphere are left as `_unknowns`
// for the Filler (procgen.mjs) to derive.

import { hash32, mulberry32, sampleNormal, sampleTruncated } from './prng.mjs';
import { insolation } from './astrophysics.mjs';
import {
  PROCGEN_VERSION,
  PLANET_COUNT_BY_CLASS,
  ORBITAL_GEOMETRY_BY_CLASS,
  TYPE_WEIGHTS_BY_INSOLATION,
  TYPE_MULTIPLIER_BY_CLASS,
  PHYSICAL_SPEC_BY_TYPE,
  MOON_COUNT_BY_TYPE,
  ECCENTRICITY,
  INCLINATION_DEG,
  AXIAL_TILT_DEG,
  BELT_OCCURRENCE_BY_CLASS,
  BELT_PLACEMENT,
  BELT_RESOURCE_PRIORS,
  RING_OCCURRENCE_BY_TYPE,
  RING_EXTENT,
} from './procgen-priors.mjs';

// =============================================================================
// Sampling helpers
// =============================================================================

// Weighted categorical sample. Weights can be unnormalized; zero/negative
// entries are skipped. Falls back to last key on FP edge cases.
function sampleWeighted(prng, weights) {
  let total = 0;
  for (const w of Object.values(weights)) if (w > 0) total += w;
  if (total <= 0) return Object.keys(weights)[0];
  let r = prng() * total;
  for (const [k, w] of Object.entries(weights)) {
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return k;
  }
  return Object.keys(weights).pop();
}

// Per-(star, slot, salt) PRNG. slot=-1 reserved for system-level draws
// (planet count, etc.) that aren't tied to a specific orbital slot.
function slotPrng(starId, slotIdx, salt) {
  return mulberry32(hash32(`${starId}:${slotIdx}:${salt}:${PROCGEN_VERSION}`));
}

// Per-(planet, moon, salt) PRNG. Seeded off planet.id rather than the
// architect's (starId, slot) tuple so the same generator works for both
// architect-built planets and catalog rows being moon-backfilled — the
// planet's id is the only stable handle that exists in both cases.
function moonPrng(planetId, mIdx, salt) {
  return mulberry32(hash32(`${planetId}:moon${mIdx}:${salt}:${PROCGEN_VERSION}`));
}

// Per-(star, beltClass, salt) PRNG. Belts are system-level structural
// features — one of each class per star at most — so the slot key is
// the class name rather than an index.
function beltPrng(starId, beltClass, salt) {
  return mulberry32(hash32(`${starId}:belt:${beltClass}:${salt}:${PROCGEN_VERSION}`));
}

// Per-(planet, salt) PRNG for ring sampling. Like moonPrng, keyed off
// the planet id so both architect-built and backfilled-catalog rings
// share the same seeding scheme.
function ringPrng(planetId, salt) {
  return mulberry32(hash32(`${planetId}:ring:${salt}:${PROCGEN_VERSION}`));
}

// =============================================================================
// Per-slot sampling
// =============================================================================

// Largest-insolationMin-wins lookup. TYPE_WEIGHTS_BY_INSOLATION is ordered
// hot→cold; the first matching entry is the right zone.
function pickInsolationZone(S) {
  for (const zone of TYPE_WEIGHTS_BY_INSOLATION) {
    if (S >= zone.insolationMin) return zone;
  }
  return TYPE_WEIGHTS_BY_INSOLATION[TYPE_WEIGHTS_BY_INSOLATION.length - 1];
}

function planetTypeWeights(S, stellarClass) {
  const zone = pickInsolationZone(S);
  const multipliers = TYPE_MULTIPLIER_BY_CLASS[stellarClass] ?? TYPE_MULTIPLIER_BY_CLASS.G;
  const weights = {};
  for (const [type, w] of Object.entries(zone.weights)) {
    weights[type] = w * (multipliers[type] ?? 1);
  }
  return weights;
}

// IAU planet designation: 0→'b', 1→'c', … 'a' is reserved for the star.
// Caps at 25 planets ('z'); the priors clamp planet count well below this.
function planetLetterAt(idx) {
  return String.fromCharCode('b'.charCodeAt(0) + Math.min(idx, 24));
}

// Roman numeral 1..15. Used for procgen moon display names; ids use 'm1'
// etc. for slug-friendliness. Caps at XV — moon counts clamp to 15.
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];

// =============================================================================
// Body shape — fields the Architect doesn't set, listed for _unknowns
// =============================================================================

// The Filler will derive these from anchors + physics. Listing here so the
// Architect's output declares its dependencies cleanly to the next layer.
const FILLER_TARGET_FIELDS = [
  'worldClass', 'avgSurfaceTempK', 'surfaceTempMinK', 'surfaceTempMaxK',
  'waterFraction', 'iceFraction', 'albedo',
  'magneticFieldGauss', 'tectonicActivity',
  'surfacePressureBar',
  'atm1', 'atm1Frac', 'atm2', 'atm2Frac', 'atm3', 'atm3Frac',
  'resMetals', 'resSilicates', 'resVolatiles',
  'resRareEarths', 'resRadioactives', 'resExotics',
  'biosphere',
  'rotationPeriodHours',
];

// Build a body record with anchors set + every Filler-target field as null
// + `_unknowns` listing those targets. Belts and rings pass `_unknowns: []`
// in props to short-circuit the Filler (their structural fields are baked
// at architect time from belt/ring priors, not derived from physics).
function makeBody(props) {
  const base = {
    hostStarIdx: null,
    hostBodyIdx: null,
    worldClass: null, beltClass: null,
    avgSurfaceTempK: null, surfaceTempMinK: null, surfaceTempMaxK: null,
    waterFraction: null, iceFraction: null, albedo: null,
    magneticFieldGauss: null, tectonicActivity: null,
    surfacePressureBar: null,
    atm1: null, atm1Frac: null, atm2: null, atm2Frac: null, atm3: null, atm3Frac: null,
    resMetals: null, resSilicates: null, resVolatiles: null,
    resRareEarths: null, resRadioactives: null, resExotics: null,
    biosphere: null,
    rotationPeriodHours: null,
    innerAu: null, outerAu: null, innerPlanetRadii: null, outerPlanetRadii: null,
    moons: [],
    ring: null,
    _unknowns: [...FILLER_TARGET_FIELDS],
  };
  return { ...base, ...props };
}

// =============================================================================
// Moons
// =============================================================================

// Generate 0..N moons for one planet. Moon orbital distances spread out
// from the planet in AU at planetary scales (Galilean ~0.003 AU). Mass
// distribution is log-uniform from sub-Enceladus (10^-5 M⊕) to about
// 0.025 M⊕ (Titan-Ganymede range). Radius approximated from mass via a
// rocky-mean-density relation (ρ ≈ 3 g/cm³). Exported so the Filler can
// reuse it when backfilling moons for catalog planets that arrived with
// none — observed exoplanets rarely have moon coverage, but every body
// should be explorable for the game.
export function generateMoons(planet, planetType) {
  const spec = MOON_COUNT_BY_TYPE[planetType];
  if (!spec) return [];
  const countPrng = moonPrng(planet.id, -1, 'count');
  const N = Math.max(0, Math.min(spec.max, Math.round(sampleNormal(countPrng, spec.mean, spec.sd))));
  if (N === 0) return [];

  const moons = [];
  for (let mIdx = 0; mIdx < N; mIdx++) {
    const massPrng = moonPrng(planet.id, mIdx, 'mass');
    const orbitPrng = moonPrng(planet.id, mIdx, 'orbit');
    const phasePrng = moonPrng(planet.id, mIdx, 'phase');
    const eccPrng = moonPrng(planet.id, mIdx, 'ecc');
    const incPrng = moonPrng(planet.id, mIdx, 'inc');
    const tiltPrng = moonPrng(planet.id, mIdx, 'tilt');

    // Mass: log-uniform between Enceladus-tiny and Ganymede-large.
    const massEarth = Math.pow(10, -5 + massPrng() * (Math.log10(0.025) + 5));
    const radiusEarth = Math.pow(massEarth * 5.5 / 3.0, 1 / 3);  // ρ≈3 g/cm³ vs Earth's 5.5

    // Orbital distance: starts inside Roche-ish, spreads out with each slot
    // by ~factor 1.6. Galilean spacing is ~1.4–1.8x consecutive.
    const baseA = 0.002;
    const semiMajorAu = baseA * Math.pow(1.6, mIdx) * (0.8 + orbitPrng() * 0.4);
    // Kepler in days, Earth-mass planet at 1 AU around Sol = 365.25 days
    // (P² = a³ / M_host_solar). Convert to moon-around-planet: M_host is
    // the planet's mass in solar units (massEarth / 333000).
    const periodDays = 365.25 * Math.sqrt(Math.pow(semiMajorAu, 3) / (planet.massEarth / 333000));

    moons.push(makeBody({
      id: `${planet.id}-m${mIdx + 1}`,
      hostId: planet.id,
      kind: 'moon',
      formalName: `${planet.formalName} ${ROMAN[mIdx] ?? `M${mIdx + 1}`}`,
      name: `${planet.formalName} ${ROMAN[mIdx] ?? `M${mIdx + 1}`}`,
      source: 'procgen',
      semiMajorAu: Number(semiMajorAu.toFixed(5)),
      eccentricity: Number(sampleTruncated(eccPrng, ECCENTRICITY).toFixed(4)),
      inclinationDeg: Number(sampleTruncated(incPrng, INCLINATION_DEG).toFixed(2)),
      periodDays: Number(periodDays.toFixed(3)),
      orbitalPhaseDeg: Number((phasePrng() * 360).toFixed(2)),
      axialTiltDeg: Number(sampleTruncated(tiltPrng, AXIAL_TILT_DEG).toFixed(2)),
      massEarth: Number(massEarth.toFixed(4)),
      radiusEarth: Number(radiusEarth.toFixed(4)),
    }));
  }
  return moons;
}

// =============================================================================
// Belts
// =============================================================================

// Roman numeral for the IAU-style "II Belt" naming below. Caps at IV —
// no system today has more than 3 belt classes, so this is plenty.
const BELT_NUMERAL = { asteroid: 'I', debris: 'II', ice: 'III' };

// Descriptive belt name keyed off the band's center distance and class:
// e.g. "Inner Asteroid Belt", "Outer Ice Belt". Used for procgen rows
// where there's no curated colloquial name. Bands at < 1 AU are "Hot",
// 1–5 AU "Inner", 5–20 AU "Middle", 20–100 AU "Outer", >100 AU "Distant".
function describeBeltLocation(centerAu) {
  if (centerAu < 1)   return 'Hot';
  if (centerAu < 5)   return 'Inner';
  if (centerAu < 20)  return 'Middle';
  if (centerAu < 100) return 'Outer';
  return 'Distant';
}

const BELT_CLASS_LABEL = {
  asteroid: 'Asteroid Belt',
  ice:      'Ice Belt',
  debris:   'Debris Field',
};

// Generate 0..3 belts for one star (asteroid, ice, debris — each rolled
// independently). Returns Body[] ready to concatenate with the planet
// stream. Exported so the catalog backfill in build-catalog.mjs could
// add belts to partially-observed catalog stars later (v1 only emits
// during generateSystem).
export function generateBelts(star) {
  const cls = star.cls;
  const occurrence = BELT_OCCURRENCE_BY_CLASS[cls];
  const geom = ORBITAL_GEOMETRY_BY_CLASS[cls];
  if (!occurrence || !geom) return [];

  const belts = [];
  for (const beltClass of Object.keys(occurrence)) {
    const rollPrng = beltPrng(star.id, beltClass, 'occur');
    if (rollPrng() >= occurrence[beltClass]) continue;

    const placement = BELT_PLACEMENT[beltClass];
    const innerAu = geom.outerEdgeAu * placement.innerFrac;
    const outerAu = geom.outerEdgeAu * placement.outerFrac;
    const centerAu = (innerAu + outerAu) / 2;

    // Mass: log-uniform between placement.mass.min and .max.
    const massPrng = beltPrng(star.id, beltClass, 'mass');
    const logMin = Math.log10(placement.mass.min);
    const logMax = Math.log10(placement.mass.max);
    const massEarth = Math.pow(10, logMin + massPrng() * (logMax - logMin));

    // Resources: per-field truncated normal from BELT_RESOURCE_PRIORS.
    const resPriors = BELT_RESOURCE_PRIORS[beltClass];
    const resources = {};
    for (const field of Object.keys(resPriors)) {
      const prng = beltPrng(star.id, beltClass, `res_${field}`);
      resources[field] = Math.round(sampleTruncated(prng, resPriors[field]));
    }

    // Ice fraction tags volatile-dominated belts so the renderer + game
    // logic can treat "icy belt" generically without hardcoding the
    // beltClass enum: ~0.85 for ice belts, ~0.1 for asteroid/debris.
    const iceFraction = beltClass === 'ice' ? 0.85 : 0.1;

    const formal = `${star.name} ${describeBeltLocation(centerAu)} ${BELT_CLASS_LABEL[beltClass]}`;
    belts.push(makeBody({
      id: `${star.id}-belt-${beltClass}`,
      hostId: star.id,
      kind: 'belt',
      formalName: formal,
      name: formal,
      source: 'procgen',
      beltClass,
      semiMajorAu: Number(centerAu.toFixed(3)),
      innerAu: Number(innerAu.toFixed(3)),
      outerAu: Number(outerAu.toFixed(3)),
      massEarth: Number(massEarth.toFixed(5)),
      iceFraction,
      ...resources,
      _unknowns: [],
    }));
  }
  return belts;
}

// =============================================================================
// Rings
// =============================================================================

// Generate 0 or 1 ring for one planet. Exported so the build-catalog
// backfill can run rings over catalog planets that arrived without one
// (same posture as moon backfill — the bias model assumes the catalog
// is silent on rings, not authoritative).
export function generateRing(planet, planetType) {
  const spec = RING_OCCURRENCE_BY_TYPE[planetType];
  if (!spec) return null;
  const rollPrng = ringPrng(planet.id, 'occur');
  if (rollPrng() >= spec.p) return null;

  // Class: weighted sample over { ice, debris }.
  const classPrng = ringPrng(planet.id, 'class');
  const ringClass = sampleWeighted(classPrng, spec.weights);
  const extent = RING_EXTENT[ringClass];
  if (!extent) return null;

  const innerPrng = ringPrng(planet.id, 'inner');
  const outerPrng = ringPrng(planet.id, 'outer');
  const icePrng   = ringPrng(planet.id, 'ice');
  let inner = sampleTruncated(innerPrng, extent.inner);
  let outer = sampleTruncated(outerPrng, extent.outer);
  // If the outer sample lands below the inner, swap (cleaner than
  // re-rolling, preserves determinism).
  if (outer < inner) { const t = inner; inner = outer; outer = t; }

  const iceFraction = Number(sampleTruncated(icePrng, extent.iceFraction).toFixed(3));
  const formal = `${planet.formalName} ${ringClass === 'ice' ? 'Ice' : 'Debris'} Ring`;
  return makeBody({
    id: `${planet.id}-ring`,
    hostId: planet.id,
    kind: 'ring',
    formalName: formal,
    name: formal,
    source: 'procgen',
    beltClass: ringClass,
    innerPlanetRadii: Number(inner.toFixed(3)),
    outerPlanetRadii: Number(outer.toFixed(3)),
    iceFraction,
    _unknowns: [],
  });
}

// =============================================================================
// Entry point
// =============================================================================

// Generate the planets + moons for one star. Returns [] when the stellar
// class isn't in the priors or the count sample lands at 0.
export function generateSystem(star) {
  const cls = star.cls;
  const countSpec = PLANET_COUNT_BY_CLASS[cls];
  if (!countSpec) return [];

  // Planet count
  const countPrng = slotPrng(star.id, -1, 'planet_count');
  const N = sampleTruncated(countPrng, countSpec, true);
  if (N <= 0) return [];

  // Orbit layout — start past the inner edge, walk outward by sampled
  // period ratios. Stop when we exceed the outer edge or hit N planets.
  const geom = ORBITAL_GEOMETRY_BY_CLASS[cls];
  const orbits = [];
  let a = geom.innerEdgeAu;
  for (let i = 0; i < N; i++) {
    if (i === 0) {
      // First planet sits between 1.0 and 2.0× the inner edge — small
      // jitter so two stars of the same class don't always start at
      // exactly the same distance.
      const firstPrng = slotPrng(star.id, i, 'first_a');
      a = geom.innerEdgeAu * (1.0 + firstPrng() * 1.0);
    } else {
      // Log-normal period ratio per the prior. Period ratio → a ratio
      // via P ∝ a^(3/2), so the AU ratio is (period_ratio)^(2/3).
      const ratioPrng = slotPrng(star.id, i, 'spacing');
      const periodRatio = Math.exp(sampleNormal(ratioPrng, Math.log(geom.spacingRatio.mean), geom.spacingRatio.sd));
      a *= Math.pow(periodRatio, 2 / 3);
    }
    if (a > geom.outerEdgeAu) break;
    orbits.push(a);
  }

  const bodies = [];
  for (let i = 0; i < orbits.length; i++) {
    const aAu = orbits[i];
    const S = insolation(star.mass, aAu);

    // Type sample
    const weights = planetTypeWeights(S, cls);
    const typePrng = slotPrng(star.id, i, 'planet_type');
    const planetType = sampleWeighted(typePrng, weights);
    const physSpec = PHYSICAL_SPEC_BY_TYPE[planetType];
    if (!physSpec) continue;

    // Mass + radius
    const massPrng = slotPrng(star.id, i, 'mass');
    const radiusPrng = slotPrng(star.id, i, 'radius');
    const massEarth = sampleTruncated(massPrng, physSpec.massEarth);
    const radiusEarth = sampleTruncated(radiusPrng, physSpec.radiusEarth);

    // Flavor
    const eccPrng = slotPrng(star.id, i, 'eccentricity');
    const incPrng = slotPrng(star.id, i, 'inclination');
    const tiltPrng = slotPrng(star.id, i, 'axial_tilt');
    const phasePrng = slotPrng(star.id, i, 'orbital_phase');

    // Kepler period: P² = a³ / M_host_solar
    const periodDays = 365.25 * Math.sqrt(Math.pow(aAu, 3) / Math.max(star.mass, 0.01));

    const letter = planetLetterAt(i);
    const planet = makeBody({
      id: `${star.id}-${letter}`,
      hostId: star.id,
      kind: 'planet',
      formalName: `${star.name} ${letter}`,
      name: `${star.name} ${letter}`,
      source: 'procgen',
      semiMajorAu: Number(aAu.toFixed(4)),
      eccentricity: Number(sampleTruncated(eccPrng, ECCENTRICITY).toFixed(4)),
      inclinationDeg: Number(sampleTruncated(incPrng, INCLINATION_DEG).toFixed(2)),
      periodDays: Number(periodDays.toFixed(2)),
      orbitalPhaseDeg: Number((phasePrng() * 360).toFixed(2)),
      axialTiltDeg: Number(sampleTruncated(tiltPrng, AXIAL_TILT_DEG).toFixed(2)),
      massEarth: Number(massEarth.toFixed(3)),
      radiusEarth: Number(radiusEarth.toFixed(3)),
    });
    bodies.push(planet);
    bodies.push(...generateMoons(planet, planetType));
    const ring = generateRing(planet, planetType);
    if (ring) bodies.push(ring);
  }
  // Belts roll independently of the planet stream — even a system with
  // zero planet samples may still host belts (a debris-disk-only star).
  bodies.push(...generateBelts(star));
  return bodies;
}
