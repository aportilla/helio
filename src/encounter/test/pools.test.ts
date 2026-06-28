// Pool-stack invariants — the damage cascade (top→bottom absorb, overflow past the last band lethal,
// `dealt` never exceeds what existed, immutable input), the splice/drop band edits (splice above a
// named anchor else at the top; drop-by-source spares the permanent hull), and the remainingHp/isDown
// predicate (an absent OR empty stack is "unpooled" = un-downable, NOT depleted). Pure; synthetic bands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadeDamage, dropPoolsBySource, restorePoolsBySource, splicePool, type Pool } from '../pools.ts';
import { isDown, remainingHp, type Combatant } from '../state.ts';

const band = (key: string, current: number, sourceEffectId?: number): Pool =>
  sourceEffectId === undefined ? { key, current, max: current } : { key, current, max: current, sourceEffectId };
const combatant = (pools?: readonly Pool[]): Combatant =>
  ({ kind: 'ship', id: 'x', combatId: 0, factionId: 'player', classId: 'corvette', commands: [], pools });

test('cascadeDamage absorbs within one band; dealt = the hit', () => {
  const { pools, dealt } = cascadeDamage([band('hull', 100)], 40);
  assert.equal(dealt, 40);
  assert.deepEqual(pools, [{ key: 'hull', current: 60, max: 100 }]);
});

test('cascadeDamage spills overflow into the next band (shields before hull)', () => {
  const { pools, dealt } = cascadeDamage([band('shields', 30), band('hull', 100)], 50);
  assert.equal(dealt, 50);
  assert.equal(pools[0]!.current, 0, 'shields emptied first');
  assert.equal(pools[1]!.current, 80, 'hull took the 20 overflow');
});

test('cascadeDamage past the last band is lethal but dealt never exceeds what existed', () => {
  const { pools, dealt } = cascadeDamage([band('hull', 30)], 100);
  assert.equal(dealt, 30, 'only 30 HP existed to remove — not the raw 100');
  assert.equal(pools[0]!.current, 0);
});

test('cascadeDamage spills cleanly THROUGH an already-empty band', () => {
  // A depleted shield band (current 0) absorbs nothing and is skipped transparently — the full hit
  // reaches hull. Pins the `absorbed === 0` skip as a pass-through, not a break or a swallow.
  const { pools, dealt } = cascadeDamage([band('shields', 0), band('hull', 100)], 50);
  assert.equal(dealt, 50);
  assert.equal(pools[0]!.current, 0, 'the empty band stays at 0');
  assert.equal(pools[1]!.current, 50, 'hull took the whole hit');
});

test('cascadeDamage is a total no-op for a non-positive hit (no heal, no negative)', () => {
  for (const raw of [0, -5]) {
    const { pools, dealt } = cascadeDamage([band('hull', 100)], raw);
    assert.equal(dealt, 0, `raw ${raw} removes nothing`);
    assert.equal(pools[0]!.current, 100, `raw ${raw} neither heals nor goes negative`);
  }
});

test('cascadeDamage is immutable — the input bands are untouched', () => {
  const input = [band('hull', 100)];
  cascadeDamage(input, 40);
  assert.equal(input[0]!.current, 100, 'the source band is not mutated');
});

test('cascadeDamage scales the per-band bite by effByKey: super-effective strips more, resisted less', () => {
  // A laser-vs-shield (1500 = 150%): a 40 hit lands 60 of pressure, stripping the whole 30-current shield.
  const sup = cascadeDamage([band('shields', 30)], 40, { shields: 1500 });
  assert.equal(sup.dealt, 30, 'the band is fully stripped (60 pressure ≥ 30 current)');
  assert.equal(sup.pools[0]!.current, 0);
  // A laser-vs-hull (600 = 60%): the same 40 hit lands only 24 — the weak axis.
  const res = cascadeDamage([band('hull', 100)], 40, { hull: 600 });
  assert.equal(res.dealt, 24, '40 × 600 / 1000 = 24');
  assert.equal(res.pools[0]!.current, 76);
  // A missing key defaults to 1000 (full effect) — identical to a flat hit, so untyped bands are unchanged.
  const miss = cascadeDamage([band('hull', 100)], 40, { shields: 500 });
  assert.equal(miss.dealt, 40, 'hull absent from the map ⇒ 1000 ⇒ flat');
  assert.equal(miss.pools[0]!.current, 60);
});

