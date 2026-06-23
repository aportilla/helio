// ships-to-actors adapter invariants — ready ships split by faction into sides, the
// controlled-side flag, the 'building' filter, and the loadout override. After the inversion an
// Actor carries RESOLVED ActionCommands derived from a stub loadout (until ShipComponentDef
// lands). Runs under `node --test` type-stripping: the Ship import is a type (erased), so only
// node-pure modules load (the factions registry's DEV block is skipped — import.meta.env is
// undefined). Unlike the body adapter, this pulls in no sim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipsToActors, shipToActor, STUB_SHIP_COMMANDS } from '../ships-to-actors.ts';
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

test('a ship Actor always carries the Attack + Navigation category palette', () => {
  // The menu shows these two top-level rows on every ship (greying one if its loadout is
  // empty there); a ship never shows Support — that palette is the body's.
  assert.deepEqual(shipToActor(ship('p1', 'player')).categories, ['attack', 'navigation']);
});

test('the stub loadout derives an attack (encounter) + flee (immediate), via the SAME projection', () => {
  // Until ShipComponentDef lands, every ship gets the stub: a weapon → ATTACK that enters an
  // encounter, the drive → NAVIGATION flee (D9). The wire ids are the composed provider:key.
  assert.deepEqual(STUB_SHIP_COMMANDS.map((c) => c.id), ['stub-weapon:attack', 'stub-drive:flee']);
  const attack = STUB_SHIP_COMMANDS.find((c) => c.grant.category === 'attack')!;
  const flee = STUB_SHIP_COMMANDS.find((c) => c.grant.category === 'navigation')!;
  assert.equal(attack.grant.kind, 'encounter', 'attack enters the encounter modality');
  assert.equal(flee.grant.kind, 'immediate');
  assert.deepEqual([attack.count, attack.totalCost], [1, 0], 'no stacking, no energy cost in the bones');
});

test('an actor gets the bones loadout by default', () => {
  const a = shipToActor(ship('p1', 'player'));
  assert.deepEqual(a.commands, STUB_SHIP_COMMANDS);
  assert.equal(a.id, 'p1');
});

test('commandsFor overrides the per-ship loadout', () => {
  const only = STUB_SHIP_COMMANDS.slice(0, 1); // just the attack command
  const sides = shipsToActors([ship('p1', 'player')], () => only);
  assert.deepEqual(sides[0]!.actors[0]!.commands, only);
});

test('no ready ships → no sides', () => {
  assert.deepEqual(shipsToActors([]), []);
  assert.deepEqual(shipsToActors([ship('pb', 'player', 'building')]), []);
});
