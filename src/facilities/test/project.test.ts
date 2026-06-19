// Projection seam tests (facility-definitions plan §12) — where the integration
// risk is retired before anything depends on the seam. Runs under `node --test`
// (type-stripping): `import type` is erased, so the DOM-coupled catalog is never
// loaded; only the node-pure facilities modules + the standalone sim.
//
// Fixtures are hand-authored minimal Body objects, never real BODIES rows (which
// would couple the test to procgen output that shifts on a PROCGEN_VERSION bump).
// The v1 facilities read NO body physics, so a body needs only an id + kind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EconomyEngine,
  STORAGE_UNCAPPED,
  defaultBalance,
  makeGeometry,
  makeWorld,
} from '../../../sim/src/index.ts';
import type { Body } from '../../data/stars.ts';
import { projectBody, projectWorld } from '../project.ts';
import { EconResource, appResourceTable } from '../resource-vocab.ts';
import {
  COLONY_FOOD_CONSUME_MILLI,
  COLONY_MINERALS_CONSUME_MILLI,
  FARM_FOOD_PRODUCE_MILLI,
  FARM_MINERALS_CONSUME_MILLI,
  MINE_FOOD_CONSUME_MILLI,
  MINE_MINERALS_PRODUCE_MILLI,
} from '../tuning.ts';
import type { FacilityType, ProjectionCtx } from '../types.ts';

const FOOD = EconResource.Food;
const MIN = EconResource.Minerals;
const R = appResourceTable().count;
const ctx: ProjectionCtx = { R, starOf: () => 0 };
const INT32_MAX = 2 ** 31;

// A minimal body: just id + kind. Nothing else is read by the v1 projection.
function makeBody(over: Partial<Body> & { id: string }): Body {
  return { kind: 'planet', ...over } as unknown as Body;
}
const PLANET = makeBody({ id: 'p' });
const BELT = makeBody({ id: 'b', kind: 'belt' });

const sum = (a: readonly number[]) => a.reduce((s, x) => s + x, 0);

test('projectBody: a body with no facility is not a sim node', () => {
  assert.equal(projectBody(PLANET, [], ctx), null);
});

test('projectBody: a body whose only facility is unknown is not a node (skip-on-missing)', () => {
  assert.equal(projectBody(PLANET, [{ type: 'ghost-type' as unknown as FacilityType }], ctx), null);
});

test('projectBody: a colony is a flat consumer of food + minerals, producing nothing', () => {
  const c = projectBody(PLANET, [{ type: 'colony' }], ctx)!;
  assert.equal(c.consumption![FOOD], COLONY_FOOD_CONSUME_MILLI);
  assert.equal(c.consumption![MIN], COLONY_MINERALS_CONSUME_MILLI);
  assert.equal(sum(c.production!), 0, 'a colony produces nothing');
});

test('projectBody: a mining base is a faucet making flat minerals (uncapped), eats a little food', () => {
  const m = projectBody(PLANET, [{ type: 'mining-base' }], ctx)!;
  assert.equal(m.production![MIN], MINE_MINERALS_PRODUCE_MILLI);
  assert.equal(m.production![FOOD], 0, 'a mine makes no food');
  assert.equal(m.consumption![FOOD], MINE_FOOD_CONSUME_MILLI);
  // Demand-pull: a producer imposes NO storage ceiling — it mints on pull and holds
  // nothing, so its minerals column is uncapped like every other.
  assert.equal(m.storageCeiling![MIN], STORAGE_UNCAPPED, 'a faucet sets no silo (uncapped)');
  assert.equal(m.storageCeiling![FOOD], STORAGE_UNCAPPED, 'imported food stays uncapped');
});

test('projectBody: a farm is a faucet making flat food (uncapped), draws a little minerals', () => {
  const f = projectBody(PLANET, [{ type: 'farm' }], ctx)!;
  assert.equal(f.production![FOOD], FARM_FOOD_PRODUCE_MILLI);
  assert.equal(f.production![MIN], 0, 'a farm makes no minerals');
  assert.equal(f.consumption![MIN], FARM_MINERALS_CONSUME_MILLI);
  assert.equal(f.storageCeiling![FOOD], STORAGE_UNCAPPED, 'a faucet sets no silo (uncapped)');
  assert.equal(f.storageCeiling![MIN], STORAGE_UNCAPPED, 'imported minerals stay uncapped');
});

test('projectBody: emissions ignore body physics — a planet and a belt project identically', () => {
  // No body dynamics: the same facility on wildly different bodies emits the same.
  for (const type of ['colony', 'mining-base', 'farm'] as const) {
    const onPlanet = projectBody(PLANET, [{ type }], ctx)!;
    const onBelt = projectBody(BELT, [{ type }], ctx)!;
    assert.deepEqual(onPlanet, onBelt, `${type}: flat across bodies`);
  }
});

