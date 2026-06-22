// projectBody / projectWorld — THE adapter from player intent to sim input.
// In the sim a *planet* is the node and *facilities* are its contributors, read
// uniformly with no facility-type branch (sim/README.md §6.0). So here a BODY is
// the node and each facility is a contributor: a body's facilities' contributions
// SUM into one PlanetSpec, and the kernel never sees facility identity.
//
// This file imports the sim's runtime; the boundary guard
// (scripts/check-sim-boundary.mjs) forbids sim imports outside this package. The
// package README lists which modules here reach the sim.

import { STORAGE_UNCAPPED, type PlanetSpec } from '../../sim/src/index.ts';
import type { Body } from '../data/stars.ts';
import { FACILITY_BY_TYPE } from './registry.ts';
import { appResourceTable } from './resource-vocab.ts';
import type { Contribution, FacilityDef, PlacedFacility, ProjectionCtx, SimStarResolver } from './types.ts';

// Combine two storage ceilings. Inputs use the sim sentinel:
// callers translate a facility's "0 = no limit" via ceilingFromContribution()
// BEFORE folding. Any uncapped operand dominates; finite capacities sum; the
// min() keeps two uncapped sentinels (1<<30 + 1<<30 = 2^31) from wrapping
// negative when the World stores them in an Int32Array — a silent determinism
// corruptor if left unguarded.
function combineCeiling(a: number, b: number): number {
  if (a >= STORAGE_UNCAPPED || b >= STORAGE_UNCAPPED) return STORAGE_UNCAPPED;
  return Math.min(STORAGE_UNCAPPED, a + b);
}

// A facility's storageCeiling[r] of 0 means "I impose no limit" → the sim's
// uncapped sentinel. A positive value is a real finite capacity.
function ceilingFromContribution(facilityCeil: number): number {
  return facilityCeil === 0 ? STORAGE_UNCAPPED : facilityCeil;
}

// One body's facilities → one summed PlanetSpec, or null if the body hosts no
// LIVE facility — a known, non-retired def. A retired tombstone or an unknown
// type (skip-on-missing, mirroring game-state's tolerant load) contributes
// nothing and does not, on its own, make the body a sim node; so a tombstone can
// never inject stale economics, and a body whose only facility is retired/unknown
// is not projected. Pure, deterministic, integer-only.
export function projectBody(
  body: Body,
  facilities: readonly PlacedFacility[],
  ctx: ProjectionCtx,
): PlanetSpec | null {
  const liveDefs: FacilityDef[] = [];
  for (const f of facilities) {
    const def = FACILITY_BY_TYPE.get(f.type);
    if (def && !def.retired) liveDefs.push(def);
  }
  if (liveDefs.length === 0) return null;

  const R = ctx.R;
  const production = new Array<number>(R).fill(0);
  const consumption = new Array<number>(R).fill(0);
  const stock = new Array<number>(R).fill(0);
  // 0 is the combineCeiling identity (uncapped after the first fold); see §7.3.
  const storageCeiling = new Array<number>(R).fill(0);

  for (const def of liveDefs) {
    const c: Contribution = def.contribute(body, ctx);
    for (let r = 0; r < R; r++) {
      // Flows ADD; ceilings COMBINE (never add — see §7.3).
      production[r] = (production[r] ?? 0) + (c.production[r] ?? 0);
      consumption[r] = (consumption[r] ?? 0) + (c.consumption[r] ?? 0);
      stock[r] = (stock[r] ?? 0) + (c.stock[r] ?? 0);
      storageCeiling[r] = combineCeiling(
        storageCeiling[r] ?? 0,
        ceilingFromContribution(c.storageCeiling[r] ?? 0),
      );
    }
  }

  return { star: ctx.starOf(body), production, consumption, stock, storageCeiling };
}

// The full cold-start projection. PlanetIds are allocated in the order of the
// `bodies` argument (NOT facility-insertion or Map-iteration order), so CALLERS
// MUST pass bodies in canonical BODIES order — or the sim's seeded PRNG and any
// replay diverge. The function preserves the caller's order; it does
// not impose it. bodyIdByPlanet is the read-back side-table a future flow
// visualization resolves edges through.
export interface ProjectedWorld {
  readonly planets: readonly PlanetSpec[];
  /** PlanetId (dense index) → catalog Body.id. */
  readonly bodyIdByPlanet: readonly string[];
}

export function projectWorld(
  bodies: readonly Body[],
  facilitiesByBodyId: ReadonlyMap<string, readonly PlacedFacility[]>,
  starOf: SimStarResolver,
): ProjectedWorld {
  const ctx: ProjectionCtx = { R: appResourceTable().count, starOf };
  const planets: PlanetSpec[] = [];
  const bodyIdByPlanet: string[] = [];

  for (const body of bodies) {
    const facs = facilitiesByBodyId.get(body.id);
    if (!facs || facs.length === 0) continue;
    const spec = projectBody(body, facs, ctx);
    if (!spec) continue;
    planets.push(spec);
    bodyIdByPlanet.push(body.id);
  }

  return { planets, bodyIdByPlanet };
}
