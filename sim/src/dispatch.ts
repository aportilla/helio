// P7 — dispatch (§8). The SINGLE conservation chokepoint: the only place stock
// leaves a planet — AND, under demand-pull, the single point a producer's export
// stock is BORN. A demand-pull faucet holds nothing at rest; Pass 0 mints exactly
// what the plan pulls from each source (capped at its per-turn rating, after
// resting stock), then Pass 1 ships it. So a producer with no consumer mints
// nothing and there is no glut.
//
// An interstellar order enters transit — merge-on-dispatch into an existing
// same-(src,dst,res,arrivalTurn) transfer or mint a new one, decrement source
// stock by the floored qty, reserve inbound in the ETA ledger, and insert into
// the arrival ring. An intra-cluster (same-node) order is instead deposited
// straight into the destination the same turn — the cargo is already home, so it
// never sits in the ring (§ 0-turn intra-system transfers). Either way stock is
// conserved and auditable at exactly this point (§3.6).
//
// Invariant A (§8): every RING insertion's arrival is ≥ turn + 1 (no min-distance
// leg arrives the same turn). The same-node fast path is exempt — it makes no ring
// insertion. The ring head advance is implicit — arrivals (P2) for turn T already
// drained bucket T before any P7 insertion, and all P7 arrivals are in future
// buckets.

import type { World } from './world.ts';
import type { DispatchPlan } from './allocate.ts';
import type { PlanetId, ResourceId } from './ids.ts';

/** A same-cluster (intra-node) move executed instantly this turn: deposited
 *  straight into the destination's stock, never minted into the ring. The read
 *  surface's intra-node analogue of `edgeFlows` — a strict sink the viz reads to
 *  draw internal lanes, aggregated by (src, dst, res). */
export interface LocalTransfer {
  readonly srcPlanet: PlanetId;
  readonly dstPlanet: PlanetId;
  readonly resource: ResourceId;
  readonly qtyMilli: number;
}

export interface DispatchResult {
  readonly dispatched: number; // Σ qty that left sources into transit this turn (interstellar)
  readonly records: number; // distinct ring records touched (mint + merge)
  readonly localDelivered: number; // Σ qty deposited same-turn by intra-cluster moves
  readonly localTransfers: readonly LocalTransfer[]; // those moves, aggregated by (src,dst,res)
  readonly producedMintedTotal: number; // Σ export stock minted on pull this turn (the off-body half of `produced`)
  readonly producedMinted: Int32Array; // per-(planet, resource) export mint — the off-body component of realized production
}

export function dispatch(world: World, plan: DispatchPlan): DispatchResult {
  const R = world.R;
  let dispatched = 0;
  let records = 0;
  let localDelivered = 0;
  // Merge-on-dispatch dedup, scoped to this turn's chokepoint (§3.2). Keyed on
  // dstPlanet (never destination star) so multi-planet systems don't fan-in
  // wrongly.
  const mergeIndex = new Map<string, number>(); // key -> ring slot (string key is a small-int concat: repack to a packed int at WASM-port time)
  // Intra-cluster deposits this turn, aggregated by (src,dst,res). Same small-int
  // string-concat key convention as mergeIndex.
  const localAgg = new Map<string, { srcPlanet: PlanetId; dstPlanet: PlanetId; resource: ResourceId; qtyMilli: number }>();

  // PASS 0 — realize-on-pull. Mint exactly what the plan pulls from each source,
  // resting stock first, then up to the per-turn production rating. A dense typed
  // array (NOT a Map) keeps the tally deterministic. The `min(…, production)` is a
  // BACKSTOP: allocate only ever planned qty ≤ exportable = netProd + resting, so
  // need − stock ≤ production always holds and allocate stays the single authority
  // for per-order quantity. After this pass stock[src] ≥ Σ qty for every planned
  // source, so the Pass-1 over-commit guard is a genuine backstop, not dead code.
  const need = new Int32Array(world.planetCount * R);
  for (const o of plan.orders) need[(o.src as number) * R + (o.res as number)]! += o.qty;
  const producedMinted = new Int32Array(world.planetCount * R);
  let producedMintedTotal = 0;
  for (let i = 0; i < need.length; i++) {
    if (need[i] === 0) continue;
    const mint = Math.max(0, Math.min(need[i]! - world.stock[i]!, world.production[i]!));
    if (mint > 0) {
      producedMinted[i] = mint;
      producedMintedTotal += mint;
      world.stock[i] = world.stock[i]! + mint;
    }
  }

  // PASS 1 — the order loop. After Pass 0, source stock covers every planned qty.
  for (const o of plan.orders) {
    const qty = o.qty;
    if (qty <= 0) continue;

    const srcI = (o.src as number) * R + (o.res as number);
    if (world.stock[srcI]! < qty) {
      throw new Error(`dispatch: source ${o.src} stock ${world.stock[srcI]} < qty ${qty} (over-commit)`);
    }

    // Intra-cluster (same node): the cargo is already home. Deposit it straight
    // into the destination's stock THIS turn — no ring, no ledger reserve, no
    // Invariant A (which guards ring insertions only). Net stock change is zero
    // (src −qty, dst +qty), so conservation holds with no new accounting, and
    // nothing is left aloft at a resting turn boundary.
    if (world.star[o.src as number] === world.star[o.dst as number]) {
      const dstI = (o.dst as number) * R + (o.res as number);
      world.stock[srcI] = world.stock[srcI]! - qty;
      world.stock[dstI] = world.stock[dstI]! + qty;
      localDelivered += qty;
      const key = `${o.src}:${o.dst}:${o.res}`;
      const cur = localAgg.get(key);
      if (cur) cur.qtyMilli += qty;
      else localAgg.set(key, { srcPlanet: o.src, dstPlanet: o.dst, resource: o.res, qtyMilli: qty });
      continue;
    }

    // Interstellar: enter the ring. Key on BOTH the first-leg arrival (the ring
    // bucket) and the final arrival (what the ledger/guard reconcile on), so two
    // orders that share a first hop but take different total routes never collide
    // into a mismatched merge.
    if (o.firstLegArrival < world.turn + 1) {
      throw new Error(`dispatch: arrival ${o.firstLegArrival} < turn+1 (${world.turn + 1}) — Invariant A`);
    }
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

  // Deterministic order: by src, then dst, then res. allocate already produces
  // orders deterministically; sorting makes the emitted list independent of
  // insertion order regardless.
  const localTransfers = [...localAgg.values()].sort((a, b) =>
    (a.srcPlanet as number) - (b.srcPlanet as number) ||
    (a.dstPlanet as number) - (b.dstPlanet as number) ||
    (a.resource as number) - (b.resource as number));

  return { dispatched, records, localDelivered, localTransfers, producedMintedTotal, producedMinted };
}
