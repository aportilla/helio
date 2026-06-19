// Regression tests for defects surfaced by the adversarial review. Each pins a
// fix on a path the original suite did not exercise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scene, stepN, only, FOOD, P0, P1, P2 } from './helpers.ts';
import type { SceneSpec } from './helpers.ts';
import { quantify } from '../src/quantify.ts';
import { allocate } from '../src/allocate.ts';
import { dispatch } from '../src/dispatch.ts';
import type { DispatchOrder } from '../src/allocate.ts';
import { Topology } from '../src/topology.ts';
import { makeGeometry, MAX_STARS } from '../src/geometry.ts';
import { defaultBalance } from '../src/constants.ts';
import { serialize, deserialize } from '../src/serialize.ts';
import { EconomyEngine } from '../src/engine.ts';
import { ShortfallReason } from '../src/shortfall.ts';
import { asStar } from '../src/ids.ts';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

// — Fix A (critical): save/load survives a reach/speed tech change —

test('A: a save taken after researching reach/speed tech reloads and continues identically', () => {
  const SPEC: SceneSpec = {
    xs: [0, 30, 60, 90, 120],
    planets: [
      { star: 0, stock: [5000, 0, 0, 0], production: [80, 0, 0, 0] },
      { star: 2, stock: [0, 0, 0, 0], consumption: [50, 0, 0, 0] },
      { star: 4, stock: [100, 0, 0, 0], consumption: [40, 0, 0, 0] },
    ],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 8, setpointTurns: 3, keepBufferTurns: 3 },
    seed: 5,
  };
  const a = scene(SPEC);
  stepN(a.engine, 12);
  a.engine.applyTech({ jumpRadius: 130, travelSpeedTier: 1 }); // research reach + speed
  stepN(a.engine, 10);

  const saved = a.engine.serialize(); // previously: unloadable after any applyTech
  const b = new EconomyEngine(deserialize(a.skeleton, saved), { checkInvariants: true });
  assert.ok(bytesEqual(saved, serialize(b.world)), 'reload re-serializes identically (tech tiers restored)');
  for (let i = 0; i < 25; i++) {
    a.engine.step();
    b.step();
    assert.ok(bytesEqual(serialize(a.engine.world), serialize(b.world)), `divergence at continuation turn ${i}`);
  }
});

// — Fix B: inboundWithinH must not double-count when the horizon exceeds transit —

test('B: inboundWithinH counts each inbound once even when horizonH > transit span', () => {
  // maxLegTurns=1 → tiny maxTransit; horizonH=6 forces ringSpan to cover the window.
  const w = scene({
    xs: [0, 30],
    planets: [{ star: 0 }, { star: 1 }],
    cfg: { jumpRadius: 50, maxLegTurns: 1, horizonH: 6 },
  }).engine.world;
  assert.ok(w.ringSpan > w.cfg.horizonH, 'ring span dominates the horizon window');
  // finalTurn = turn+1 would alias to a second window slot under a too-small modulus.
  w.ledger.add(P0, FOOD, w.turn + 1, 1000);
  assert.equal(w.ledger.inboundWithinH(P0, FOOD, w.turn, 6), 1000, 'counted once, not aliased to 2000');
});

// — Fix C: a route re-costed by a topology rebuild gets its own table entry —

test('C: routeBetween after a re-cost matches getRoute(ref); the old ref stays valid', () => {
  const A = asStar(0), C = asStar(2);
  const topo = new Topology(makeGeometry([[0, 0, 0], [30, 0, 0], [60, 0, 0]]),
    defaultBalance({ jumpRadius: 50, maxLegTurns: 5 }));
  const before = topo.routeBetween(A, C)!;
  assert.equal(before.route.totalTurns, 6);

  topo.rebuild(defaultBalance({ jumpRadius: 50, maxLegTurns: 5, travelSpeedTier: 1 }));
  const after = topo.routeBetween(A, C)!;
  assert.equal(after.route.totalTurns, 4, 're-costed to 2+2');
  assert.notEqual(after.routeRef, before.routeRef, 'a fresh ref, not the stale one');
  assert.equal(topo.getRoute(after.routeRef).totalTurns, 4, 'table entry agrees with the returned route');
  assert.equal(topo.getRoute(before.routeRef).totalTurns, 6, 'in-flight cargo keeps its original route');
  assert.equal(topo.reachTurns(A, C), after.route.totalTurns, 'reachTurns agrees with the live route');
});

// — Fix E: Unreachable vs SourceExhausted is reach-scoped, not a galaxy-wide sum —

test('E: a reachable-but-exhausted region reads SourceExhausted even if far surplus exists', () => {
  // C reaches only the exhausted A; B holds surplus but is disconnected.
  const w = scene({
    xs: [0, 30, 5000],
    planets: [
      { star: 0, stock: only(FOOD, 0) }, // A reachable, no surplus
      { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }, // C
      { star: 2, stock: only(FOOD, 99999) }, // B far away, has surplus
    ],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6 },
  }).engine.world;
  const dp = allocate(w, quantify(w));
  assert.equal(dp.reasons.get(w.pr(P1, FOOD as number)), ShortfallReason.SourceExhausted,
    'locally-actionable: build production in reach, not "research jump range"');
});

test('E: a fully isolated colony reads Unreachable', () => {
  const w = scene({
    xs: [0, 5000],
    planets: [{ star: 0, stock: only(FOOD, 99999) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6 },
  }).engine.world;
  const dp = allocate(w, quantify(w));
  assert.equal(dp.reasons.get(w.pr(P1, FOOD as number)), ShortfallReason.Unreachable);
});

// — Fix F: merge key aligns with the guard (no spurious throw on distinct finals) —

test('F: two orders sharing a first-leg arrival but different finals do not collide', () => {
  const w = scene({
    xs: [0, 30],
    planets: [{ star: 0, stock: only(FOOD, 10000) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5 },
  }).engine.world;
  w.turn = 100;
  const rb = w.topology.routeBetween(w.starOf(P0), w.starOf(P1))!;
  const base: DispatchOrder = {
    src: P0, dst: P1, res: FOOD, qty: 100, routeRef: rb.routeRef,
    firstLegArrival: w.turn + rb.route.legTurns[0]!, finalArrival: w.turn + rb.route.totalTurns,
  };
  // Same (src,dst,res,firstLegArrival) but a different finalArrival → distinct records, no throw.
  const res = dispatch(w, { orders: [base, { ...base, finalArrival: base.finalArrival + 2 }], reasons: new Map() });
  assert.equal(res.records, 2, 'distinct finals → two records, no merge-collision throw');
});

// — Fix G: the read surface is internally consistent about "now" —

test('G: digest.turn + turnsRemaining == finalArrival (one canonical "now")', () => {
  const { engine } = scene({
    xs: [0, 30],
    planets: [{ star: 0, stock: only(FOOD, 600) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 },
    startTurn: 100,
  });
  engine.step();
  const digest = engine.getReadDigest();
  const deliveries = engine.getInTransitTo(P1, FOOD);
  assert.ok(deliveries.length > 0);
  for (const d of deliveries) {
    assert.equal(digest.turn + d.turnsRemaining, d.finalArrival, 'digest and drill-down agree on the turn');
  }
});

// — Overflow guard: star count is bounded so EdgeId stays within Int32 —

test('makeGeometry rejects a star count that would overflow EdgeId', () => {
  const coords = Array.from({ length: MAX_STARS + 1 }, (_, i) => [i, 0, 0] as const);
  assert.throws(() => makeGeometry(coords), /MAX_STARS/);
  void P2;
});
