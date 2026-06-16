import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scene, only, stepN, stockOf, FOOD, P0, P1 } from './helpers.ts';
import { ThrottleReason } from '../src/produce.ts';
import { STORAGE_UNCAPPED } from '../src/world.ts';

test('glut → throttle (not destruction): a producer with no demand pegs and pauses', () => {
  // A produces 100 food/turn into a 500 ceiling, with no reachable consumer.
  const { engine } = scene({
    xs: [0],
    planets: [{ star: 0, stock: only(FOOD, 0), production: only(FOOD, 100), storageCeiling: only(FOOD, 500) }],
    cfg: { jumpRadius: 50 },
  });
  stepN(engine, 8);
  assert.equal(stockOf(engine, P0, FOOD), 500, 'stock pegs at the storage ceiling — nothing destroyed');
  assert.equal(engine.throttleOf(P0, FOOD), ThrottleReason.OutputFull, 'production paused itself (output-room clamp)');
});

test('glut resolves on its own when demand returns', () => {
  // A is glutted; C downstream is hungry → A drains, throttle clears.
  const { engine } = scene({
    xs: [0, 30],
    planets: [
      { star: 0, stock: only(FOOD, 500), production: only(FOOD, 100), storageCeiling: only(FOOD, 500) },
      { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 80) },
    ],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 },
  });
  const first = engine.step();
  assert.ok(first.dispatched > 0, 'A ships to C, freeing storage room');
  stepN(engine, 5);
  assert.equal(engine.throttleOf(P0, FOOD), ThrottleReason.None, 'production resumes once it has somewhere to go');
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
