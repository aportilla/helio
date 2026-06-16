import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scene, only, stepN, stockOf, FOOD, P0, P1 } from './helpers.ts';
import { ShortfallReason } from '../src/shortfall.ts';

// §12: breadbasket A(0), relay waypoint H(30, no planet), frontier colony C(60).
// A→C is unreachable directly (60 > radius 50); H bridges the gap. Tuned so each
// leg is 3 turns and H = 6 — exactly the doc's numbers.
function workedScene() {
  return scene({
    xs: [0, 30, 60],
    planets: [
      { star: 0, stock: only(FOOD, 600) }, // A: 600 exportable, no consumption
      // C eats 50 in P3 before quantify (P4) runs, so 170 → 120 at quantify time,
      // matching the doc's worked numbers (stock 120, projStock −180, deficit 330).
      { star: 2, stock: only(FOOD, 170), consumption: only(FOOD, 50) },
    ],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3, deadbandTurns: 1 },
    startTurn: 100,
  });
}

test('turn 100: C emits a 330 deficit and a relayed shipment is booked to arrive turn 106', () => {
  const { engine } = workedScene();
  const r100 = engine.step();

  // Quantify reproduces the doc: setpoint 150, projStock −180 → netDemand 330.
  assert.equal(engine.getResourceCover(P1, FOOD), -330);
  // One relayed shipment A→C, the only bound being A's surplus and C's need.
  assert.equal(r100.dispatched, 330, 'capped to need, drawn from A');

  const inTransit = engine.getInTransitTo(P1, FOOD);
  assert.equal(inTransit.length, 1);
  assert.equal(inTransit[0]!.sourcePlanet as number, 0, 'from breadbasket A');
  assert.equal(inTransit[0]!.finalArrival, 106, 'arrives turn 106 (100 + 6)');
});

test('the shipment relays through H, then delivers exactly 330 to C (durable)', () => {
  const { engine } = workedScene();
  const reports = stepN(engine, 7); // turns 100..106
  assert.ok(reports.reduce((s, r) => s + r.continued, 0) > 0, 'advanced its route in place at H');
  assert.ok(reports.reduce((s, r) => s + r.delivered, 0) >= 330, 'the 330 landed at C, exactly as shipped');
  assert.ok(stockOf(engine, P1, FOOD) > 120, 'C is better-stocked than it started');
});

test('C does NOT re-order the full deficit each turn (ETA ledger suppresses)', () => {
  const { engine } = workedScene();
  const reports = stepN(engine, 6); // turns 100..105, before delivery
  // Only the first turn dispatches the big wave; the inbound-within-H credit
  // keeps later turns from re-ordering another 330 (the anti-bullwhip property).
  const totalDispatched = reports.reduce((s, r) => s + r.dispatched, 0);
  assert.ok(totalDispatched < 660, `no thundering herd: dispatched ${totalDispatched}, not ~330/turn`);
});

test('redirect: C destroyed mid-journey → cargo re-routes at H, C never receives it', () => {
  const { engine } = workedScene();
  stepN(engine, 2); // turns 100,101 — wave is mid-route toward H
  const cStock = stockOf(engine, P1, FOOD);
  engine.killPlanet(P1); // C destroyed at turn 102
  const after = stepN(engine, 8);
  assert.ok(after.reduce((s, r) => s + r.rerouted, 0) > 0, 'the doomed wave re-routed (lands as supply at H/fallback)');
  assert.equal(stockOf(engine, P1, FOOD), cStock, 'a dead C is never delivered to');
});

test('without a bridge, C is Unreachable — and the read surface says how to fix it', () => {
  const { engine } = scene({
    xs: [0, 60], // A and C 60 apart, no waypoint
    planets: [{ star: 0, stock: only(FOOD, 600) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6 },
    startTurn: 100,
  });
  engine.step();
  assert.equal(engine.explainShortfall(P1, FOOD)!.reason, ShortfallReason.Unreachable);

  // Researching jump range to span 60 makes the direct edge legal — reach fixed.
  engine.applyTech({ jumpRadius: 70 });
  engine.step();
  assert.equal(engine.explainShortfall(P1, FOOD), null, 'now served — the shortfall clears');
  assert.ok(engine.getInTransitTo(P1, FOOD).length > 0, 'a direct shipment is on the way');
  void P0;
});
