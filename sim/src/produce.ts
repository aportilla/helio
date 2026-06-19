// P3 — produce + consume (§8). Demand-pull (make-to-order): a producer is a
// FAUCET, not a tank. The only production minted here is the SELF-FEED — a body
// makes exactly what it eats of its own output, in place, before consuming. The
// off-body export is realized later at the dispatch chokepoint (P7 Pass 0), sized
// by what the matcher actually pulls — so a producer with no consumer makes
// nothing and holds nothing (no silo, no glut). Multi-input fixed-ratio recipes
// are a later contributor rule (§6.0); the conservation equality (§3.6) holds for
// either.
//
// Self-feed is settled HERE (not via the matcher) because `rankCandidates`
// provably excludes a body as its own source (allocate.ts: `q === p` is skipped) —
// a same-body sink genuinely cannot be matched, so its ration must be reserved
// before quantify reads stock.
//
// The EMA tracks *attempted* consumption (the colony's appetite), not realized
// (stock-limited) consumption — otherwise a famine would shrink the setpoint and
// the colony would order less and never recover (a livelock the matcher's
// starvation escalation also guards, §5).

import { emaStep } from './constants.ts';
import type { World } from './world.ts';

export interface ProduceResult {
  /** Σ of the same-body self-feed minted this turn (the local half of `produced`;
   *  the off-body half is `DispatchResult.producedMinted`, born at P7). */
  readonly producedLocalTotal: number;
  readonly consumed: number;
  /** Per-(planet, resource) self-feed minted this turn — the local component of
   *  realized production for the read surface (utilization %). */
  readonly producedLocal: Int32Array;
  /** Per-(planet, resource) consumption actually served this turn (stock-clamped)
   *  — the numerator of the read surface's fill % (§ rate-display). */
  readonly realizedConsumption: Int32Array;
}

export function produceConsume(world: World): ProduceResult {
  const R = world.R;
  let producedLocalTotal = 0;
  let consumed = 0;
  const producedLocal = new Int32Array(world.planetCount * R);
  const realizedConsumption = new Int32Array(world.planetCount * R);

  for (let p = 0; p < world.planetCount; p++) {
    if (world.tombstone[p]) continue;
    for (let r = 0; r < R; r++) {
      const i = p * R + r;
      const prod = world.production[i]!;
      const cons = world.consumption[i]!;

      // SELF-FEED: a body mints exactly what it eats of the same resource, in
      // place — never a silo, never the allocator. This is the one production the
      // faucet makes unconditionally; the export surplus is minted on pull at P7.
      const localProd = prod < cons ? prod : cons; // min(prod, cons), integer
      if (localProd > 0) {
        world.stock[i] = world.stock[i]! + localProd;
        producedLocal[i] = localProd;
        producedLocalTotal += localProd;
      }

      // CONSUME from the larder (self-feed + any carried/inbound stock), clamped —
      // a starving colony eats only what it has.
      if (cons > 0) {
        const realized = Math.min(cons, world.stock[i]!);
        world.stock[i] = world.stock[i]! - realized;
        consumed += realized;
        realizedConsumption[i] = realized;
      }

      // EMA of attempted consumption (constant in v1, but trend-ready).
      world.emaConsume[i] = emaStep(world.emaConsume[i]!, cons, world.cfg);
    }
  }

  return { producedLocalTotal, consumed, producedLocal, realizedConsumption };
}

/** P7.5 — residual consume (§ same-turn intra-cluster consumption). After dispatch
 *  (P7) has deposited this turn's instant intra-cluster cargo straight into
 *  destination stock, top each body's consumption up to its static rate from the
 *  freshly-landed stock. P3 consume ran before P7, so an import-fed body that was
 *  starved then (stock 0) ate 0 even though its same-system supply lands this turn;
 *  this pass lets it eat that supply the SAME turn it arrives, rather than waiting
 *  for next turn's P3.
 *
 *  Mints NOTHING (self-feed was settled at P3) and touches NEITHER emaConsume (the
 *  attempted-appetite EMA is finalized at P3, not re-fed) NOR the ledger/ring. Its
 *  only mutation is `stock[i] -= take`, where take ≤ stock[i] and take ≤ the
 *  unmet appetite — so realized never exceeds the static rate (fill% stays ≤ 100%),
 *  stock never goes negative, and conservation holds by adding `extraConsumed` to
 *  the turn's `consumed` (the same stock is eaten one turn sooner, never created).
 *  Integer-only and iterated in the fixed (p·R + r) order, so replay stays
 *  bit-stable. Returns the folded per-(planet,resource) realized consumption (P3 +
 *  this top-up) for the read surface, plus the scalar delta for the tally. */
export function consumeResidual(
  world: World, alreadyRealized: Int32Array,
): { extraConsumed: number; realizedConsumption: Int32Array } {
  const R = world.R;
  const realizedConsumption = alreadyRealized.slice();
  let extraConsumed = 0;

  for (let p = 0; p < world.planetCount; p++) {
    if (world.tombstone[p]) continue;
    for (let r = 0; r < R; r++) {
      const i = p * R + r;
      const residual = world.consumption[i]! - realizedConsumption[i]!;
      if (residual <= 0) continue; // already fully fed at P3
      const take = Math.min(residual, world.stock[i]!);
      if (take <= 0) continue; // nothing landed since P3 to top up with
      world.stock[i] = world.stock[i]! - take;
      realizedConsumption[i] = realizedConsumption[i]! + take;
      extraConsumed += take;
    }
  }

  return { extraConsumed, realizedConsumption };
}
