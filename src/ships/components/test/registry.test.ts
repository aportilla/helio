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
  shipWarpRangeMilliLy,
  shipWarpSpeedMilliLyPerTurn,
  warpTravelTurns,
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

test('the small engine grants WARP DRIVE (a root-level system-space jump) but no combat action', () => {
  const engine = COMPONENT_BY_TYPE.get('small-engine')!;
  assert.equal(engine.kind, 'drive');
  const grants = engine.grants ?? [];
  assert.equal(grants.length, 1, 'exactly one grant — the galaxy warp; no flee, no combat verb');
  const warp = grants[0]!;
  assert.deepEqual(
    [warp.key, warp.category, warp.targeting, warp.kind, warp.rootLevel, warp.targetSpace],
    ['warp', 'navigation', 'single', 'immediate', true, 'system'],
  );
  // Movement is energy-inert — the warp grant carries no salvo cost.
  assert.equal(warp.costPerUnit, undefined);
  // Its predicate admits only a galaxy 'system' candidate — so in an encounter (ship/body candidates
  // only) it matches none and the row greys, which IS the "disabled in combat" behavior.
  assert.equal(warp.targets!({ id: 'sys:vega', kind: 'system', allegiance: 'neutral', tags: [] }, { id: 's', commands: [] }), true);
  assert.equal(warp.targets!({ id: 's2', kind: 'ship', allegiance: 'enemy', tags: [] }, { id: 's', commands: [] }), false);
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

test('the small engine carries galaxy warp stats (a drive is what lets a ship leave its system)', () => {
  const engine = COMPONENT_BY_TYPE.get('small-engine')!;
  assert.equal(engine.warpRangeMilliLy, 9_000, 'range = trade reach (pinned by the cross-registry test)');
  assert.equal(engine.warpSpeedMilliLyPerTurn, 3_000);
  // Warp stats are DRIVE-only — a weapon/defense part carries neither.
  assert.equal(COMPONENT_BY_TYPE.get('small-laser')!.warpRangeMilliLy, undefined);
  assert.equal(COMPONENT_BY_TYPE.get('small-shield-generator')!.warpSpeedMilliLyPerTurn, undefined);
});

test('shipWarpRangeMilliLy / shipWarpSpeedMilliLyPerTurn take the MAX over drives (a ceiling, not a sum)', () => {
  // A single drive → its own values.
  assert.equal(shipWarpRangeMilliLy(['small-engine']), 9_000);
  assert.equal(shipWarpSpeedMilliLyPerTurn(['small-engine']), 3_000);
  // Two drives do NOT sum — stacking engines can't buy reach past the authored band (MAX, not Σ).
  assert.equal(shipWarpRangeMilliLy(['small-engine', 'small-engine']), 9_000);
  assert.equal(shipWarpSpeedMilliLyPerTurn(['small-engine', 'small-engine']), 3_000);
  // A driveless loadout can't warp (0 range/speed); unknown-id contributions are 0.
  assert.equal(shipWarpRangeMilliLy(['small-laser', 'small-cannon']), 0);
  assert.equal(shipWarpSpeedMilliLyPerTurn([]), 0);
});

test('warpTravelTurns prices distance into turns: max(1, ceil(dist / speed))', () => {
  const drive: ['small-engine'] = ['small-engine']; // speed 3_000/turn, range 9_000
  // A near hop rounds up to a whole turn; nothing is instant.
  assert.equal(warpTravelTurns(1, drive), 1);
  assert.equal(warpTravelTurns(3_000, drive), 1);
  // Just past a turn's worth rolls to the next turn (ceil).
  assert.equal(warpTravelTurns(3_001, drive), 2);
  // A max-range hop costs a small handful (9_000 / 3_000 = 3), so distance keeps pricing positioning.
  assert.equal(warpTravelTurns(9_000, drive), 3);
  // Monotonic in distance.
  assert.ok(warpTravelTurns(6_000, drive) >= warpTravelTurns(3_000, drive));
  // A driveless loadout (speed 0) never divides by zero — the guarded fallback stays finite.
  assert.ok(Number.isFinite(warpTravelTurns(1_000, [])));
});
