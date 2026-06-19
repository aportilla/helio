import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scene, only, stepN, stockOf, FOOD, P0, P1 } from './helpers.ts';
import { STORAGE_UNCAPPED } from '../src/world.ts';
import { asResource } from '../src/ids.ts';

// Read realized production / consumption for a (planet, resource) off the digest —
// the integers behind the display utilization % / fill %.
function realized(engine: ReturnType<typeof scene>['engine'], p: typeof P0, r = FOOD) {
  const rr = engine.getReadDigest().planets.get(p)?.byResource.get(asResource(r as number));
  return { prod: rr?.realizedProductionMilli ?? 0, cons: rr?.realizedConsumptionMilli ?? 0 };
}

test('demand-pull: a producer with no consumer makes nothing (no silo, no glut)', () => {
  // A faucet rated 100 food/turn, no reachable consumer. It mints only what's
  // pulled — and nothing is pulled — so it holds ~0 and runs at 0% utilization.
  const { engine } = scene({
    xs: [0],
    planets: [{ star: 0, production: only(FOOD, 100) }],
    cfg: { jumpRadius: 50 },
  });
  stepN(engine, 8);
  assert.equal(stockOf(engine, P0, FOOD), 0, 'no silo fill — a faucet holds nothing at rest');
  assert.equal(realized(engine, P0).prod, 0, 'idle faucet realized 0 (0% utilization)');
});

test('demand-pull: an over-subscribed faucet runs at 100% and its consumer reads under-fed', () => {
  // C wants 150/turn but A makes only 100 — the faucet pegs at its capacity (100%
  // utilization) and C stays hungry (fill < 100%): the two continuous rates ARE the
  // demand-pull signals — 100% means "maxed", and the under-fill IS the shortage cue.
  const { engine } = scene({
    xs: [0],
    planets: [
      { star: 0, production: only(FOOD, 100) },                         // faucet, no resting stock
      { star: 0, stock: only(FOOD, 0), consumption: only(FOOD, 150) },  // wants more than A can make
    ],
    cfg: { jumpRadius: 50, setpointTurns: 3, keepBufferTurns: 3, horizonH: 6 },
  });
  stepN(engine, 10);
  assert.equal(realized(engine, P0).prod, 100, 'faucet maxed at its 100 rating (100% utilization)');
  assert.ok(realized(engine, P1).cons < 150, `consumer under-fed (fill < 100%), ate ${realized(engine, P1).cons}`);
});

test('demand-pull: a new provider ships on turn 0 — no silo-fill latency', () => {
  // A faucet with a downstream consumer dispatches immediately — production is
  // realized on pull at the chokepoint, so nothing waits a turn to leave.
  const { engine } = scene({
    xs: [0, 30],
    planets: [
      { star: 0, production: only(FOOD, 100) },
      { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 80) },
    ],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 },
  });
  const first = engine.step();
  assert.ok(first.dispatched > 0, 'A ships to C on the very first turn');
});

test('starvation escalation: an unserved demand accrues, then resets when served', () => {
  // A and C are 200 apart (radius 50) → C is unreachable, chronically unserved.
  const { engine } = scene({
    xs: [0, 200],
    planets: [{ star: 0, stock: only(FOOD, 100000) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, starveEscalationTurns: 3 },
  });
  stepN(engine, 5);
  const i = engine.world.pr(P1, FOOD as number);
  assert.ok(engine.world.starveTurns[i]! >= 5, 'starvation counter climbs while unserved');

  // Research reach so C becomes reachable: it gets served, counter resets.
  engine.applyTech({ jumpRadius: 250 });
  stepN(engine, 2);
  assert.equal(engine.world.starveTurns[i], 0, 'a fully-served demand resets its escalation');
});

test('anti-bullwhip: supply tracks demand without runaway overshoot', () => {
  // Steady producer A feeds consumer C (50/turn) for 120 turns.
  const { engine } = scene({
    xs: [0, 30],
    planets: [
      { star: 0, stock: only(FOOD, 2000), production: only(FOOD, 60), storageCeiling: only(FOOD, STORAGE_UNCAPPED) },
      { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) },
    ],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 },
  });
  const reports = stepN(engine, 120);
  const consumed = reports.reduce((s, r) => s + r.consumed, 0);
  const dispatched = reports.reduce((s, r) => s + r.dispatched, 0);

  // What shipped exceeds what was eaten by only a bounded amount — C's standing
  // buffer plus a wave in flight — NOT a quantity that grows with run length
  // (the bullwhip signature). One buffer is setpoint + keep ≈ 6 turns of drain.
  assert.ok(dispatched - consumed < 50 * 10, `bounded buffer fill: dispatched ${dispatched} vs consumed ${consumed}`);
  // The in-flight pool stays tiny — a couple of waves, never a runaway.
  assert.ok(engine.world.ring.liveCount <= 3, `bounded in-flight, got ${engine.world.ring.liveCount}`);
  // No thundering herd in steady state: no late-game turn ships a huge multiple.
  const backHalfMax = Math.max(...reports.slice(60).map((r) => r.dispatched));
  assert.ok(backHalfMax <= 50 * 6, `no per-turn spike, max was ${backHalfMax}`);
  // Steady state: C is healthily stocked, not starving or flooded.
  assert.ok(stockOf(engine, P1, FOOD) > 0);
  void P0;
});
