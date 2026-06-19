// Public barrel for the facilities package. Callers import from '../facilities'
// (or '../../facilities') for the registry + projection surface; never re-export
// raw sim symbols here. The live engine (economy-bridge.ts) is imported directly
// and deliberately kept OUT of this barrel, so light/type-only consumers don't
// drag in its catalog + localStorage dependencies.

export type {
  FacilityType,
  FacilityDef,
  Contribution,
  ProjectionCtx,
  SimStarResolver,
  PlacedFacility,
} from './types.ts';
export { ContributionBuilder, emptyContribution } from './types.ts';

export {
  FACILITY_DEFS,
  FACILITY_BY_TYPE,
  FACILITY_TYPES,
  ADD_ORDER,
  FROZEN_FACILITY_IDS,
  facilityLabel,
} from './registry.ts';

export { addableTypesFor } from './eligibility.ts';

// — Projection seam (live: economy-bridge.ts folds these into the running sim) —
export { EconResource, appResourceTable } from './resource-vocab.ts';
export { projectBody, projectWorld, type ProjectedWorld } from './project.ts';
