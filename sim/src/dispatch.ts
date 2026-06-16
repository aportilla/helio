// P7 — dispatch (§8). The SINGLE conservation chokepoint: the only place stock
// leaves a planet and enters transit. Per order: merge-on-dispatch into an
// existing same-(src,dst,res,arrivalTurn) transfer or mint a new one, decrement
// source stock by the floored qty, reserve inbound in the ETA ledger, and insert
// into the arrival ring. Auditable at exactly this point and at arrival (§3.6).
//
// Invariant A (§8): every insertion's arrival is ≥ turn + 1 (no min-distance leg
// arrives the same turn). The ring head advance is implicit — arrivals (P2) for
// turn T already drained bucket T before any P7 insertion, and all P7 arrivals
// are in future buckets.

import { floorToGranularity } from './math.ts';
import type { World } from './world.ts';
import type { DispatchPlan } from './allocate.ts';

export interface DispatchResult {
  readonly dispatched: number; // Σ qty that left sources this turn
  readonly records: number; // distinct transfer records touched (mint + merge)
}

export function dispatch(world: World, plan: DispatchPlan): DispatchResult {
  const R = world.R;
  let dispatched = 0;
  let records = 0;
  // Merge-on-dispatch dedup, scoped to this turn's chokepoint (§3.2). Keyed on
  // dstPlanet (never destination star) so multi-planet systems don't fan-in
  // wrongly.
  const mergeIndex = new Map<string, number>(); // key -> ring slot

  for (const o of plan.orders) {
    const grain = world.resources.metas[o.res as number]!.transferChunkMilli;
    const qty = floorToGranularity(o.qty, grain);
    if (qty <= 0) continue;

    if (o.firstLegArrival < world.turn + 1) {
      throw new Error(`dispatch: arrival ${o.firstLegArrival} < turn+1 (${world.turn + 1}) — Invariant A`);
    }
    const srcI = (o.src as number) * R + (o.res as number);
    if (world.stock[srcI]! < qty) {
      throw new Error(`dispatch: source ${o.src} stock ${world.stock[srcI]} < qty ${qty} (over-commit)`);
    }

    // Key on BOTH the first-leg arrival (the ring bucket) and the final arrival
    // (what the ledger/guard reconcile on), so two orders that share a first hop
    // but take different total routes never collide into a mismatched merge.
    const key = `${o.src}:${o.dst}:${o.res}:${o.firstLegArrival}:${o.finalArrival}`;
    const existing = mergeIndex.get(key);
    if (existing !== undefined) {
      // Durable cargo, identical route + arrival ⇒ quantities simply sum (§3.6).
      if (world.ring.finalArrival[existing]! !== o.finalArrival) {
        throw new Error('dispatch: merge key collision with mismatched final arrival');
      }
      world.ring.qtyMilli[existing] = world.ring.qtyMilli[existing]! + qty;
      world.ring.inFlightTotal += qty;
    } else {
      const slot = world.ring.mint({
        resource: o.res,
        qtyMilli: qty,
        srcPlanet: o.src,
        dstPlanet: o.dst,
        arrivalTurn: o.firstLegArrival,
        finalArrival: o.finalArrival,
        hopIndex: 0,
        routeRef: o.routeRef,
      });
      mergeIndex.set(key, slot);
      records++;
    }

    world.stock[srcI] = world.stock[srcI]! - qty;
    world.ledger.add(o.dst, o.res, o.finalArrival, qty);
    dispatched += qty;
  }

  return { dispatched, records };
}
