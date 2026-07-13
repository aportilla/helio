// ai policy invariants — the fleet-aware opponent driver (§3.7). Asserts the two core behaviours:
// it reasons over the WHOLE phase side (a drained active ship does not forfeit the phase) and it
// FOCUS-FIRES the weakest living enemy
// (not the first in roster order). Plus the null cases (no living enemy / a fully drained side) the
// controller turns into an auto-pass, and purity. Drives real corvette combatants through the E1
// adapter; runs under `node --test` type-stripping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAutoIntent } from '../ai.ts';
import { createEncounterState } from '../step.ts';
import { shipsToCombatants } from '../ships-to-combatants.ts';
import { buildEncounterSpec } from '../encounter-spec.ts';
import { ENERGY_STAT, type EncounterState } from '../state.ts';
import { PLACEHOLDER_HULL_MILLI } from '../tuning.ts';
import type { Ship } from '../../game-state-codec.ts';

const LASER = 'small-laser:laser'; // the corvette's ATTACK command

const ship = (id: string, factionId: Ship['factionId']): Ship => ({
  id, systemId: 'sol', factionId, components: ['small-engine', 'small-laser'], name: id, status: 'ready',
});

// Build an encounter whose LIVE phase is the initiator's side — the side chooseAutoIntent drives.
function encounterOf(ships: readonly Ship[], initiatorId = ships[0]!.id): EncounterState {
  const sides = shipsToCombatants(ships);
  return createEncounterState(buildEncounterSpec(sides, { actorId: initiatorId, actionId: LASER, targetIds: [] }));
}

// Immutably set a combatant's single hull-pool current — the focus-fire weakness axis.
function withHull(s: EncounterState, id: string, current: number): EncounterState {
  return { ...s, combatants: s.combatants.map((c) => (c.id === id ? { ...c, pools: [{ key: 'hull', current, max: PLACEHOLDER_HULL_MILLI }] } : c)) };
}

// Immutably set a combatant's energy stat — the affordability axis (0 = can't fire its salvo).
function withEnergy(s: EncounterState, id: string, energy: number): EncounterState {
  return { ...s, combatants: s.combatants.map((c) => (c.id === id ? { ...c, stats: { ...c.stats, [ENERGY_STAT]: energy } } : c)) };
}

test('fires a phase-side ship and focus-fires the weakest living enemy', () => {
  // rival opens (phaseSide = rival); two player targets, p2 the weaker → r1 aims at p2.
  let s = encounterOf([ship('r1', 'rival'), ship('p1', 'player'), ship('p2', 'player')], 'r1');
  s = withHull(s, 'p2', PLACEHOLDER_HULL_MILLI / 4);
  assert.deepEqual(chooseAutoIntent(s), { actorId: 'r1', actionId: LASER, targetIds: ['p2'] });
});

test('chooses a charged same-side ship when the active (lower-combatId) ship is drained — no forfeit', () => {
  // r1 (active, combatId 0) is out of salvo energy but r2 is charged: the fleet-aware policy fires r2
  // rather than forfeiting the whole phase because the active ship can't fire.
  let s = encounterOf([ship('r1', 'rival'), ship('r2', 'rival'), ship('p1', 'player')], 'r1');
  s = withEnergy(s, 'r1', 0);
  const intent = chooseAutoIntent(s);
  assert.equal(intent?.actorId, 'r2', 'a charged same-side ship fires instead of forfeiting');
  assert.deepEqual(intent?.targetIds, ['p1']);
});

test('focus-fires the lowest-HP enemy, not the first in roster order', () => {
  let s = encounterOf([ship('r1', 'rival'), ship('p1', 'player'), ship('p2', 'player')], 'r1');
  s = withHull(s, 'p1', PLACEHOLDER_HULL_MILLI); // p1 is first but full
  s = withHull(s, 'p2', 1_000);                  // p2 is weaker
  assert.equal(chooseAutoIntent(s)?.targetIds[0], 'p2');
});

test('breaks an HP tie by the lowest combatId (deterministic)', () => {
  let s = encounterOf([ship('r1', 'rival'), ship('p1', 'player'), ship('p2', 'player')], 'r1');
  s = withHull(s, 'p1', 1_000); // p1 = combatId 1
  s = withHull(s, 'p2', 1_000); // p2 = combatId 2, equally weak → p1 wins on the lower combatId
  assert.equal(chooseAutoIntent(s)?.targetIds[0], 'p1');
});

test('returns null when no living enemy remains (the caller auto-passes the phase)', () => {
  let s = encounterOf([ship('r1', 'rival'), ship('p1', 'player')], 'r1');
  s = withHull(s, 'p1', 0); // the only enemy is downed
  assert.equal(chooseAutoIntent(s), null);
});

test('returns null when the whole phase side is out of salvo energy', () => {
  let s = encounterOf([ship('r1', 'rival'), ship('r2', 'rival'), ship('p1', 'player')], 'r1');
  s = withEnergy(s, 'r1', 0);
  s = withEnergy(s, 'r2', 0);
  assert.equal(chooseAutoIntent(s), null, 'a fully drained side yields no intent');
});

test('drives whichever side\'s phase is live (acts for the controlled side under auto-play too)', () => {
  // player opens → phaseSide = player; the policy fires a player ship at the weakest rival.
  let s = encounterOf([ship('p1', 'player'), ship('r1', 'rival'), ship('r2', 'rival')], 'p1');
  s = withHull(s, 'r2', 1_000);
  const intent = chooseAutoIntent(s);
  assert.equal(intent?.actorId, 'p1');
  assert.equal(intent?.targetIds[0], 'r2');
});

test('is pure: the same state yields the same intent and never mutates it', () => {
  const s = encounterOf([ship('r1', 'rival'), ship('p1', 'player'), ship('p2', 'player')], 'r1');
  const snapshot = JSON.stringify(s);
  assert.deepEqual(chooseAutoIntent(s), chooseAutoIntent(s));
  assert.equal(JSON.stringify(s), snapshot, 'state is untouched');
});
