// buildEncounterSpec invariants — the launch contract flattens faction sides into the dense,
// combatId-indexed roster the reducer walks (combatants[i].combatId === i), carries the launching
// intent untouched, and preserves the sides for the renderer. Pure; no scene, no sim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEncounterSpec } from '../encounter-spec.ts';
import { shipsToCombatants } from '../ships-to-combatants.ts';
import type { CombatantSide, ShipCombatant } from '../state.ts';
import type { ActionIntent } from '../../actions/types.ts';
import type { Ship } from '../../game-state-codec.ts';

const ship = (id: string, factionId: Ship['factionId']): Ship => ({
  id, systemId: 'sol', factionId, components: ['small-engine', 'small-laser'], name: id, status: 'ready',
});

const intent: ActionIntent = { actorId: 'p1', actionId: 'small-laser:laser', targetIds: ['r1'] };

test('flattens sides into a dense combatId-indexed roster (combatants[i].combatId === i)', () => {
  const sides = shipsToCombatants([ship('p1', 'player'), ship('r1', 'rival'), ship('p2', 'player')]);
  const spec = buildEncounterSpec(sides, intent);
  assert.equal(spec.combatants.length, 3);
  spec.combatants.forEach((c, i) => assert.equal(c.combatId, i));
  // In combatId order, which is ships-first across faction order (p1, p2, then r1).
  assert.deepEqual(spec.combatants.map((c) => c.id), ['p1', 'p2', 'r1']);
});

test('carries the launching intent and preserves the sides', () => {
  const sides = shipsToCombatants([ship('p1', 'player')]);
  const spec = buildEncounterSpec(sides, intent);
  assert.equal(spec.initiator, intent);
  assert.equal(spec.sides, sides);
});

test('places each combatant at its own combatId, not flatten order (append-safe for E5 bodies)', () => {
  // Synthetic sides whose combatIds interleave across the two sides — proving buildEncounterSpec
  // indexes by combatId (so an E5 body pass can append combatants at higher ids in a later side
  // without disturbing the ships) rather than trusting side/iteration order.
  const sc = (id: string, combatId: number, factionId: ShipCombatant['factionId']): ShipCombatant => ({
    kind: 'ship', id, combatId, factionId, components: ['small-engine', 'small-laser'], commands: [], categories: [],
  });
  const sides: readonly CombatantSide[] = [
    { factionId: 'player', controlled: true, combatants: [sc('a', 0, 'player'), sc('c', 2, 'player')] },
    { factionId: 'rival', controlled: false, combatants: [sc('b', 1, 'rival')] },
  ];
  const spec = buildEncounterSpec(sides, intent);
  assert.deepEqual(spec.combatants.map((c) => c.id), ['a', 'b', 'c']);
});

test('empty roster → empty spec', () => {
  const spec = buildEncounterSpec([], intent);
  assert.deepEqual(spec.combatants, []);
  assert.equal(spec.initiator, intent);
});