test('cascadeDamage spills with per-band effectiveness, debiting the raw budget by what each band cost', () => {
  // The worked example, scaled: a 40 laser into a 30 shield (1500) over a 100 hull (600). The shield is
  // stripped (consuming 20 of raw: 30 ÷ 1.5), then the 20 remaining raw hits hull at 60% = 12.
  const { pools, dealt } = cascadeDamage([band('shields', 30), band('hull', 100)], 40, { shields: 1500, hull: 600 });
  assert.equal(pools[0]!.current, 0, 'shield stripped');
  assert.equal(pools[1]!.current, 88, 'hull took 12 of spill (20 raw × 60%)');
  assert.equal(dealt, 42, 'dealt = 30 shield + 12 hull, the HP actually removed');
});

test('cascadeDamage treats a 0-effectiveness band as immune: it absorbs nothing and costs no budget', () => {
  // A weapon a shield is fully immune to (eff 0) passes THROUGH the shield untouched to hull at full effect.
  const { pools, dealt } = cascadeDamage([band('shields', 30), band('hull', 100)], 40, { shields: 0 });
  assert.equal(pools[0]!.current, 30, 'the immune shield is untouched');
  assert.equal(pools[1]!.current, 60, 'the full 40 reached hull (hull key absent ⇒ 1000)');
  assert.equal(dealt, 40);
});

test('restorePoolsBySource tops a sourced band toward max, clamps at max, spares unsourced bands', () => {
  const stack: readonly Pool[] = [{ key: 'shields', current: 30, max: 50, sourceEffectId: 7 }, { key: 'hull', current: 100, max: 100 }];
  assert.deepEqual(restorePoolsBySource(stack, 7, 15).map((p) => p.current), [45, 100], 'the sourced band climbed by 15');
  assert.equal(restorePoolsBySource(stack, 7, 100)[0]!.current, 50, 'clamped at max');
  assert.deepEqual(restorePoolsBySource(stack, 99, 15), stack, 'no matching source ⇒ unchanged set');
  assert.equal(restorePoolsBySource(stack, 7, 0), stack, 'a non-positive amount is a no-op');
});

test('splicePool inserts above the named band, else at the top', () => {
  const stack = [band('hull', 100)];
  assert.deepEqual(splicePool(stack, band('shields', 50), 'hull').map((p) => p.key), ['shields', 'hull']);
  assert.deepEqual(splicePool(stack, band('shields', 50), 'missing').map((p) => p.key), ['shields', 'hull'], 'unknown anchor → top');
  assert.deepEqual(splicePool(stack, band('shields', 50)).map((p) => p.key), ['shields', 'hull'], 'no anchor → top');
  assert.equal(stack.length, 1, 'the input stack is untouched');
});

test('dropPoolsBySource removes only the matching sourced band; the permanent hull stays', () => {
  const stack = [band('shields', 50, 7), band('hull', 100)];
  assert.deepEqual(dropPoolsBySource(stack, 7).map((p) => p.key), ['hull'], 'the sourced band 7 dropped');
  assert.deepEqual(dropPoolsBySource(stack, 99).map((p) => p.key), ['shields', 'hull'], 'no match → unchanged set');
});

test('remainingHp / isDown: an absent OR empty stack is unpooled (un-downable); a 0-current band is down', () => {
  assert.equal(remainingHp(combatant(undefined)), Infinity);
  assert.equal(isDown(combatant(undefined)), false, 'no pools → cannot be downed');
  assert.equal(remainingHp(combatant([])), Infinity);
  assert.equal(isDown(combatant([])), false, 'empty pools → unpooled, NOT depleted (a [].reduce is 0)');
  assert.equal(remainingHp(combatant([band('hull', 0)])), 0);
  assert.equal(isDown(combatant([band('hull', 0)])), true, 'a depleted hull band → down');
  assert.equal(remainingHp(combatant([band('shields', 10), band('hull', 100)])), 110, 'sums the whole stack');
});
