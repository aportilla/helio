#!/usr/bin/env node
//
// Audit procgen output against the priors in lib/procgen-priors.mjs.
// Walks src/data/catalog.generated.json — the post-build snapshot —
// and reports observed occurrence rates next to the expected rates
// from each prior. Read-only.
//
// Use after editing a prior + `npm run build:catalog`: re-run this
// script and the deltas in the rightmost columns surface what moved.
//
// Denominators are scoped to the population a given prior actually
// governs — catalog anchors don't participate in procgen rolls, so:
//   - Ring / moon comparisons exclude curated-system planets (Sol),
//     since their CSV is the source of truth there. They also include
//     non-curated catalog planets, since those go through ring/moon
//     backfill in build-catalog.mjs.
//   - Belt comparisons restrict to stars with zero catalog planets,
//     since the Architect only fires belt rolls on those today (the
//     partial-system overlay that would extend it is deferred).
//
// Mostly procgen rates won't match the prior `p` exactly — sample
// noise on 100–5000 rolls is real — but a 2× or larger drift usually
// means a typo or a calibration miss worth investigating.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planetTypeFor } from './lib/procgen.mjs';
import { insolation } from './lib/astrophysics.mjs';
import {
  PLANET_COUNT_BY_CLASS,
  PLANET_TYPES,
  RING_OCCURRENCE_BY_TYPE,
  MOON_COUNT_BY_TYPE,
  BELT_OCCURRENCE_BY_CLASS,
  BELT_RESOURCE_PRIORS,
  COMPANION_PLANET_SUPPRESSION,
  WATER_FRACTION_BY_CLASS,
  ICE_FRACTION_BY_CLASS,
  ALBEDO_BY_CLASS,
  TECTONIC_ACTIVITY_BY_CLASS,
  MAGNETIC_FIELD_GAUSS_BY_CLASS,
  TEMP_SWING_FRAC_BY_CLASS,
  PLANET_RESOURCE_PRIORS_BY_CLASS,
  BIOSPHERE_BY_CLASS,
  BIOSPHERE_GATE_INSOLATION,
  BIOSPHERE_ARCHETYPES,
  BIOSPHERE_TIERS,
} from './lib/procgen-priors.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = resolve(REPO_ROOT, 'src/data/catalog.generated.json');

// Mirrors CURATED_SYSTEM_HOSTS in build-catalog.mjs. Kept inline rather
// than imported so this script stays Node-runnable without pulling the
// build module's other deps.
const CURATED_HOSTS = new Set(['sol']);

const cat = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const { stars, bodies, clusters } = cat;

const STELLAR_CLASSES = Object.keys(PLANET_COUNT_BY_CLASS);

// --- helpers -----------------------------------------------------------------

function meanStd(arr) {
  if (!arr.length) return { mean: 0, sd: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}

function insolationFor(planet) {
  if (planet.semiMajorAu == null || planet.hostStarIdx == null) return null;
  const star = stars[planet.hostStarIdx];
  if (!star || star.mass == null) return null;
  return insolation(star.mass, planet.semiMajorAu);
}

// Prefer the architect's persisted decision over re-derivation: the
// worldClass→planetType mapping in planetTypeFor is many-to-one and would
// re-bucket a super_earth at mass=2 (legitimately sampled by the architect
// with 30% ice-ring weight) as 'rocky' (0% ice-ring weight), making the
// audit disagree with the sampler on its own output. Fall back to the
// derived form only for curated-system planets where neither the architect
// nor the backfill ran.
function planetTypeOf(planet) {
  if (planet.planetType) return planet.planetType;
  const wc = planet.worldClass || 'rocky';
  return planetTypeFor(wc, planet.massEarth, insolationFor(planet));
}

function pct(n, d, decimals = 2) {
  if (!d) return '   —   ';
  return (n / d * 100).toFixed(decimals).padStart(5 + decimals) + '%';
}

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}

// z-score for a binomial proportion (k successes in n trials vs. prior
// rate p). Normal approximation; returns null when the comparison isn't
// defined. Use min(np, n(1-p)) ≥ 5 to decide whether the approximation
// is trustworthy enough to flag a deviation.
function zBinom(k, n, p) {
  if (n === 0 || p <= 0 || p >= 1) return null;
  const se = Math.sqrt(p * (1 - p) / n);
  return (k / n - p) / se;
}

