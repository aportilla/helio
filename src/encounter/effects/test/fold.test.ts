// Effect-fold invariants — collectInstalls (the deriveCommands twin), mintEffects (dense
// install-order ids, self-sourced, per owner), and tickCycleStart (recharge tops energy, clamps at
// energyMax, emits only on a real change, ticks only the active owner, counts down + drops timed
// instances). Pure; synthetic combatants + effects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectInstalls, mintEffects, tickCycleStart } from '../fold.ts';
import type { ActiveEffect, EffectInstall } from '../types.ts';
import { ENERGY_MAX_STAT, ENERGY_STAT, type Combatant, type EncounterState } from '../../state.ts';

const c = (combatId: number, factionId: Combatant['factionId'], stats: Combatant['stats']): Combatant => ({
  kind: 'ship', id: `c${combatId}`, combatId, factionId, classId: 'corvette', commands: [], stats,
});
const stateOf = (combatants: readonly Combatant[], effects: readonly ActiveEffect[]): EncounterState => ({ combatants, activeId: 0, round: 1, effects });
const RECHARGE = (amount: number, remaining = -1): EffectInstall => ({ effectKey: 'recharge', remaining, params: { amount } });
const energy = (s: EncounterState, combatId: number) => s.combatants[combatId]!.stats?.[ENERGY_STAT];

test('collectInstalls flatMaps provider installs; a provider with none is a no-op', () => {
  const i1 = RECHARGE(3000);
  assert.deepEqual(collectInstalls([{ installs: [i1] }, {}, { installs: [] }]), [i1]);
});

test('mintEffects assigns dense install-order ids, self-sourced, per owner', () => {
  const combatants = [c(0, 'player', {}), c(1, 'rival', {})];
  const effects = mintEffects(combatants, (cb) => (cb.combatId === 0 ? [RECHARGE(3000)] : []));
  assert.equal(effects.length, 1);
  assert.deepEqual(effects[0], { id: 0, key: 'recharge', ownerId: 0, sourceId: 0, remainingCycles: -1, params: { amount: 3000 } });
});

test('recharge tops energy toward energyMax and emits an effect event', () => {
  const combatants = [c(0, 'player', { [ENERGY_STAT]: 1000, [ENERGY_MAX_STAT]: 9000 })];
  const { state, events } = tickCycleStart(stateOf(combatants, mintEffects(combatants, () => [RECHARGE(3000)])), 0);
  assert.equal(energy(state, 0), 4000);
  assert.deepEqual(events, [{ kind: 'effect', combatId: 0, effectKey: 'recharge', statKey: ENERGY_STAT, delta: 3000 }]);
});

test('recharge clamps at energyMax and emits NO event once nothing changes', () => {
  const combatants = [c(0, 'player', { [ENERGY_STAT]: 8000, [ENERGY_MAX_STAT]: 9000 })];
  const r1 = tickCycleStart(stateOf(combatants, [{ id: 0, key: 'recharge', ownerId: 0, sourceId: 0, remainingCycles: -1, params: { amount: 3000 } }]), 0);
  assert.equal(energy(r1.state, 0), 9000); // 8000 + 3000 clamped to 9000
  assert.equal(r1.events.length, 1); // applied 1000 → one event
  const r2 = tickCycleStart(r1.state, 0);
  assert.equal(energy(r2.state, 0), 9000);
  assert.deepEqual(r2.events, []); // already full → no change → no event
});

test('only the active combatant\'s effects tick', () => {
  const combatants = [
    c(0, 'player', { [ENERGY_STAT]: 1000, [ENERGY_MAX_STAT]: 9000 }),
    c(1, 'rival', { [ENERGY_STAT]: 1000, [ENERGY_MAX_STAT]: 9000 }),
  ];
  const effects: readonly ActiveEffect[] = [
    { id: 0, key: 'recharge', ownerId: 0, sourceId: 0, remainingCycles: -1, params: { amount: 3000 } },
    { id: 1, key: 'recharge', ownerId: 1, sourceId: 1, remainingCycles: -1, params: { amount: 3000 } },
  ];
  const { state } = tickCycleStart(stateOf(combatants, effects), 1); // tick combatId 1 only
  assert.equal(energy(state, 0), 1000); // untouched
  assert.equal(energy(state, 1), 4000); // recharged
});

test('a timed effect applies, then counts down and drops at 0; a permanent one persists', () => {
  const combatants = [c(0, 'player', { [ENERGY_STAT]: 1000, [ENERGY_MAX_STAT]: 9000 })];
  const timed: ActiveEffect = { id: 0, key: 'recharge', ownerId: 0, sourceId: 0, remainingCycles: 1, params: { amount: 1000 } };
  const perm: ActiveEffect = { id: 1, key: 'recharge', ownerId: 0, sourceId: 0, remainingCycles: -1, params: { amount: 1000 } };
  const { state } = tickCycleStart(stateOf(combatants, [timed, perm]), 0);
  assert.deepEqual(state.effects.map((e) => e.id), [1], 'timed dropped at 0, permanent remains');
  assert.equal(energy(state, 0), 3000, 'both applied this cycle (1000 + 1000 + 1000)');
});

test('a multi-cycle timed effect decrements but stays', () => {
  const combatants = [c(0, 'player', { [ENERGY_STAT]: 1000, [ENERGY_MAX_STAT]: 9000 })];
  const timed: ActiveEffect = { id: 0, key: 'recharge', ownerId: 0, sourceId: 0, remainingCycles: 3, params: { amount: 1000 } };
  const { state } = tickCycleStart(stateOf(combatants, [timed]), 0);
  assert.equal(state.effects[0]!.remainingCycles, 2);
});
