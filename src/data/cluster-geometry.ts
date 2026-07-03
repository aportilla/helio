// Node-pure cluster-distance math, extracted from stars.ts so it is testable under `node --test`
// without loading the catalog / three.js. stars.ts wraps these over STAR_CLUSTERS' centres-of-mass;
// the pure core takes plain {x,y,z} points so the geometry can be unit-tested with fabricated data.

import type { Vec3 } from './kdtree.ts';

// Milli-light-years per light-year — the data-side unit crossing for galaxy movement (a drive's warp
// range/speed are authored in milli-ly). Deliberately mirrors the sim projection's LY_TO_SIM_UNITS
// (src/facilities/sim-geometry.ts) so a ship's reach and the economy's trade reach are measured on ONE
// scale; the equality is pinned by a test (src/facilities/test/warp-geometry-pins.test.ts), never an
// import (this leaf must not drag the sim in). Round — not floor — at the crossing for symmetric error,
// matching buildGeometry.
export const MILLI_PER_LY = 1000;

// Euclidean distance between two cluster COMs, in milli-light-years (integer). The single float→int
// crossing for movement geometry: COMs are catalog floats, everything movement stores is integer.
// Squared distances over the ~50 ly catalog span stay exact in JS doubles (< 2^53).
export function distanceMilliLy(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * MILLI_PER_LY);
}

// The indices of every point within `rangeMilli` of the origin, EXCLUDING the origin itself — movement's
// reachable-destination set. A linear scan (KDTree3 exposes only nearest(), no radius query); trivial at
// catalog scale, run once per menu-open / mode-entry. An out-of-bounds originIdx yields the empty set.
export function clustersWithinRange(coms: readonly Vec3[], originIdx: number, rangeMilli: number): number[] {
  const origin = coms[originIdx];
  if (!origin) return [];
  const out: number[] = [];
  for (let i = 0; i < coms.length; i++) {
    if (i === originIdx) continue;
    if (distanceMilliLy(origin, coms[i]!) <= rangeMilli) out.push(i);
  }
  return out;
}