test('projectBody: contributions SUM (flows add) when a body hosts several facilities', () => {
  const farm = projectBody(PLANET, [{ type: 'farm' }], ctx)!;
  const mine = projectBody(PLANET, [{ type: 'mining-base' }], ctx)!;
  const both = projectBody(PLANET, [{ type: 'farm' }, { type: 'mining-base' }], ctx)!;
  for (let r = 0; r < R; r++) {
    assert.equal(both.production![r], farm.production![r]! + mine.production![r]!, `production[${r}]`);
    assert.equal(both.consumption![r], farm.consumption![r]! + mine.consumption![r]!, `consumption[${r}]`);
  }
});

test('projectBody: facility order does not change the result (commutative sum)', () => {
  const ab = projectBody(PLANET, [{ type: 'colony' }, { type: 'mining-base' }], ctx)!;
  const ba = projectBody(PLANET, [{ type: 'mining-base' }, { type: 'colony' }], ctx)!;
  assert.deepEqual(ab, ba);
});

test('projectBody: two uncapped facilities combine to one uncapped sentinel (no Int32 overflow)', () => {
  // Under demand-pull no v1 facility caps, so colony + mine are both uncapped:
  // combineCeiling must return the sentinel, NOT sum two sentinels into a negative
  // Int32 (§7.3 — the overflow guard that keeps the future warehouse-cap lever safe).
  const spec = projectBody(PLANET, [{ type: 'colony' }, { type: 'mining-base' }], ctx)!;
  for (let r = 0; r < R; r++) {
    assert.equal(spec.storageCeiling![r], STORAGE_UNCAPPED, `ceiling[${r}] uncapped`);
    assert.ok(spec.storageCeiling![r]! < INT32_MAX, 'ceiling stays inside Int32');
  }
});

test('projectBody: every projected value is a safe integer well inside Int32', () => {
  const spec = projectBody(PLANET, [{ type: 'colony' }, { type: 'mining-base' }, { type: 'farm' }], ctx)!;
  for (const arr of [spec.production!, spec.consumption!, spec.stock!, spec.storageCeiling!]) {
    for (const v of arr) {
      assert.ok(Number.isSafeInteger(v), `value ${v} must be an integer`);
      assert.ok(Math.abs(v) < INT32_MAX, `value ${v} must fit Int32`);
    }
  }
});

test('projectBody: deterministic — same inputs, byte-identical output', () => {
  const a = projectBody(PLANET, [{ type: 'colony' }, { type: 'farm' }], ctx);
  const b = projectBody(PLANET, [{ type: 'colony' }, { type: 'farm' }], ctx);
  assert.deepEqual(a, b);
});

test('projectWorld: follows the bodies-argument order (not Map order), skipping empty bodies', () => {
  const empty = makeBody({ id: 'empty' });
  const bodies = [empty, PLANET, BELT];
  // Map insertion order is deliberately the REVERSE of bodies order — the result
  // must follow the bodies array, not the map, or replay/PRNG would diverge.
  const facs = new Map([
    [BELT.id, [{ type: 'mining-base' as const }]],
    [PLANET.id, [{ type: 'colony' as const }]],
  ]);
  const out = projectWorld(bodies, facs, () => 0);
  assert.equal(out.planets.length, 2, 'the facility-less body is skipped');
  assert.deepEqual([...out.bodyIdByPlanet], [PLANET.id, BELT.id]);
});

test('projectWorld: deterministic across runs', () => {
  const bodies = [PLANET, BELT];
  const facs = new Map([
    [PLANET.id, [{ type: 'farm' as const }]],
    [BELT.id, [{ type: 'mining-base' as const }]],
  ]);
  const a = projectWorld(bodies, facs, (b) => bodies.indexOf(b));
  const b = projectWorld(bodies, facs, (bd) => bodies.indexOf(bd));
  assert.deepEqual(a, b);
});

test('integration: farm + mine + colony step in the sim with invariants on (two-way cargo)', () => {
  // Farm grows food, mine digs minerals, colony eats both → cargo flows both ways.
  const bodies = [makeBody({ id: 'farm' }), makeBody({ id: 'mine', kind: 'belt' }), makeBody({ id: 'town' })];
  const facs = new Map([
    [bodies[0]!.id, [{ type: 'farm' as const }]],
    [bodies[1]!.id, [{ type: 'mining-base' as const }]],
    [bodies[2]!.id, [{ type: 'colony' as const }]],
  ]);
  const starIdx = new Map(bodies.map((b, i) => [b.id, i] as const));
  const { planets, bodyIdByPlanet } = projectWorld(bodies, facs, (b) => starIdx.get(b.id)!);

  const geometry = makeGeometry(bodies.map((_, i) => [i * 30, 0, 0] as const));
  const world = makeWorld({
    geometry,
    resources: appResourceTable(),
    cfg: defaultBalance({ jumpRadius: 50, maxLegTurns: 5, horizonH: 8 }),
    seed: 1,
    planets,
  });
  const engine = new EconomyEngine(world, { checkInvariants: true });
  // Each step asserts conservation, no-negative-stock, and ledger consistency.
  for (let i = 0; i < 8; i++) engine.step();

  assert.equal(planets.length, 3);
  assert.deepEqual([...bodyIdByPlanet], [bodies[0]!.id, bodies[1]!.id, bodies[2]!.id]);
});
