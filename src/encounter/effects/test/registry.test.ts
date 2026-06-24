// Effect registry invariants — the frozen-key discipline (mirrors the factions/ships/facilities CI
// guards) + the recharge def's onCycleStart shape. Runs under `node --test` type-stripping (the DEV
// module-load asserts are skipped — import.meta.env is undefined — so these pin the same facts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_DEFS, EFFECT_BY_KEY, EFFECT_KEYS, FROZEN_EFFECT_IDS } from '../registry.ts';

test('every def is keyed by its own key', () => {
  for (const def of EFFECT_DEFS) {
    assert.equal(def.key, [...EFFECT_BY_KEY].find(([, d]) => d === def)?.[0]);
    assert.equal(EFFECT_BY_KEY.get(def.key), def);
  }
});

test('every frozen id is still a live key (a rename/removal fails here)', () => {
  for (const id of FROZEN_EFFECT_IDS) {
    assert.ok(EFFECT_KEYS.has(id), `frozen effect id '${id}' is no longer live`);
  }
});

test('recharge: onCycleStart asks for an energy delta clamped to energyMax', () => {
  const recharge = EFFECT_BY_KEY.get('recharge')!;
  assert.equal(recharge.key, 'recharge');
  const deltas = recharge.onCycleStart!({ params: { amount: 3000 }, owner: { stats: { energy: 1000, energyMax: 9000 } } });
  assert.deepEqual(deltas, [{ statKey: 'energy', delta: 3000, clampToMaxKey: 'energyMax' }]);
});

test('recharge: a missing amount param is a silent zero delta, not a throw', () => {
  const recharge = EFFECT_BY_KEY.get('recharge')!;
  assert.deepEqual(recharge.onCycleStart!({ params: {}, owner: {} }), [{ statKey: 'energy', delta: 0, clampToMaxKey: 'energyMax' }]);
});
