// Geometry adapter tests — the single float→int crossing for transport geometry.
// Node-pure: imports only the adapter (which imports only the sim), never the
// catalog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeometry, LY_TO_SIM_UNITS } from '../sim-geometry.ts';

test('buildGeometry: scales light-years to integer sim units, rounding', () => {
  const g = buildGeometry([
    { x: 1.2345, y: -2.5, z: 0 },
    { x: 0, y: 0, z: 10 },
  ]);
  assert.equal(g.starCount, 2);
  assert.equal(g.x[0], Math.round(1.2345 * LY_TO_SIM_UNITS));
  assert.equal(g.y[0], -2.5 * LY_TO_SIM_UNITS);
  assert.equal(g.z[0], 0);
  assert.equal(g.z[1], 10 * LY_TO_SIM_UNITS);
});

test('buildGeometry: every coordinate is an integer (makeGeometry would throw otherwise)', () => {
  const g = buildGeometry([{ x: 3.14159, y: 2.71828, z: -1.41421 }]);
  assert.ok(Number.isInteger(g.x[0]!));
  assert.ok(Number.isInteger(g.y[0]!));
  assert.ok(Number.isInteger(g.z[0]!));
});

test('buildGeometry: preserves caller order (geometry index === input index)', () => {
  const coords = [
    { x: 5, y: 0, z: 0 },
    { x: 0, y: 7, z: 0 },
    { x: 0, y: 0, z: 9 },
  ];
  const g = buildGeometry(coords);
  coords.forEach((c, i) => {
    assert.equal(g.x[i], c.x * LY_TO_SIM_UNITS);
    assert.equal(g.y[i], c.y * LY_TO_SIM_UNITS);
    assert.equal(g.z[i], c.z * LY_TO_SIM_UNITS);
  });
});
