// The economic vocabulary bridge. The sim owns the ResourceTable *type* and its
// validating constructor; the app owns the *instance* — the correct side of the
// standalone wall. This module imports the sim; the package README
// lists which modules here reach it.
//
// EconResource is a const-object + derived union (the erasableSyntaxOnly idiom
// the sim's resources.ts uses, since `enum` is banned). Its ordinals ARE the
// ResourceTable row indices: makeResourceTable() asserts meta.id === index, so a
// drift between this list's order and the table below fails loudly at startup.
//
// These ids are app-internal and NEVER serialized into 'helio.game' (that save
// holds facility types, not resources), so the roster is freely re-mappable.

import { makeResourceTable, TransportTier, type ResourceTable } from '../../sim/src/index.ts';

// The v1 roster, deliberately minimal: just the two goods the base facilities
// move. Farms make Food, mines make Minerals, colonies eat both. More resources
// (and a general resource granularity) are a later, additive change.
export const EconResource = {
  Food: 0,
  Minerals: 1,
} as const;
export type EconResource = (typeof EconResource)[keyof typeof EconResource];

// Built once per call; callers (the engine-bridge, the projector for its resource
// count, tests) cache as they see fit. Row order MUST match the EconResource
// ordinals above — makeResourceTable enforces it. Food outranks Minerals on
// criticality so the matcher feeds people before tooling under contention.
export function appResourceTable(): ResourceTable {
  return makeResourceTable([
    { id: EconResource.Food, name: 'Food', tier: TransportTier.Transportable, criticality: 100 },
    { id: EconResource.Minerals, name: 'Minerals', tier: TransportTier.Transportable, criticality: 60 },
  ]);
}
