// Pins the helio.game save reader (parse → validate-and-merge → skip-on-missing)
// and the pure ship-build kernels (advanceShipBuilds / buildingShipAt). Pure: we
// feed raw blobs + stub existence predicates, no localStorage or catalog. Guards
// the save-evolution seam — a tightened validator or a new field must not silently
// drop valid records or mis-floor turn/seq. Lives here because the validity gate is
// the facilities + ships registries' frozen type sets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGameState,
  DEFAULTS,
  advanceShipBuilds,
  buildingShipAt,
  type Ship,
} from '../../game-state-codec.ts';

const anyBody = () => true;
const noBody = () => false;
const anySystem = () => true;
const noSystem = () => false;
const blob = (o: unknown) => JSON.stringify(o);

// A valid Ship for the pure-kernel tests (the parse tests feed raw JSON instead).
const ship = (o: Partial<Ship> = {}): Ship => ({
  id: 's1',
  systemId: 'sol',
  factionId: 'player',
  shipyardBodyId: 'earth',
  classId: 'corvette',
  name: 'Corvette 1',
  status: 'building',
  completesOnTurn: 3,
  ...o,
});

test('null/empty/corrupt blobs fall back to fresh DEFAULTS', () => {
  assert.deepEqual(parseGameState(null, anyBody, anySystem).state, DEFAULTS);
  assert.deepEqual(parseGameState('', anyBody, anySystem).state, DEFAULTS);
  assert.deepEqual(parseGameState('{not json', anyBody, anySystem).state, DEFAULTS);
});

test('valid facilities survive; malformed ones are dropped', () => {
  const raw = blob({
    version: 1, turn: 3, seq: 2,
    facilities: [
      { id: 'f1', bodyId: 'earth', type: 'colony' },
      { id: 'f2', bodyId: 'luna', type: 'mining-base' },
      { id: 'f3', bodyId: 'mars', type: 'not-a-real-type' }, // unknown type → dropped
      { id: 'f4', type: 'colony' },                          // missing bodyId → dropped
      { bodyId: 'venus', type: 'colony' },                   // missing id → dropped
    ],
  });
  const { state, droppedFacilities } = parseGameState(raw, anyBody, anySystem);
  assert.deepEqual(state.facilities.map((f) => f.id), ['f1', 'f2']);
  assert.equal(droppedFacilities, 3);
});

test('skip-on-missing: a facility whose body the catalog dropped is discarded', () => {
  const raw = blob({ version: 1, turn: 1, seq: 1, facilities: [{ id: 'f1', bodyId: 'gone', type: 'colony' }] });
  const { state, droppedFacilities } = parseGameState(raw, noBody, anySystem);
  assert.equal(state.facilities.length, 0);
  assert.equal(droppedFacilities, 1);
});

test('body ownership: valid records survive; malformed/unknown-faction dropped; missing-body pruned', () => {
  const raw = blob({
    version: 1, turn: 1, seq: 0,
    ownership: [
      { bodyId: 'earth', factionId: 'rival' },
      { bodyId: 'luna', factionId: 'no-such-faction' }, // unknown faction → dropped
      { factionId: 'rival' },                            // missing bodyId → dropped
      { bodyId: 'gone', factionId: 'rival' },            // valid shape, but body pruned below
    ],
  });
  // Every body exists EXCEPT 'gone' (a catalog rebuild dropped it).
  const { state, droppedOwnership } = parseGameState(raw, (id) => id !== 'gone', anySystem);
  assert.deepEqual(state.ownership.map((o) => o.bodyId), ['earth']);
  assert.deepEqual(state.ownership.map((o) => o.factionId), ['rival']);
  assert.equal(droppedOwnership, 3);
});

test('an old save with no ownership key loads unowned (empty overlay, nothing dropped)', () => {
  const raw = blob({ version: 1, turn: 2, seq: 0, facilities: [] });
  const { state, droppedOwnership } = parseGameState(raw, anyBody, anySystem);
  assert.deepEqual(state.ownership, []);
  assert.equal(droppedOwnership, 0);
});

test('turn/seq are floored and validated; bad values read as defaults', () => {
  assert.equal(parseGameState(blob({ turn: 9.7 }), anyBody, anySystem).state.turn, 9);
  assert.equal(parseGameState(blob({ turn: 0 }), anyBody, anySystem).state.turn, 1);  // turns are 1-based
  assert.equal(parseGameState(blob({ turn: -5 }), anyBody, anySystem).state.turn, 1);
  assert.equal(parseGameState(blob({}), anyBody, anySystem).state.turn, 1);          // missing → 1
  assert.equal(parseGameState(blob({ seq: 4.9 }), anyBody, anySystem).state.seq, 4);
  assert.equal(parseGameState(blob({ seq: -1 }), anyBody, anySystem).state.seq, 0);
  assert.equal(parseGameState(blob({}), anyBody, anySystem).state.seq, 0);
});

