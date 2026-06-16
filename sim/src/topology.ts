// Topology / reach (§3, §6, P1) — the jump graph plus multi-leg pathfinding.
//
// Reach is *graph connectivity*, never a stored flag (§11 rule 5): a destination
// is reachable iff a chain of legal legs exists to it. Jump-range and speed tech
// edit the graph's edges and per-leg cost; there is no edge capacity (§6).
//
// Two stability commitments the rest of the sim leans on:
//   • EdgeId is one stable id per unordered star-pair, reused across rebuilds
//     (§11 rule 4) — route caches and the edge-flow read key on it.
//   • The route TABLE is append-only and never deleted, because in-flight
//     transfers hold a routeRef into it (§3.7). A topology rebuild invalidates
//     the per-version *caches* (which route is current for a pair), never the
//     table entries an in-flight transfer still points at.

import { clampInt, ceilDiv } from './math.ts';
import { starDistance } from './geometry.ts';
import type { StarGeometry } from './geometry.ts';
import { asEdge, asStar } from './ids.ts';
import type { StarId, EdgeId } from './ids.ts';
import type { BalanceConfig } from './constants.ts';

/** A fully-resolved multi-leg route. hops has one more entry than legTurns /
 *  edgeIds. A same-system route is a single 1-turn self-leg (hops [S,S]). */
export interface Route {
  readonly hops: readonly StarId[];
  readonly legTurns: readonly number[];
  readonly edgeIds: readonly EdgeId[];
  readonly totalTurns: number;
}

interface Adj {
  readonly to: StarId;
  readonly legTurns: number;
  readonly edge: EdgeId;
}

interface ShortestTree {
  readonly dist: number[]; // turns to dstStar, Infinity if unreachable
  readonly succ: Int32Array; // next hop toward dstStar, -1 if none
}

export class Topology {
  readonly geometry: StarGeometry;
  private cfg: BalanceConfig;
  private readonly n: number;
  private adj: Adj[][] = [];
  /** Bumped on every rebuild; per-version caches key on it to self-invalidate. */
  version = 0;

  // Append-only route table (serialized; transfers hold indices into it).
  private readonly routes: Route[] = [];
  private readonly routeIntern = new Map<string, number>(); // hopKey -> routeRef

  // Per-version derived caches (cleared on rebuild).
  private treeCache = new Map<number, ShortestTree>(); // dstStar -> tree
  private pairCache = new Map<number, number>(); // pairKey -> routeRef

  constructor(geometry: StarGeometry, cfg: BalanceConfig) {
    this.geometry = geometry;
    this.cfg = cfg;
    this.n = geometry.starCount;
    this.rebuild(cfg);
  }

  /** (Re)build adjacency from geometry + the current config, bumping version and
   *  clearing per-version caches. Route-table entries are preserved (§3.7). */
  rebuild(cfg: BalanceConfig): void {
    this.cfg = cfg;
    this.version++;
    this.treeCache = new Map();
    this.pairCache = new Map();
    const adj: Adj[][] = Array.from({ length: this.n }, () => []);
    for (let a = 0; a < this.n; a++) {
      for (let b = a + 1; b < this.n; b++) {
        const d = starDistance(this.geometry, asStar(a), asStar(b));
        if (d > cfg.jumpRadius) continue;
        const turns = this.legTurnsForDist(d);
        const e = this.edgeId(asStar(a), asStar(b));
        adj[a]!.push({ to: asStar(b), legTurns: turns, edge: e });
        adj[b]!.push({ to: asStar(a), legTurns: turns, edge: e });
      }
    }
    // Sort each adjacency by neighbor id for deterministic relaxation order.
    for (const list of adj) list.sort((p, q) => (p.to as number) - (q.to as number));
    this.adj = adj;
  }

  /** Stable unordered star-pair id: a·N + b with a ≤ b. Survives rebuilds
   *  because star indices are static. A self-pair (S,S) encodes the local leg. */
  edgeId(a: StarId, b: StarId): EdgeId {
    const lo = Math.min(a as number, b as number);
    const hi = Math.max(a as number, b as number);
    return asEdge(lo * this.n + hi);
  }

  /** Turns for a leg of absolute distance d: 1 at d=0, up to maxLegTurns at the
   *  jump limit; speed tech subtracts turns, floored at 1 (§6, rule 7). */
  private legTurnsForDist(d: number): number {
    const base = Math.max(1, ceilDiv(d * this.cfg.maxLegTurns, Math.max(1, this.cfg.jumpRadius)));
    return clampInt(base - this.cfg.travelSpeedTier, 1, this.cfg.maxLegTurns);
  }

  legTurns(a: StarId, b: StarId): number {
    return this.legTurnsForDist(starDistance(this.geometry, a, b));
  }

  /** Is there a direct legal leg between two stars right now? Used by the
   *  arrival rule to detect an "onward path removed" re-route trigger (§3.7). */
  edgeExists(a: StarId, b: StarId): boolean {
    if ((a as number) === (b as number)) return true; // self-leg always legal
    for (const e of this.adj[a as number]!) if ((e.to as number) === (b as number)) return true;
    return false;
  }

