// isTerminal invariants — the encounter is over once fewer than two factions field a living
// combatant (side elimination). Pure; synthetic combatants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminal } from '../terminal.ts';
import { HULL_STAT, type Combatant, type EncounterState } from '../state.ts';

const c = (combatId: number, factionId: Combatant['factionId'], hull = 100): Combatant => ({
  kind: 'ship', id: `c${combatId}`, combatId, factionId, classId: 'corvette', commands: [], stats: { [HULL_STAT]: hull },
});
const roster = (combatants: readonly Combatant[]): EncounterState => ({ combatants, activeId: 0, round: 1, effects: [] });

test('not terminal while two factions each field a living combatant', () => {
  assert.equal(isTerminal(roster([c(0, 'player'), c(1, 'rival')])), false);
});

test('terminal when one side is eliminated', () => {
  assert.equal(isTerminal(roster([c(0, 'player'), c(1, 'rival', 0)])), true);
});

test('a faction counts as living only if a member is still up', () => {
  // player still has c1 up, rival all down → terminal
  assert.equal(isTerminal(roster([c(0, 'player', 0), c(1, 'player'), c(2, 'rival', 0)])), true);
  // both sides have a living member → not terminal
  assert.equal(isTerminal(roster([c(0, 'player', 0), c(1, 'player'), c(2, 'rival')])), false);
});

test('terminal for an empty roster', () => {
  assert.equal(isTerminal(roster([])), true);
});