test('an unknown future field is ignored, not fatal (merge-over-defaults)', () => {
  const raw = blob({ version: 1, turn: 2, seq: 0, facilities: [], futureThing: { a: 1 } });
  const { state } = parseGameState(raw, anyBody, anySystem);
  assert.equal(state.turn, 2);
  assert.equal(state.version, 1);
  assert.ok(!('futureThing' in state));
});

test('an old save with no ships key loads with an empty fleet', () => {
  const raw = blob({ version: 1, turn: 2, seq: 0, facilities: [] });
  const { state, droppedShips } = parseGameState(raw, anyBody, anySystem);
  assert.deepEqual(state.ships, []);
  assert.equal(droppedShips, 0);
});

test('valid ships survive; malformed ones are dropped', () => {
  const raw = blob({
    version: 1, turn: 5, seq: 9,
    ships: [
      { id: 's1', systemId: 'sol', shipyardBodyId: 'earth', classId: 'corvette', name: 'Corvette 1', status: 'building', completesOnTurn: 7 },
      { id: 's2', systemId: 'sol', shipyardBodyId: 'luna', classId: 'corvette', name: 'Corvette 2', status: 'ready', completesOnTurn: 4 },
      { id: 's3', systemId: 'sol', shipyardBodyId: 'mars', classId: 'dreadnought', name: 'X', status: 'building', completesOnTurn: 9 }, // unknown classId → dropped
      { id: 's4', systemId: 'sol', shipyardBodyId: 'venus', classId: 'corvette', name: 'X', status: 'queued', completesOnTurn: 9 },     // bad status → dropped
      { id: 's5', systemId: 'sol', shipyardBodyId: 'io', classId: 'corvette', name: 'X', status: 'building', completesOnTurn: 0 },      // completesOnTurn < 1 → dropped
      { id: 's6', systemId: 'sol', shipyardBodyId: 'io', classId: 'corvette', name: 'X', status: 'building', completesOnTurn: 3.5 },    // non-integer → dropped
      { systemId: 'sol', shipyardBodyId: 'earth', classId: 'corvette', name: 'X', status: 'ready', completesOnTurn: 2 },               // missing id → dropped
    ],
  });
  const { state, droppedShips } = parseGameState(raw, anyBody, anySystem);
  assert.deepEqual(state.ships.map((s) => s.id), ['s1', 's2']);
  assert.equal(droppedShips, 5);
});

test('skip-on-missing: a ship whose system the catalog dropped is discarded (any status)', () => {
  const raw = blob({
    version: 1, turn: 1, seq: 2,
    ships: [
      { id: 's1', systemId: 'gone', shipyardBodyId: 'earth', classId: 'corvette', name: 'A', status: 'building', completesOnTurn: 3 },
      { id: 's2', systemId: 'gone', shipyardBodyId: 'earth', classId: 'corvette', name: 'B', status: 'ready', completesOnTurn: 2 },
    ],
  });
  const { state, droppedShips } = parseGameState(raw, anyBody, noSystem);
  assert.equal(state.ships.length, 0);
  assert.equal(droppedShips, 2);
});

test('a building ship whose shipyard body is gone is reaped; a ready ship outlives its yard', () => {
  const raw = blob({
    version: 1, turn: 1, seq: 2,
    ships: [
      { id: 's1', systemId: 'sol', shipyardBodyId: 'gone', classId: 'corvette', name: 'A', status: 'building', completesOnTurn: 3 },
      { id: 's2', systemId: 'sol', shipyardBodyId: 'gone', classId: 'corvette', name: 'B', status: 'ready', completesOnTurn: 2 },
    ],
  });
  // System exists, but the shipyard body is gone: the in-flight build is a zombie and
  // is reaped; the finished ship is independent of its birth planet and is KEPT.
  const { state, droppedShips } = parseGameState(raw, noBody, anySystem);
  assert.deepEqual(state.ships.map((s) => s.id), ['s2']);
  assert.equal(droppedShips, 1);
});

