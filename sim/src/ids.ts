// Branded integer ids — the dense indices the SoA world is keyed by.
//
// We brand the *identity* types (planet, star, system, resource, edge, turn,
// transfer) because mixing them is a real bug (indexing planet arrays with a
// star id), and they are used as indices, never arithmetic operands, so the
// brand costs nothing at the call sites. Quantities are deliberately NOT
// branded: they are plain integer `number` in milli-units (see constants.ts),
// and the load-bearing path does enough arithmetic on them that a `Milli` brand
// would add re-brand noise without catching real bugs. The integer-ness of
// quantities is enforced by invariants (§3.6), not by the type system.

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type PlanetId = Brand<number, 'PlanetId'>;
export type StarId = Brand<number, 'StarId'>;
export type SystemId = Brand<number, 'SystemId'>;
export type ResourceId = Brand<number, 'ResourceId'>;
/** Stable unordered star-pair id, reused across topology rebuilds (§11 rule 4). */
export type EdgeId = Brand<number, 'EdgeId'>;
export type Turn = Brand<number, 'Turn'>;
/** Monotonic, never recycled — a transfer's identity for the in-transit story. */
export type TransferId = Brand<number, 'TransferId'>;

export const asPlanet = (n: number): PlanetId => n as PlanetId;
export const asStar = (n: number): StarId => n as StarId;
export const asSystem = (n: number): SystemId => n as SystemId;
export const asResource = (n: number): ResourceId => n as ResourceId;
export const asEdge = (n: number): EdgeId => n as EdgeId;
export const asTurn = (n: number): Turn => n as Turn;
export const asTransfer = (n: number): TransferId => n as TransferId;
