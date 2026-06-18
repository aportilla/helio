// World reconciliation — the pure mechanics behind "a build/remove must not zero
// the existing economy" (the committed persist-stock model). Kept sim-only (no
// catalog, no localStorage, no DOM) so it unit-tests under `node --test` exactly
// like project.ts; economy-bridge.ts composes these with BODIES, game-state, and
// the save.
//
// The contract: when the set of facilities changes, the projector yields a FRESH
// PlanetSpec[] (new flows, possibly new/removed planets, renumbered PlanetIds).
// We rebuild the World from that projection, then carry the live state across from
// the prior World, matched by Body.id:
//   - ACCUMULATOR columns (stock + the demand-signal memory) — so rates update
//     while the larder, smoothing, and hysteresis survive (World.copyAccumulators
//     owns the column partition, so a new sim column can't silently drop out).
//   - IN-FLIGHT cargo (the transfer ring + route table) — so a structural edit no
//     longer makes goods already deducted from a source and en route to a consumer
//     vanish from the ledger. Routes key on CLUSTERS (stable across an edit), so
//     they import verbatim; only the dense PlanetId endpoints renumber. Cargo whose
//     destination body the edit removed lands as stock on a same-cluster holding
//     planet (mirroring arrivals.reroute), keeping conservation exact.
// A plain reload skips reconciliation entirely — the bridge adopts the persisted
// world untouched when the facility set is unchanged.

import { asPlanet, type World, type TransferView } from '../../sim/src/index.ts';

// Are two PlanetId→Body.id tables identical (same bodies, same order)? When true,
// a restored save and the current facilities describe the same planets, so the
// bridge can adopt the restored World untouched (full fidelity, in-flight kept)
// rather than rebuild-and-transplant.
export function sameBodyIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Carry accumulated live state from `prev` into the freshly projected `next`,
// matched by Body.id, so a facility edit changes rates without resetting the
// economy. WHICH columns cross over (the live accumulators) vs. stay fresh (the
// re-derived projection) is the sim's call — World.copyAccumulators owns the
// partition (World.ACCUMULATOR_COLUMNS), so a new sim column can't silently drop
// out of the carry here. A body absent from `prev` (newly built) keeps its
// projected cold-start values. The sim clock and PRNG stream are kept continuous.
export function transplantLiveState(
  next: World,
  nextBodyIds: readonly string[],
  prev: World,
  prevBodyIds: readonly string[],
): void {
  const prevPlanetByBody = new Map<string, number>();
  prevBodyIds.forEach((id, p) => prevPlanetByBody.set(id, p));

  for (let np = 0; np < nextBodyIds.length; np++) {
    const pp = prevPlanetByBody.get(nextBodyIds[np]!);
    if (pp === undefined) continue; // a body new since `prev` → keep its cold start
    next.copyAccumulators(np, prev, pp);
  }

  next.turn = prev.turn;
  next.prng.setState(prev.prng.getState());

  carryInFlight(next, nextBodyIds, prev, prevBodyIds);
}

// Carry the prior World's live in-flight cargo into the freshly projected `next`,
// remapped by Body.id. Routes key on CLUSTERS (stars), whose identity is stable
// across a facility edit, so the route table imports verbatim and every transfer's
// routeRef stays valid; only the dense src/dst PlanetIds renumber. Re-minting into
// `next`'s empty ring always fits (its capacity equals `prev`'s, which already held
// these), so there is no pool-exhaustion path here — exhaustion can only arise from
// the turn's own dispatches later, inside step(). The ETA ledger is derived, so it
// is rebuilt from the ring AFTER every dstPlanet remap (it keys on dstPlanet +
// finalArrival).
function carryInFlight(
  next: World,
  nextBodyIds: readonly string[],
  prev: World,
  prevBodyIds: readonly string[],
): void {
  if (prev.ring.liveCount === 0) return; // nothing in transit — keep the cheap path

  const nextPlanetByBody = new Map<string, number>();
  nextBodyIds.forEach((id, p) => nextPlanetByBody.set(id, p));

  next.topology.importRoutes(prev.topology.exportRoutes());

  prev.ring.forEachLive((slot) => {
    const v = prev.ring.view(slot);
    const dstBody = prevBodyIds[v.dstPlanet as number];
    const nextDst = dstBody !== undefined ? nextPlanetByBody.get(dstBody) : undefined;
    if (nextDst === undefined) {
      // Destination body removed by the edit → land the cargo as stock, conserving it.
      landAsStock(next, v);
      return;
    }
    // The source is provenance only (read-surface "through" classification and the
    // getInTransitTo source field). If its body is gone, attribute the carried
    // transfer to a holding planet on the route's origin CLUSTER, so its source-
    // cluster classification is unchanged; land it if even that cluster is empty.
    const srcBody = prevBodyIds[v.srcPlanet as number];
    const nextSrc = srcBody !== undefined ? nextPlanetByBody.get(srcBody) : undefined;
    const src = nextSrc ?? (next.holdingPlanetOnStar(next.topology.getRoute(v.routeRef).hops[0]!) as number);
    if (src < 0) {
      landAsStock(next, v);
      return;
    }
    next.ring.restoreTransfer({
      id: v.id as number,
      resource: v.resource,
      qtyMilli: v.qtyMilli,
      srcPlanet: asPlanet(src),
      dstPlanet: asPlanet(nextDst),
      arrivalTurn: v.arrivalTurn,
      finalArrival: v.finalArrival,
      hopIndex: v.hopIndex,
      routeRef: v.routeRef,
    });
  });

  // Keep re-minted ids monotonic/unique against the turn's future dispatches.
  next.ring.nextTransferId = prev.ring.nextTransferId;
  // Rebuild the derived inbound ledger from the now-authoritative ring.
  next.ledger.rebuildFrom(next.ring);
}

// Land a carried transfer's cargo as re-allocatable stock at its current cluster
// (its current leg's origin hop), mirroring arrivals.reroute: the lowest-PlanetId
// living planet there, else any living planet. Conservation-preserving; only a
// fully empty economy (no living planet anywhere) drops it.
function landAsStock(world: World, v: TransferView): void {
  const atStar = world.topology.getRoute(v.routeRef).hops[v.hopIndex]!;
  let holding = world.holdingPlanetOnStar(atStar);
  if ((holding as number) < 0) holding = world.anyHoldingPlanet();
  if ((holding as number) < 0) return;
  const i = world.pr(holding, v.resource as number);
  world.stock[i] = world.stock[i]! + v.qtyMilli;
}
