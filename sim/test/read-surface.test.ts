import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scene, only, stepN, FOOD, P0, P1 } from './helpers.ts';
import { ShortfallReason, SHORTFALL_FIX } from '../src/shortfall.ts';

test('signed cover: surplus reads positive, deficit reads negative', () => {
  const { engine } = scene({
    xs: [0, 30],
    planets: [{ star: 0, stock: only(FOOD, 600) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 },
  });
  engine.step();
  const digest = engine.getReadDigest();
  const a = digest.planets.get(P0)!.byResource.get(FOOD)!;
  const c = digest.planets.get(P1)!.byResource.get(FOOD)!;
  assert.ok(a.coverMilli > 0, 'producer surplus is positive');
  assert.ok(c.coverMilli < 0, 'consumer deficit is negative');
  assert.ok(c.inboundWithinHMilli > 0, 'and relief is shown inbound this turn');
});

test('digest emits only non-zero / noteworthy (planet, resource) pairs', () => {
  const { engine } = scene({
    xs: [0],
    planets: [{ star: 0, stock: [0, 0, 0, 0] }], // idle planet, nothing happening
    cfg: { jumpRadius: 50 },
  });
  engine.step();
  assert.equal(engine.getReadDigest().planets.size, 0, 'a quiescent planet emits nothing');
});

test('explainShortfall names a reason and a buildable fix; served demands return null', () => {
  // Unreachable consumer (no route): C is 500 from A, radius 50.
  const { engine } = scene({
    xs: [0, 500],
    planets: [{ star: 0, stock: only(FOOD, 600) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, horizonH: 6 },
  });
  engine.step();
  const rec = engine.explainShortfall(P1, FOOD)!;
  assert.equal(rec.reason, ShortfallReason.Unreachable);
  assert.equal(rec.fix, SHORTFALL_FIX[ShortfallReason.Unreachable]);
  assert.equal(engine.explainShortfall(P0, FOOD), null, 'a producer has no shortfall');
});

test('getInTransitTo tells the in-transit story (source, turns remaining)', () => {
  const { engine } = scene({
    xs: [0, 30],
    planets: [{ star: 0, stock: only(FOOD, 600) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 },
  });
  engine.step(); // dispatches A→C
  const deliveries = engine.getInTransitTo(P1, FOOD);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.sourcePlanet as number, 0, 'from A');
  assert.ok(deliveries[0]!.qtyMilli > 0);
  assert.ok(deliveries[0]!.turnsRemaining > 0, 'still on the way');
});

test('edge flows mark a relay leg `through` (waypoint, not producer)', () => {
  // A(0)—H1(30)—H2(60)—C(90): a 3-leg route. The middle leg H1→H2 is `through`.
  const { engine } = scene({
    xs: [0, 30, 60, 90],
    planets: [{ star: 0, stock: only(FOOD, 100000) }, { star: 3, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 12, setpointTurns: 3, keepBufferTurns: 3 },
  });
  // turn 0 dispatches; first leg lands at H1 on turn 3, then continues onto the
  // middle leg H1→H2 — which is the `through` segment.
  const r0 = engine.step();
  void r0;
  assert.ok(engine.getReadDigest().edgeFlows.every((e) => !e.through), 'first leg A→H1 is sourced, not through');
  stepN(engine, 3); // advance to turn 3 → onto the middle leg
  assert.ok(engine.getReadDigest().edgeFlows.some((e) => e.through), 'the relay middle leg reads as through');
});

test('getSystemRead returns every planet (no per-system collapse)', () => {
  const { engine } = scene({
    xs: [0, 30],
    planets: [{ star: 0, stock: only(FOOD, 600) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    cfg: { jumpRadius: 50, horizonH: 6 },
  });
  engine.step();
  const sysA = engine.getSystemRead(engine.systemOfPlanet(P0));
  assert.equal(sysA.length, 1, 'system A holds one planet, reported per-planet');
  assert.equal(sysA[0]!.planet as number, 0);
});