test('factionId validate-and-merge: a pre-faction or unknown side defaults to the controlled faction', () => {
  const raw = blob({
    version: 1, turn: 5, seq: 9,
    ships: [
      // no factionId (a ship saved before ownership existed) → defaults
      { id: 's1', systemId: 'sol', shipyardBodyId: 'earth', classId: 'corvette', name: 'A', status: 'building', completesOnTurn: 7 },
      // an unknown factionId (a retired/typo'd side) → defaults, NOT dropped
      { id: 's2', systemId: 'sol', classId: 'corvette', name: 'B', status: 'ready', factionId: 'no-such-faction' },
      // an explicit live faction is preserved
      { id: 's3', systemId: 'sol', classId: 'corvette', name: 'C', status: 'ready', factionId: 'rival' },
    ],
  });
  const { state, droppedShips } = parseGameState(raw, anyBody, anySystem);
  assert.equal(droppedShips, 0, 'a missing/unknown factionId must default, never drop the ship');
  assert.deepEqual(state.ships.map((s) => s.factionId), ['player', 'player', 'rival']);
});

test("a 'ready' ship may omit the build-only fields (shipyard / completion turn)", () => {
  // The build-only fields are present iff 'building'. A 'ready' ship that never went
  // through the build flow legitimately carries neither, and survives even when NO body
  // exists, because the shipyard-existence prune is skipped for a ready ship. This is a
  // durable schema property — any non-built ready ship (a future starting/captured/
  // gifted ship) relies on it, independent of how one gets created today.
  const raw = blob({
    version: 1, turn: 3, seq: 4,
    ships: [
      { id: 's1', systemId: 'sol', classId: 'corvette', name: 'Corvette 1', status: 'ready' },
    ],
  });
  const { state, droppedShips } = parseGameState(raw, noBody, anySystem);
  assert.equal(droppedShips, 0);
  assert.equal(state.ships.length, 1);
  assert.equal(state.ships[0]!.shipyardBodyId, undefined);
  assert.equal(state.ships[0]!.completesOnTurn, undefined);
});

test('a building ship still REQUIRES a shipyard + completion turn (the build-only invariant)', () => {
  const raw = blob({
    version: 1, turn: 1, seq: 2,
    ships: [
      { id: 's1', systemId: 'sol', classId: 'corvette', name: 'A', status: 'building', completesOnTurn: 3 }, // no shipyardBodyId → dropped
      { id: 's2', systemId: 'sol', shipyardBodyId: 'earth', classId: 'corvette', name: 'B', status: 'building' }, // no completesOnTurn → dropped
    ],
  });
  const { state, droppedShips } = parseGameState(raw, anyBody, anySystem);
  assert.equal(state.ships.length, 0);
  assert.equal(droppedShips, 2);
});

test('advanceShipBuilds flips at completesOnTurn (>=), not before; idempotent on a double-fire', () => {
  const ships: readonly Ship[] = [ship({ id: 's1', status: 'building', completesOnTurn: 5 })];

  // Off-by-one: one turn early stays 'building', and the SAME ref is returned (no write).
  const early = advanceShipBuilds(ships, 4);
  assert.equal(early, ships);
  assert.equal(early[0]!.status, 'building');

  // At the threshold: flips to 'ready' as a NEW array (so the caller persists).
  const done = advanceShipBuilds(ships, 5);
  assert.notEqual(done, ships);
  assert.equal(done[0]!.status, 'ready');

  // Double-fire / a later turn over an already-'ready' ship is a no-op (same ref).
  assert.equal(advanceShipBuilds(done, 6), done);

  // A straggler still flips when the turn is well past completion.
  assert.equal(advanceShipBuilds(ships, 9)[0]!.status, 'ready');
});

test('buildingShipAt finds the in-flight build at a yard (the one-build-per-yard kernel)', () => {
  const ships: readonly Ship[] = [
    ship({ id: 's1', status: 'building', shipyardBodyId: 'earth' }),
    ship({ id: 's2', status: 'ready', shipyardBodyId: 'earth' }), // a ready ship does NOT occupy the yard
    ship({ id: 's3', status: 'building', shipyardBodyId: 'luna' }),
  ];
  assert.equal(buildingShipAt(ships, 'earth')?.id, 's1'); // a build in flight → the cap is hit
  assert.equal(buildingShipAt(ships, 'luna')?.id, 's3');
  assert.equal(buildingShipAt(ships, 'mars'), undefined);  // a free yard
  // A yard holding only a READY ship is free to start a new build.
  assert.equal(buildingShipAt([ship({ id: 's2', status: 'ready', shipyardBodyId: 'earth' })], 'earth'), undefined);
});
