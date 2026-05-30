// Point-in-disc hit test — the picker primitive for every circular body
// in the system diagram (stars, planets, moons). Compares squared
// distance to avoid the sqrt. `pickDiscPool` (below) shares the loop that
// walks a layer's slots and returns the topmost (largest-z) hit, so the
// three layers can't drift on either the predicate or the depth
// resolution; each layer only supplies how to read a slot's cx/cy/r/z
// and how to label the pick.
//
// The other picker, `hitsRing` (geom/ring.ts), deliberately lives apart:
// the circle pick is frame-independent and shared across three layers,
// while the ring pick is coupled to the ellipse parameterization that
// `ringEllipseParams` produces (it consumes a RingProbe of those same
// radii + tilt), so it stays next to the geometry that feeds it rather
// than being co-located here.

function hitCircle(x: number, y: number, cx: number, cy: number, r: number): boolean {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Walk a pool of `count` circular bodies and return the TOPMOST whose
// disc contains (x, y), or null. A single pool can hold discs from
// different z bands (planets across row slots, moons across parents),
// and their discs overlap freely — a big inner planet's disc reaches
// into its outer neighbor's slot — so returning the first hit in
// iteration order would pick a body the depth test drew behind. We keep
// the largest-z match instead, mirroring the depth test; the coordinator
// then resolves across pools the same way. Strict `>` keeps the earlier
// slot on a z tie. The accessors decouple the walk from how each layer
// stores its slots: stars read mesh.position, planets/moons read a
// packed Float32Array. Generic in the pick type so this geometry module
// stays free of the layers' DiagramPick union — the caller's `makePick`
// fixes T at the call site.
export function pickDiscPool<T>(
  x: number,
  y: number,
  count: number,
  cxAt: (i: number) => number,
  cyAt: (i: number) => number,
  rAt: (i: number) => number,
  zAt: (i: number) => number,
  makePick: (i: number) => T,
): T | null {
  let bestI = -1;
  let bestZ = -Infinity;
  for (let i = 0; i < count; i++) {
    if (hitCircle(x, y, cxAt(i), cyAt(i), rAt(i)) && zAt(i) > bestZ) {
      bestZ = zAt(i);
      bestI = i;
    }
  }
  return bestI < 0 ? null : makePick(bestI);
}
