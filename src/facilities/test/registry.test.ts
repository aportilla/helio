// Registry + eligibility invariants (facility-definitions plan §11/§12). Runs
// under `node --test` (type-stripping): the `import type` lines are erased, so
// this never loads the DOM-coupled catalog — only the node-pure facilities
// modules. Fixtures are hand-authored minimal Body objects, never real BODIES
// rows (which would couple the test to procgen output).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Body } from '../../data/stars.ts';
import type { FacilityType } from '../types.ts';
import {
  ADD_ORDER,
  FACILITY_BY_TYPE,
  FACILITY_DEFS,
  FACILITY_TYPES,
  FROZEN_FACILITY_IDS,
  facilityLabel,
} from '../registry.ts';
import { addableTypesFor } from '../eligibility.ts';

// The fields the v1 predicates read (kind + resource indices), all "absent" by
// default. Cast through unknown — the test never exercises the rest of Body.
const body = (kind: Body['kind'], over: Partial<Body> = {}): Body =>
  ({
    kind,
    resMetals: null,
    resSilicates: null,
    resVolatiles: null,
    resRareEarths: null,
    resRadioactives: null,
    resExotics: null,
    ...over,
  }) as unknown as Body;
// A solid site with something worth mining (a non-null strategic index).
const richBody = (kind: Body['kind']): Body => body(kind, { resMetals: 8 });

test('registry: every def.type is its own map key, no duplicates', () => {
  for (const d of FACILITY_DEFS) {
    assert.equal(FACILITY_BY_TYPE.get(d.type), d, `def '${d.type}' is not keyed by its type`);
  }
  assert.equal(FACILITY_BY_TYPE.size, FACILITY_DEFS.length, 'a duplicate type key collapsed the map');
});

test('registry: every FROZEN_FACILITY_ID is still a live type (the localStorage save contract)', () => {
  // FROZEN entries are historical wire strings; the validation set is derived from
  // the live registry, so removing OR renaming a shipped id makes this fail.
  for (const id of FROZEN_FACILITY_IDS) {
    assert.ok(FACILITY_TYPES.has(id), `frozen save id '${id}' is no longer a live type — old saves would silently drop`);
  }
});

test('registry: ADD_ORDER is addOrder-sorted and excludes retired defs', () => {
  const orders = ADD_ORDER.map((t) => FACILITY_BY_TYPE.get(t)!.addOrder);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'ADD_ORDER is not sorted by addOrder');
  for (const t of ADD_ORDER) {
    assert.ok(!FACILITY_BY_TYPE.get(t)!.retired, `retired type '${t}' must not appear in ADD_ORDER`);
  }
});

test('facilityLabel: resolves a def to its display label', () => {
  assert.equal(facilityLabel('colony'), 'Colony');
  assert.equal(facilityLabel('mining-base'), 'Mining base');
});

test('eligibility: a colony fits any solid site; a mining base needs extractable richness', () => {
  for (const kind of ['planet', 'moon', 'belt'] as const) {
    // Barren: colony only — mining-base is richness-gated (plan §10).
    assert.deepEqual(addableTypesFor(body(kind), []), ['colony'], `barren ${kind} → colony only`);
    // With strategic richness present: both, in ADD_ORDER order.
    assert.deepEqual(addableTypesFor(richBody(kind), []), [...ADD_ORDER], `rich ${kind} → all types`);
  }
  // A ring hosts nothing regardless of richness (not a solid extraction site).
  assert.deepEqual(addableTypesFor(body('ring'), []), [], 'barren ring hosts nothing');
  assert.deepEqual(addableTypesFor(richBody('ring'), []), [], 'rich ring still hosts nothing');
});

test('eligibility: a type already at its per-body cap drops out of the addable set', () => {
  const current: { type: FacilityType }[] = [{ type: 'colony' }];
  const addable = addableTypesFor(richBody('planet'), current);
  assert.ok(!addable.includes('colony'), 'colony is at maxPerBody=1, so not re-addable');
  assert.ok(addable.includes('mining-base'), 'mining-base is unaffected by a colony placement');
});