// z-score for a sample mean against a prior N(μ, σ²). Standard-error of
// the mean is σ/√n, so z = (obs − μ) / (σ/√n).
function zMean(obsMean, n, priorMean, priorSd) {
  if (n === 0 || priorSd <= 0) return null;
  return (obsMean - priorMean) / (priorSd / Math.sqrt(n));
}

// Format a z-score for column display. `validN` gates the `*` marker —
// for binomial: min(np, n(1-p)); for means: n. We always show the value
// so small-n cells stay visible, but only mark a cell as significant
// (|z| ≥ 2) when the underlying approximation is reasonable.
function fmtZ(z, validN = Infinity) {
  if (z == null || !Number.isFinite(z)) return '   —     ';
  const sign = z >= 0 ? '+' : '';
  const marker = (validN >= 5 && Math.abs(z) >= 2) ? '*' : ' ';
  return ' z=' + (sign + z.toFixed(2)).padStart(5) + marker;
}

// --- 1. Overview -------------------------------------------------------------

console.log('=== Overview ===');
console.log('catalog:', CATALOG_PATH);
console.log('stars:  ', stars.length, '  bodies:', bodies.length);
const kindSrc = {};
for (const b of bodies) {
  const k = b.kind + ' / ' + (b.source || '?');
  kindSrc[k] = (kindSrc[k] || 0) + 1;
}
for (const k of Object.keys(kindSrc).sort()) {
  console.log('  ' + pad(k, 22), pad(kindSrc[k], 6, true));
}
console.log();

// --- 2. Planets per system, by stellar class --------------------------------

console.log('=== Planets per system, by stellar class ===');
console.log('  cls | systems |  obs.mean  obs.sd     prior.mean  prior.sd   z');
console.log('  ----+---------+----------  ------     ----------  --------   --------');
const planetCountByCls = {};
for (const star of stars) {
  const cls = star.cls || '?';
  if (!planetCountByCls[cls]) planetCountByCls[cls] = [];
  planetCountByCls[cls].push(star.planets.length);
}
for (const cls of STELLAR_CLASSES) {
  const arr = planetCountByCls[cls] || [];
  const obs = meanStd(arr);
  const p = PLANET_COUNT_BY_CLASS[cls];
  console.log(
    '  ' + pad(cls, 4) +
    '| ' + pad(arr.length, 7, true) +
    ' |  ' + pad(obs.mean.toFixed(2), 6, true) +
    '   ' + pad(obs.sd.toFixed(2), 4, true) +
    '       ' + pad(p.mean.toFixed(2), 5, true) +
    '       ' + pad(p.sd.toFixed(2), 4, true) +
    fmtZ(zMean(obs.mean, arr.length, p.mean, p.sd), arr.length),
  );
}
console.log();

// --- 2b. Planets per system, by cluster role --------------------------------
//
// Verifies that multi-star companion suppression (COMPANION_PLANET_SUPPRESSION
// in procgen-priors.mjs) lands roughly where the multiplier predicts.
// Primaries should match the per-class prior unchanged; secondary/tertiary
// counts should sit near `multiplier × class-weighted-mean prior`.
console.log('=== Planets per system, by cluster role ===');
console.log('  role          | stars |  obs.mean  obs.sd     suppression   expected*');
console.log('  --------------+-------+----------  ------     -----------   --------');
const roleByStarIdx = new Map();
for (const cluster of clusters) {
  for (let i = 0; i < cluster.members.length; i++) {
    const role = i === 0 ? 'primary' : i === 1 ? 'secondary' : 'tertiary_plus';
    roleByStarIdx.set(cluster.members[i], role);
  }
}
const countByRole = { primary: [], secondary: [], tertiary_plus: [] };
const classDistByRole = { primary: {}, secondary: {}, tertiary_plus: {} };
for (let i = 0; i < stars.length; i++) {
  const role = roleByStarIdx.get(i) ?? 'primary';
  countByRole[role].push(stars[i].planets.length);
  const cls = stars[i].cls || '?';
  classDistByRole[role][cls] = (classDistByRole[role][cls] || 0) + 1;
}
for (const role of ['primary', 'secondary', 'tertiary_plus']) {
  const arr = countByRole[role];
  if (!arr.length) continue;
  const obs = meanStd(arr);
  // Expected = sum over classes of (class_share × class_prior_mean) × suppression
  const dist = classDistByRole[role];
  const total = arr.length;
  let weighted = 0;
  for (const [cls, n] of Object.entries(dist)) {
    const p = PLANET_COUNT_BY_CLASS[cls];
    if (p) weighted += (n / total) * p.mean;
  }
  const mul = COMPANION_PLANET_SUPPRESSION[role];
  const expected = weighted * mul;
  console.log(
    '  ' + pad(role, 13) +
    ' |' + pad(arr.length, 6, true) +
    ' |  ' + pad(obs.mean.toFixed(2), 6, true) +
    '   ' + pad(obs.sd.toFixed(2), 4, true) +
    '       ' + pad(mul.toFixed(2) + '×', 6, true) +
    '        ' + pad(expected.toFixed(2), 5, true),
  );
}
console.log();

