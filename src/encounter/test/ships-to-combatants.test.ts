// ships-to-combatants adapter invariants — the combat specialization of ships-to-actors: ready
// ships split by faction into sides of Combatants, the controlled-side flag, the 'building' filter,
// the dense ships-first combatId numbering, and the DERIVED loadout shared with the live view.
// Runs under `node --test` type-stripping: the Ship import is a type (erased), so only node-pure
// modules load (the registry DEV blocks are skipped — import.meta.env is undefined). Like the actor
// adapter, this pulls in no sim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipsToCombatants, shipToCombatant } from '../ships-to-combatants.ts';
import type { CombatantSide } from '../state.ts';
import { shipLoadout } from '../../actions/ships-to-actors.ts';
import type { Ship } from '../../game-state-codec.ts';

const ship = (id: string, factionId: Ship['factionId'], status: Ship['status'] = 'ready'): Ship => ({
  id,
  systemId: 'sol',
  factionId,
  classId: 'corvette',
  name: id,
  status,
});

const flat = (sides: readonly CombatantSide[]) => sides.flatMap((s) => s.combatants);

test('splits ready ships by faction, preserving first-seen faction order', () => {
  const sides = shipsToCombatants([ship('p1', 'player'), ship('r1', 'rival'), ship('p2', 'player')]);
  assert.equal(sides.length, 2);
  assert.deepEqual(sides.map((s) => s.factionId), ['player', 'rival']);
  assert.deepEqual(sides[0]!.combatants.map((c) => c.id), ['p1', 'p2']);
  assert.deepEqual(sides[1]!.combatants.map((c) => c.id), ['r1']);
});

test('marks the controlled side (factionId === CONTROLLED_FACTION_ID)', () => {
  const sides = shipsToCombatants([ship('p1', 'player'), ship('r1', 'rival')]);
  assert.equal(sides.find((s) => s.factionId === 'player')?.controlled, true);
  assert.equal(sides.find((s) => s.factionId === 'rival')?.controlled, false);
});

test("'building' ships are excluded (not in the field yet)", () => {
  const sides = shipsToCombatants([ship('p1', 'player'), ship('pb', 'player', 'building')]);
  assert.equal(sides.length, 1);
  assert.deepEqual(sides[0]!.combatants.map((c) => c.id), ['p1']);
});

test('combatId is dense and ships-first across the whole roster (faction order × ship order)', () => {
  // player seen first → its ships number 0,1; rival's ship continues at 2. The dense total order is
  // what makes the turn-order tiebreak replay-stable, independent of the id strings.
  const all = flat(shipsToCombatants([ship('p1', 'player'), ship('r1', 'rival'), ship('p2', 'player')]));
  assert.deepEqual(all.map((c) => [c.id, c.combatId]), [['p1', 0], ['p2', 1], ['r1', 2]]);
});

test('a combatant is an Actor + combat identity: kind, classId, palette, derived loadout', () => {
  const c = shipToCombatant(ship('p1', 'player'), 7);
  assert.equal(c.kind, 'ship');
  assert.equal(c.id, 'p1');
  assert.equal(c.combatId, 7);
  assert.equal(c.factionId, 'player');
  assert.equal(c.classId, 'corvette');
  // A ship never shows Support — that palette is the body's; same SHIP_CATEGORIES as the live view.
  assert.deepEqual(c.categories, ['attack', 'navigation']);
  // Commands ARE the ship's derived loadout — the SAME projection the system-view actor uses, so a
  // combatant and a live-view ship offer an identical menu.
  assert.deepEqual(c.commands, shipLoadout(ship('p1', 'player')));
});

test('no ready ships → no sides', () => {
  assert.deepEqual(shipsToCombatants([]), []);
  assert.deepEqual(shipsToCombatants([ship('pb', 'player', 'building')]), []);
});
