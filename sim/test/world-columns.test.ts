// Guards the World column partition: every per-(planet, resource) column must be
// categorized as ACCUMULATOR (carried across a facility edit) or PROJECTION
// (re-derived). Reflection-based, so adding a column to World without a partition
// entry fails HERE — turning a future silent "build resets this column" into a
// red test. The carry itself (World.copyAccumulators) iterates ACCUMULATOR_COLUMNS,
// so once a column is categorized the right behavior follows automatically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, ACCUMULATOR_COLUMNS, PROJECTION_COLUMNS } from '../src/world.ts';
import { makeGeometry } from '../src/geometry.ts';
import { defaultResourceTable } from '../src/resources.ts';
import { defaultBalance } from '../src/constants.ts';

test('every per-(planet,resource) World column is partitioned into accumulator|projection', () => {
  const resources = defaultResourceTable();
  const R = resources.count;                // 4
  const P = 3;                              // P*R = 12, distinct from P, R, and the per-planet column length
  const geometry = makeGeometry([[0, 0, 0], [10, 0, 0], [0, 10, 0]] as const);
  const cfg = defaultBalance({ jumpRadius: 100 });
  const world = makeWorld({
    geometry, resources, cfg, seed: 1,
    planets: [{ star: 0 }, { star: 1 }, { star: 2 }],
  });

  // A per-(planet,resource) column is an own typed-array field of length P*R
  // (per-planet columns like `star`/`tombstone` are length P; nested arrays on
  // geometry/ring/ledger are not own fields of the World instance).
  const perPR = new Set<string>();
  for (const [key, val] of Object.entries(world)) {
    if (ArrayBuffer.isView(val) && (val as Int32Array).length === P * R) perPR.add(key);
  }

  const partitioned = new Set<string>([...ACCUMULATOR_COLUMNS, ...PROJECTION_COLUMNS]);

  for (const col of perPR) {
    assert.ok(
      partitioned.has(col),
      `World.${col} is a per-(planet,resource) column with no ACCUMULATOR/PROJECTION entry — categorize it in world.ts`,
    );
  }
  for (const col of partitioned) {
    assert.ok(perPR.has(col), `'${col}' is partitioned but is not a per-(planet,resource) World column`);
  }
  // The two lists must be disjoint — a column can't be both carried and re-derived.
  for (const col of ACCUMULATOR_COLUMNS) {
    assert.ok(!(PROJECTION_COLUMNS as readonly string[]).includes(col), `${col} is in both partition lists`);
  }
});