// --- 3. Planet-type mix (procgen taxonomy) ----------------------------------

// "Procgen-eligible" planets = everything outside curated systems. Architect-
// generated planets always qualify; catalog planets qualify too, since the
// ring/moon backfill treats them with the same priors.
const procgenPlanets = bodies.filter(
  b => b.kind === 'planet' && !CURATED_HOSTS.has(b.hostId),
);

console.log('=== Planet-type mix (procgen-eligible planets) ===');
const typeCount = {};
for (const p of procgenPlanets) {
  const t = planetTypeOf(p);
  typeCount[t] = (typeCount[t] || 0) + 1;
}
const totalProcgen = procgenPlanets.length;
for (const t of PLANET_TYPES) {
  const n = typeCount[t] || 0;
  console.log('  ' + pad(t, 13) + pad(n, 6, true) + '   ' + pct(n, totalProcgen));
}
console.log('  ' + pad('total', 13) + pad(totalProcgen, 6, true));
console.log();

// --- 4. Ring occurrence by planet type --------------------------------------

console.log('=== Rings, by host planet type ===');
console.log('  type        | planets |  rings    obs.rate    prior.p      z          obs.ice%  prior.ice%    obs.debris%  prior.debris%');
console.log('  ------------+---------+-------    --------    -------      --------   --------  ----------    -----------  -------------');
const ringsByType = {};  // type → { total, ice, debris }
for (const b of bodies) {
  if (b.kind !== 'ring') continue;
  const host = bodies[b.hostBodyIdx];
  if (!host) continue;
  if (CURATED_HOSTS.has(host.hostId)) continue;
  const t = planetTypeOf(host);
  if (!ringsByType[t]) ringsByType[t] = { total: 0, ice: 0, debris: 0 };
  ringsByType[t].total += 1;
  ringsByType[t][b.beltClass] = (ringsByType[t][b.beltClass] || 0) + 1;
}
for (const t of PLANET_TYPES) {
  const planets = typeCount[t] || 0;
  const rc = ringsByType[t] || { total: 0, ice: 0, debris: 0 };
  const p = RING_OCCURRENCE_BY_TYPE[t];
  const obsRate = planets ? rc.total / planets : 0;
  const obsIce = rc.total ? rc.ice / rc.total : 0;
  const obsDebris = rc.total ? rc.debris / rc.total : 0;
  console.log(
    '  ' + pad(t, 11) +
    ' |' + pad(planets, 8, true) +
    ' |' + pad(rc.total, 7, true) +
    '   ' + pad((obsRate * 100).toFixed(2) + '%', 8, true) +
    '   ' + pad((p.p * 100).toFixed(2) + '%', 7, true) +
    fmtZ(zBinom(rc.total, planets, p.p), Math.min(planets * p.p, planets * (1 - p.p))) +
    '   ' + pad((obsIce * 100).toFixed(0) + '%', 5, true) +
    '     ' + pad((p.weights.ice * 100).toFixed(0) + '%', 5, true) +
    '       ' + pad((obsDebris * 100).toFixed(0) + '%', 5, true) +
    '       ' + pad((p.weights.debris * 100).toFixed(0) + '%', 5, true),
  );
}
console.log();

// --- 5. Moon count by planet type -------------------------------------------

console.log('=== Moons per planet, by planet type ===');
console.log('  type        | planets |  obs.mean  obs.sd     prior.mean  prior.sd   z            %with-moons');
console.log('  ------------+---------+----------  ------     ----------  --------   --------     -----------');
const moonsByType = {};
for (const p of procgenPlanets) {
  const t = planetTypeOf(p);
  if (!moonsByType[t]) moonsByType[t] = [];
  moonsByType[t].push(p.moons.length);
}
for (const t of PLANET_TYPES) {
  const arr = moonsByType[t] || [];
  const obs = meanStd(arr);
  const p = MOON_COUNT_BY_TYPE[t];
  const withMoons = arr.filter(n => n > 0).length;
  // Poisson(λ) has Var = λ, so prior SD = √mean. Capped at max=spec.max
  // pulls the upper tail in slightly; close enough for the z-score.
  const priorSd = Math.sqrt(p.mean);
  console.log(
    '  ' + pad(t, 11) +
    ' |' + pad(arr.length, 8, true) +
    ' |  ' + pad(obs.mean.toFixed(2), 6, true) +
    '   ' + pad(obs.sd.toFixed(2), 4, true) +
    '       ' + pad(p.mean.toFixed(2), 5, true) +
    '       ' + pad(priorSd.toFixed(2), 4, true) +
    fmtZ(zMean(obs.mean, arr.length, p.mean, priorSd), arr.length) +
    '   ' + pct(withMoons, arr.length),
  );
}
console.log();

