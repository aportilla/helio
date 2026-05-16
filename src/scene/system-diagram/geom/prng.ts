// FNV-1a 32-bit hash and mulberry32 PRNG, matched bit-for-bit with the
// build-time pair in scripts/lib/prng.mjs. Two copies exist because the
// build script runs under Node and the diagram runs in the browser; any
// change here must be mirrored in scripts/lib/prng.mjs (and vice-versa)
// or the runtime moon/belt/ring seeds will drift from what was baked
// into catalog.generated.json.

// Deterministic per-string. Each planet's moon ring, belt's chunk pattern,
// and ring's tilt rolls off a `${kind}:${body.id}` seed; identical seed in
// → identical hash out → identical PRNG stream.
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — one instance per consumer so draws stay isolated. A
// shared global PRNG would couple every belt's chunk layout to every
// other belt's draw count, breaking determinism under any reordering.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}
