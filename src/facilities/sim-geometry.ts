// Catalog → sim geometry adapter. Scales each cluster centre-of-mass's float
// light-year position into the sim's integer coordinate space and rounds — THE
// single float→int crossing for transport geometry, the geometry-side analogue
// of abundance.ts's role for richness.
//
// Why integer at all: the sim is integer-only so it stays bit-identical across
// re-implementations (the planned WASM port, sim/README.md), and everything a
// coordinate feeds — leg *turns*, EdgeIds, ring buckets, Dijkstra costs — is
// integer downstream, so a float coordinate would be floored at first use anyway.
// Concentrating that floor here keeps it auditable instead of smeared into the
// hot path.

import { makeGeometry, type StarGeometry } from '../../sim/src/index.ts';

// Integer sim units per light-year. At ×1000 (milli-light-year), ~50 ly of span
// stays far inside Int32 and squared distances stay exact as JS doubles (< 2^53),
// while the resulting 0.001-ly precision is finer than the catalog's own
// coordinate quality AND far finer than legTurnsForDist's quantization of the
// whole jump radius into a handful of integer turns — so it never costs a
// meaningful distance bit. PINNED: deriving it per-session (e.g. from a max over
// coords) would let rounding diverge a replay.
export const LY_TO_SIM_UNITS = 1000;

export interface StarCoord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// One geometry node per cluster, in the caller's order — the bridge passes the
// cluster centres-of-mass, so geometry index === STAR_CLUSTERS index === the
// value a SimStarResolver returns for a body. Round (not floor) for symmetric
// error.
export function buildGeometry(stars: readonly StarCoord[]): StarGeometry {
  return makeGeometry(
    stars.map((s) => [
      Math.round(s.x * LY_TO_SIM_UNITS),
      Math.round(s.y * LY_TO_SIM_UNITS),
      Math.round(s.z * LY_TO_SIM_UNITS),
    ] as const),
  );
}
