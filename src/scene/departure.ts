// The DTO that drives a warp DEPARTURE pick — the galaxy-view navigation-destination mode. Built by
// StarmapScene when the player warps a CONVOY (one or more ready ships) out of a system's galaxy-sidebar
// fleet list, it carries everything the mode needs to draw the pick, so the mode reads no game state of its
// own. Confirm dispatches the picked destination straight to orderGroupWarp (no intent — warp is galaxy
// navigation, not an action-menu command). A single-ship warp is just a convoy of one.

import type { Ship } from '../game-state-codec';
import { clusterDistanceMilliLy, clustersWithinRangeMilliLy, systemIdForCluster } from '../data/stars';
import { shipWarpRangeMilliLy, warpTravelTurns } from '../ships/components/registry';

export interface DepartureDestination {
  // The reachable cluster + its stable system handle (what orderGroupWarp keys the warp order on).
  readonly clusterIdx: number;
  readonly systemId: string;
  // Precomputed when the request is built so the mode only displays: milli-ly distance + convoy ETA in turns.
  readonly distanceMilli: number;
  readonly etaTurns: number;
}

export interface DepartureRequest {
  // The convoy — one or more ships warping together from the same origin cluster.
  readonly shipIds: readonly string[];
  readonly originClusterIdx: number;
  // The convoy's warp range (milli-ly) = the MINIMUM member range, since every member must reach the
  // destination (D2 intersection). Doubles as the range ring's radius (÷ MILLI_PER_LY → world light-years).
  readonly rangeMilliLy: number;
  // Every reachable destination, distance-ordered (nearest first), origin excluded. Reachable = within the
  // min range = exactly the intersection of the members' individual reaches.
  readonly reachable: readonly DepartureDestination[];
}

// Bake a convoy + its shared origin cluster into a ready-to-pick DepartureRequest: the group's range (MIN
// member range, so the ring bounds exactly what all members can reach) and every in-range destination with
// distance + CONVOY ETA (max member ETA — they arrive together, D1) precomputed and distance-ordered
// (nearest first). Pure over the neutral catalog + ship-component leaves, so it's node-testable and reads no
// live game state. The caller has resolved originClusterIdx and passes ≥1 same-origin ready ship.
export function buildDepartureRequest(ships: readonly Ship[], originClusterIdx: number): DepartureRequest {
  const rangeMilliLy = Math.min(...ships.map((s) => shipWarpRangeMilliLy(s.components)));
  const reachable = clustersWithinRangeMilliLy(originClusterIdx, rangeMilliLy)
    .map((clusterIdx) => {
      const distanceMilli = clusterDistanceMilliLy(originClusterIdx, clusterIdx);
      // Convoy ETA = the slowest member's transit time to this destination — they warp in together.
      const etaTurns = Math.max(...ships.map((s) => warpTravelTurns(distanceMilli, s.components)));
      return { clusterIdx, systemId: systemIdForCluster(clusterIdx), distanceMilli, etaTurns };
    })
    .sort((a, b) => a.distanceMilli - b.distanceMilli);
  return { shipIds: ships.map((s) => s.id), originClusterIdx, rangeMilliLy, reachable };
}