// --- 6. Belt occurrence by stellar class ------------------------------------

// Every non-curated star is architect- or overlay-touched today, so the
// belt-roll population is "stars with a class supported by the priors,
// minus curated hosts (Sol's belts are catalog-canonical)."
const eligibleStars = stars.filter(s => s.cls && !CURATED_HOSTS.has(s.id));

console.log('=== Belts, by stellar class (architect + overlay) ===');
console.log('  z column: standard deviations from the prior. `*` flags |z|≥2 when min(np, n(1-p))≥5.');
console.log('  cls | systems |  ast.obs  ast.prior   z         ice.obs  ice.prior   z         deb.obs  deb.prior   z');
console.log('  ----+---------+--------- ----------  --------- --------  ---------  --------- --------  ---------  ---------');
const beltsByCls = {};
for (const star of eligibleStars) {
  const cls = star.cls || '?';
  if (!beltsByCls[cls]) beltsByCls[cls] = { systems: 0, asteroid: 0, ice: 0, debris: 0 };
  beltsByCls[cls].systems += 1;
  for (const bi of star.belts) {
    const belt = bodies[bi];
    if (!belt || belt.source !== 'procgen') continue;
    beltsByCls[cls][belt.beltClass] = (beltsByCls[cls][belt.beltClass] || 0) + 1;
  }
}
for (const cls of STELLAR_CLASSES) {
  const row = beltsByCls[cls] || { systems: 0, asteroid: 0, ice: 0, debris: 0 };
  const p = BELT_OCCURRENCE_BY_CLASS[cls];
  const n = Math.max(1, row.systems);
  const obsA = row.asteroid / n, obsI = row.ice / n, obsD = row.debris / n;
  console.log(
    '  ' + pad(cls, 4) +
    '| ' + pad(row.systems, 7, true) +
    ' | ' + pad((obsA * 100).toFixed(2) + '%', 7, true) +
    '   ' + pad((p.asteroid * 100).toFixed(2) + '%', 6, true) +
    fmtZ(zBinom(row.asteroid, row.systems, p.asteroid), Math.min(row.systems * p.asteroid, row.systems * (1 - p.asteroid))) +
    '  ' + pad((obsI * 100).toFixed(2) + '%', 6, true) +
    '   ' + pad((p.ice * 100).toFixed(2) + '%', 6, true) +
    fmtZ(zBinom(row.ice, row.systems, p.ice), Math.min(row.systems * p.ice, row.systems * (1 - p.ice))) +
    '  ' + pad((obsD * 100).toFixed(2) + '%', 6, true) +
    '   ' + pad((p.debris * 100).toFixed(2) + '%', 6, true) +
    fmtZ(zBinom(row.debris, row.systems, p.debris), Math.min(row.systems * p.debris, row.systems * (1 - p.debris))),
  );
}
console.log();

// --- 7. Surface scalars by worldClass ---------------------------------------

