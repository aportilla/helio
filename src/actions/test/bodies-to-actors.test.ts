// bodies-to-actors invariants — facility-bearing bodies projected into menu Actors split by
// ownership, the body-namespaced ids, the facility-GRANTED commands (derived + merged from each
// facility's own grants, no central map), and the command-less-body omission. Runs under
// `node --test`: the adapter reads grants off the facility defs (FACILITY_BY_TYPE), and the
// registry is sim-free, so this suite loads no sim; node loads the .ts via type-stripping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodiesToActors, bodyToActor, type BodyActorInput } from '../bodies-to-actors.ts';
import { encodeBodyEntityId } from '../entity-id.ts';
import type { FacilityType } from '../../facilities/types.ts';

const body = (bodyIdx: number, factionId: string, types: readonly FacilityType[]): BodyActorInput => ({
  bodyIdx,
  factionId,
  facilities: types.map((type) => ({ type })),
});

const ids = (input: BodyActorInput) => bodyToActor(input).commands.map((c) => c.id);

test('a body Actor is id-namespaced under body:; commands are derived from facility grants', () => {
  const a = bodyToActor(body(7, 'player', ['mining-base']));
  assert.equal(a.id, encodeBodyEntityId(7));
  assert.deepEqual(a.commands.map((c) => c.id), ['mining-base:mine']);
  assert.equal(a.commands[0]!.grant.label, 'Mine');
});

test('a body Actor always carries the Attack + Support category palette', () => {
  // The menu shape is stable per actor TYPE: a body shows Attack + Support even when a
  // category is empty (the menu greys it), so the palette rides every body regardless of loadout.
  assert.deepEqual(bodyToActor(body(7, 'player', ['mining-base'])).categories, ['attack', 'support']);
  assert.deepEqual(bodyToActor(body(8, 'player', ['farm'])).categories, ['attack', 'support']);
});

test('a colony grants establish; a facility with no grants (farm) grants no command', () => {
  assert.deepEqual(ids(body(1, 'player', ['colony'])), ['colony:establish']);
  assert.deepEqual(ids(body(2, 'player', ['farm'])), []);
});

test('military / service facilities each grant their one command, with coherent dispatch kinds', () => {
  assert.deepEqual(ids(body(1, 'player', ['railgun-battery'])), ['railgun-battery:railgun']);
  assert.deepEqual(ids(body(2, 'player', ['missile-battery'])), ['missile-battery:missile']);
  assert.deepEqual(ids(body(3, 'player', ['shipyard'])), ['shipyard:repair']);
  assert.deepEqual(ids(body(4, 'player', ['sensor-network'])), ['sensor-network:recon']);

  // The body weapons ENTER an encounter; the support verbs resolve immediately.
  const railgun = bodyToActor(body(1, 'player', ['railgun-battery'])).commands[0]!;
  const repair = bodyToActor(body(3, 'player', ['shipyard'])).commands[0]!;
  assert.equal(railgun.grant.kind, 'encounter', 'a body weapon enters an encounter');
  assert.equal(repair.grant.kind, 'immediate');
});

test('identical facilities merge their grant into ONE scaled command (D2), first-seen order', () => {
  // maxPerBody=1 keeps this from happening live, but the merge rule is uniform — two colonies
  // stack their establish into a single command with count 2, mirroring identical ship components.
  const a = bodyToActor(body(4, 'player', ['colony', 'mining-base', 'colony']));
  assert.deepEqual(a.commands.map((c) => c.id), ['colony:establish', 'mining-base:mine']);
  assert.equal(a.commands.find((c) => c.id === 'colony:establish')?.count, 2);
});

test('splits by ownership, preserving first-seen order and marking the controlled side', () => {
  const sides = bodiesToActors([
    body(1, 'player', ['mining-base']),
    body(2, 'rival', ['colony']),
    body(3, 'player', ['colony']),
  ]);
  assert.deepEqual(sides.map((s) => s.factionId), ['player', 'rival']);
  assert.equal(sides.find((s) => s.factionId === 'player')?.controlled, true);
  assert.equal(sides.find((s) => s.factionId === 'rival')?.controlled, false);
  assert.deepEqual(sides[0]!.actors.map((a) => a.id), [encodeBodyEntityId(1), encodeBodyEntityId(3)]);
});

test('a body with no commandable facilities is omitted from its side', () => {
  const sides = bodiesToActors([
    body(1, 'player', ['farm']),       // no grant → omitted
    body(2, 'player', ['mining-base']),
  ]);
  assert.equal(sides.length, 1);
  assert.deepEqual(sides[0]!.actors.map((a) => a.id), [encodeBodyEntityId(2)]);
});

test('no commandable bodies → no sides', () => {
  assert.deepEqual(bodiesToActors([]), []);
  assert.deepEqual(bodiesToActors([body(1, 'player', ['farm'])]), []);
});
