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

// A band carrying a per-type resistance profile (max = current, like `band`).
const resisted = (key: string, current: number, resistByType: Record<string, number>): Pool => ({ key, current, max: current, resistByType });

test('cascadeDamage scales the per-band bite by the band resistance to the hit type', () => {
  // A shield WEAK to 'energy' (1500 = 150%): a 40 'energy' hit lands 60 of pressure, stripping a 30 shield.
  const sup = cascadeDamage([resisted('shields', 30, { energy: 1500 })], 40, 'energy');
  assert.equal(sup.dealt, 30, 'the band is fully stripped (60 pressure ≥ 30 current)');
  assert.equal(sup.pools[0]!.current, 0);
  // Hull RESISTANT to 'energy' (600 = 60%): the same hit lands only 24 — the weak axis.
  const res = cascadeDamage([resisted('hull', 100, { energy: 600 })], 40, 'energy');
  assert.equal(res.dealt, 24, '40 × 600 / 1000 = 24');
  assert.equal(res.pools[0]!.current, 76);
  // No resistByType (or an unprofiled type) defaults to 1000 — a flat hit, so untyped bands are unchanged.
  const flat = cascadeDamage([band('hull', 100)], 40, 'energy');
  assert.equal(flat.dealt, 40, 'no resistByType ⇒ 1000 ⇒ flat');
  assert.equal(flat.pools[0]!.current, 60);
});

test('cascadeDamage spills with per-band resistance, debiting the raw budget by what each band cost', () => {
  // The worked example, scaled: a 40 'energy' hit into a 30 shield (weak, 1500) over a 100 hull (resistant,
  // 600). The shield is stripped (consuming 20 of raw: 30 ÷ 1.5), then the 20 remaining raw hits hull at 60% = 12.
  const { pools, dealt } = cascadeDamage([resisted('shields', 30, { energy: 1500 }), resisted('hull', 100, { energy: 600 })], 40, 'energy');
  assert.equal(pools[0]!.current, 0, 'shield stripped');
  assert.equal(pools[1]!.current, 88, 'hull took 12 of spill (20 raw × 60%)');
  assert.equal(dealt, 42, 'dealt = 30 shield + 12 hull, the HP actually removed');
});

test('cascadeDamage treats a 0-resistance band as immune: it absorbs nothing and costs no budget', () => {
  // A band fully immune to 'energy' (resist 0) passes THROUGH untouched to hull (no profile ⇒ full effect).
  const { pools, dealt } = cascadeDamage([resisted('shields', 30, { energy: 0 }), band('hull', 100)], 40, 'energy');
  assert.equal(pools[0]!.current, 30, 'the immune shield is untouched');
  assert.equal(pools[1]!.current, 60, 'the full 40 reached hull');
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
