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

test('shield-segment: onInstall splices a shields band above hull, onExpire drops it', () => {
  const shield = EFFECT_BY_KEY.get('shield-segment')!;
  assert.equal(shield.key, 'shield-segment');
  // onInstall returns the band to splice (the fold stamps the sourceEffectId); onExpire returns the
  // drop. No onCycleStart — absorb-before-hull is pure stack order, not a per-cycle hook.
  assert.equal(shield.onCycleStart, undefined);
  assert.deepEqual(
    shield.onInstall!({ params: { capacity: 50000 }, owner: { pools: [{ key: 'hull', current: 100, max: 100 }] } }),
    [{ op: 'splice', pool: { key: 'shields', current: 50000, max: 50000 }, aboveKey: 'hull' }],
  );
  assert.deepEqual(shield.onExpire!({ params: { capacity: 50000 }, owner: {} }), [{ op: 'drop' }]);
});

test('shield-segment: a missing capacity param is a silent zero band, not a throw', () => {
  const shield = EFFECT_BY_KEY.get('shield-segment')!;
  assert.deepEqual(
    shield.onInstall!({ params: {}, owner: {} }),
    [{ op: 'splice', pool: { key: 'shields', current: 0, max: 0 }, aboveKey: 'hull' }],
  );
});
