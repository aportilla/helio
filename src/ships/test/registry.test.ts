// Ship-class registry invariants (ship-building plan §4/§9 P1). Runs under
// `node --test` (type-stripping): the `import type` lines are erased, so this loads
// only the node-pure ships modules — no DOM, no catalog. Mirrors
// src/facilities/test/registry.test.ts's frozen-id + color guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIP_CLASS_BY_TYPE,
  SHIP_CLASS_DEFS,
  SHIP_CLASS_TYPES,
  FROZEN_SHIP_CLASS_IDS,
  shipClassLabel,
  shipClassColor,
  buildTurns,
} from '../registry.ts';

test('registry: every def.type is its own map key, no duplicates', () => {
  for (const d of SHIP_CLASS_DEFS) {
    assert.equal(SHIP_CLASS_BY_TYPE.get(d.type), d, `def '${d.type}' is not keyed by its type`);
  }
  assert.equal(SHIP_CLASS_BY_TYPE.size, SHIP_CLASS_DEFS.length, 'a duplicate type key collapsed the map');
});

test('registry: every FROZEN_SHIP_CLASS_ID is still a live type (the localStorage save contract)', () => {
  // FROZEN entries are historical wire strings; the validation set is derived from
  // the live registry, so removing OR renaming a shipped id makes this fail.
  for (const id of FROZEN_SHIP_CLASS_IDS) {
    assert.ok(SHIP_CLASS_TYPES.has(id), `frozen save id '${id}' is no longer a live type — old saves would silently drop`);
  }
});

test('shipClassColor: every class carries a well-formed sRGB hex swatch', () => {
  // The fleet sprite reads this; a malformed color would render NaN in the shader,
  // so pin both the format and the accessor round-trip for every live def.
  for (const d of SHIP_CLASS_DEFS) {
    assert.match(d.color, /^#[0-9a-fA-F]{6}$/, `class '${d.type}' has a malformed color '${d.color}'`);
    assert.equal(shipClassColor(d.type), d.color, `shipClassColor('${d.type}') must resolve to its def color`);
  }
});

test('buildTurns: every class takes a positive integer number of turns', () => {
  // completesOnTurn = startTurn + buildTurns must stay an integer >= startTurn+1,
  // so a class's buildTurns must be a positive integer (decrement-free turn math).
  for (const d of SHIP_CLASS_DEFS) {
    assert.ok(Number.isInteger(d.buildTurns) && d.buildTurns >= 1, `class '${d.type}' buildTurns must be a positive integer`);
    assert.equal(buildTurns(d.type), d.buildTurns, `buildTurns('${d.type}') must resolve to its def value`);
  }
});

test('spriteSizePx: every class carries a positive sprite budget', () => {
  for (const d of SHIP_CLASS_DEFS) {
    assert.ok(d.spriteSizePx > 0, `class '${d.type}' spriteSizePx must be positive`);
  }
});

test('shipClassLabel: resolves a def to its display label', () => {
  assert.equal(shipClassLabel('corvette'), 'Corvette');
});
