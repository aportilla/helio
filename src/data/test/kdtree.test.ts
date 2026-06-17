// KDTree3 nearest-neighbor — cross-checked against a brute-force linear scan.
// The tree backs a per-frame query (nearestClusterIdxTo in scene.tick), so a
// silent partition/pruning bug would mis-resolve the candidate cluster every
// frame with no other test to catch it. Pure module, no Three.js/DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KDTree3, type Vec3 } from '../kdtree.ts';

// Deterministic PRNG (mulberry32) so the random point sets are reproducible —
// no Math.random, no cross-run flake.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const id = (p: Vec3): Vec3 => p;

function sq(p: Vec3, qx: number, qy: number, qz: number): number {
  const dx = qx - p.x, dy = qy - p.y, dz = qz - p.z;
  return dx * dx + dy * dy + dz * dz;
}

// Ground truth: linear scan for the minimum squared distance.
function bruteNearestSq(pts: Vec3[], qx: number, qy: number, qz: number): number {
  let best = Infinity;
  for (const p of pts) best = Math.min(best, sq(p, qx, qy, qz));
  return best;
}

test('empty tree returns -1', () => {
  const tree = new KDTree3<Vec3>([], id);
  assert.equal(tree.nearest(0, 0, 0), -1);
});

test('single point always wins', () => {
  const tree = new KDTree3<Vec3>([{ x: 3, y: -1, z: 2 }], id);
  assert.equal(tree.nearest(0, 0, 0), 0);
  assert.equal(tree.nearest(3, -1, 2), 0);
});

test('matches brute-force nearest on random anisotropic clouds', () => {
  const rand = rng(0x5eed);
  for (const n of [2, 5, 23, 200, 1000]) {
    const pts: Vec3[] = Array.from({ length: n }, () => ({
      x: rand() * 100 - 50,
      y: rand() * 100 - 50,
      z: rand() * 20 - 10, // thin in z, like the galactic-plane-biased catalog
    }));
    const tree = new KDTree3<Vec3>(pts, id);
    for (let q = 0; q < 100; q++) {
      const qx = rand() * 120 - 60, qy = rand() * 120 - 60, qz = rand() * 30 - 15;
      const got = tree.nearest(qx, qy, qz);
      // Compare DISTANCE, not index: equidistant ties may resolve to a
      // different index, but the winning squared distance must match exactly.
      assert.equal(sq(pts[got]!, qx, qy, qz), bruteNearestSq(pts, qx, qy, qz));
    }
  }
});

test('handles duplicate coordinates', () => {
  const pts: Vec3[] = [
    { x: 5, y: 5, z: 5 }, { x: 5, y: 5, z: 5 }, { x: 5, y: 5, z: 5 },
    { x: -8, y: 0, z: 0 }, { x: 0, y: 9, z: 0 },
  ];
  const tree = new KDTree3<Vec3>(pts, id);
  assert.equal(sq(pts[tree.nearest(5, 5, 5)]!, 5, 5, 5), 0);
});

test('handles pre-sorted axis-aligned input (median-of-three guard)', () => {
  // Strictly increasing along x — the degenerate case the median-of-three pivot
  // exists to tame; the result must still be correct.
  const pts: Vec3[] = Array.from({ length: 256 }, (_, i) => ({ x: i, y: 0, z: 0 }));
  const tree = new KDTree3<Vec3>(pts, id);
  for (const qx of [-10, 0, 0.4, 17.6, 200, 255, 1000]) {
    assert.equal(sq(pts[tree.nearest(qx, 0, 0)]!, qx, 0, 0), bruteNearestSq(pts, qx, 0, 0));
  }
});
