// World reconciliation + persistence round-trip — the mechanics that make a
// facility build/remove preserve accumulated stock, and a reload restore it.
// Node-pure: builds Worlds from explicit PlanetSpecs (no catalog Body needed) on
// the same skeleton (buildGeometry + appResourceTable) the bridge uses, so the
// configHash this exercises is the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeWorld, serialize, deserialize, defaultBalance,
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
