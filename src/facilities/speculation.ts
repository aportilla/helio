// The speculative next-turn world — running the *real* Next Turn early on a
// throwaway copy so the system view can show what the economy is ABOUT to do
// (the cargo a new provider will dispatch, the inbound that will relieve a
// deficit) before the player commits the turn. Kept sim-only (no catalog, no
// localStorage, no DOM) so it unit-tests under `node --test` exactly like
// world-sync.ts; economy-bridge.ts owns the live engine and caches the clone.
//
// Correctness rests on the sim being a closed, integer-only, deterministic
// kernel: two Worlds with byte-identical serialization step to byte-identical
// results (proven by sim/test/serialize-replay.ts's continuation test). So a
// clone stepped once produces exactly what the real Next Turn will — PROVIDED
// the caller clones the world the next step will actually advance (i.e. AFTER
// any pending facility edit / tech / kill has reconciled the real world). The
// step logic is reused verbatim; this is the same computation, run early on a
// copy that is never persisted.

import {
  EconomyEngine,
  serialize,
  deserialize,
  type World,
  type WorldSkeleton,
} from '../../sim/src/index.ts';

// Deep-clone `world` via the trusted save round-trip, wrap it in a throwaway
// engine, and step once so its ring holds the would-emit transfers and its read
// digest holds the predicted cover. Returns the stepped clone, or null if the
// round-trip or step throws (transfer-pool exhaustion, a malformed clone) — a
// purely visual prediction must degrade to no-prediction, never abort the turn
// UI. The clone is independent: its own engine, ring, and PRNG instance, so a
// speculative step can never write back into the real world or its save.
//
// The skeleton MUST be the same `{ geometry, resources, cfg }` instance set the
// live world was built/restored against, or deserialize's configHash assert
// throws. `checkInvariants:false` because a DEV invariant tripping on a throwaway
// read must not crash the turn — it degrades to null here.
export function cloneWorldForSpeculation(
  world: World,
  skeleton: WorldSkeleton,
): EconomyEngine | null {
  try {
    const clone = deserialize(skeleton, serialize(world));
    const engine = new EconomyEngine(clone, { checkInvariants: false });
    engine.step();
    return engine;
  } catch {
    return null;
  }
}
