// Action registry invariants. Runs under `node --test` (type-stripping): the `import
// type` lines are erased, so this loads only the node-pure actions modules — no DOM, no
// catalog. Mirrors src/factions/test/registry.test.ts's frozen-id + color guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_BY_ID,
  ACTION_DEFS,
  ACTION_TYPES,
  FROZEN_ACTION_IDS,
  PASS_ACTION,
  actionLabel,
  actionColor,
} from '../registry.ts';

test('registry: every def.type is its own map key, no duplicates', () => {
  for (const d of ACTION_DEFS) {
    assert.equal(ACTION_BY_ID.get(d.type), d, `def '${d.type}' is not keyed by its type`);
  }
  assert.equal(ACTION_BY_ID.size, ACTION_DEFS.length, 'a duplicate type key collapsed the map');
});

test('registry: every FROZEN_ACTION_ID is still a live type (the saved-log wire contract)', () => {
  // FROZEN entries are historical wire strings; the validation set is derived from the
  // live registry, so removing OR renaming a shipped id makes this fail.
  for (const id of FROZEN_ACTION_IDS) {
    assert.ok(ACTION_TYPES.has(id), `frozen id '${id}' is no longer a live type — a saved action log would break`);
  }
});

test('actionColor: every action carries a well-formed sRGB hex accent', () => {
  // The menu row reads this; a malformed color would render NaN in a shader, so pin both
  // the format and the accessor round-trip for every live def.
  for (const d of ACTION_DEFS) {
    assert.match(d.color, /^#[0-9a-fA-F]{6}$/, `action '${d.type}' has a malformed color '${d.color}'`);
    assert.equal(actionColor(d.type), d.color, `actionColor('${d.type}') must resolve to its def color`);
  }
});

test('actionLabel: resolves a def to its menu label', () => {
  assert.equal(actionLabel('attack'), 'Attack');
  assert.equal(actionLabel('flee'), 'Flee');
  assert.equal(actionLabel('pass'), 'Pass');
});

test('PASS_ACTION is a live action (the always-present decline verb)', () => {
  assert.ok(ACTION_TYPES.has(PASS_ACTION), 'the injected Pass verb must be a live action id');
});

test('dispatch kinds are coherent: attack enters an encounter, the rest are immediate', () => {
  // The live-view fork — the bones depend on attack carrying an encounter kind so a
  // confirm against an opponent transitions into combat (no separate Engage trigger).
  assert.equal(ACTION_BY_ID.get('attack')?.kind, 'encounter');
  for (const d of ACTION_DEFS) {
    assert.ok(d.kind === 'immediate' || d.kind === 'encounter', `action '${d.type}' has an unknown kind '${d.kind}'`);
  }
});
