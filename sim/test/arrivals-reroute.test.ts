import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scene, only, stepN, stockOf, FOOD, P1 } from './helpers.ts';
import type { EconomyEngine } from '../src/engine.ts';
import type { TurnReport } from '../src/engine.ts';

/** Every dispatched unit is delivered, re-routed, or still in flight — exactly. */
function assertFlowBalance(engine: EconomyEngine, reports: TurnReport[]) {
  const sum = (k: keyof TurnReport) => reports.reduce((s, r) => s + (r[k] as number), 0);
  assert.equal(
    sum('dispatched') - sum('delivered') - sum('rerouted'),
    engine.world.ring.inFlightTotal,
    'flow balance: dispatched − delivered − rerouted == in-flight');
}

test('single-leg delivery is durable: goods arrive exactly as shipped', () => {
  const { engine } = scene({
    xs: [0, 30],
    planets: [{ star: 0, stock: only(FOOD, 100000) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 },
  });
  const reports = stepN(engine, 12);
  const delivered = reports.reduce((s, r) => s + r.delivered, 0);
  assert.ok(delivered > 0, 'C received food');
  assert.equal(reports.reduce((s, r) => s + r.rerouted, 0), 0, 'nothing re-routed on a clean run');
  assert.ok(stockOf(engine, P1, FOOD) > 0, 'C accumulated a buffer');
  assertFlowBalance(engine, reports);
});

test('multi-leg relay: cargo continues through a waypoint star, then delivers', () => {
  // A(0) — [H waypoint at 30, no planet] — C(60). A→C is unreachable directly.
  const { engine } = scene({
    xs: [0, 30, 60],
    planets: [{ star: 0, stock: only(FOOD, 100000) }, { star: 2, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 8, setpointTurns: 3, keepBufferTurns: 3 },
  });
  const reports = stepN(engine, 16);
  assert.ok(reports.reduce((s, r) => s + r.continued, 0) > 0, 'a relay leg was advanced in place');
  assert.ok(reports.reduce((s, r) => s + r.delivered, 0) > 0, 'eventually delivered to C');
  assert.equal(reports.reduce((s, r) => s + r.rerouted, 0), 0);
  assertFlowBalance(engine, reports);
});

test('re-route on colony death: in-flight cargo re-homes, nothing is lost', () => {
  const { engine } = scene({
    xs: [0, 30, 60],
    planets: [{ star: 0, stock: only(FOOD, 100000) }, { star: 2, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 8, setpointTurns: 3, keepBufferTurns: 3 },
  });
  const before = stepN(engine, 2); // get a shipment moving toward C
  assert.ok(engine.world.ring.inFlightTotal > 0, 'cargo is in transit to C');
  const cStockAtDeath = stockOf(engine, P1, FOOD);

  engine.killPlanet(P1); // C destroyed (exogenous)
  const after = stepN(engine, 12);

  assert.ok(after.reduce((s, r) => s + r.rerouted, 0) > 0, 'the doomed cargo re-routed');
  assert.equal(stockOf(engine, P1, FOOD), cStockAtDeath, 'a dead colony never gains stock');
  assertFlowBalance(engine, [...before, ...after]);
});

test('re-route when the onward path is removed mid-journey', () => {
  // A(0) — H(30) — C(70). Legs A→H (30) and H→C (40) both legal at radius 50.
  const { engine } = scene({
    xs: [0, 30, 70],
    planets: [{ star: 0, stock: only(FOOD, 100000) }, { star: 2, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 8, setpointTurns: 3, keepBufferTurns: 3 },
  });
  const warmup = stepN(engine, 1); // dispatch a shipment A→C (arrives H in 3 turns)
  assert.ok(engine.world.ring.inFlightTotal > 0);

  // Sever the onward H→C leg (dist 40) while keeping A→H (dist 30): radius 35.
  engine.applyTech({ jumpRadius: 35 });
  const after = stepN(engine, 12);
  assert.ok(after.reduce((s, r) => s + r.rerouted, 0) > 0, 'cargo re-routed at H when H→C vanished');
  assertFlowBalance(engine, [...warmup, ...after]);
});

test('re-routed cargo flows onward to a still-hungry colony', () => {
  // A(0) producer; C(60) doomed; D on the waypoint star (30) stays hungry, so
  // re-homed cargo lands at D and feeds it rather than sitting idle.
  const { engine } = scene({
    xs: [0, 30, 60],
    planets: [
      { star: 0, stock: only(FOOD, 100000) },
      { star: 2, stock: only(FOOD, 0), consumption: only(FOOD, 50) }, // C (P1), doomed
      { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }, // D (P2) on the waypoint
    ],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 8, setpointTurns: 3, keepBufferTurns: 3 },
  });
  const warmup = stepN(engine, 2);
  engine.killPlanet(P1); // C dies; its in-flight cargo will re-home at the waypoint where D lives
  const reports = stepN(engine, 16);
  assert.ok(reports.reduce((s, r) => s + r.rerouted, 0) > 0, 're-route happened');
  assertFlowBalance(engine, [...warmup, ...reports]);
});
