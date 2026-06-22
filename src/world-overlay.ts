// The reusable shape for MUTABLE per-body state overlaid on the immutable catalog.
//
// The catalog (STARS/BODIES/STAR_CLUSTERS) is a frozen, regenerated snapshot — it
// is never a save. Anything the player changes about a body (today: placed
// facilities; later: ownership, explored/visibility, a renamed body, depleted
// deposits) lives in a separate overlay keyed by the STABLE `Body.id`, NOT a
// volatile array index, so a catalog rebuild (PROCGEN_VERSION bump / CSV id
// change) can't silently misattribute it.
//
// Two primitives every such overlay needs are factored here so the next mutable
// concern reuses them instead of re-deriving a flat list + filter:
//   - skip-on-missing load (drop records whose body the rebuilt catalog dropped)
//   - by-body lookup
// A new overlay is then "a versioned list of BodyKeyed records": persist it under
// storage.slotKey(name), parse it with the same validate-and-merge shape as
// game-state-codec, prune it with pruneMissingBodies, read it with recordsOnBody.
// (A concern keyed on a different stable anchor — e.g. a ship's SYSTEM rather than a
// body — reuses the validate-and-merge SHAPE but supplies its own prune; see the
// ship handling in game-state-codec.)

// Anything carrying a stable catalog Body.id it overlays state onto.
export interface BodyKeyed {
  readonly bodyId: string;
}

// Skip-on-missing: keep only records whose body the catalog still contains.
// `bodyExists` is injected (typically `(id) => indexOfBodyId(id) >= 0`) so this
// stays a pure, node-testable function with no catalog coupling.
export function pruneMissingBodies<T extends BodyKeyed>(
  records: readonly T[],
  bodyExists: (bodyId: string) => boolean,
): T[] {
  return records.filter((r) => bodyExists(r.bodyId));
}

// All overlay records sitting on a given body, in their stored order.
export function recordsOnBody<T extends BodyKeyed>(records: readonly T[], bodyId: string): readonly T[] {
  return records.filter((r) => r.bodyId === bodyId);
}
