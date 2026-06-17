// Public barrel for the facilities package. Callers import from '../facilities'
// (or '../../facilities'); the internal module layout stays private. The sim is
// reached only through project.ts + resource-vocab.ts — never re-export raw sim
// symbols here.

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
export { abundanceMilli, scaleByRichness } from './abundance.ts';
export { projectBody, projectWorld, type ProjectedWorld } from './project.ts';
