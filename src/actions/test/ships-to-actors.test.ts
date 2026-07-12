// ships-to-actors adapter invariants — ready ships split by faction into sides, the
// controlled-side flag, the 'building' filter, and the loadout override. After the inversion an
// Actor carries RESOLVED ActionCommands derived from its class's component loadout
// (ShipClassDef.components → each ShipComponentDef's grants). Runs under `node --test`
// type-stripping: the Ship import is a type (erased), so only node-pure modules load (the registry
// DEV blocks are skipped — import.meta.env is undefined). Unlike the body adapter, this pulls in no
// sim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipsToActors, shipToActor, shipLoadout } from '../ships-to-actors.ts';
import type { Ship } from '../../game-state-codec.ts';

const ship = (id: string, factionId: Ship['factionId'], status: Ship['status'] = 'ready'): Ship => ({
  id,
  systemId: 'sol',
  factionId,
  components: ['small-engine', 'small-laser'],
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

test('a ship Actor carries the Attack + Support + Command category palette', () => {
  // The menu shows all three on every ship, greying any its loadout leaves empty (Command always, for
  // now — no module grants it). Star-to-star navigation is a galaxy-view modality now, not a menu command,
  // so nothing warp-related appears here (and there is still no flee — an encounter is fought to its terminal).
  assert.deepEqual(shipToActor(ship('p1', 'player')).categories, ['attack', 'support', 'command']);
});

test('the corvette loadout derives ONLY the laser — the drive grants no menu command', () => {
  // A corvette flies a small-engine + small-laser. The engine grants NO action-menu command (warp is a
  // galaxy-view modality dispatched straight to orderShipWarp, not a command you arm), so only the laser —
  // an ATTACK that enters an encounter — derives. Composed wire ids are `<componentId>:<key>`.
  assert.deepEqual(shipLoadout(ship('p1', 'player')).map((c) => c.id), ['small-laser:laser']);
  const laser = shipLoadout(ship('p1', 'player')).find((c) => c.grant.category === 'attack')!;
  assert.equal(laser.grant.kind, 'encounter', 'the laser enters the encounter modality');
  assert.deepEqual([laser.count, laser.totalCost], [1, 9000], 'one laser, its full-charge salvo cost (costPerUnit == placeholder energyMax)');
  assert.equal(shipLoadout(ship('p1', 'player')).some((c) => c.grant.rootLevel), false, 'no root-level command — warp is not an action');
});

test('an actor gets its class loadout by default', () => {
  const a = shipToActor(ship('p1', 'player'));
  assert.deepEqual(a.commands, shipLoadout(ship('p1', 'player')));
  assert.equal(a.id, 'p1');
});

test('commandsFor overrides the per-ship loadout', () => {
  const only = shipLoadout(ship('p1', 'player')).slice(0, 1); // just the laser command
  const sides = shipsToActors([ship('p1', 'player')], () => only);
  assert.deepEqual(sides[0]!.actors[0]!.commands, only);
});

test('no ready ships → no sides', () => {
  assert.deepEqual(shipsToActors([]), []);
  assert.deepEqual(shipsToActors([ship('pb', 'player', 'building')]), []);
});
