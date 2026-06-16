// P2 — arrivals first (§8, §3.7). Drains the current arrival bucket; at each star
// a transfer reaches it does one of three things:
//   • Continue — final destination still valid and more legs remain → advance
//     the route in place to the next leg (no child record, the same slot relinks).
//   • Deliver — this is the destination and the target planet is live → credit
//     its stock.
//   • Re-route — destination gone/tombstoned or the onward edge was removed →
//     land the cargo as re-allocatable supply at this star (the same turn's
//     matcher re-homes it). Cargo is never stranded or spoiled.
//
// Identity is by tombstone on dstPlanet: a dead colony's dense index is never
// reused, so cargo can't misdeliver into a recycled slot — it re-routes (§3.7).
// The ledger is decremented by exactly the delivered/re-routed quantity, so
// `Σ inboundReserved == Σ in-flight` holds throughout (§11 rule 10).

import type { World } from './world.ts';
import type { StarId } from './ids.ts';
import type { TransferView } from './transfer-ring.ts';

export interface ArrivalsResult {
  readonly delivered: number;
  readonly rerouted: number;
  readonly continued: number;
}

export function advanceArrivals(world: World): ArrivalsResult {
  const ring = world.ring;
  const topo = world.topology;
  let delivered = 0;
  let rerouted = 0;
  let continued = 0;

  for (const slot of ring.takeDue(world.turn)) {
    const v = ring.view(slot);
    const route = topo.getRoute(v.routeRef);
    const nextHop = v.hopIndex + 1; // index in hops[] of the star just reached
    const arrivedStar = route.hops[nextHop]!;
    const isFinalLeg = nextHop === route.hops.length - 1;

    if (isFinalLeg) {
      if (world.isLive(v.dstPlanet)) {
        const di = world.pr(v.dstPlanet, v.resource as number);
        world.stock[di] = world.stock[di]! + v.qtyMilli;
        world.ledger.sub(v.dstPlanet, v.resource, v.finalArrival, v.qtyMilli);
        ring.free(slot);
        delivered += v.qtyMilli;
      } else {
        reroute(world, slot, arrivedStar, v);
        rerouted += v.qtyMilli;
      }
    } else {
      const onwardTo = route.hops[nextHop + 1]!;
      const onwardOk = topo.edgeExists(arrivedStar, onwardTo);
      if (world.isLive(v.dstPlanet) && onwardOk) {
        const newArrival = world.turn + route.legTurns[nextHop]!;
        ring.relink(slot, newArrival, nextHop);
        continued += v.qtyMilli;
      } else {
        reroute(world, slot, arrivedStar, v);
        rerouted += v.qtyMilli;
      }
    }
  }

  return { delivered, rerouted, continued };
}

/** Land cargo as re-allocatable supply at `atStar` (§3.7): the system's
 *  lowest-PlanetId living planet, else any living planet (a convoy whose port is
 *  gone sailing to the next). The original destination's inbound is released. */
function reroute(world: World, slot: number, atStar: StarId, v: TransferView): void {
  let holding = world.holdingPlanetOnStar(atStar);
  if ((holding as number) < 0) holding = world.anyHoldingPlanet();
  if ((holding as number) < 0) {
    throw new Error('reroute: no living planet anywhere to re-home cargo');
  }
  const hi = world.pr(holding, v.resource as number);
  world.stock[hi] = world.stock[hi]! + v.qtyMilli;
  world.ledger.sub(v.dstPlanet, v.resource, v.finalArrival, v.qtyMilli);
  world.ring.free(slot);
}
