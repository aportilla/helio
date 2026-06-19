// P6 — allocation (§5). A deterministic greedy priority auction that READS the
// quantified emissions, returns a PURE plan, and mutates nothing but the
// per-(planet, resource) starvation counters (escalation history). All mutation
// of stock / ledger / ring happens later, at the single dispatch chokepoint (P7).
//
// Mechanisms that keep the pass honest (§5): source fair-share (the only
// contended capacity — transport is uncapped), starvation escalation
// (anti-livelock), and frozen-snapshot scores (computed before the loop, never
// mutated mid-pass). Fan-out falls out of the shared `avail` working copy; fan-in
// from a demand drawing across its ranked candidate sources. Candidates are filled
// in distance-group order — a nearer tie-group is exhausted before a farther one —
// but WITHIN a tie-group the demand is split in proportion to each source's
// capacity, so equal-distance providers share a load rather than the lowest-index
// one being drained first (the 0-turn intra-cluster pool is the common tie).

import { TransportTier } from './resources.ts';
import { ShortfallReason } from './shortfall.ts';
import { asPlanet, asResource } from './ids.ts';
import type { PlanetId, ResourceId } from './ids.ts';
import type { World } from './world.ts';
import type { Quantified } from './quantify.ts';
import type { Route } from './topology.ts';

export interface DispatchOrder {
  readonly src: PlanetId;
  readonly dst: PlanetId;
  readonly res: ResourceId;
  readonly qty: number;
  readonly routeRef: number;
  readonly firstLegArrival: number;
  readonly finalArrival: number;
}

export interface DispatchPlan {
  readonly orders: readonly DispatchOrder[];
  /** Binding shortfall reason per unserved demand, keyed by pr index (p·R + r). */
  readonly reasons: ReadonlyMap<number, ShortfallReason>;
}

interface Candidate {
  readonly src: PlanetId;
  readonly routeRef: number;
  readonly route: Route;
  readonly totalTurns: number;
}

interface Demand {
  readonly p: PlanetId;
  readonly r: ResourceId;
  readonly i: number; // pr index
  readonly amount: number;
  readonly score: number;
  cands: Candidate[];
}

const CRIT_BAND = 100000; // criticality dominates; deficit depth breaks ties within a band

export function allocate(world: World, q: Quantified): DispatchPlan {
  const R = world.R;
  const cfg = world.cfg;
  const orders: DispatchOrder[] = [];
  const reasons = new Map<number, ShortfallReason>();

  // Build the open-demand list with FROZEN integer scores (§5).
  const demands: Demand[] = [];
  for (let p = 0; p < world.planetCount; p++) {
    if (world.tombstone[p]) continue;
    for (let r = 0; r < R; r++) {
      if (world.resources.metas[r]!.tier !== TransportTier.Transportable) continue;
      const i = p * R + r;
      const nd = q.netDemand[i]!;
      if (nd <= 0) continue;
      const bands = Math.floor(world.starveTurns[i]! / cfg.starveEscalationTurns);
      const effCrit = world.resources.metas[r]!.criticality + bands * cfg.starveBoost;
      const score = effCrit * CRIT_BAND + Math.min(nd, CRIT_BAND - 1);
      demands.push({ p: asPlanet(p), r: asResource(r), i, amount: nd, score, cands: [] });
    }
  }
  // A real total order: score desc, then resourceId asc, then sinkPlanetId asc.
  demands.sort((a, b) =>
    b.score - a.score || (a.r as number) - (b.r as number) || (a.p as number) - (b.p as number));

  // PASS A — gather ranked candidate sources per demand; tally per-source contention.
  const contenders = new Int32Array(world.planetCount * R);
  for (const d of demands) {
    d.cands = rankCandidates(world, d.p, d.r, cfg.fanInK, q.exportable);
    for (const c of d.cands) contenders[(c.src as number) * R + (d.r as number)]!++;
  }

  // PASS B — fill against a working copy; never over-commit a source.
  const avail = q.exportable.slice();
  const alreadyShed = new Int32Array(world.planetCount * R); // CFL accumulator this turn

  for (const d of demands) {
    let remaining = d.amount;
    let cflBound = false;

    // Walk candidates in DISTANCE-GROUP order (cands are pre-sorted by totalTurns
    // then src). A nearer group is fully drawn before a farther one — the distance
    // heuristic is untouched — but WITHIN a group every source is equidistant, so
    // the demand is split across them in PROPORTION TO CAPACITY rather than draining
    // the lowest-index source dry first. The 0-turn intra-cluster pool is just the
    // most common tie; this handles every equal-distance set the same way (§5).
    let gi = 0;
    while (gi < d.cands.length && remaining > 0) {
      const dist = d.cands[gi]!.totalTurns;
      let gj = gi + 1;
      while (gj < d.cands.length && d.cands[gj]!.totalTurns === dist) gj++;

      // Each tied source's capacity for THIS demand: the working `avail`, the
      // cross-sink fair share of its ORIGINAL exportable (so contending sinks get
      // fair slices, not a compounding fraction of leftovers), and the CFL outflow
      // cap — whichever is smallest. cflBound flags a source CFL bit strictly first:
      // the shortfall blame if the demand ends unmet (else it's contention).
      const caps = new Array<number>(gj - gi);
      let sumCap = 0;
      for (let k = gi; k < gj; k++) {
        const srcI = (d.cands[k]!.src as number) * R + (d.r as number);
        const a = avail[srcI]!;
        const fsSrc = Math.floor(q.exportable[srcI]! / Math.max(1, contenders[srcI]!));
        // CFL bounds outflow to a fraction of OFFERED CAPACITY (exportable), not
        // resting stock — a demand-pull faucet rests at stock≈0, so a stock-based
        // CFL would clamp every faucet to 0 outflow and deadlock the economy. With
        // the shipped default (cflNum==cflDen) the clamp is inert; this is the
        // correct basis for the throughput-throttle intent when it is tuned on.
        const cfl = Math.max(0, Math.floor(q.exportable[srcI]! * cfg.cflNum / cfg.cflDen) - alreadyShed[srcI]!);
        if (cfl < a && cfl < fsSrc) cflBound = true;
        const cap = Math.max(0, Math.min(a, fsSrc, cfl));
        caps[k - gi] = cap;
        sumCap += cap;
      }

      if (sumCap > 0) {
        const take = Math.min(remaining, sumCap);
        // Proportional split by CUMULATIVE rounding: source k ships the rise in
        // floor(take · Σcaps[0..k] / sumCap). The cumulative form sums EXACTLY to
        // `take`, never hands a source more than its cap, and needs no remainder
        // pass — and it's deterministic in the frozen candidate order. A bigger
        // capacity (a higher per-turn faucet rating) draws a proportionally bigger
        // share of the demand.
        let cumCap = 0;
        let cumAlloc = 0;
        for (let k = gi; k < gj; k++) {
          cumCap += caps[k - gi]!;
          const target = Math.floor((take * cumCap) / sumCap);
          const qty = target - cumAlloc;
          cumAlloc = target;
          if (qty <= 0) continue;
          const c = d.cands[k]!;
          const srcI = (c.src as number) * R + (d.r as number);
          const route = c.route;
          orders.push({
            src: c.src, dst: d.p, res: d.r, qty,
            routeRef: c.routeRef,
            firstLegArrival: world.turn + route.legTurns[0]!,
            finalArrival: world.turn + route.totalTurns,
          });
          avail[srcI] = avail[srcI]! - qty;
          alreadyShed[srcI] = alreadyShed[srcI]! + qty;
        }
        remaining -= take;
      }

      gi = gj;
    }

    if (remaining > 0) {
      // Demand left unmet → a real shortfall (reach / production / contention).
      reasons.set(d.i, resolveReason(world, d, cflBound));
      world.starveTurns[d.i] = world.starveTurns[d.i]! + 1;
    } else {
      world.starveTurns[d.i] = 0;
    }
  }

  return { orders, reasons };
}

