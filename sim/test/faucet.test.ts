// Demand-pull (make-to-order) production — the faucet model. A producer mints ONLY
// what is pulled from it this turn, up to its per-turn rating; it holds nothing at rest;
// a producer with no consumer makes nothing. These pin the four sharpest edges:
// no-consumer mints 0, same-body self-feed nets in place, a zero-stock faucet
// still ships under CFL, and the capacity-math consistency that keeps dispatch's
// mint a backstop (never the primary gate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scene, only, stepN, stockOf, FOOD, P0, P1 } from './helpers.ts';
import { quantify } from '../src/quantify.ts';
import { allocate } from '../src/allocate.ts';

// — No-consumer faucet mints nothing; conservation holds (Δ = 0) —

test('a faucet with no consumer mints 0 — conservation holds, stock stays empty', () => {
  // checkInvariants defaults true → conservation/no-negative asserted every turn.
  const { engine } = scene({
    xs: [0],
    planets: [{ star: 0, production: only(FOOD, 8000) }], // pure producer, nobody buys
    cfg: { jumpRadius: 50 },
  });
  const w = engine.world;
  const before = w.totalStockAll() + w.ring.inFlightTotal;
  assert.doesNotThrow(() => stepN(engine, 12));
  const after = w.totalStockAll() + w.ring.inFlightTotal;
  assert.equal(after, before, 'nothing minted, nothing moved — Δ = 0');
  assert.equal(stockOf(engine, P0, FOOD), 0, 'no silo: a faucet holds nothing at rest');
});

// — Same-body produce + consume nets in place (D5: rankCandidates excludes self) —

test('a same-body farm+colony self-feeds in P3, never through the matcher (mixed-body, D5)', () => {
  // One body makes 8000 food and eats 4000 of it. The colony cannot be fed by the
  // co-located farm via the allocator (a body is never its own source), so the
  // ration MUST settle in P3. Conservation + no-negative are asserted each turn.
  const { engine } = scene({
    xs: [0],
    planets: [{ star: 0, production: only(FOOD, 8000), consumption: only(FOOD, 4000) }],
    cfg: { jumpRadius: 50 },
  });
  assert.doesNotThrow(() => stepN(engine, 20));
  engine.step();
  const rr = engine.getReadDigest().planets.get(P0)!.byResource.get(FOOD)!;
  assert.equal(rr.realizedConsumptionMilli, 4000, 'colony fully self-fed (fill 100%) from the co-located farm');
  // Net producer (8000 > 4000): realized production is the self-feed (4000) since
  // there is no off-body buyer here — utilization 50% of the 8000 rating.
  assert.equal(rr.realizedProductionMilli, 4000, 'self-feed only — no export pull, so 4000 of 8000 made');
  assert.equal(stockOf(engine, P0, FOOD), 0, 'self-feed in, ration out — nothing accumulates');
});

// — A zero-stock faucet still ships under a strict CFL (D10: CFL on capacity) —

test('CFL on a zero-stock faucet ships up to a fraction of CAPACITY, not (zero) stock', () => {
  // The deadlock landmine: a faucet rests at stock 0, so a stock-based CFL would
  // clamp every faucet to 0 outflow. Re-based onto offered capacity, a cflNum/cflDen
  // < 1 throttles to a fraction of the per-turn rating instead.
  const { engine } = scene({
    xs: [0],
    planets: [
      { star: 0, production: only(FOOD, 100) },                         // faucet, no resting stock
      { star: 0, stock: only(FOOD, 0), consumption: only(FOOD, 80) },   // hungry, same cluster (intra)
    ],
    cfg: { jumpRadius: 50, cflNum: 1, cflDen: 2, setpointTurns: 3, keepBufferTurns: 3, horizonH: 6 },
  });
  const r = engine.step();
  assert.ok(r.localDelivered > 0 && r.localDelivered <= 50,
    `faucet ships ≤ floor(100/2)=50 under CFL, got ${r.localDelivered}`);
  // The relief lands intra-cluster AND is eaten the same turn (P7.5 residual
  // consume). The consumer's appetite (80) exceeds the CFL-capped supply (≤50), so
  // it eats everything that landed and keeps nothing — fill < 100%, stock 0.
  const rr = engine.getReadDigest().planets.get(P1)!.byResource.get(FOOD)!;
  assert.equal(rr.realizedConsumptionMilli, r.localDelivered,
    'the consumer ate exactly its CFL-limited relief this turn — still hungry, nothing left over');
  assert.equal(stockOf(engine, P1, FOOD), 0, 'all relief consumed same-turn (demand exceeds capped supply)');
});

// — Capacity-math consistency: Σ planned outflow ≤ exportable ⇒ mint ≤ rating —

test('Σ planned outflow per source ≤ its offered exportable (dispatch mint stays a backstop)', () => {
  // The invariant that keeps dispatch Pass 0 from ever over-minting: allocate never
  // plans more from a source than quantify offered (netProd + resting), so
  // need − stock ≤ production always — the min(…, production) clamp is a backstop,
  // never the primary gate, and the Pass-1 over-commit guard cannot trip.
  const w = scene({
    xs: [0, 30, 60],
    planets: [
      { star: 0, production: only(FOOD, 80) },                          // faucet
      { star: 1, stock: only(FOOD, 500) },                              // resting-stock source
      { star: 2, stock: only(FOOD, 0), consumption: only(FOOD, 50) },   // consumer pulling on both
    ],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 },
  }).engine.world;
  const q = quantify(w);
  const dp = allocate(w, q);
  const planned = new Map<number, number>();
  for (const o of dp.orders) {
    const i = (o.src as number) * w.R + (o.res as number);
    planned.set(i, (planned.get(i) ?? 0) + o.qty);
  }
  assert.ok(planned.size > 0, 'the consumer actually drew from a source');
  for (const [i, total] of planned) {
    assert.ok(total <= q.exportable[i]!, `pr ${i}: planned ${total} ≤ exportable ${q.exportable[i]}`);
    const mint = Math.max(0, total - w.stock[i]!);
    assert.ok(mint <= w.production[i]!, `pr ${i}: mint ${mint} ≤ production rating ${w.production[i]}`);
  }
});
