import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/dispatch.ts';
import type { DispatchOrder, DispatchPlan } from '../src/allocate.ts';
import { scene, only, FOOD, P0, P1 } from './helpers.ts';

function worldWithRoute() {
  // A (star0, producer) and C (star1) 30 apart — a single direct leg.
  const w = scene({
    xs: [0, 30],
    planets: [{ star: 0, stock: only(FOOD, 1000) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
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

test('dispatch moves stock into transit and reserves the ledger', () => {
  const { w, order } = worldWithRoute();
  const res = dispatch(w, { orders: [order(300)], reasons: new Map() });
  assert.equal(res.dispatched, 300);
  assert.equal(res.records, 1);
  assert.equal(w.stock[w.pr(P0, FOOD as number)], 700, 'source debited');
  assert.equal(w.ring.inFlightTotal, 300, 'now in transit');
  assert.equal(w.ledger.total(), 300, 'inbound reserved == in-flight');
});

test('merge-on-dispatch: two identical-key orders become one record, summed', () => {
  const { w, order } = worldWithRoute();
  const plan: DispatchPlan = { orders: [order(100), order(250)], reasons: new Map() };
  const res = dispatch(w, plan);
  assert.equal(res.records, 1, 'one record, not two');
  assert.equal(w.ring.liveCount, 1);
  assert.equal(w.ring.inFlightTotal, 350, 'quantities summed (durable cargo)');
  assert.equal(w.ledger.total(), 350);
});

test('Invariant A: an order arriving the same turn is rejected', () => {
  const { w, order } = worldWithRoute();
  const bad = { ...order(100), firstLegArrival: w.turn };
  assert.throws(() => dispatch(w, { orders: [bad], reasons: new Map() }), /Invariant A/);
});

test('over-commit guard: shipping more than stock throws', () => {
  const { w, order } = worldWithRoute();
  assert.throws(() => dispatch(w, { orders: [order(5000)], reasons: new Map() }), /over-commit/);
});

test('all goods ship at milli granularity; no chunk flooring at dispatch', () => {
  // No per-resource chunk: an order of 2500 ships the full 2500, nothing held back.
  const w = scene({
    xs: [0, 30],
    planets: [{ star: 0, stock: [0, 0, 5000, 0] }, { star: 1, stock: [0, 0, 0, 0], consumption: [0, 0, 100, 0] }],
    cfg: { jumpRadius: 50, maxLegTurns: 5 },
  }).engine.world;
  w.turn = 10;
  const rb = w.topology.routeBetween(w.starOf(P0), w.starOf(P1))!;
  const res = dispatch(w, {
    orders: [{ src: P0, dst: P1, res: (2 as unknown as typeof FOOD), qty: 2500, routeRef: rb.routeRef,
      firstLegArrival: w.turn + rb.route.legTurns[0]!, finalArrival: w.turn + rb.route.totalTurns }],
    reasons: new Map(),
  });
  assert.equal(res.dispatched, 2500, 'the full order ships — no grain');
  assert.equal(w.stock[w.pr(P0, 2)], 2500, 'source debited by exactly the order');
});
