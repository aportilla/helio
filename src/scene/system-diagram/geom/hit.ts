// Point-in-disc hit test — the picker primitive for every circular body
// in the system diagram (stars, planets, moons). Compares squared
// distance to avoid the sqrt. The per-layer pick loops still own their
// own cx/cy/r sourcing and the returned DiagramPick kind; only this
// predicate is shared so the test can't drift between layers.
//
// The other picker, `hitsRing` (geom/ring.ts), deliberately lives apart:
// the circle pick is frame-independent and shared across three layers,
// while the ring pick is coupled to the ellipse parameterization that
// `ringEllipseParams` produces (it consumes a RingProbe of those same
// radii + tilt), so it stays next to the geometry that feeds it rather
// than being co-located here.

export function hitCircle(x: number, y: number, cx: number, cy: number, r: number): boolean {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