console.log('=== Surface scalars, by worldClass (procgen planets) ===');
function auditScalar(field, priorTable, label) {
  console.log('  --- ' + label + ' ---');
  console.log('  class       |  n      obs.mean  obs.sd     prior.mean  prior.sd   z');
  const byClass = {};
  for (const b of bodies) {
    if (b.kind !== 'planet' || b.source !== 'procgen') continue;
    if (b.worldClass == null || b[field] == null) continue;
    if (!byClass[b.worldClass]) byClass[b.worldClass] = [];
    byClass[b.worldClass].push(b[field]);
  }
  for (const cls of Object.keys(priorTable).sort()) {
    const arr = byClass[cls] || [];
    const obs = meanStd(arr);
    const p = priorTable[cls];
    if (!arr.length) continue;
    console.log(
      '  ' + pad(cls, 11) +
      ' |' + pad(arr.length, 5, true) +
      '   ' + pad(obs.mean.toFixed(3), 6, true) +
      '   ' + pad(obs.sd.toFixed(3), 5, true) +
      '      ' + pad(p.mean.toFixed(3), 5, true) +
      '       ' + pad(p.sd.toFixed(3), 5, true) +
      fmtZ(zMean(obs.mean, arr.length, p.mean, p.sd || 0.001), arr.length),
    );
  }
}
auditScalar('waterFraction',    WATER_FRACTION_BY_CLASS,    'waterFraction');
auditScalar('iceFraction',      ICE_FRACTION_BY_CLASS,      'iceFraction');
auditScalar('albedo',           ALBEDO_BY_CLASS,            'albedo (post-ice-lift; expect bias above prior on ice worlds)');
auditScalar('tectonicActivity', TECTONIC_ACTIVITY_BY_CLASS, 'tectonicActivity (post-mass-scale; expect bias on non-Earth-mass)');
auditScalar('magneticFieldGauss', MAGNETIC_FIELD_GAUSS_BY_CLASS, 'magneticFieldGauss (post-tect/rot scaling for terrestrials)');
console.log();

// --- 8. Atmosphere top-gas distribution -------------------------------------

console.log('=== Atmosphere top gas (atm1) by worldClass ===');
const atmByClass = {};
for (const b of bodies) {
  if (b.kind !== 'planet' || b.source !== 'procgen') continue;
  if (!b.worldClass || !b.atm1) continue;
  if (!atmByClass[b.worldClass]) atmByClass[b.worldClass] = { total: 0, gases: {} };
  atmByClass[b.worldClass].total += 1;
  atmByClass[b.worldClass].gases[b.atm1] = (atmByClass[b.worldClass].gases[b.atm1] || 0) + 1;
}
for (const cls of Object.keys(atmByClass).sort()) {
  const r = atmByClass[cls];
  const sorted = Object.entries(r.gases).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const breakdown = sorted.map(([g, n]) => `${g} ${(n / r.total * 100).toFixed(0)}%`).join('  ');
  console.log('  ' + pad(cls, 11) + ' | n=' + pad(r.total, 4, true) + '  ' + breakdown);
}
console.log();

// --- 9. Resource means by worldClass ---------------------------------------

console.log('=== Resource means, by worldClass (procgen planets, 0-10 scale) ===');
console.log('  class       |  n      met  sil  vol  rare radio exo    (priors in brackets)');
const RES = ['resMetals','resSilicates','resVolatiles','resRareEarths','resRadioactives','resExotics'];
const resByClass = {};
for (const b of bodies) {
  if (b.kind !== 'planet' || b.source !== 'procgen') continue;
  if (!b.worldClass) continue;
  if (!resByClass[b.worldClass]) {
    resByClass[b.worldClass] = { n: 0, sums: Object.fromEntries(RES.map(f => [f, 0])) };
  }
  resByClass[b.worldClass].n += 1;
  for (const f of RES) if (b[f] != null) resByClass[b.worldClass].sums[f] += b[f];
}
for (const cls of Object.keys(PLANET_RESOURCE_PRIORS_BY_CLASS).sort()) {
  const r = resByClass[cls];
  const p = PLANET_RESOURCE_PRIORS_BY_CLASS[cls];
  if (!r || !r.n) continue;
  const obs = RES.map(f => (r.sums[f] / r.n).toFixed(1).padStart(3));
  const prior = RES.map(f => p[f].mean.toString().padStart(3));
  console.log(
    '  ' + pad(cls, 11) +
    ' | ' + pad(r.n, 4, true) +
    '   ' + obs.join('  ') +
    '   [' + prior.join(' ') + ']',
  );
}
console.log();

console.log('=== Resource means, by belt class (procgen belts, 0-10 scale) ===');
console.log('  class       |  n      met  sil  vol  rare radio exo    (priors in brackets)');
const beltResByClass = {};
for (const b of bodies) {
  if (b.kind !== 'belt' || b.source !== 'procgen') continue;
  if (!b.beltClass) continue;
  if (!beltResByClass[b.beltClass]) {
    beltResByClass[b.beltClass] = { n: 0, sums: Object.fromEntries(RES.map(f => [f, 0])) };
  }
  beltResByClass[b.beltClass].n += 1;
  for (const f of RES) if (b[f] != null) beltResByClass[b.beltClass].sums[f] += b[f];
}
for (const cls of Object.keys(BELT_RESOURCE_PRIORS).sort()) {
  const r = beltResByClass[cls];
  const p = BELT_RESOURCE_PRIORS[cls];
  if (!r || !r.n) continue;
  const obs = RES.map(f => (r.sums[f] / r.n).toFixed(1).padStart(3));
  const prior = RES.map(f => p[f].mean.toString().padStart(3));
  console.log(
    '  ' + pad(cls, 11) +
    ' | ' + pad(r.n, 4, true) +
    '   ' + obs.join('  ') +
    '   [' + prior.join(' ') + ']',
  );
}
console.log();

