import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scene, stepN, FOOD, MINERALS, MUNITIONS } from './helpers.ts';
import type { Scene } from './helpers.ts';

// A busy 6-star line galaxy: producers and consumers of three transportable
// resources scattered so flows cross multiple legs and contend for sources.
function busyGalaxy(cfgOver = {}): Scene {
  return scene({
    xs: [0, 30, 60, 90, 120, 150],
    planets: [
      { star: 0, stock: [5000, 0, 0, 0], production: [80, 0, 0, 0] }, // breadbasket
      { star: 1, stock: [200, 200, 0, 0], consumption: [50, 0, 0, 0] },
      { star: 2, stock: [0, 4000, 0, 0], production: [0, 60, 0, 0], consumption: [40, 0, 0, 0] }, // mine + eats food
      { star: 3, stock: [0, 0, 0, 0], consumption: [30, 40, 0, 0] }, // pure consumer
      { star: 4, stock: [0, 0, 20000, 0], production: [0, 0, 2000, 0], consumption: [20, 30, 0, 0] }, // arsenal
      { star: 5, stock: [100, 100, 0, 0], consumption: [25, 25, 2000, 0] }, // frontier, wants munitions (coarse grain)
    ],
    cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 8, setpointTurns: 3, keepBufferTurns: 3, ...cfgOver },
  });
}

test('100 turns hold conservation, no-negative-stock, and ledger==in-flight (per-turn asserts)', () => {
  const { engine } = busyGalaxy();
  // checkInvariants defaults true → step() throws on any violation.
  assert.doesNotThrow(() => stepN(engine, 100));
});

test('global mass balance: Σ(produced − consumed) == Δ(stock + in-transit) over the run', () => {
  const { engine } = busyGalaxy();
  const w = engine.world;
  const initial = w.totalStockAll() + w.ring.inFlightTotal;
  const reports = stepN(engine, 100);
  const final = w.totalStockAll() + w.ring.inFlightTotal;
  const produced = reports.reduce((s, r) => s + r.produced, 0);
  const consumed = reports.reduce((s, r) => s + r.consumed, 0);
  assert.equal(final - initial, produced - consumed, 'no goods created or destroyed (durable cargo)');
  assert.ok(produced > 0 && consumed > 0, 'the economy actually moved');
});

test('ledger stays exactly equal to in-flight throughout (derived-cache integrity)', () => {
  const { engine } = busyGalaxy();
  for (let i = 0; i < 60; i++) {
    engine.step();
    assert.equal(engine.world.ledger.total(), engine.world.ring.inFlightTotal, `turn ${i}`);
  }
});

test('flow balance closes across the whole run', () => {
  const { engine } = busyGalaxy();
  const reports = stepN(engine, 80);
  const sum = (k: 'dispatched' | 'delivered' | 'rerouted') => reports.reduce((s, r) => s + r[k], 0);
  assert.equal(sum('dispatched') - sum('delivered') - sum('rerouted'), engine.world.ring.inFlightTotal);
});

test('a strict CFL (1/3) still conserves over a long run', () => {
  const { engine } = busyGalaxy({ cflNum: 1, cflDen: 3 });
  assert.doesNotThrow(() => stepN(engine, 120));
  assert.ok(engine.world.totalStock() > 0);
});

test('multiple resources move (food, minerals, munitions all flow)', () => {
  const { engine } = busyGalaxy();
  let food = 0, minerals = 0, munitions = 0;
  for (let i = 0; i < 60; i++) {
    engine.step();
    for (const ef of engine.getReadDigest().edgeFlows) {
      if ((ef.resource as number) === (FOOD as number)) food += ef.unitsMilli;
      if ((ef.resource as number) === (MINERALS as number)) minerals += ef.unitsMilli;
      if ((ef.resource as number) === (MUNITIONS as number)) munitions += ef.unitsMilli;
    }
  }
  assert.ok(food > 0, 'food crossed edges');
  assert.ok(minerals > 0, 'minerals crossed edges');
  assert.ok(munitions > 0, 'munitions crossed edges');
});
