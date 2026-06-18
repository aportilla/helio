// World reconciliation + persistence round-trip — the mechanics that make a
// facility build/remove preserve accumulated stock, and a reload restore it.
// Node-pure: builds Worlds from explicit PlanetSpecs (no catalog Body needed) on
// the same skeleton (buildGeometry + appResourceTable) the bridge uses, so the
// configHash this exercises is the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EconomyEngine, makeGeometry, makeWorld, serialize, deserialize, defaultBalance,
  type PlanetSpec, type World,
} from '../../../sim/src/index.ts';
import { appResourceTable } from '../resource-vocab.ts';
import { buildGeometry } from '../sim-geometry.ts';
import { sameBodyIds, transplantLiveState } from '../world-sync.ts';

const resources = appResourceTable();
const R = resources.count;
// Three distinct star nodes (the bridge's real adapter, small input).
const geometry = buildGeometry([
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: 0 },
  { x: 0, y: 10, z: 0 },
]);
const cfg = defaultBalance({ jumpRadius: 100 });

function worldWith(planets: readonly PlanetSpec[]): World {
  return makeWorld({ geometry, resources, cfg, seed: 7, planets });
}

// A length-R array with `val` at resource index 0.
function at0(val: number): number[] {
  const a = new Array<number>(R).fill(0);
  a[0] = val;
  return a;
}

test('sameBodyIds: identical lists match; any difference does not', () => {
  assert.ok(sameBodyIds(['a', 'b'], ['a', 'b']));
  assert.ok(sameBodyIds([], []));
  assert.ok(!sameBodyIds(['a', 'b'], ['b', 'a']));
  assert.ok(!sameBodyIds(['a'], ['a', 'b']));
});

test('transplantLiveState: stock carries by Body.id, rates stay fresh, new body cold-starts', () => {
  // prev: bodies a (star 0), b (star 1). Accumulate stock + advance the clock/RNG.
  const prev = worldWith([{ star: 0 }, { star: 1 }]);
  prev.stock[0 * R + 0] = 5000;     // body a holds 5 units of resource 0
  prev.stock[1 * R + 0] = 3000;     // body b holds 3 — but b is about to be removed
  prev.turn = 9;
  prev.prng.setState([11, 22, 33, 44]);

  // next: a survives (with a NEW production rate), b is gone, c (star 2) is new.
  const next = worldWith([{ star: 0, production: at0(2000) }, { star: 2 }]);
  transplantLiveState(next, ['a', 'c'], prev, ['a', 'b']);

  assert.equal(next.stock[0 * R + 0], 5000, 'body a stock carried across');
  assert.equal(next.production[0 * R + 0], 2000, 'production stays the fresh projected rate');
  assert.equal(next.stock[1 * R + 0], 0, 'newly built body c cold-starts at 0');
  assert.equal(next.turn, 9, 'sim clock kept continuous');
  assert.deepEqual(next.prng.getState(), [11, 22, 33, 44], 'RNG stream kept continuous');
});

// A reachable line of 3 stars in RAW sim units (the shared buildGeometry geometry
// scales 10 LY → 10000 units, far beyond a sane jumpRadius, so nothing would ever
// trade). prev and next must share this geometry + cfg or the ring's bucket span
// (sized from starCount + maxLegTurns) would misalign.
const flowGeometry = makeGeometry([[0, 0, 0], [30, 0, 0], [60, 0, 0]]);
const flowCfg = defaultBalance({ jumpRadius: 50 });
function flowWorld(planets: readonly PlanetSpec[]): World {
  return makeWorld({ geometry: flowGeometry, resources, cfg: flowCfg, seed: 7, planets });
}

// Build a producer→consumer world and step it until cargo is in transit, so the
// carry path has live transfers to move. Resource 0; star 0 ships to star 1.
function steppedFlowWorld(): World {
  const w = flowWorld([
    { star: 0, stock: at0(50000), production: at0(800) },
    { star: 1, consumption: at0(500) },
  ]);
  const eng = new EconomyEngine(w, { checkInvariants: true });
  for (let i = 0; i < 8; i++) eng.step();
  return w;
}

