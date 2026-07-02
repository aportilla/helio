// initiative invariants — the actor → icon BASE heuristic (§3.8.2): floor(livingActors × ratio),
// clamped up to MIN_INITIATIVE. An actor is a living ship (always) or a living body that can act (one
// carrying a command); a bombard-only / unarmed body adds none. The component tempo tier (tactical-
// command) is NOT here — it rides the effect substrate (see effects/test/fold.test.ts foldPhaseStart).
// Pure; synthetic combatants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseSideInitiative, zeroInitiative, fullInitiative } from '../initiative.ts';
import { INITIATIVE_PER_ACTOR_MILLI, MIN_INITIATIVE } from '../tuning.ts';
import type { Combatant } from '../state.ts';
import type { ActionCommand } from '../../actions/types.ts';
import type { FactionType } from '../../factions/types.ts';

const c = (combatId: number, factionId: FactionType, hull = 100): Combatant => ({
  kind: 'ship', id: `c${combatId}`, combatId, factionId, components: ['small-engine', 'small-laser'], commands: [], pools: [{ key: 'hull', current: hull, max: hull }],
});
const fleet = (n: number, factionId: FactionType = 'player'): Combatant[] => Array.from({ length: n }, (_, i) => c(i, factionId));

// A minimal armed command — enough for the actor test (baseSideInitiative reads only commands.length).
const armedCmd: ActionCommand = {
  id: 'orbital:railgun', count: 1, totalCost: 0,
  grant: { key: 'railgun', label: 'Railgun', color: '#ffffff', category: 'attack', targeting: 'single', kind: 'encounter' },
};
// A body combatant: `armed` gives it a command (an actor that adds tempo); unarmed leaves it a
// bombard-only target (adds none). hull=0 marks it downed.
const body = (combatId: number, factionId: FactionType, armed: boolean, hull = 100): Combatant => ({
  kind: 'body', id: `b${combatId}`, bodyId: `body-${combatId}`, combatId, factionId,
  commands: armed ? [armedCmd] : [], pools: [{ key: 'hull', current: hull, max: hull }],
});

test('the ratio is the only fractional step and is floored', () => {
  assert.equal(INITIATIVE_PER_ACTOR_MILLI, 500, 'sanity: ≈½ in milli (the tuning these expectations assume)');
});

test('baseSideInitiative floors ships × ratio, clamped up to MIN_INITIATIVE', () => {
  assert.equal(baseSideInitiative(fleet(1)), MIN_INITIATIVE, 'floor(½ × 1) = 0 → the lone-ship floor');
  assert.equal(baseSideInitiative(fleet(2)), 1, 'floor(½ × 2) = 1');
  assert.equal(baseSideInitiative(fleet(3)), 1, 'floor(½ × 3) = 1 — the tempo throttle');
  assert.equal(baseSideInitiative(fleet(4)), 2, 'floor(½ × 4) = 2');
  assert.equal(baseSideInitiative(fleet(12)), 6, 'a big fleet does not get an icon per ship');
});

test('baseSideInitiative counts only LIVING ships (attrition lowers tempo)', () => {
  const cs = [c(0, 'player', 0), c(1, 'player', 0), c(2, 'player'), c(3, 'player'), c(4, 'player'), c(5, 'player')];
  assert.equal(baseSideInitiative(cs), 2, '4 living of 6 → floor(½ × 4) = 2');
});

test('armed bodies count toward tempo like ships (home-field defenders add pips)', () => {
  assert.equal(baseSideInitiative([...fleet(3), body(3, 'player', true)]), 2, '3 ships + 1 armed body = 4 actors → floor(½ × 4) = 2 (the body bumped it from 1)');
});

test('an unarmed / bombard-only body adds no initiative (a target, not an actor)', () => {
  assert.equal(baseSideInitiative([...fleet(2), body(2, 'player', false)]), 1, '2 ships + a command-less body → still floor(½ × 2) = 1');
});

test('a lone armed body still gets the floor (a defended world fights)', () => {
  assert.equal(baseSideInitiative([body(0, 'player', true)]), MIN_INITIATIVE, 'floor(½ × 1) = 0 → the lone-actor floor');
});

test('a destroyed armed body stops contributing (attrition counts bodies too)', () => {
  assert.equal(baseSideInitiative([...fleet(3), body(3, 'player', true, 0)]), 1, 'the downed body drops back to 3 actors → floor(½ × 3) = 1');
});

test('fullInitiative gives each present faction its fresh base pool, others 0', () => {
  const combatants = [...fleet(4, 'player'), ...fleet(2, 'rival')];
  const pools = fullInitiative(combatants);
  assert.equal(pools.player, 2, '4 player ships → floor(½ × 4) = 2');
  assert.equal(pools.rival, 1, '2 rival ships → floor(½ × 2) = 1');
});

test('fullInitiative zeroes a faction with no combatants', () => {
  assert.equal(fullInitiative(fleet(3, 'player')).rival, 0, 'no rival combatants → 0 (never selected)');
});

test('zeroInitiative is a full per-faction record at 0', () => {
  const z = zeroInitiative();
  assert.equal(z.player, 0);
  assert.equal(z.rival, 0);
});
