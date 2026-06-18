// Public surface of the standalone economy sim. The game wires to this barrel
// when the sim is integrated; until then it is exercised only by sim/test.

export { EconomyEngine } from './engine.ts';
export type { TurnReport, EngineOptions } from './engine.ts';

export type { LocalTransfer } from './dispatch.ts';

export { makeWorld, World, STORAGE_UNCAPPED } from './world.ts';
export type { WorldSpec, PlanetSpec } from './world.ts';

export { makeGeometry, starDistance, systemOfStar } from './geometry.ts';
export type { StarGeometry } from './geometry.ts';

export { makeResourceTable, defaultResourceTable, TransportTier } from './resources.ts';
export type { ResourceMeta, ResourceTable } from './resources.ts';

export { defaultBalance, emaStep, MILLI_PER_UNIT, SCHEMA_VERSION } from './constants.ts';
export type { BalanceConfig } from './constants.ts';

export { Topology } from './topology.ts';
export type { Route } from './topology.ts';

export { TransferRing, EtaBuckets } from './transfer-ring.ts';
export type { TransferView, MintArgs } from './transfer-ring.ts';

export { Prng } from './prng.ts';
export { isqrt, ceilDiv, clampInt, floorToGranularity } from './math.ts';

export { ShortfallReason, SHORTFALL_FIX, shortfallName } from './shortfall.ts';
export { ThrottleReason } from './produce.ts';

export { serialize, deserialize, configHash } from './serialize.ts';
export type { WorldSkeleton } from './serialize.ts';

export { buildReadDigest, getInTransitTo, explainShortfall } from './read-surface.ts';
export type {
  ReadDigest, PlanetRead, ResourceRead, EdgeFlowRead, Delivery, ShortfallRecord,
} from './read-surface.ts';

export {
  asPlanet, asStar, asSystem, asResource, asEdge, asTurn, asTransfer,
} from './ids.ts';
export type { PlanetId, StarId, SystemId, ResourceId, EdgeId, Turn, TransferId, Brand } from './ids.ts';
