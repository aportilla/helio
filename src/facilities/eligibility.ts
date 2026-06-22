// addableTypesFor — the one function both the panel and the scene ask "which
// Add buttons does this body get?". Eligibility depends on BOTH the body's
// physics (each def's canBuildOn predicate) AND what's already placed (the
// per-(body, type) build cap). The `current` parameter is in the signature from
// the start so caps — and future "requires an existing X" prerequisites — land
// without a signature change (plan §10).

import type { Body } from '../data/stars.ts';
import type { FacilityType, PlacedFacility } from './types.ts';
import { ADD_ORDER, FACILITY_BY_TYPE } from './registry.ts';

// Buildable types for `body`, given what's already on it, in Add-button order.
// A type appears iff its predicate accepts the body AND the body is below the
// type's per-body cap. Retired types never appear (ADD_ORDER already drops them).
export function addableTypesFor(
  body: Body,
  current: readonly PlacedFacility[],
): FacilityType[] {
  const counts = new Map<FacilityType, number>();
  for (const f of current) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);

  return ADD_ORDER.filter((t) => {
    const def = FACILITY_BY_TYPE.get(t);
    if (!def || !def.canBuildOn(body)) return false;
    return (counts.get(t) ?? 0) < def.maxPerBody;
  });
}

// Whether any placed facility lets this body build ships — the gate for the
// Build-Ship affordance. Asks the registry (the capability flag), never an inline
// `type === 'shipyard'`, so it stays in lockstep with the defs (mirrors addableTypesFor).
export function facilityHasShipbuilding(current: readonly PlacedFacility[]): boolean {
  return current.some((f) => FACILITY_BY_TYPE.get(f.type)?.enablesShipbuilding === true);
}
