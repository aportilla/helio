// The economic vocabulary bridge. The sim owns the ResourceTable *type* and its
// validating constructor; the app owns the *instance* — the correct side of the
// standalone wall (plan §8). This module + project.ts are the facilities
// package's window onto the sim.
//
// EconResource is a const-object + derived union (the erasableSyntaxOnly idiom
// the sim's resources.ts uses, since `enum` is banned). Its ordinals ARE the
// ResourceTable row indices: makeResourceTable() asserts meta.id === index, so a
// drift between this list's order and the table below fails loudly at startup.
//
// These ids are app-internal and NEVER serialized into 'helio.game' (that save
// holds facility types, not resources), so the roster is freely re-mappable.

import { makeResourceTable, TransportTier, type ResourceTable } from '../../sim/src/index.ts';

export const EconResource = {
  Food: 0,
  Alloys: 1,
  Minerals: 2,
  Volatiles: 3,
  RareTech: 4,
  Exotics: 5,
  Energy: 6,
} as const;
export type EconResource = (typeof EconResource)[keyof typeof EconResource];

// Built once per call; callers (the future engine-bridge, the projector for its
// resource count, tests) cache as they see fit. Row order MUST match the
// EconResource ordinals above — makeResourceTable enforces it.
export function appResourceTable(): ResourceTable {
  return makeResourceTable([
    { id: EconResource.Food, name: 'Food', tier: TransportTier.Transportable, criticality: 100, transferChunkMilli: 1 },
    { id: EconResource.Alloys, name: 'Alloys', tier: TransportTier.Transportable, criticality: 60, transferChunkMilli: 1 },
    { id: EconResource.Minerals, name: 'Minerals', tier: TransportTier.Transportable, criticality: 55, transferChunkMilli: 1 },
    { id: EconResource.Volatiles, name: 'Volatiles', tier: TransportTier.Transportable, criticality: 50, transferChunkMilli: 1 },
    // Strategic, lumpy: coarse transfer chunks + high criticality.
    { id: EconResource.RareTech, name: 'RareTech', tier: TransportTier.Transportable, criticality: 80, transferChunkMilli: 1000 },
    { id: EconResource.Exotics, name: 'Exotics', tier: TransportTier.Transportable, criticality: 85, transferChunkMilli: 1000 },
    // LocalOnly: consumed where it's made, never shipped.
    { id: EconResource.Energy, name: 'Energy', tier: TransportTier.LocalOnly, criticality: 90, transferChunkMilli: 1 },
  ]);
}
