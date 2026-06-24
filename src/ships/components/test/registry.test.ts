// Ship-component registry invariants (modular-components plan §3.4, Phase 2). Runs under
// `node --test` (type-stripping): the `import type` lines are erased, so this loads only the
// node-pure component modules — no DOM, no catalog, no sim. Mirrors src/ships/test/registry.test.ts
// and src/facilities/test/registry.test.ts's frozen-id + def-keying guards, plus the grant shapes
// the action menu derives from each component.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIP_COMPONENT_DEFS,
  COMPONENT_BY_TYPE,
  SHIP_COMPONENT_TYPES,
  FROZEN_COMPONENT_IDS,
  componentLabel,
} from '../registry.ts';
import type { TargetCandidate } from '../../../actions/types.ts';

test('registry: every def.type is its own map key, no duplicates', () => {
  for (const d of SHIP_COMPONENT_DEFS) {
    assert.equal(COMPONENT_BY_TYPE.get(d.type), d, `def '${d.type}' is not keyed by its type`);
  }
  assert.equal(COMPONENT_BY_TYPE.size, SHIP_COMPONENT_DEFS.length, 'a duplicate type key collapsed the map');
});

test('registry: every FROZEN_COMPONENT_ID is still a live type (the save / action-id contract)', () => {
  // FROZEN entries are historical wire strings; the validation set is derived from the live
  // registry, so removing OR renaming a shipped id makes this fail — and a renamed id would also
  // orphan the action ids derived from it.
  for (const id of FROZEN_COMPONENT_IDS) {
    assert.ok(SHIP_COMPONENT_TYPES.has(id), `frozen id '${id}' is no longer a live type — old saves / action ids would break`);
  }
});

test('every grant carries a well-formed sRGB hex accent', () => {
  // The menu row reads grant.color; a malformed hex would render NaN in the painter, so pin the
  // format on every grant a component declares.
  for (const d of SHIP_COMPONENT_DEFS) {
    for (const g of d.grants ?? []) {
      assert.match(g.color, /^#[0-9a-fA-F]{6}$/, `component '${d.type}' grant '${g.key}' has a malformed color '${g.color}'`);
    }
  }
});

test('the small engine is a drive granting an immediate self-targeted flee (D9)', () => {
  const engine = COMPONENT_BY_TYPE.get('small-engine')!;
  assert.equal(engine.kind, 'drive');
  const grants = engine.grants ?? [];
  assert.equal(grants.length, 1);
  const flee = grants[0]!;
  assert.deepEqual(
    [flee.key, flee.category, flee.targeting, flee.kind],
    ['flee', 'navigation', 'self', 'immediate'],
  );
});

test('the small laser is a weapon granting an enemy-only encounter attack', () => {
  const laser = COMPONENT_BY_TYPE.get('small-laser')!;
  assert.equal(laser.kind, 'weapon');
  const grants = laser.grants ?? [];
  assert.equal(grants.length, 1);
  const beam = grants[0]!;
  assert.deepEqual(
    [beam.key, beam.category, beam.targeting, beam.kind],
    ['laser', 'attack', 'single', 'encounter'],
  );
  // The enemy-only predicate keeps the bracket on opposing ships/bodies (mirrors the body weapons).
  const enemy = { id: 's', kind: 'ship', allegiance: 'enemy', tags: [] } satisfies TargetCandidate;
  const ally = { id: 's', kind: 'ship', allegiance: 'ally', tags: [] } satisfies TargetCandidate;
  const actor = { id: 'self', commands: [] };
  assert.equal(beam.targets!(enemy, actor), true, 'an enemy is a valid laser target');
  assert.equal(beam.targets!(ally, actor), false, 'an ally is not');
});

test('componentLabel resolves a def to its display label', () => {
  assert.equal(componentLabel('small-laser'), 'Small Laser');
  assert.equal(componentLabel('small-engine'), 'Small Engine');
});
