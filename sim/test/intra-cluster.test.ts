// 0-turn intra-cluster transfers (§ the intra-system zero-turn-transfer plan). A
// same-star (same-node) move is delivered the SAME turn — deposited straight into
// the destination's stock, never minted into the ring — while inter-star hauls keep
// their multi-turn transit and in-flight representation. These pin both the dispatch
// fast path and a full-step turn, plus determinism and legacy-save back-compat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/dispatch.ts';
import type { DispatchOrder } from '../src/allocate.ts';
import { serialize } from '../src/serialize.ts';
import { scene, only, stepN, stockOf, FOOD, P0, P1, P2 } from './helpers.ts';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

// Two planets on ONE star (one cluster) — every order between them is intra-node.
// The interned self-route is harmless: the same-star branch never traverses it.
function sameStarWorld() {
  const w = scene({
    xs: [0],
    planets: [{ star: 0, stock: only(FOOD, 1000) }, { star: 0, stock: only(FOOD, 0) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5 },
  }).engine.world;
  w.turn = 100;
  const rb = w.topology.routeBetween(w.starOf(P0), w.starOf(P1))!;
  const order = (qty: number): DispatchOrder => ({
    src: P0, dst: P1, res: FOOD, qty, routeRef: rb.routeRef,
    firstLegArrival: w.turn + rb.route.legTurns[0]!,
    finalArrival: w.turn + rb.route.totalTurns,
  });
  return { w, order };
}

// — dispatch fast path —

test('same-star order deposits instantly: no ring, no ledger, recorded as a local transfer', () => {
  const { w, order } = sameStarWorld();
  const res = dispatch(w, { orders: [order(300)], reasons: new Map() });
  assert.equal(res.dispatched, 0, 'nothing entered transit');
  assert.equal(res.records, 0, 'no ring record minted');
  assert.equal(res.localDelivered, 300, 'deposited same-turn');
  assert.equal(w.stock[w.pr(P0, FOOD as number)], 700, 'source debited');
  assert.equal(w.stock[w.pr(P1, FOOD as number)], 300, 'destination credited the same turn');
  assert.equal(w.ring.inFlightTotal, 0, 'nothing aloft');
  assert.equal(w.ring.liveCount, 0);
  assert.equal(w.ledger.total(), 0, 'no inbound reserved');
  assert.deepEqual(
    res.localTransfers.map((t) => [t.srcPlanet as number, t.dstPlanet as number, t.resource as number, t.qtyMilli]),
    [[0, 1, 0, 300]],
  );
});

test('over-commit guard still applies to a same-star order', () => {
  const { w, order } = sameStarWorld();
  assert.throws(() => dispatch(w, { orders: [order(5000)], reasons: new Map() }), /over-commit/);
});

test('two same-(src,dst,res) intra orders aggregate into one local transfer', () => {
  const { w, order } = sameStarWorld();
  const res = dispatch(w, { orders: [order(100), order(250)], reasons: new Map() });
  assert.equal(res.localDelivered, 350);
  assert.equal(res.localTransfers.length, 1, 'aggregated by (src,dst,res)');
  assert.equal(res.localTransfers[0]!.qtyMilli, 350);
  assert.equal(w.stock[w.pr(P1, FOOD as number)], 350, 'destination credited the sum');
});

test('Invariant A does not apply to an intra-cluster order (it makes no ring insertion)', () => {
  const { w, order } = sameStarWorld();
  // firstLegArrival == turn would be rejected on the ring path; the fast path is exempt.
  const o = { ...order(100), firstLegArrival: w.turn, finalArrival: w.turn };
  assert.doesNotThrow(() => dispatch(w, { orders: [o], reasons: new Map() }));
  assert.equal(w.stock[w.pr(P1, FOOD as number)], 100);
});

// — full-step behaviour —

function relievedConsumerCfg() {
  return { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 };
}

test('a same-cluster producer→consumer is relieved the SAME turn, nothing left aloft', () => {
  const { engine } = scene({
    xs: [0],
    planets: [{ star: 0, stock: only(FOOD, 600) }, { star: 0, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: relievedConsumerCfg(),
  });
  const r = engine.step(); // checkInvariants defaults true → conservation/ledger asserted
  assert.ok(r.localDelivered > 0, 'cargo moved intra-cluster this turn');
  assert.equal(r.dispatched, 0, 'no interstellar volume');
  assert.equal(engine.world.ring.inFlightTotal, 0, 'ring empty — instant, not in flight');
  assert.equal(engine.world.ring.liveCount, 0);
  assert.equal(engine.getInTransitTo(P1, FOOD).length, 0, 'nothing in transit toward the consumer');
  assert.ok(stockOf(engine, P1, FOOD) > 0, 'the relief landed in the consumer this turn');
  const lt = engine.getLocalTransfers();
  assert.equal(lt.length, 1);
  assert.equal(lt[0]!.srcPlanet as number, 0);
  assert.equal(lt[0]!.dstPlanet as number, 1);
});

test('an inter-cluster producer→consumer still mints a ring transfer and is in flight', () => {
  const { engine } = scene({
    xs: [0, 30],
    planets: [{ star: 0, stock: only(FOOD, 600) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: relievedConsumerCfg(),
  });
  const r = engine.step();
  assert.equal(r.localDelivered, 0, 'crossing the void is not an intra move');
  assert.equal(engine.getLocalTransfers().length, 0);
  assert.ok(r.dispatched > 0, 'volume entered transit');
  assert.ok(engine.world.ring.inFlightTotal > 0, 'cargo is aloft until it arrives');
  assert.ok(engine.getInTransitTo(P1, FOOD).length > 0, 'and reads as in-transit');
});

test('mixed turn: the intra move lands instantly while the inter haul flies', () => {
  // P0 (star 0) feeds both P1 (star 0, intra) and P2 (star 1, inter).
  const { engine } = scene({
    xs: [0, 30],
    planets: [
      { star: 0, stock: only(FOOD, 100000) },
      { star: 0, stock: only(FOOD, 0), consumption: only(FOOD, 50) },
      { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) },
    ],
    cfg: relievedConsumerCfg(),
  });
  const r = engine.step();
  assert.ok(r.localDelivered > 0 && r.dispatched > 0, 'both an intra deposit and an inter dispatch happened');
  const lt = engine.getLocalTransfers();
  assert.equal(lt.length, 1, 'localTransfers records exactly the intra move');
  assert.equal(lt[0]!.dstPlanet as number, 1, 'the same-star consumer P1');
  assert.equal(engine.getInTransitTo(P1, FOOD).length, 0, 'P1 got it instantly');
  assert.equal(engine.getInTransitTo(P2, FOOD).length, 1, 'P2 is still waiting on its haul');
  assert.equal(engine.world.ring.inFlightTotal, engine.world.ledger.total(), 'ledger == ring (only the inter cargo)');
  assert.ok(engine.world.ring.inFlightTotal > 0);
});

test('flow balance closes over a long intra+inter run (telemetry split is honest)', () => {
  // Intra moves touch neither dispatched/delivered nor the ring, so the ring
  // identity Σdispatched − Σdelivered − Σrerouted == in-flight must still hold,
  // and the produced/consumed mass balance closes including the instant deposits.
  const { engine } = scene({
    xs: [0, 30, 60],
    planets: [
      { star: 0, stock: only(FOOD, 100000), production: only(FOOD, 120) },
      { star: 0, stock: only(FOOD, 0), consumption: only(FOOD, 50) }, // intra sink
      { star: 0, stock: only(FOOD, 0), consumption: only(FOOD, 30) }, // intra sink
      { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 40) }, // inter sink
      { star: 2, stock: only(FOOD, 0), consumption: only(FOOD, 20) }, // inter sink (relays via star 1)
    ],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 8, setpointTurns: 3, keepBufferTurns: 3 },
  });
  const w = engine.world;
  const initial = w.totalStockAll() + w.ring.inFlightTotal;
  const reports = stepN(engine, 80); // checkInvariants on → conservation asserted each turn
  const sum = (k: 'dispatched' | 'delivered' | 'rerouted' | 'produced' | 'consumed' | 'localDelivered') =>
    reports.reduce((s, r) => s + r[k], 0);

  assert.equal(sum('dispatched') - sum('delivered') - sum('rerouted'), w.ring.inFlightTotal, 'flow balance closes');
  assert.equal(w.totalStockAll() + w.ring.inFlightTotal - initial, sum('produced') - sum('consumed'), 'no goods created/destroyed');
  assert.ok(sum('localDelivered') > 0, 'intra-cluster moves actually happened');
});

test('intra-heavy scenes serialize byte-identically across two independent runs', () => {
  const build = () => scene({
    xs: [0, 30],
    planets: [
      { star: 0, stock: only(FOOD, 100000), production: only(FOOD, 80) },
      { star: 0, stock: only(FOOD, 0), consumption: only(FOOD, 50) },
      { star: 0, stock: only(FOOD, 0), consumption: only(FOOD, 30) },
      { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 40) }, // one inter sink for contrast
    ],
    cfg: relievedConsumerCfg(),
    seed: 7,
  }).engine;
  const a = build();
  const b = build();
  stepN(a, 30);
  stepN(b, 30);
  assert.ok(bytesEqual(serialize(a.world), serialize(b.world)),
    'integer-only deposits + deterministic order keep the save bit-stable');
});

test('back-compat: a legacy same-star ring transfer drains via arrivals, then intra stays ring-empty', () => {
  // Simulate a pre-0-turn save: a same-star transfer sitting in the ring, due now.
  const { engine } = scene({
    xs: [0],
    planets: [{ star: 0, stock: only(FOOD, 0) }, { star: 0, stock: only(FOOD, 0) }],
    cfg: { jumpRadius: 50 },
    startTurn: 5,
  });
  const w = engine.world;
  const rb = w.topology.routeBetween(w.starOf(P0), w.starOf(P1))!; // self-route
  const qty = 300;
  w.ring.mint({
    resource: FOOD, qtyMilli: qty, srcPlanet: P0, dstPlanet: P1,
    arrivalTurn: w.turn, finalArrival: w.turn, hopIndex: 0, routeRef: rb.routeRef,
  });
  w.ledger.add(P1, FOOD, w.turn, qty);
  assert.equal(w.ring.inFlightTotal, qty, 'the legacy cargo is aloft at load');

  const r = engine.step(); // arrivals (P2) delivers it — regardless of shared star
  assert.ok(r.delivered >= qty, 'delivered via arrivals, not the new fast path');
  assert.equal(r.localDelivered, 0, 'no NEW intra deposit this turn');
  assert.equal(engine.getLocalTransfers().length, 0);
  assert.equal(w.ring.inFlightTotal, 0, 'ring emptied of the legacy intra cargo');
  assert.equal(stockOf(engine, P1, FOOD), qty, 'it landed in the destination stock');

  engine.step();
  assert.equal(w.ring.liveCount, 0, 'steady state: nothing intra ever re-enters the ring');
});
