// FleetLayer's pick geometry (fleet-pick.ts) — the disc hit-test that makes a built
// ship selectable. Pure (no Three.js, no catalog), so it loads cleanly under node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFleetShip, type FleetPickCandidate } from '../system-diagram/layers/fleet-pick.ts';

const C = (cx: number, cy: number, r: number, shipId: string): FleetPickCandidate => ({ cx, cy, r, shipId });

test('empty fleet picks nothing', () => {
  assert.equal(pickFleetShip([], 0, 0), null);
});

test('a point outside every disc picks nothing', () => {
  const fleet = [C(10, 10, 4, 's1'), C(30, 10, 4, 's2')];
  assert.equal(pickFleetShip(fleet, 20, 10), null); // dead between the two discs
  assert.equal(pickFleetShip(fleet, 10, 20), null); // above s1, past its radius
});

test('a point inside a disc picks that ship', () => {
  const fleet = [C(10, 10, 4, 's1'), C(30, 10, 4, 's2')];
  assert.equal(pickFleetShip(fleet, 12, 11), 's1');
  assert.equal(pickFleetShip(fleet, 31, 9), 's2');
});

test('the exact rim counts as a hit (inclusive radius)', () => {
  assert.equal(pickFleetShip([C(0, 0, 5, 's1')], 5, 0), 's1'); // d² === r²
});

test('overlapping discs resolve to the nearest center', () => {
  const fleet = [C(0, 0, 10, 'left'), C(8, 0, 10, 'right')];
  assert.equal(pickFleetShip(fleet, 7, 0), 'right'); // d(left)=7, d(right)=1
  assert.equal(pickFleetShip(fleet, 1, 0), 'left'); // d(left)=1, d(right)=7
});
