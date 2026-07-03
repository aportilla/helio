// Node-pure cluster-distance math — the movement-geometry core extracted from stars.ts so it's
// testable with fabricated COMs, without loading the catalog / three.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MILLI_PER_LY, distanceMilliLy, clustersWithinRange } from '../cluster-geometry.ts';

const p = (x: number, y: number, z: number) => ({ x, y, z });

test('distanceMilliLy is the rounded Euclidean distance × MILLI_PER_LY', () => {
  assert.equal(MILLI_PER_LY, 1000);
  assert.equal(distanceMilliLy(p(0, 0, 0), p(0, 0, 0)), 0);
  // A unit axis step is exactly one ly = MILLI_PER_LY milli-ly.
  assert.equal(distanceMilliLy(p(0, 0, 0), p(1, 0, 0)), 1000);
  // A 3-4-5 triangle in a plane: distance 5 ly.
  assert.equal(distanceMilliLy(p(0, 0, 0), p(3, 4, 0)), 5000);
  // ROUNDS, not floors (symmetric error) — half a milli-ly rounds up.
  assert.equal(distanceMilliLy(p(0, 0, 0), p(0.0004, 0, 0)), 0);
  assert.equal(distanceMilliLy(p(0, 0, 0), p(0.0006, 0, 0)), 1);
  // Symmetric in its arguments.
  assert.equal(distanceMilliLy(p(1, 2, 3), p(4, 6, 3)), distanceMilliLy(p(4, 6, 3), p(1, 2, 3)));
});

test('clustersWithinRange returns every point within range, EXCLUDING the origin, boundary-inclusive', () => {
  const coms = [p(0, 0, 0), p(1, 0, 0), p(3, 0, 0), p(10, 0, 0)];
  // range 3 ly = 3000 milli: index 1 (1 ly) + index 2 (3 ly, inclusive) reachable; index 3 (10 ly) not;
  // origin (index 0) excluded even though distance 0 ≤ range.
  assert.deepEqual(clustersWithinRange(coms, 0, 3000), [1, 2]);
  // Just under 3 ly drops the boundary point.
  assert.deepEqual(clustersWithinRange(coms, 0, 2999), [1]);
  // From a different origin (index 3 at x=10): only index 2 (7 ly) sits within 8 ly.
  assert.deepEqual(clustersWithinRange(coms, 3, 8000), [2]);
  // Zero range → nothing (the origin is always excluded).
  assert.deepEqual(clustersWithinRange(coms, 0, 0), []);
  // An out-of-bounds origin index → the empty set (no throw).
  assert.deepEqual(clustersWithinRange(coms, 99, 10000), []);
});
