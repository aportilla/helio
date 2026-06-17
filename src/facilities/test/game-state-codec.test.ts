// Pins the helio.game save reader (parse → validate-and-merge → skip-on-missing).
// Pure: we feed raw blobs + a stub body-existence predicate, no localStorage or
// catalog. Guards the save-evolution seam — a tightened validator or a new field
// must not silently drop valid facilities or mis-floor turn/seq. Lives here
// because the validity gate is the facilities registry's frozen type set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGameState, DEFAULTS } from '../../game-state-codec.ts';

const anyBody = () => true;
const noBody = () => false;
const blob = (o: unknown) => JSON.stringify(o);

test('null/empty/corrupt blobs fall back to fresh DEFAULTS', () => {
  assert.deepEqual(parseGameState(null, anyBody).state, DEFAULTS);
  assert.deepEqual(parseGameState('', anyBody).state, DEFAULTS);
  assert.deepEqual(parseGameState('{not json', anyBody).state, DEFAULTS);
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
  const { state, droppedFacilities } = parseGameState(raw, anyBody);
  assert.deepEqual(state.facilities.map((f) => f.id), ['f1', 'f2']);
  assert.equal(droppedFacilities, 3);
});

test('skip-on-missing: a facility whose body the catalog dropped is discarded', () => {
  const raw = blob({ version: 1, turn: 1, seq: 1, facilities: [{ id: 'f1', bodyId: 'gone', type: 'colony' }] });
  const { state, droppedFacilities } = parseGameState(raw, noBody);
  assert.equal(state.facilities.length, 0);
  assert.equal(droppedFacilities, 1);
});

test('turn/seq are floored and validated; bad values read as defaults', () => {
  assert.equal(parseGameState(blob({ turn: 9.7 }), anyBody).state.turn, 9);
  assert.equal(parseGameState(blob({ turn: 0 }), anyBody).state.turn, 1);  // turns are 1-based
  assert.equal(parseGameState(blob({ turn: -5 }), anyBody).state.turn, 1);
  assert.equal(parseGameState(blob({}), anyBody).state.turn, 1);          // missing → 1
  assert.equal(parseGameState(blob({ seq: 4.9 }), anyBody).state.seq, 4);
  assert.equal(parseGameState(blob({ seq: -1 }), anyBody).state.seq, 0);
  assert.equal(parseGameState(blob({}), anyBody).state.seq, 0);
});

test('an unknown future field is ignored, not fatal (merge-over-defaults)', () => {
  const raw = blob({ version: 1, turn: 2, seq: 0, facilities: [], futureThing: { a: 1 } });
  const { state } = parseGameState(raw, anyBody);
  assert.equal(state.turn, 2);
  assert.equal(state.version, 1);
  assert.ok(!('futureThing' in state));
});
