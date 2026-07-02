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
  shipEnergyMax,
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

test('the small engine is a drive granting NO action — it only installs the recharge effect', () => {
  const engine = COMPONENT_BY_TYPE.get('small-engine')!;
  assert.equal(engine.kind, 'drive');
  // No flee (an encounter is fought to its terminal, never withdrawn) — the drive grants nothing.
  assert.deepEqual(engine.grants ?? [], []);
  assert.deepEqual(
    engine.installs,
    [{ effectKey: 'recharge', remaining: -1, params: { amount: 3_000 } }],
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

test('the small shield is a defense part granting a self support verb that installs a timed shield on resolve', () => {
  const shield = COMPONENT_BY_TYPE.get('small-shield')!;
  assert.equal(shield.kind, 'defense');
  const grants = shield.grants ?? [];
  assert.equal(grants.length, 1);
  const raise = grants[0]!;
  assert.deepEqual(
    [raise.key, raise.category, raise.targeting, raise.kind],
    ['raise-shields', 'support', 'self', 'immediate'],
  );
  // The grant's resolve installs a timed shield-segment, keyed BY GRANT KEY on the component def (the
  // on-resolve twin of build-time `installs`) — not a field on the neutral ActionGrant.
  assert.deepEqual(
    shield.installsOnResolve?.['raise-shields'],
    [{ effectKey: 'shield-segment', remaining: 3, params: { capacity: 50_000 } }],
  );
});

test('the tactical-command-module is a utility that grants nothing and installs a permanent tactical-command effect', () => {
  const mod = COMPONENT_BY_TYPE.get('tactical-command-module')!;
  assert.equal(mod.kind, 'utility');
  assert.equal(mod.grants, undefined, 'it grants no action — its job is side tempo, not a command');
  // The Press-Turn contribution is a DECLARED effect (the generic substrate), NOT a static `initiative`
  // registry key: it installs a permanent tactical-command whose phaseStart folds a +1 SideDelta.
  assert.deepEqual(mod.installs, [{ effectKey: 'tactical-command', remaining: -1, params: { initiative: 1 } }]);
});

test('shipEnergyMax sums the loadout batteries (the at-rest / charged energy cap)', () => {
  // Σ battery across the modules — the energy-model twin of shipBuildTurns. A weapon/shield carries its
  // own charge; a drive/utility carries none. The full demo kit is laser + cannon + shield-generator at
  // 9_000 each (the engine adds none), so the cap is 27_000.
  assert.equal(shipEnergyMax(['small-laser']), 9_000);
  assert.equal(shipEnergyMax(['small-engine', 'small-laser', 'small-cannon', 'small-shield-generator']), 27_000);
  // A loadout with no battery-bearing module yields 0 (an empty gauge), and unknown-id contributions are 0.
  assert.equal(shipEnergyMax(['small-engine']), 0);
  assert.equal(shipEnergyMax([]), 0);
});

test('componentLabel resolves a def to its display label', () => {
  assert.equal(componentLabel('small-laser'), 'Small Laser');
  assert.equal(componentLabel('small-engine'), 'Small Engine');
});
