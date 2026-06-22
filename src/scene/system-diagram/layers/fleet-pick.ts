// The fleet's pick geometry, split out of fleet.ts as a pure leaf (no Three.js, no
// catalog) so it loads cleanly under node --test and the disc hit-test is pinned on
// its own. FleetLayer rebuilds the candidate list on each relayout (the formation is
// otherwise static) and delegates pickAt here.

// One pickable ship sprite: its parity-snapped center, disc radius, and the
// game-state Ship.id the pick carries out. Buffer-pixel coords, matching the layout.
export interface FleetPickCandidate {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly shipId: string;
}

// The ready ship whose disc covers (x, y), or null. The fleet is a single flat
// formation with no z-banding, so "topmost" reduces to the nearest center among the
// discs that actually contain the point (inclusive of the exact rim). Returns its
// shipId. A plain walk — the caller holds a stable candidate array, so no allocation.
export function pickFleetShip(
  candidates: readonly FleetPickCandidate[],
  x: number,
  y: number,
): string | null {
  let bestId: string | null = null;
  let bestD2 = Infinity;
  for (const c of candidates) {
    const dx = x - c.cx;
    const dy = y - c.cy;
    const d2 = dx * dx + dy * dy;
    if (d2 <= c.r * c.r && d2 < bestD2) {
      bestId = c.shipId;
      bestD2 = d2;
    }
  }
  return bestId;
}
