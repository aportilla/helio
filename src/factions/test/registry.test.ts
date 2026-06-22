// Faction registry invariants. Runs under `node --test` (type-stripping): the
// `import type` lines are erased, so this loads only the node-pure factions modules —
// no DOM, no catalog. Mirrors src/ships/test/registry.test.ts's frozen-id + color
// guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACTION_BY_ID,
  FACTION_DEFS,
  FACTION_TYPES,
  FROZEN_FACTION_IDS,
  CONTROLLED_FACTION_ID,
  factionLabel,
  factionColor,
} from '../registry.ts';

test('registry: every def.id is its own map key, no duplicates', () => {
  for (const d of FACTION_DEFS) {
    assert.equal(FACTION_BY_ID.get(d.id), d, `def '${d.id}' is not keyed by its id`);
  }
  assert.equal(FACTION_BY_ID.size, FACTION_DEFS.length, 'a duplicate id key collapsed the map');
});

test('registry: every FROZEN_FACTION_ID is still a live type (the localStorage save contract)', () => {
  // FROZEN entries are historical wire strings; the validation set is derived from
  // the live registry, so removing OR renaming a shipped id makes this fail.
  for (const id of FROZEN_FACTION_IDS) {
    assert.ok(FACTION_TYPES.has(id), `frozen save id '${id}' is no longer a live type — old saves would silently default`);
  }
});

test('factionColor: every faction carries a well-formed sRGB hex swatch', () => {
  // The fleet sprite reads this; a malformed color would render NaN in the shader,
  // so pin both the format and the accessor round-trip for every live def.
  for (const d of FACTION_DEFS) {
    assert.match(d.color, /^#[0-9a-fA-F]{6}$/, `faction '${d.id}' has a malformed color '${d.color}'`);
    assert.equal(factionColor(d.id), d.color, `factionColor('${d.id}') must resolve to its def color`);
  }
});

test('factionLabel: resolves a def to its display label', () => {
  assert.equal(factionLabel('player'), 'Player');
  assert.equal(factionLabel('rival'), 'Rival');
});

test('CONTROLLED_FACTION_ID is a live faction (the "my side" pointer + legacy default)', () => {
  assert.ok(FACTION_TYPES.has(CONTROLLED_FACTION_ID), 'the controlled faction must be a live type');
});
