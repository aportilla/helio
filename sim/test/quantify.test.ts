import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantify } from '../src/quantify.ts';
import type { PlanetSpec } from '../src/world.ts';
import type { BalanceConfig } from '../src/constants.ts';
import { scene, only, FOOD, P0 } from './helpers.ts';

function freshWorld(planet: PlanetSpec, cfg?: Partial<BalanceConfig>, turn = 0) {
  const w = scene({ xs: [0], planets: [planet], cfg }).engine.world;
  w.turn = turn;
  return w;
}

const TUNE = { horizonH: 6, setpointTurns: 3, keepBufferTurns: 3, deadbandTurns: 1 };

test('deficit math reproduces the worked turn (projStock → netDemand 330)', () => {
  const w = freshWorld({ star: 0, stock: only(FOOD, 120), consumption: only(FOOD, 50) }, TUNE);
  const q = quantify(w);
  const i = w.pr(P0, FOOD as number);
  assert.equal(q.netDemand[i], 330, 'setpoint 150 − projStock(−180)');
  assert.equal(q.cover[i], -330, 'signed cover is the negated deficit');
  assert.equal(q.exportable[i], 0, 'an ordering planet exports nothing');
  assert.equal(w.ordering[i], 1, 'crossed the reorder threshold');
});

test('a pure producer exports its stock above the keep buffer', () => {
  const w = freshWorld({ star: 0, stock: only(FOOD, 600) }, TUNE); // no consumption → ema 0 → keep 0
  const q = quantify(w);
  const i = w.pr(P0, FOOD as number);
  assert.equal(q.exportable[i], 600);
  assert.equal(q.cover[i], 600);
  assert.equal(q.netDemand[i], 0);
  assert.equal(w.ordering[i], 0);
});

test('a faucet offers its per-turn production capacity as exportable (no resting stock)', () => {
  const w = freshWorld({ star: 0, production: only(FOOD, 800) }, TUNE); // capacity, holds nothing
  const q = quantify(w);
  const i = w.pr(P0, FOOD as number);
  assert.equal(q.exportable[i], 800, 'offers per-turn capacity, not silo surplus');
  assert.equal(q.cover[i], 800, 'cover reports offered capacity (a healthy faucet reads green)');
  assert.equal(q.netDemand[i], 0);
});

test('a mixed producer offers only its NET capacity (same-body appetite withheld)', () => {
  // Makes 800 food, eats 300 of it → offers 500 for export; the 300 self-feeds in P3.
  const w = freshWorld({ star: 0, production: only(FOOD, 800), consumption: only(FOOD, 300) }, TUNE);
  const q = quantify(w);
  const i = w.pr(P0, FOOD as number);
  assert.equal(q.exportable[i], 500, 'net = production − consumption (a net producer never orders its own good)');
  assert.equal(w.ordering[i], 0, 'a self-sufficient producer stays in the export branch');
});

test('hysteresis: same projStock yields different output by prior ordering state', () => {
  // setpoint 150, deadband 50 → reorder threshold 100. Pick stock so projStock=120
  // (inside the deadband): a settled planet does NOT start ordering...
  const settled = freshWorld({ star: 0, stock: only(FOOD, 420), consumption: only(FOOD, 50) }, TUNE);
  const qs = quantify(settled);
  const i = settled.pr(P0, FOOD as number);
  assert.equal(settled.ordering[i], 0, 'projStock 120 ≥ threshold 100 → no new order');
  assert.equal(qs.netDemand[i], 0);
  assert.ok(qs.exportable[i]! > 0, 'instead it offers a little surplus');

  // ...but a planet already ordering keeps ordering until it refills to setpoint.
  const ordering = freshWorld({ star: 0, stock: only(FOOD, 420), consumption: only(FOOD, 50) }, TUNE);
  ordering.ordering[ordering.pr(P0, FOOD as number)] = 1;
  const qo = quantify(ordering);
  assert.equal(ordering.ordering[i], 1, 'stays ordering inside the deadband');
  assert.equal(qo.netDemand[i], 30, 'tops up to setpoint 150 from projStock 120');
});

test('inbound within horizon H suppresses demand (the #1 anti-bullwhip rule)', () => {
  const base = freshWorld({ star: 0, stock: only(FOOD, 120), consumption: only(FOOD, 50) }, TUNE, 100);
  assert.equal(quantify(base).netDemand[base.pr(P0, FOOD as number)], 330, 'no inbound → full deficit');

  const relieved = freshWorld({ star: 0, stock: only(FOOD, 120), consumption: only(FOOD, 50) }, TUNE, 100);
  relieved.ledger.add(P0, FOOD, 104, 200); // 200 landing within (100, 106]
  const i = relieved.pr(P0, FOOD as number);
  assert.equal(quantify(relieved).netDemand[i], 130, 'demand drops by the 200 already inbound');
});

test('inbound outside horizon H does NOT silence a planet starving now', () => {
  const w = freshWorld({ star: 0, stock: only(FOOD, 120), consumption: only(FOOD, 50) }, TUNE, 100);
  w.ledger.add(P0, FOOD, 200, 1000); // far-future relief, well beyond H
  const i = w.pr(P0, FOOD as number);
  assert.equal(quantify(w).netDemand[i], 330, 'a convoy 100 turns out is ignored by the horizon');
});
