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

test("the corvette loadout derives flee (immediate) + laser (encounter), via the SAME projection", () => {
  // A corvette flies a small-engine + small-laser: the engine grants NAVIGATION flee (D9), the
  // laser an ATTACK that enters an encounter. The wire ids are the composed `<componentId>:<key>`,
  // in loadout order (engine before laser).
  assert.deepEqual(shipLoadout(ship('p1', 'player')).map((c) => c.id), ['small-engine:flee', 'small-laser:laser']);
  const laser = shipLoadout(ship('p1', 'player')).find((c) => c.grant.category === 'attack')!;
  const flee = shipLoadout(ship('p1', 'player')).find((c) => c.grant.category === 'navigation')!;
  assert.equal(laser.grant.kind, 'encounter', 'the laser enters the encounter modality');
  assert.equal(flee.grant.kind, 'immediate');
  assert.deepEqual([laser.count, laser.totalCost], [1, 0], 'one laser, no energy model yet ⇒ zero cost');
});

test('an actor gets its class loadout by default', () => {
  const a = shipToActor(ship('p1', 'player'));
  assert.deepEqual(a.commands, shipLoadout(ship('p1', 'player')));
  assert.equal(a.id, 'p1');
});

test('commandsFor overrides the per-ship loadout', () => {
  const only = shipLoadout(ship('p1', 'player')).slice(0, 1); // just the flee command
  const sides = shipsToActors([ship('p1', 'player')], () => only);
  assert.deepEqual(sides[0]!.actors[0]!.commands, only);
});

test('no ready ships → no sides', () => {
  assert.deepEqual(shipsToActors([]), []);
  assert.deepEqual(shipsToActors([ship('pb', 'player', 'building')]), []);
});