  /** Dijkstra from dstStar over the star graph, deterministic on ties (prefer
   *  the lower-id next hop), cached per (dstStar, version). */
  private shortestTo(dstStar: StarId): ShortestTree {
    const key = dstStar as number;
    const hit = this.treeCache.get(key);
    if (hit) return hit;
    const dist = new Array<number>(this.n).fill(Infinity);
    const succ = new Int32Array(this.n).fill(-1);
    const settled = new Uint8Array(this.n);
    dist[key] = 0;
    for (let iter = 0; iter < this.n; iter++) {
      // O(V) pick of the nearest unsettled node (deterministic id tie-break).
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < this.n; i++) {
        if (!settled[i] && dist[i]! < best) { best = dist[i]!; u = i; }
      }
      if (u < 0) break;
      settled[u] = 1;
      for (const e of this.adj[u]!) {
        const w = e.to as number;
        if (settled[w]) continue;
        const nd = dist[u]! + e.legTurns;
        if (nd < dist[w]! || (nd === dist[w]! && u < succ[w]!)) {
          dist[w] = nd;
          succ[w] = u; // u is one hop closer to dst than w
        }
      }
    }
    const tree: ShortestTree = { dist, succ };
    this.treeCache.set(key, tree);
    return tree;
  }

  /** Shortest total turns from srcStar to dstStar, or Infinity if unreachable. */
  reachTurns(srcStar: StarId, dstStar: StarId): number {
    if ((srcStar as number) === (dstStar as number)) return 1; // local self-leg
    return this.shortestTo(dstStar).dist[srcStar as number]!;
  }

  /** Per-star turn distances FROM `fromStar` (Infinity = unreachable), cached per
   *  version. The graph is undirected, so this is shortestTo(fromStar).dist.
   *  Used to scope the Unreachable-vs-SourceExhausted shortfall split (§5). */
  reachDistancesFrom(fromStar: StarId): readonly number[] {
    return this.shortestTo(fromStar).dist;
  }

  /** The current cheapest route between two stars, or null if unreachable.
   *  Returns a stable routeRef into the append-only table; the *which-route*
   *  binding is cached per version. (§11 rule 5: reachable ≡ this is non-null.) */
  routeBetween(srcStar: StarId, dstStar: StarId): { routeRef: number; route: Route } | null {
    const pk = (srcStar as number) * this.n + (dstStar as number);
    const cached = this.pairCache.get(pk);
    if (cached !== undefined) return { routeRef: cached, route: this.routes[cached]! };

    let route: Route | null;
    if ((srcStar as number) === (dstStar as number)) {
      route = {
        hops: [srcStar, dstStar],
        legTurns: [this.legTurnsForDist(0)],
        edgeIds: [this.edgeId(srcStar, dstStar)],
        totalTurns: this.legTurnsForDist(0),
      };
    } else {
      const tree = this.shortestTo(dstStar);
      if (!Number.isFinite(tree.dist[srcStar as number]!)) return null;
      const hops: StarId[] = [srcStar];
      const legTurns: number[] = [];
      const edgeIds: EdgeId[] = [];
      let cur = srcStar as number;
      let guard = 0;
      while (cur !== (dstStar as number)) {
        const nxt = tree.succ[cur]!;
        if (nxt < 0 || guard++ > this.n) return null; // disconnected / cycle guard
        hops.push(asStar(nxt));
        legTurns.push(this.legTurns(asStar(cur), asStar(nxt)));
        edgeIds.push(this.edgeId(asStar(cur), asStar(nxt)));
        cur = nxt;
      }
      route = { hops, legTurns, edgeIds, totalTurns: legTurns.reduce((s, t) => s + t, 0) };
    }

    const routeRef = this.intern(route);
    this.pairCache.set(pk, routeRef);
    return { routeRef, route };
  }

  /** Intern a route into the append-only table, returning a stable ref. The key
   *  includes leg costs, not just the hop sequence: a topology rebuild can
   *  re-cost the same hops (speed tech changes legTurns), and an in-flight
   *  transfer's routeRef must keep pointing at the route it was dispatched with,
   *  so a re-costed route gets its OWN entry rather than colliding with the
   *  stale one (§3.7). The table stays append-only, so old refs remain valid. */
  private intern(route: Route): number {
    const k = route.hops.map((h) => h as number).join(',') + '|' + route.legTurns.join(',');
    const existing = this.routeIntern.get(k);
    if (existing !== undefined) return existing;
    const ref = this.routes.length;
    this.routes.push(route);
    this.routeIntern.set(k, ref);
    return ref;
  }

  getRoute(routeRef: number): Route {
    const r = this.routes[routeRef];
    if (!r) throw new Error(`topology: no route at ref ${routeRef}`);
    return r;
  }

  /** Snapshot the route table for serialization (§9). */
  exportRoutes(): readonly Route[] {
    return this.routes;
  }

  /** Restore a serialized route table (replaces the append-only table). */
  importRoutes(routes: readonly Route[]): void {
    this.routes.length = 0;
    this.routeIntern.clear();
    for (const r of routes) this.intern(r);
  }
}
