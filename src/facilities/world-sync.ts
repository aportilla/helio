// World reconciliation — the pure mechanics behind "a build/remove must not zero
// the existing economy" (the committed persist-stock model). Kept sim-only (no
// catalog, no localStorage, no DOM) so it unit-tests under `node --test` exactly
// like project.ts; economy-bridge.ts composes these with BODIES, game-state, and
// the save.
//
// The contract: when the set of facilities changes, the projector yields a FRESH
// PlanetSpec[] (new flows, possibly new/removed planets, renumbered PlanetIds).
// We rebuild the World from that projection, then carry the ACCUMULATED live
// state across from the prior World, matched by Body.id — so rates update while
// the larder, smoothing, and hysteresis survive. In-flight cargo is intentionally
// NOT carried (a structural edit is an exogenous event); a plain reload keeps it
// via the bridge's adopt-untouched path instead.

import type { World } from '../../sim/src/index.ts';

// Are two PlanetId→Body.id tables identical (same bodies, same order)? When true,
// a restored save and the current facilities describe the same planets, so the
// bridge can adopt the restored World untouched (full fidelity, in-flight kept)
// rather than rebuild-and-transplant.
export function sameBodyIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Carry accumulated live state from `prev` into the freshly projected `next`,
// matched by Body.id. Only stock and the per-(planet,resource) state the demand
// signal depends on (EMA consumption, the hysteresis ordering flag, the
// starvation counter) cross over; production/consumption/storageCeiling stay as
// the new projection set them, so a facility edit changes rates without resetting
// the economy. A body absent from `prev` (newly built) keeps its projected
// cold-start values. The sim clock and PRNG stream are kept continuous.
export function transplantLiveState(
  next: World,
  nextBodyIds: readonly string[],
  prev: World,
  prevBodyIds: readonly string[],
): void {
  const prevPlanetByBody = new Map<string, number>();
  prevBodyIds.forEach((id, p) => prevPlanetByBody.set(id, p));

  const R = next.R;
  for (let np = 0; np < nextBodyIds.length; np++) {
    const pp = prevPlanetByBody.get(nextBodyIds[np]!);
    if (pp === undefined) continue; // a body new since `prev` → keep its cold start
    for (let r = 0; r < R; r++) {
      const ni = np * R + r;
      const pi = pp * R + r;
      next.stock[ni] = prev.stock[pi]!;
      next.emaConsume[ni] = prev.emaConsume[pi]!;
      next.ordering[ni] = prev.ordering[pi]!;
      next.starveTurns[ni] = prev.starveTurns[pi]!;
    }
  }

  next.turn = prev.turn;
  next.prng.setState(prev.prng.getState());
}
