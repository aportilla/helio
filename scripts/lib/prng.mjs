// FNV-1a + mulberry32 — shared seeded PRNG helpers for build-time
// derivations. Same numerical behavior the original syntheticMass /
// expandCoincidentSets used in build-catalog.mjs; lifted into a shared
// module so procgen.mjs can derive identical seeds from the same id
// strings, and so future build-time consumers don't fork the implementation.
//
// **Mirrored at runtime** in src/scene/system-diagram/geom/prng.ts. Two
// copies exist because this file runs under Node (no TS toolchain in
// the build script's path) and the diagram runs in the bundled browser
// build. Any change to hash32 or mulberry32 here MUST be mirrored over
// there (and vice-versa) — drift would silently desync the runtime's
// per-body seeds from the ones baked into catalog.generated.json, so
// procgen moons/belts/rings would re-roll different layouts on load
// than the build script intended. sampleNormal / sampleTruncated are
// build-time only and have no runtime counterpart.

export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller normal sample. Returns one variate per call; the second
// variate is discarded — cheap enough for build-time use.
export function sampleNormal(prng, mean, sd) {
  let u1 = prng(); if (u1 < 1e-9) u1 = 1e-9;
  const u2 = prng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sd;
}

// Sample N(mean, sd), clamp to [min, max]. Optionally round to integer.
export function sampleTruncated(prng, spec, round = false) {
  const v = sampleNormal(prng, spec.mean, spec.sd);
  const clamped = Math.max(spec.min, Math.min(spec.max, v));
  return round ? Math.round(clamped) : clamped;
}

// Sample from a mixture of truncated normals. `spec` is an object mapping
// mode names to `{ mean, sd, min, max, weight }`. Weights need not sum to
// 1 — the sampler normalizes. Used for priors whose true distribution is
// bimodal (e.g. eccentricity: settled multi-planet systems vs. scattered
// outliers — a single normal can't fit both).
export function sampleMixture(prng, spec) {
  const modes = Object.values(spec);
  let totalWeight = 0;
  for (const m of modes) totalWeight += m.weight;
  let r = prng() * totalWeight;
  for (const m of modes) {
    r -= m.weight;
    if (r <= 0) return sampleTruncated(prng, m);
  }
  return sampleTruncated(prng, modes[modes.length - 1]);
}

// Poisson(λ) via Knuth's algorithm. Returns a non-negative integer.
// Suitable for the small λ (≤ ~15) the build-time procgen uses; for
// larger λ Atkinson's PA would be faster but we don't need it. Used in
// preference to truncated-normal for discrete count priors where Var ≈ λ
// is the natural shape — clamping a normal at 0 inflates the mean by
// ~10-20% when λ is small (see audit-procgen.mjs's moon-count drift
// before this sampler shipped).
export function samplePoisson(prng, lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= prng();
  } while (p > L);
  return k - 1;
}