function totalStock(w: World): number {
  let s = 0;
  for (let p = 0; p < w.planetCount; p++) {
    if (w.tombstone[p]) continue;
    for (let r = 0; r < R; r++) s += w.stock[p * R + r]!;
  }
  return s;
}

test('transplantLiveState: in-flight cargo carries by Body.id — conservation + ledger==ring', () => {
  const prev = steppedFlowWorld(); // bodies a (star 0) → b (star 1), cargo aloft
  assert.ok(prev.ring.inFlightTotal > 0, 'precondition: cargo is in transit');
  const beforeTotal = totalStock(prev) + prev.ring.inFlightTotal;

  // An edit that adds a new body c (star 2) — a and b both survive, so every
  // transfer's endpoints remap and all cargo carries.
  const next = flowWorld([{ star: 0, production: at0(800) }, { star: 1, consumption: at0(500) }, { star: 2 }]);
  transplantLiveState(next, ['a', 'b', 'c'], prev, ['a', 'b']);

  assert.equal(next.ring.liveCount, prev.ring.liveCount, 'every in-flight transfer carried across');
  assert.equal(next.ring.inFlightTotal, prev.ring.inFlightTotal, 'in-flight volume conserved');
  assert.equal(next.ring.nextTransferId, prev.ring.nextTransferId, 'id counter kept monotonic');
  assert.equal(next.ledger.total(), next.ring.inFlightTotal, 'ledger rebuilt to match the ring');
  assert.equal(totalStock(next) + next.ring.inFlightTotal, beforeTotal, 'stock + in-flight conserved (new body cold-starts at 0)');

  // The reconciled world must keep stepping cleanly with the DEV invariants on.
  assert.doesNotThrow(() => new EconomyEngine(next, { checkInvariants: true }).step());
});

test('transplantLiveState: cargo to a removed body lands as stock (conserved)', () => {
  const prev = steppedFlowWorld(); // all cargo is bound for body b
  assert.ok(prev.ring.inFlightTotal > 0, 'precondition: cargo is in transit');
  const prevAStock = (() => { let s = 0; for (let r = 0; r < R; r++) s += prev.stock[0 * R + r]!; return s; })();
  const flight = prev.ring.inFlightTotal;

  // The edit removes body b (its last facility) — its destination is gone.
  const next = flowWorld([{ star: 0, production: at0(800) }]);
  transplantLiveState(next, ['a'], prev, ['a', 'b']);

  assert.equal(next.ring.liveCount, 0, 'undeliverable cargo is not re-minted');
  assert.equal(next.ring.inFlightTotal, 0, 'ring drained');
  assert.equal(next.ledger.total(), 0, 'ledger matches the empty ring');
  // The cargo did not vanish: it landed as stock on the surviving same-cluster planet (a).
  assert.equal(totalStock(next), prevAStock + flight, 'landed cargo conserved into a live planet');
  assert.doesNotThrow(() => new EconomyEngine(next, { checkInvariants: true }).step());
});

test('serialize/deserialize round-trips stock + turn against the bridge skeleton', () => {
  const w = worldWith([{ star: 0 }, { star: 1 }]);
  w.stock[0 * R + 0] = 12345;
  w.stock[1 * R + 1] = 678;
  w.turn = 4;

  const restored = deserialize({ geometry, resources, cfg }, serialize(w));

  assert.equal(restored.turn, 4);
  assert.equal(restored.planetCount, 2);
  assert.equal(restored.stock[0 * R + 0], 12345);
  assert.equal(restored.stock[1 * R + 1], 678);
});

test('deserialize: a changed skeleton (configHash mismatch) is rejected — the bridge cold-starts', () => {
  const bytes = serialize(worldWith([{ star: 0 }]));
  // A different star layout → different configHash → the save must not silently load.
  const otherGeometry = buildGeometry([
    { x: 0, y: 0, z: 0 },
    { x: 99, y: 0, z: 0 },
  ]);
  assert.throws(() => deserialize({ geometry: otherGeometry, resources, cfg }, bytes));
});
