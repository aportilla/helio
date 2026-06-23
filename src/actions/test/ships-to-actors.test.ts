// ships-to-actors adapter invariants — ready ships split by faction into sides, the
// controlled-side flag, the 'building' filter, and the loadout override. Runs under `node
// --test` type-stripping: the Ship import is a type (erased), so only node-pure modules
// load (the factions registry's DEV block is skipped — import.meta.env is undefined).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipsToActors, shipToActor, DEFAULT_SHIP_COMMANDS } from '../ships-to-actors.ts';
import type { Ship } from '../../game-state-codec.ts';

const ship = (id: string, factionId: Ship['factionId'], status: Ship['status'] = 'ready'): Ship => ({
  id,
  systemId: 'sol',
  factionId,
  classId: 'corvette',
  name: id,
  status,
});

test('splits ready ships by faction, preserving first-seen faction order', () => {
  const sides = shipsToActors([
    ship('p1', 'player'),
    ship('r1', 'rival'),
    ship('p2', 'player'),
  ]);
  assert.equal(sides.length, 2);
  assert.deepEqual(sides.map((s) => s.factionId), ['player', 'rival']);
  assert.deepEqual(sides[0]!.actors.map((a) => a.id), ['p1', 'p2']);
  assert.deepEqual(sides[1]!.actors.map((a) => a.id), ['r1']);
});

test('marks the controlled side (factionId === CONTROLLED_FACTION_ID)', () => {
  const sides = shipsToActors([ship('p1', 'player'), ship('r1', 'rival')]);
  assert.equal(sides.find((s) => s.factionId === 'player')?.controlled, true);
  assert.equal(sides.find((s) => s.factionId === 'rival')?.controlled, false);
});

test("'building' ships are excluded (not in the field yet)", () => {
  const sides = shipsToActors([ship('p1', 'player'), ship('pb', 'player', 'building')]);
  assert.equal(sides.length, 1);
  assert.deepEqual(sides[0]!.actors.map((a) => a.id), ['p1']);
});

test('an actor gets the bones loadout by default', () => {
  const a = shipToActor(ship('p1', 'player'));
  assert.deepEqual(a.commands, DEFAULT_SHIP_COMMANDS);
  assert.equal(a.id, 'p1');
});

test('commandsFor overrides the per-ship loadout', () => {
  const sides = shipsToActors([ship('p1', 'player')], () => [{ id: 'attack' }]);
  assert.deepEqual(sides[0]!.actors[0]!.commands, [{ id: 'attack' }]);
});

test('no ready ships → no sides', () => {
  assert.deepEqual(shipsToActors([]), []);
  assert.deepEqual(shipsToActors([ship('pb', 'player', 'building')]), []);
});
