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
} from './lib/procgen-priors.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = resolve(REPO_ROOT, 'src/data/catalog.generated.json');

// Mirrors CURATED_SYSTEM_HOSTS in build-catalog.mjs. Kept inline rather
// than imported so this script stays Node-runnable without pulling the
// build module's other deps.
const CURATED_HOSTS = new Set(['sol']);

const cat = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const { stars, bodies } = cat;

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
