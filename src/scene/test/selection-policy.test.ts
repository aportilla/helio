// Per-tick selection rules — the pure derivations scene.tick composes. These
// are exactly the kind of branchy logic that regresses silently, so each rule
// is pinned here. selection-policy imports only cluster-fade constants (no
// Three.js, no catalog), so it loads cleanly under node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCandidateCluster,
  dimAmountForOrbit,
} from '../selection-policy.ts';
import { FOCUS_MARKER_NEAR, STAR_DIM_FULL_BELOW, STAR_DIM_OFF_ABOVE } from '../cluster-fade.ts';

const ORIGIN = { x: 0, y: 0, z: 0 };
const COM = { x: 0, y: 0, z: 0 };
const offPivot = { x: FOCUS_MARKER_NEAR + 1, y: 0, z: 0 }; // panned off the star
const onPivot = { x: FOCUS_MARKER_NEAR - 0.1, y: 0, z: 0 }; // sitting on it

test('hover beats focus-proximity for the candidate slot', () => {
  // Hovering cluster 7 wins even though the pivot is parked off cluster 3.
  assert.equal(resolveCandidateCluster(7, 3, COM, -1, offPivot, false), 7);
});

test('hover does not promote the already-selected cluster', () => {
  assert.equal(resolveCandidateCluster(4, -1, null, 4, ORIGIN, false), -1);
});

test('focus-proximity fills the slot once the pivot pans off the nearest cluster', () => {
  assert.equal(resolveCandidateCluster(-1, 2, COM, -1, offPivot, false), 2);
});

test('focus-proximity is suppressed while the pivot sits on the cluster', () => {
  assert.equal(resolveCandidateCluster(-1, 2, COM, -1, onPivot, false), -1);
});

test('focus-proximity is suppressed during the focus glide', () => {
  assert.equal(resolveCandidateCluster(-1, 2, COM, -1, offPivot, true), -1);
});

test('focus-proximity never re-targets the selected cluster', () => {
  assert.equal(resolveCandidateCluster(-1, 2, COM, 2, offPivot, false), -1);
});

test('no candidate when nothing is hovered and no COM is supplied', () => {
  assert.equal(resolveCandidateCluster(-1, 2, null, -1, offPivot, false), -1);
});

test('dimAmountForOrbit: full dim zoomed in, off zoomed out, lerp between', () => {
  assert.equal(dimAmountForOrbit(STAR_DIM_FULL_BELOW - 1), 1);
  assert.equal(dimAmountForOrbit(STAR_DIM_OFF_ABOVE + 1), 0);
  const mid = dimAmountForOrbit((STAR_DIM_FULL_BELOW + STAR_DIM_OFF_ABOVE) / 2);
  assert.ok(mid > 0 && mid < 1);
});
