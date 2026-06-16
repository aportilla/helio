// Projection seam tests (facility-definitions plan §12) — where the integration
// risk is retired before anything depends on the seam. Runs under `node --test`
// (type-stripping): `import type` is erased, so the DOM-coupled catalog is never
// loaded; only the node-pure facilities modules + the standalone sim.
//
// Fixtures are hand-authored minimal Body objects, never real BODIES rows (which
// would couple the test to procgen output that shifts on a PROCGEN_VERSION bump).

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
import { abundanceMilli, scaleByRichness } from '../abundance.ts';
import { projectBody, projectWorld } from '../project.ts';
import { EconResource, appResourceTable } from '../resource-vocab.ts';
import type { FacilityType, ProjectionCtx } from '../types.ts';

const R = appResourceTable().count;
const ctx: ProjectionCtx = { R, starOf: () => 0 };
const INT32_MAX = 2 ** 31;

// Every field the abundance/contribute paths read, defaulted to "absent" (null),
// with overrides spread on top. Cast through unknown — the test never touches
// the rest of Body.
function makeBody(over: Partial<Body> & { id: string }): Body {
  return {
    kind: 'planet',
    resMetals: null,
    resSilicates: null,
    resVolatiles: null,
    resRareEarths: null,
    resRadioactives: null,
    resExotics: null,
    bioticCarbonAqueous: null,
    bioticSubsurfaceAqueous: null,
    bioticAerial: null,
    bioticCryogenic: null,
    bioticSilicate: null,
    bioticSulfur: null,
    ...over,
  } as unknown as Body;
}

const RICH = makeBody({
  id: 'rich',
  resMetals: 8,
  resSilicates: 7,
  resVolatiles: 6,
  resRareEarths: 5,
  resRadioactives: 4,
  resExotics: 3,
  bioticAerial: 0.5,
});

const MAXED = makeBody({
  id: 'maxed',
  resMetals: 10,
  resSilicates: 10,
  resVolatiles: 10,
  resRareEarths: 10,
  resRadioactives: 10,
  resExotics: 10,
  bioticCarbonAqueous: 1,
  bioticSubsurfaceAqueous: 1,
  bioticAerial: 1,
  bioticCryogenic: 1,
  bioticSilicate: 1,
  bioticSulfur: 1,
});

const BARREN_BELT = makeBody({ id: 'barren', kind: 'belt' });

test('projectBody: a body with no facility is not a sim node', () => {
  assert.equal(projectBody(RICH, [], ctx), null);
});

test('projectBody: a body whose only facility is unknown is not a node (skip-on-missing)', () => {
  // An orphan type (e.g. a retired def dropped from the registry, or a hand-edited
  // save) contributes nothing and never allocates a PlanetId on its own.
  assert.equal(projectBody(RICH, [{ type: 'ghost-type' as unknown as FacilityType }], ctx), null);
});

test('projectBody: colony + mining-base contributions SUM (flows add)', () => {
  const colony = projectBody(RICH, [{ type: 'colony' }], ctx)!;
  const mine = projectBody(RICH, [{ type: 'mining-base' }], ctx)!;
  const both = projectBody(RICH, [{ type: 'colony' }, { type: 'mining-base' }], ctx)!;

  for (let r = 0; r < R; r++) {
    assert.equal(both.production![r], colony.production![r]! + mine.production![r]!, `production[${r}]`);
    assert.equal(both.consumption![r], colony.consumption![r]! + mine.consumption![r]!, `consumption[${r}]`);
    assert.equal(both.stock![r], colony.stock![r]! + mine.stock![r]!, `stock[${r}]`);
  }
});

test('projectBody: facility order does not change the result (commutative sum)', () => {
  const ab = projectBody(RICH, [{ type: 'colony' }, { type: 'mining-base' }], ctx)!;
  const ba = projectBody(RICH, [{ type: 'mining-base' }, { type: 'colony' }], ctx)!;
  assert.deepEqual(ab, ba);
});

test('abundance: null and zero indices floor to exactly 0; tiny biotic floors to 0', () => {
  assert.equal(abundanceMilli(makeBody({ id: 'a', resMetals: null }), EconResource.Alloys), 0);
  assert.equal(abundanceMilli(makeBody({ id: 'b', resMetals: 0 }), EconResource.Alloys), 0);
  // 0.0004 · 1000 = 0.4 → floor → 0 (the single float→int floor in the seam).
  assert.equal(abundanceMilli(makeBody({ id: 'c', bioticAerial: 0.0004 }), EconResource.Food), 0);
  // Energy has no catalog source.
  assert.equal(abundanceMilli(MAXED, EconResource.Energy), 0);
});