// --- 10. Biosphere distribution ---------------------------------------------

console.log('=== Biosphere — archetype × tier matrix (procgen planets) ===');
const bioMatrix = {};
const tierTotals = {};
const archTotals = {};
let aliveCount = 0;
let totalProcgenAll = 0;
for (const b of bodies) {
  if (b.kind !== 'planet' || b.source !== 'procgen') continue;
  totalProcgenAll += 1;
  const t = b.biosphereTier ?? 'null';
  const a = b.biosphereArchetype ?? 'sterile';
  if (t && t !== 'none') {
    aliveCount += 1;
    archTotals[a] = (archTotals[a] || 0) + 1;
    if (!bioMatrix[a]) bioMatrix[a] = {};
    bioMatrix[a][t] = (bioMatrix[a][t] || 0) + 1;
  }
  tierTotals[t] = (tierTotals[t] || 0) + 1;
}
console.log('  total procgen planets: ' + totalProcgenAll);
console.log('  with life:             ' + aliveCount + ' (' + (aliveCount / totalProcgenAll * 100).toFixed(2) + '%)');
console.log();
const TIERS = BIOSPHERE_TIERS.filter(t => t !== 'none');
console.log('  archetype           |' + TIERS.map(t => pad(t, 11, true)).join(' |') + ' |  total');
console.log('  --------------------+' + TIERS.map(_ => '-'.repeat(12)).join('+') + '+--------');
for (const a of BIOSPHERE_ARCHETYPES) {
  const row = bioMatrix[a] || {};
  const cells = TIERS.map(t => pad(row[t] || 0, 11, true));
  const total = TIERS.reduce((s, t) => s + (row[t] || 0), 0);
  console.log('  ' + pad(a, 19) + ' |' + cells.join(' |') + ' | ' + pad(total, 6, true));
}
console.log();

console.log('=== Biosphere — observed vs predicted occurrence per (worldClass, archetype) ===');
console.log('  class      | archetype           | gate       |  n      hits   obs%     prior%   z');
console.log('  -----------+---------------------+------------+--------------------------------------');
for (const cls of Object.keys(BIOSPHERE_BY_CLASS)) {
  const archTable = BIOSPHERE_BY_CLASS[cls];
  for (const [archetype, spec] of Object.entries(archTable)) {
    // Count eligible bodies (in-gate, of this worldClass) and observed hits
    // (where this archetype was the chosen one). Note observed hits are a
    // LOWER bound on archetype rolls because the tier resolution prefers
    // higher tiers across archetypes — a silicate hit can be overridden by
    // a carbon_aqueous hit on the same body.
    let eligible = 0, hits = 0;
    for (const b of bodies) {
      if (b.kind !== 'planet' || b.source !== 'procgen') continue;
      if (b.worldClass !== cls) continue;
      if (spec.gate != null) {
        if (b.hostStarIdx == null || b.semiMajorAu == null) continue;
        const star = stars[b.hostStarIdx];
        if (!star || star.mass == null) continue;
        const S = insolation(star.mass, b.semiMajorAu);
        const r = BIOSPHERE_GATE_INSOLATION[spec.gate];
        if (S == null || S < r.min || S >= r.max) continue;
      }
      eligible += 1;
      if (b.biosphereArchetype === archetype) hits += 1;
    }
    if (!eligible) continue;
    const obsRate = hits / eligible;
    console.log(
      '  ' + pad(cls, 10) +
      ' | ' + pad(archetype, 19) +
      ' | ' + pad(spec.gate ?? '—', 10) +
      ' | ' + pad(eligible, 6, true) +
      ' ' + pad(hits, 5, true) +
      '   ' + pad((obsRate * 100).toFixed(2) + '%', 6, true) +
      '   ' + pad((spec.occurrenceRate * 100).toFixed(2) + '%', 6, true) +
      fmtZ(zBinom(hits, eligible, spec.occurrenceRate), Math.min(eligible * spec.occurrenceRate, eligible * (1 - spec.occurrenceRate))),
    );
  }
}
console.log();
