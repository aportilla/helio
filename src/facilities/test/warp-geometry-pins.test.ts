// Cross-registry pins for galaxy movement. Two invariants that must hold across independent leaves and
// are enforced by TEST, never a runtime import (each side stays sim-/catalog-free: data ↮ facilities,
// ships ↮ sim). All four modules are node-pure, so this loads under `node --test`.
//
//   1. Movement distance (MILLI_PER_LY, data) is measured on the SAME scale as the sim projection
//      (LY_TO_SIM_UNITS, facilities) — so a ship's reach and the economy's trade reach are like-for-like.
//   2. A drive's warp range equals the economy's single-jump trade reach (REACH_LY) — ONE reachability
//      graph: fleets go exactly where trade can, so the player learns a single adjacency map.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MILLI_PER_LY } from '../../data/cluster-geometry.ts';
import { LY_TO_SIM_UNITS } from '../sim-geometry.ts';
import { REACH_LY } from '../reach.ts';
import { COMPONENT_BY_TYPE } from '../../ships/components/registry.ts';

test('the movement milli-ly scale mirrors the sim projection scale', () => {
  assert.equal(MILLI_PER_LY, LY_TO_SIM_UNITS);
});

test("the small engine's warp range equals the economy's trade reach (one reachability graph)", () => {
  // Retuning one without the other breaks this pin knowingly — a longer-legged military drive is a
  // deliberate divergence, not an accident.
  const engine = COMPONENT_BY_TYPE.get('small-engine')!;
  assert.equal(engine.warpRangeMilliLy, REACH_LY * LY_TO_SIM_UNITS);
});
