// Pins pickDiscPool's depth resolution — the system-view picker the scene README
// calls "load-bearing across z bands". A single pool mixes discs from many z
// bands whose circles overlap freely, so the picker must return the TOPMOST
// (largest-z) hit, mirroring the depth test; a first-match walk would pick a body
// drawn behind. A silent regression here mis-resolves hover/select every frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDiscPool } from '../system-diagram/geom/hit.ts';

interface Disc { cx: number; cy: number; r: number; z: number }

// Run a query against a pool of discs; makePick returns the slot index.
function pick(discs: readonly Disc[], x: number, y: number): number | null {
  return pickDiscPool(
    x, y, discs.length,
    (i) => discs[i]!.cx, (i) => discs[i]!.cy, (i) => discs[i]!.r, (i) => discs[i]!.z,
    (i) => i,
  );
}

test('pickDiscPool: returns the largest-z disc where circles overlap', () => {
  const discs: Disc[] = [
    { cx: 0, cy: 0, r: 10, z: 1 }, // slot 0, low z
    { cx: 5, cy: 0, r: 10, z: 2 }, // slot 1, high z — overlaps slot 0 at (2,0)
  ];
  assert.equal(pick(discs, 2, 0), 1, 'point inside both → the higher-z (topmost) slot wins');
});

test('pickDiscPool: strict > keeps the earlier slot on a z tie', () => {
  const discs: Disc[] = [
    { cx: 0, cy: 0, r: 10, z: 5 },
    { cx: 5, cy: 0, r: 10, z: 5 },
  ];
  assert.equal(pick(discs, 2, 0), 0, 'equal z → earliest slot retained');
});

test('pickDiscPool: a point inside only one disc returns that disc', () => {
  const discs: Disc[] = [
    { cx: 0, cy: 0, r: 10, z: 1 },
    { cx: 50, cy: 0, r: 10, z: 9 }, // far away, higher z, but not under the point
  ];
  assert.equal(pick(discs, -8, 0), 0);
});

test('pickDiscPool: a miss returns null; the disc boundary is inclusive', () => {
  const discs: Disc[] = [{ cx: 0, cy: 0, r: 10, z: 1 }];
  assert.equal(pick(discs, 100, 100), null);
  assert.equal(pick(discs, 10, 0), 0, 'exactly on the radius counts as a hit (<=)');
  assert.equal(pick([], 0, 0), null, 'empty pool → null');
});
