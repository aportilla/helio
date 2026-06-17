// Pins the mutable per-body overlay primitives (the reusable shape facilities use
// today and ownership/visibility/rename will reuse): the skip-on-missing prune +
// the by-body lookup, both keyed on a stable Body.id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneMissingBodies, recordsOnBody } from '../../world-overlay.ts';

const recs = [
  { bodyId: 'earth', tag: 'a' },
  { bodyId: 'luna', tag: 'b' },
  { bodyId: 'earth', tag: 'c' },
  { bodyId: 'gone', tag: 'd' },
];

test('pruneMissingBodies drops records whose body the catalog no longer contains', () => {
  const known = new Set(['earth', 'luna']);
  assert.deepEqual(pruneMissingBodies(recs, (id) => known.has(id)).map((r) => r.tag), ['a', 'b', 'c']);
  assert.equal(pruneMissingBodies(recs, () => true).length, 4);  // all bodies exist
  assert.equal(pruneMissingBodies(recs, () => false).length, 0); // none exist
});

test('recordsOnBody returns all records on a given body, in stored order', () => {
  assert.deepEqual(recordsOnBody(recs, 'earth').map((r) => r.tag), ['a', 'c']);
  assert.deepEqual(recordsOnBody(recs, 'luna').map((r) => r.tag), ['b']);
  assert.deepEqual(recordsOnBody(recs, 'nobody'), []);
});