/** Sources that reach (p, r) with surplus, cheapest-latency-first, capped at K
 *  (§5: rankCandidates + fan-in breadth). Reachability is route existence
 *  (§11 rule 5) — never a stored flag. */
function rankCandidates(
  world: World, p: PlanetId, r: ResourceId, k: number, exportable: Int32Array,
): Candidate[] {
  const R = world.R;
  const dstStar = world.starOf(p);
  const cands: Candidate[] = [];
  for (let q = 0; q < world.planetCount; q++) {
    if (q === (p as number) || world.tombstone[q]) continue;
    if (exportable[q * R + (r as number)]! <= 0) continue;
    const srcStar = world.starOf(asPlanet(q));
    const rb = world.topology.routeBetween(srcStar, dstStar);
    if (!rb) continue;
    cands.push({ src: asPlanet(q), routeRef: rb.routeRef, route: rb.route, totalTurns: rb.route.totalTurns });
  }
  cands.sort((a, b) => a.totalTurns - b.totalTurns || (a.src as number) - (b.src as number));
  return cands.length > k ? cands.slice(0, k) : cands;
}

function resolveReason(world: World, d: Demand, cflBound: boolean): ShortfallReason {
  if (d.cands.length === 0) {
    // No source is BOTH reachable from p AND holding surplus. Split by the
    // LOCALLY-ACTIONABLE lever (reach-scoped, not a galaxy-wide surplus sum):
    //   • p has reachable peers but none have surplus → SourceExhausted (build production in reach).
    //   • p is isolated (no reachable peer) → Unreachable (extend reach / bridge the gap).
    return hasReachablePeer(world, d.p) ? ShortfallReason.SourceExhausted : ShortfallReason.Unreachable;
  }
  if (cflBound) return ShortfallReason.SourceCflLimited;
  // drainedOrContended or a tie: a reachable source existed but lost the auction.
  return ShortfallReason.OutbidByPriority;
}

/** Does any living planet other than p have a route to p? (reach-scoped split
 *  for Unreachable vs SourceExhausted — §5). Uses one cached Dijkstra from p. */
function hasReachablePeer(world: World, p: PlanetId): boolean {
  const dist = world.topology.reachDistancesFrom(world.starOf(p));
  for (let q = 0; q < world.planetCount; q++) {
    if (q === (p as number) || world.tombstone[q]) continue;
    if (Number.isFinite(dist[world.star[q]!]!)) return true;
  }
  return false;
}