test('projectBody: a barren (all-null) belt extracts nothing', () => {
  const mine = projectBody(BARREN_BELT, [{ type: 'mining-base' }], ctx)!;
  for (const res of [
    EconResource.Alloys,
    EconResource.Minerals,
    EconResource.Volatiles,
    EconResource.RareTech,
    EconResource.Exotics,
  ]) {
    assert.equal(mine.production![res], 0, `extracted resource ${res} should be 0 on a barren belt`);
  }
});

test('projectBody: a rich mine actually extracts (richness scales production up)', () => {
  const mine = projectBody(RICH, [{ type: 'mining-base' }], ctx)!;
  assert.ok(mine.production![EconResource.Alloys]! > 0, 'rich metals → positive alloys');
  // Alloys output matches the documented base·richness/unit formula exactly.
  assert.equal(
    mine.production![EconResource.Alloys],
    scaleByRichness(5000, abundanceMilli(RICH, EconResource.Alloys)),
  );
});

test('projectBody: max richness × max base rate stays well inside Int32', () => {
  const spec = projectBody(MAXED, [{ type: 'colony' }, { type: 'mining-base' }], ctx)!;
  for (const arr of [spec.production!, spec.consumption!, spec.stock!, spec.storageCeiling!]) {
    for (const v of arr) {
      assert.ok(Number.isSafeInteger(v), `value ${v} must be an integer`);
      assert.ok(Math.abs(v) < INT32_MAX, `value ${v} must fit Int32`);
    }
  }
});

test('projectBody: storage ceilings COMBINE to uncapped without overflowing (§7.3)', () => {
  const spec = projectBody(MAXED, [{ type: 'colony' }, { type: 'mining-base' }], ctx)!;
  for (let r = 0; r < R; r++) {
    // Two uncapped facilities must yield the sentinel, NOT 2·sentinel = 2^31
    // (which an Int32Array would store as a negative number).
    assert.equal(spec.storageCeiling![r], STORAGE_UNCAPPED, `ceiling[${r}]`);
    assert.ok(spec.storageCeiling![r]! < INT32_MAX, 'ceiling must stay inside Int32');
  }
});

test('projectBody: deterministic — same inputs, byte-identical output', () => {
  const a = projectBody(RICH, [{ type: 'colony' }, { type: 'mining-base' }], ctx);
  const b = projectBody(RICH, [{ type: 'colony' }, { type: 'mining-base' }], ctx);
  assert.deepEqual(a, b);
});

test('projectWorld: follows the bodies-argument order (not Map order), skipping empty bodies', () => {
  const empty = makeBody({ id: 'empty' });
  const bodies = [empty, RICH, BARREN_BELT];
  // Map insertion order is deliberately the REVERSE of bodies order — the result
  // must follow the bodies array, not the map, or replay/PRNG would diverge.
  const facs = new Map([
    [BARREN_BELT.id, [{ type: 'mining-base' as const }]],
    [RICH.id, [{ type: 'colony' as const }]],
  ]);
  const out = projectWorld(bodies, facs, () => 0);

  assert.equal(out.planets.length, 2, 'the facility-less body is skipped');
  assert.deepEqual([...out.bodyIdByPlanet], [RICH.id, BARREN_BELT.id]);
});

test('projectWorld: deterministic across runs', () => {
  const bodies = [RICH, MAXED];
  const facs = new Map([
    [RICH.id, [{ type: 'colony' as const }]],
    [MAXED.id, [{ type: 'mining-base' as const }]],
  ]);
  const a = projectWorld(bodies, facs, (b) => bodies.indexOf(b));
  const b = projectWorld(bodies, facs, (bd) => bodies.indexOf(bd));
  assert.deepEqual(a, b);
});

test('integration: projectWorld output is accepted by makeWorld; the sim steps with invariants on', () => {
  const bodies = [MAXED, RICH]; // MAXED mines, RICH (biotic) colonizes
  const facs = new Map([
    [MAXED.id, [{ type: 'mining-base' as const }]],
    [RICH.id, [{ type: 'colony' as const }]],
  ]);
  const starIdx = new Map(bodies.map((b, i) => [b.id, i] as const));
  const { planets, bodyIdByPlanet } = projectWorld(bodies, facs, (b) => starIdx.get(b.id)!);

  // One geometry node per projected body, near enough to route food between them.
  const geometry = makeGeometry(bodies.map((_, i) => [i * 30, 0, 0] as const));
  const world = makeWorld({
    geometry,
    resources: appResourceTable(),
    cfg: defaultBalance({ jumpRadius: 50, maxLegTurns: 5, horizonH: 8 }),
    seed: 1,
    planets,
  });
  const engine = new EconomyEngine(world, { checkInvariants: true });

  // Each step asserts conservation, no-negative-stock, and ledger consistency;
  // surviving several turns proves the projected spec is valid and conserved.
  for (let i = 0; i < 8; i++) engine.step();

  assert.equal(planets.length, 2);
  assert.deepEqual([...bodyIdByPlanet], [MAXED.id, RICH.id]);
});
