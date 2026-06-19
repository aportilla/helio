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

// The only field the v1 eligibility predicate reads is `kind` (a structural gate,
// no body physics). Cast through unknown — the test never touches the rest of Body.
const body = (kind: Body['kind']): Body => ({ kind }) as unknown as Body;

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
  assert.equal(facilityLabel('farm'), 'Farm');
});

test('eligibility: every facility fits any solid site; a ring hosts nothing', () => {
  for (const kind of ['planet', 'moon', 'belt'] as const) {
    // No body-physics gate any more: every type is addable on any solid site.
    assert.deepEqual(addableTypesFor(body(kind), []), [...ADD_ORDER], `${kind} → all types`);
  }
  // A ring is not a solid site, so it hosts nothing.
  assert.deepEqual(addableTypesFor(body('ring'), []), [], 'ring hosts nothing');
});

test('eligibility: a type already at its per-body cap drops out of the addable set', () => {
  const current: { type: FacilityType }[] = [{ type: 'colony' }];
  const addable = addableTypesFor(body('planet'), current);
  assert.ok(!addable.includes('colony'), 'colony is at maxPerBody=1, so not re-addable');
  assert.ok(addable.includes('mining-base'), 'mining-base is unaffected by a colony placement');
  assert.ok(addable.includes('farm'), 'farm is unaffected too');
});
