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
  // now — no module grants it). WARP DRIVE is a ROOT-LEVEL command, not a category, so it never appears
  // in this palette (and there is still no flee — an encounter is fought to its terminal).
  assert.deepEqual(shipToActor(ship('p1', 'player')).categories, ['attack', 'support', 'command']);
});

test('the corvette loadout derives WARP DRIVE + the laser, via the SAME projection', () => {
  // A corvette flies a small-engine + small-laser: the engine grants WARP DRIVE (a root-level galaxy
  // jump — movement, not a combat action), the laser an ATTACK that enters an encounter. Composed wire
  // ids are `<componentId>:<key>`, in component (provider) order.
  assert.deepEqual(shipLoadout(ship('p1', 'player')).map((c) => c.id), ['small-engine:warp', 'small-laser:laser']);
  const laser = shipLoadout(ship('p1', 'player')).find((c) => c.grant.category === 'attack')!;
  assert.equal(laser.grant.kind, 'encounter', 'the laser enters the encounter modality');
  assert.deepEqual([laser.count, laser.totalCost], [1, 9000], 'one laser, its full-charge salvo cost (costPerUnit == placeholder energyMax)');
  const warp = shipLoadout(ship('p1', 'player')).find((c) => c.grant.rootLevel)!;
  assert.deepEqual([warp.grant.kind, warp.grant.targetSpace], ['immediate', 'system'], 'warp is a root-level immediate galaxy jump, not combat');
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
