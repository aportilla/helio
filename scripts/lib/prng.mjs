// FNV-1a + mulberry32 — shared seeded PRNG helpers for build-time
// derivations. Same numerical behavior the original syntheticMass /
// expandCoincidentSets used in build-catalog.mjs; lifted into a shared
// module so procgen.mjs can derive identical seeds from the same id
// strings, and so future build-time consumers don't fork the implementation.

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
