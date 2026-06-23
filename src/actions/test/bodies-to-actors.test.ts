// bodies-to-actors invariants — facility-bearing bodies projected into menu Actors split by
// ownership, the body-namespaced ids, the placeholder facility-gated commands, and the
// command-less-body omission. Pure; runs under `node --test` (the FacilityType/PlacedFacility
// imports are erased, so only node-pure modules load — the factions DEV block is skipped).

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

test('a body Actor is id-namespaced under body:; commands are facility-gated', () => {
  const a = bodyToActor(body(7, 'player', ['mining-base']));
  assert.equal(a.id, encodeBodyEntityId(7));
  assert.deepEqual(a.commands, [{ id: 'mine' }]);
});

test('a colony grants establish; an unmapped facility grants no command', () => {
  assert.deepEqual(bodyToActor(body(1, 'player', ['colony'])).commands, [{ id: 'establish' }]);
  assert.deepEqual(bodyToActor(body(2, 'player', ['farm'])).commands, []);
  assert.deepEqual(bodyToActor(body(3, 'player', ['shipyard'])).commands, []);
});

test('multiple facilities union their commands, de-duped, first-seen order', () => {
  const a = bodyToActor(body(4, 'player', ['colony', 'mining-base', 'colony']));
  assert.deepEqual(a.commands, [{ id: 'establish' }, { id: 'mine' }]);
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
    body(1, 'player', ['farm']),       // no command → omitted
    body(2, 'player', ['mining-base']),
  ]);
  assert.equal(sides.length, 1);
  assert.deepEqual(sides[0]!.actors.map((a) => a.id), [encodeBodyEntityId(2)]);
});

test('no commandable bodies → no sides', () => {
  assert.deepEqual(bodiesToActors([]), []);
  assert.deepEqual(bodiesToActors([body(1, 'player', ['farm'])]), []);
});
