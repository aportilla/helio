// The DTO that drives a warp DEPARTURE pick — the galaxy-view navigation-destination mode. Built by
// StarmapScene when the player clicks a ready ship in the galaxy sidebar's fleet list, it carries
// everything the mode needs to draw the pick, so the mode reads no game state of its own. Confirm
// dispatches the picked destination straight to orderShipWarp (no intent — warp is galaxy navigation,
// not an action-menu command).

import type { Ship } from '../game-state-codec';
import { clusterDistanceMilliLy, clustersWithinRangeMilliLy, systemIdForCluster } from '../data/stars';
import { shipWarpRangeMilliLy, warpTravelTurns } from '../ships/components/registry';

export interface DepartureDestination {
  // The reachable cluster + its stable system handle (what orderShipWarp keys the warp order on).
  readonly clusterIdx: number;
  readonly systemId: string;
  // Precomputed when the request is built so the mode only displays: milli-ly distance + ETA in turns.
  readonly distanceMilli: number;
  readonly etaTurns: number;
}

export interface DepartureRequest {
  readonly shipId: string;
  readonly shipName: string;
  readonly originClusterIdx: number;
  // The drive's warp range (milli-ly) — the range ring's radius (÷ MILLI_PER_LY → world light-years).
  readonly rangeMilliLy: number;
  // Every reachable destination, distance-ordered (nearest first), origin excluded.
  readonly reachable: readonly DepartureDestination[];
}

// Bake a ship + its origin cluster into a ready-to-pick DepartureRequest: its drive range and every
// in-range destination with distance + ETA precomputed and distance-ordered (nearest first — the mode
// pre-locks reachable[0]). Pure over the neutral catalog + ship-component leaves, so it's node-testable
// and reads no live game state. The caller has already resolved originClusterIdx from ship.systemId.
export function buildDepartureRequest(ship: Ship, originClusterIdx: number): DepartureRequest {
  const rangeMilliLy = shipWarpRangeMilliLy(ship.components);
  const reachable = clustersWithinRangeMilliLy(originClusterIdx, rangeMilliLy)
    .map((clusterIdx) => {
      const distanceMilli = clusterDistanceMilliLy(originClusterIdx, clusterIdx);
      return { clusterIdx, systemId: systemIdForCluster(clusterIdx), distanceMilli, etaTurns: warpTravelTurns(distanceMilli, ship.components) };
    })
    .sort((a, b) => a.distanceMilli - b.distanceMilli);
  return { shipId: ship.id, shipName: ship.name, originClusterIdx, rangeMilliLy, reachable };
}
