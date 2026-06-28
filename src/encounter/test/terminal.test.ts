// isTerminal invariants — the encounter ends on side elimination (fewer than two factions field a
// living combatant) OR mutual disengage (a damage-free round latched `disengaged`). Pure; synthetic
// combatants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminal } from '../terminal.ts';
import type { Combatant, EncounterState } from '../state.ts';

const c = (combatId: number, factionId: Combatant['factionId'], hull = 100): Combatant => ({
  kind: 'ship', id: `c${combatId}`, combatId, factionId, components: ['small-engine', 'small-laser'], commands: [], pools: [{ key: 'hull', current: hull, max: hull }],
});
const roster = (combatants: readonly Combatant[], disengaged = false): EncounterState =>
  ({ combatants, activeId: 0, round: 1, effects: [], nextEffectId: 0, initiative: { player: 0, rival: 0 }, phaseSide: 'player', initiatorSide: 'player', damageThisRound: false, disengaged });

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

test('terminal when mutually disengaged, even with both sides alive', () => {
  // A damage-free round latches `disengaged` (step.beginNextPhase); isTerminal honors it though both
  // sides still field a living combatant.
  assert.equal(isTerminal(roster([c(0, 'player'), c(1, 'rival')], true)), true);
  assert.equal(isTerminal(roster([c(0, 'player'), c(1, 'rival')], false)), false);
});
