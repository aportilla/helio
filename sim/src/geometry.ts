// Static star geometry — integer 3-D coordinates, the substrate the jump graph
// and travel times are derived from (§9). A "system" is a star in v1 (1:1), so
// SystemId and StarId share an index space; the distinction is kept in the types
// because a future multi-star cluster (Helio reads a cluster as one system)
// will make them diverge, and the read surface already keys on SystemId.

import { isqrt } from './math.ts';
import type { StarId, SystemId } from './ids.ts';

export interface StarGeometry {
  readonly starCount: number;
  /** Parallel integer coordinate columns, indexed by star id. */
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly z: Int32Array;
}

/** Largest star count for which the lo·n+hi EdgeId pairing stays within Int32
 *  (so EdgeIds serialize losslessly). Well beyond any realistic galaxy. */
export const MAX_STARS = 46340;

export function makeGeometry(coords: ReadonlyArray<readonly [number, number, number]>): StarGeometry {
  const n = coords.length;
  if (n > MAX_STARS) throw new Error(`geometry: ${n} stars exceeds MAX_STARS (${MAX_STARS}) — EdgeId would overflow Int32`);
  const x = new Int32Array(n);
  const y = new Int32Array(n);
  const z = new Int32Array(n);
  coords.forEach((c, i) => {
    if (!Number.isInteger(c[0]) || !Number.isInteger(c[1]) || !Number.isInteger(c[2])) {
      throw new Error(`geometry: star ${i} has non-integer coords`);
    }
    x[i] = c[0]; y[i] = c[1]; z[i] = c[2];
  });
  return { starCount: n, x, y, z };
}

/** Exact integer Euclidean distance (floored) between two stars (§3, rule 7:
 *  travel time is a function of *absolute* distance). */
export function starDistance(g: StarGeometry, a: StarId, b: StarId): number {
  const dx = g.x[a]! - g.x[b]!;
  const dy = g.y[a]! - g.y[b]!;
  const dz = g.z[a]! - g.z[b]!;
  return isqrt(dx * dx + dy * dy + dz * dz);
}

/** v1: a system is its star. Kept as a function so consumers don't hard-code
 *  the 1:1 assumption when clusters arrive. */
export function systemOfStar(s: StarId): SystemId {
  return (s as number) as SystemId;
}
