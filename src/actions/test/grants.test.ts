// Every SHIPPED action grant is well-formed — the universal sweep the pre-inversion ACTION_DEFS
// color + kind checks used to provide, restored over the DERIVED grants now that there is no
// central registry. It walks every grant declared inline on a provider — each FacilityDef (body
// side) AND each ShipComponentDef (ship side) — so a malformed color, an out-of-vocabulary kind, or
// a colon-bearing key on ANY shipped grant fails CI, not just the few spot-checked ones. Both
// registries are sim-free (their definitions need only the action vocab + EconResource ids, not the
// sim-built table), so this runs in the actions suite without loading the economy core.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACILITY_DEFS, FACILITY_BY_TYPE } from '../../facilities/registry.ts';
import type { FacilityType } from '../../facilities/types.ts';
import { SHIP_COMPONENT_DEFS } from '../../ships/components/registry.ts';
import { grantKeyOf } from '../derive.ts';

const facilityGrants = FACILITY_DEFS.flatMap((d) => (d.grants ?? []).map((grant) => ({ provider: d.type, grant })));
const componentGrants = SHIP_COMPONENT_DEFS.flatMap((d) => (d.grants ?? []).map((grant) => ({ provider: d.type, grant })));
const allGrants = [...facilityGrants, ...componentGrants];

test('there is at least one shipped grant to sweep (the test is wired up)', () => {
  assert.ok(allGrants.length >= 6, `expected the facility grants + the ship component grants, got ${allGrants.length}`);
});

test('every shipped grant carries a well-formed sRGB hex accent', () => {
  // A malformed color would render NaN in the menu-row / bracket shader (ColorManagement is OFF).
  for (const { provider, grant } of allGrants) {
    assert.match(grant.color, /^#[0-9a-fA-F]{6}$/, `${provider}:${grant.key} has a malformed color '${grant.color}'`);
  }
});

test('every shipped grant has a coherent dispatch kind (immediate | encounter)', () => {
  // `kind` is the field the live-view dispatch forks on; a garbage value is rejected by tsc, but
  // this pins the SEMANTIC choice universally so a silent flip fails CI.
  for (const { provider, grant } of allGrants) {
    assert.ok(grant.kind === 'immediate' || grant.kind === 'encounter', `${provider}:${grant.key} has an unknown kind '${grant.kind}'`);
  }
});

test('grant keys are colon-free, so the composed id round-trips through grantKeyOf', () => {
  // grantKeyOf splits on the LAST colon; a key containing one would misroute the effect handler.
  for (const { provider, grant } of allGrants) {
    assert.ok(!grant.key.includes(':'), `grant key '${grant.key}' on ${provider} must not contain a colon`);
    assert.equal(grantKeyOf(`${provider}:${grant.key}`), grant.key);
  }
});

test('the body weapons enter an encounter; the service verbs resolve immediately', () => {
  const kindOf = (type: FacilityType) => FACILITY_BY_TYPE.get(type)?.grants?.[0]?.kind;
  assert.equal(kindOf('railgun-battery'), 'encounter');
  assert.equal(kindOf('missile-battery'), 'encounter');
  assert.equal(kindOf('shipyard'), 'immediate');
  assert.equal(kindOf('sensor-network'), 'immediate');
});
