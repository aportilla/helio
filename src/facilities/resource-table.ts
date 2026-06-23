// The runtime resource TABLE — the sim-built instance of the economic vocabulary. Split from
// resource-vocab.ts (the sim-free EconResource const) so importing the vocabulary doesn't drag the
// standalone sim: THIS is the only module here that reaches the sim for the table, and only the
// economy engine (the projector, the bridge) imports it. The package README lists the sim-reaching
// modules.
//
// Row order MUST match the EconResource ordinals — makeResourceTable asserts meta.id === index, so
// a drift between the vocabulary's order and the rows below fails loudly at startup. Food outranks
// Minerals on criticality so the matcher feeds people before tooling under contention.

import { makeResourceTable, TransportTier, type ResourceTable } from '../../sim/src/index.ts';
import { EconResource } from './resource-vocab.ts';

// Built once per call; callers (the engine-bridge, the projector for its resource count, tests)
// cache as they see fit.
export function appResourceTable(): ResourceTable {
  return makeResourceTable([
    { id: EconResource.Food, name: 'Food', tier: TransportTier.Transportable, criticality: 100 },
    { id: EconResource.Minerals, name: 'Minerals', tier: TransportTier.Transportable, criticality: 60 },
  ]);
}
