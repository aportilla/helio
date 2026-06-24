// step reducer invariants — state seeding, the flat placeholder attack, turn advance + round wrap, a
// non-attack pass, downing, and a full encounter run to the side-elimination terminal. Drives REAL
// ship combatants (the E1 adapter) so the command lookup (small-laser:laser is an attack;
// small-engine:flee is navigation) is exercised end to end. Runs under `node --test` type-stripping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createEncounterState } from '../step.ts';
import { shipsToCombatants } from '../ships-to-combatants.ts';
import { buildEncounterSpec } from '../encounter-spec.ts';
import { isTerminal } from '../terminal.ts';
import { ENERGY_STAT, HULL_STAT, isDown, type EncounterState } from '../state.ts';
import { PLACEHOLDER_DAMAGE_MILLI, PLACEHOLDER_HULL_MILLI } from '../tuning.ts';
import type { Ship } from '../../game-state-codec.ts';

const LASER = 'small-laser:laser'; // an ATTACK command on the corvette loadout
const FLEE = 'small-engine:flee'; // a NAVIGATION command — the bones treat it as a turn pass

const ship = (id: string, factionId: Ship['factionId']): Ship => ({
  id, systemId: 'sol', factionId, classId: 'corvette', name: id, status: 'ready',
});

function encounterOf(ships: readonly Ship[], initiatorId = ships[0]!.id): EncounterState {
  const sides = shipsToCombatants(ships);
  return createEncounterState(buildEncounterSpec(sides, { actorId: initiatorId, actionId: LASER, targetIds: [] }));
}
const hullOf = (s: EncounterState, id: string) => s.combatants.find((c) => c.id === id)?.stats?.[HULL_STAT];

test('createEncounterState stamps placeholder hull and starts at the initiator', () => {
  const s = encounterOf([ship('p1', 'player'), ship('r1', 'rival')], 'r1');
  assert.equal(s.round, 1);
  assert.equal(s.activeId, s.combatants.find((c) => c.id === 'r1')!.combatId, 'the initiator acts first');
  assert.equal(hullOf(s, 'p1'), PLACEHOLDER_HULL_MILLI);
  assert.equal(hullOf(s, 'r1'), PLACEHOLDER_HULL_MILLI);
});

test('an attack removes the flat placeholder hull and emits a damage event; the turn passes', () => {
  const s0 = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]); // p1 = combatId 0, acts first
  const { state: s1, events } = applyCommand(s0, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] });
  assert.equal(hullOf(s1, 'r1'), PLACEHOLDER_HULL_MILLI - PLACEHOLDER_DAMAGE_MILLI);
  assert.equal(hullOf(s1, 'p1'), PLACEHOLDER_HULL_MILLI, 'the attacker is untouched');
  assert.deepEqual(events, [{ kind: 'damage', source: 0, target: 1, amount: PLACEHOLDER_DAMAGE_MILLI }]);
  assert.equal(s1.activeId, 1, "now r1's turn");
  assert.equal(s1.round, 1);
});

test('the round bumps when the cursor wraps back to the top', () => {
  let s = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]);
  ({ state: s } = applyCommand(s, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] })); // active 0 → 1
  assert.equal(s.round, 1);
  ({ state: s } = applyCommand(s, { actorId: 'r1', actionId: LASER, targetIds: ['p1'] })); // active 1 → 0, wrap
  assert.equal(s.activeId, 0);
  assert.equal(s.round, 2);
});

test('a non-attack command passes the turn without damage', () => {
  const s0 = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]);
  const { state: s1, events } = applyCommand(s0, { actorId: 'p1', actionId: FLEE, targetIds: [] });
  assert.deepEqual(events, []);
  assert.equal(hullOf(s1, 'r1'), PLACEHOLDER_HULL_MILLI, 'no damage from a navigation command');
  assert.equal(s1.activeId, 1, 'the turn still passed');
});

test('a target reaching 0 hull is downed (event + isDown + terminal)', () => {
  // Bring r1 one hit from death, then land it.
  const base = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]);
  const low: EncounterState = {
    ...base,
    combatants: base.combatants.map((c) =>
      c.id === 'r1' ? { ...c, stats: { ...c.stats, [HULL_STAT]: PLACEHOLDER_DAMAGE_MILLI } } : c),
  };
  const { state, events } = applyCommand(low, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] });
  assert.equal(hullOf(state, 'r1'), 0);
  assert.ok(events.some((e) => e.kind === 'down' && e.combatId === 1), 'a down event for r1');
  assert.equal(isDown(state.combatants.find((c) => c.id === 'r1')!), true);
  assert.equal(isTerminal(state), true, 'rival eliminated → terminal');
});

test('a combatant recharges energy at its own turn start (the declared engine effect)', () => {
  // p1 (combatId 0) acts first on a charged start (no pre-tick). Drain p1, then run a full round so
  // the cursor wraps back to p1 — its turn start ticks small-engine's declared recharge.
  const base = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]);
  let s: EncounterState = {
    ...base,
    combatants: base.combatants.map((c) => (c.id === 'p1' ? { ...c, stats: { ...c.stats, [ENERGY_STAT]: 1000 } } : c)),
  };
  ({ state: s } = applyCommand(s, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] })); // p1 acts → r1's turn
  assert.equal(s.combatants.find((c) => c.id === 'p1')!.stats?.[ENERGY_STAT], 1000, "p1 doesn't recharge on r1's turn");
  ({ state: s } = applyCommand(s, { actorId: 'r1', actionId: LASER, targetIds: ['p1'] })); // r1 acts → wraps to p1 → p1 ticks
  assert.equal(s.combatants.find((c) => c.id === 'p1')!.stats?.[ENERGY_STAT], 4000, 'p1 recharged 3000 at its turn start');
});

test('runs a full encounter to the side-elimination terminal', () => {
  let s = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]);
  let guard = 0;
  while (!isTerminal(s) && guard++ < 100) {
    const active = s.combatants[s.activeId]!;
    const enemy = s.combatants.find((c) => c.factionId !== active.factionId && !isDown(c));
    assert.ok(enemy, 'a living enemy exists while not terminal');
    ({ state: s } = applyCommand(s, { actorId: active.id, actionId: LASER, targetIds: [enemy!.id] }));
  }
  assert.ok(isTerminal(s));
  assert.ok(guard < 100, 'terminated well before the guard');
  const livingFactions = new Set(s.combatants.filter((c) => !isDown(c)).map((c) => c.factionId));
  assert.equal(livingFactions.size, 1, 'exactly one side left standing');
});
