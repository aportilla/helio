// nextActor invariants — round-robin by combatId, skipping downed combatants, undefined when the
// active is the last one standing. Pure; synthetic combatants (no registry, no scene).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextActor } from '../turn-order.ts';
import { HULL_STAT, type Combatant, type EncounterState } from '../state.ts';

// hull defaults to a living value; pass 0 for a downed combatant.
const c = (combatId: number, factionId: Combatant['factionId'], hull = 100): Combatant => ({
  kind: 'ship', id: `c${combatId}`, combatId, factionId, classId: 'corvette', commands: [], stats: { [HULL_STAT]: hull },
});
const at = (combatants: readonly Combatant[], activeId: number): EncounterState => ({ combatants, activeId, round: 1, effects: [] });

test('advances to the next combatId, cyclically', () => {
  const cs = [c(0, 'player'), c(1, 'rival'), c(2, 'player')];
  assert.equal(nextActor(at(cs, 0)), 1);
  assert.equal(nextActor(at(cs, 1)), 2);
  assert.equal(nextActor(at(cs, 2)), 0); // wraps past the top
});

test('skips downed combatants', () => {
  const cs = [c(0, 'player'), c(1, 'rival', 0), c(2, 'player')]; // combatId 1 is down
  assert.equal(nextActor(at(cs, 0)), 2);
  assert.equal(nextActor(at(cs, 2)), 0);
});

test('undefined when the active is the last one standing', () => {
  assert.equal(nextActor(at([c(0, 'player'), c(1, 'rival', 0)], 0)), undefined);
});

test('undefined for a single combatant', () => {
  assert.equal(nextActor(at([c(0, 'player')], 0)), undefined);
});
