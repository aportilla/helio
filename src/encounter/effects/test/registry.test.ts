// Effect registry invariants — the frozen-key discipline (mirrors the factions/ships/facilities CI
// guards) + the unified `on` lifecycle map each def declares. Runs under `node --test` type-stripping
// (the DEV module-load asserts are skipped — import.meta.env is undefined — so these pin the same facts).

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

test('recharge: a phaseStart handler returns an energy stat outcome clamped to energyMax', () => {
  const recharge = EFFECT_BY_KEY.get('recharge')!;
  assert.equal(recharge.key, 'recharge');
  const outcomes = recharge.on!.phaseStart!({ params: { amount: 3000 }, owner: { stats: { energy: 1000, energyMax: 9000 } } });
  assert.deepEqual(outcomes, [{ kind: 'stat', statKey: 'energy', delta: 3000, clampToMaxKey: 'energyMax' }]);
});

test('recharge: a missing amount param is a silent zero delta, not a throw', () => {
  const recharge = EFFECT_BY_KEY.get('recharge')!;
  assert.deepEqual(recharge.on!.phaseStart!({ params: {}, owner: {} }), [{ kind: 'stat', statKey: 'energy', delta: 0, clampToMaxKey: 'energyMax' }]);
});

test('shield-segment: install splices a shields band above hull, expire drops it; no turnStart', () => {
  const shield = EFFECT_BY_KEY.get('shield-segment')!;
  assert.equal(shield.key, 'shield-segment');
  // install returns the band to splice (the fold stamps the sourceEffectId); expire returns the drop.
  // No turnStart — absorb-before-hull is pure stack order, not a per-turn hook.
  assert.equal(shield.on!.turnStart, undefined);
  assert.deepEqual(
    shield.on!.install!({ params: { capacity: 50000 }, owner: { pools: [{ key: 'hull', current: 100, max: 100 }] } }),
    [{ kind: 'pool', op: 'splice', pool: { key: 'shields', current: 50000, max: 50000 }, aboveKey: 'hull' }],
  );
  assert.deepEqual(shield.on!.expire!({ params: { capacity: 50000 }, owner: {} }), [{ kind: 'pool', op: 'drop' }]);
});

test('shield-segment: a missing capacity param is a silent zero band, not a throw', () => {
  const shield = EFFECT_BY_KEY.get('shield-segment')!;
  assert.deepEqual(
    shield.on!.install!({ params: {}, owner: {} }),
    [{ kind: 'pool', op: 'splice', pool: { key: 'shields', current: 0, max: 0 }, aboveKey: 'hull' }],
  );
});

test('tactical-command: a phaseStart handler returns a side initiative delta; presence stacking', () => {
  const tac = EFFECT_BY_KEY.get('tactical-command')!;
  assert.equal(tac.key, 'tactical-command');
  // It rides the GENERIC substrate — no static `initiative` registry key. presence-not-count is the
  // def's `stacking`, so the fold counts it once per side however many ships carry it.
  assert.equal(tac.stacking, 'presence');
  assert.equal(tac.on!.turnStart, undefined);
  assert.deepEqual(tac.on!.phaseStart!({ params: { initiative: 1 }, owner: {} }), [{ kind: 'side', initiative: 1 }]);
});

test('tactical-command: a missing initiative param is a silent zero side delta', () => {
  const tac = EFFECT_BY_KEY.get('tactical-command')!;
  assert.deepEqual(tac.on!.phaseStart!({ params: {}, owner: {} }), [{ kind: 'side', initiative: 0 }]);
});
