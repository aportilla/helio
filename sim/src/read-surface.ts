// §4 — the read surface. A thin integer per-turn snapshot plus two drill-down
// queries. This is the SIMULATION layer's only legibility obligation: every
// system's state and every shortfall is readable this turn, in integers, with no
// visualization (§4.3, deferred). The surface is a strict sink — nothing a
// consumer derives from it ever re-enters the sim (§4.1).
//
// The spine is signed cover per (planet, resource), from the SAME math the
// matcher allocated against (§4.2). Per-system or galaxy summaries are derived
// at read time by a consumer — never stored (no SystemEconState, the
// composition-over-taxonomy discipline).

import { systemOfStar } from './geometry.ts';
import { TransportTier } from './resources.ts';
import { ShortfallReason, SHORTFALL_FIX } from './shortfall.ts';
import { ThrottleReason } from './produce.ts';
import { asPlanet, asResource } from './ids.ts';
import type { PlanetId, ResourceId, SystemId, EdgeId } from './ids.ts';
import type { World } from './world.ts';
import type { Quantified } from './quantify.ts';

export interface ResourceRead {
  readonly coverMilli: number; // signed: + surplus / − deficit
  readonly netDemandMilli: number;
  readonly exportableMilli: number;
  readonly inboundWithinHMilli: number;
  readonly shortfall: ShortfallReason | null;
  readonly throttle: ThrottleReason; // OutputFull = glutted provider (§6)
}

export interface PlanetRead {
  readonly planet: PlanetId;
  readonly system: SystemId;
  readonly byResource: ReadonlyMap<ResourceId, ResourceRead>; // non-zero entries only
}

export interface EdgeFlowRead {
  readonly edge: EdgeId;
  readonly fromSystem: SystemId;
  readonly toSystem: SystemId;
  readonly resource: ResourceId;
  readonly unitsMilli: number;
  readonly through: boolean; // relay traffic — neither sourced nor sunk here
}

export interface ReadDigest {
  readonly turn: number;
  readonly planets: ReadonlyMap<PlanetId, PlanetRead>;
  readonly edgeFlows: readonly EdgeFlowRead[];
}

/** A single in-flight delivery toward (planet, resource) — the in-transit story. */
export interface Delivery {
  readonly sourcePlanet: PlanetId;
  readonly qtyMilli: number;
  readonly currentStar: number;
  readonly finalArrival: number;
  readonly turnsRemaining: number;
}

export interface ShortfallRecord {
  readonly reason: ShortfallReason;
  readonly fix: string;
}

export function buildReadDigest(
  world: World, q: Quantified, reasons: ReadonlyMap<number, ShortfallReason>, throttle: Int8Array,
): ReadDigest {
  const R = world.R;
  const planets = new Map<PlanetId, PlanetRead>();

  for (let p = 0; p < world.planetCount; p++) {
    if (world.tombstone[p]) continue;
    const byResource = new Map<ResourceId, ResourceRead>();
    for (let r = 0; r < R; r++) {
      if (world.resources.metas[r]!.tier !== TransportTier.Transportable) continue;
      const i = p * R + r;
      const cover = q.cover[i]!;
      const nd = q.netDemand[i]!;
      const ex = q.exportable[i]!;
      const inH = world.ledger.inboundWithinH(asPlanet(p), asResource(r), world.turn, world.cfg.horizonH);
      const thr = throttle[i]! as ThrottleReason;
      const sf = reasons.get(i) ?? null;
      if (cover === 0 && nd === 0 && ex === 0 && inH === 0 && sf === null && thr === ThrottleReason.None) {
        continue; // emit only non-zero / noteworthy pairs
      }
      byResource.set(asResource(r), {
        coverMilli: cover, netDemandMilli: nd, exportableMilli: ex,
        inboundWithinHMilli: inH, shortfall: sf, throttle: thr,
      });
    }
    if (byResource.size > 0) {
      planets.set(asPlanet(p), { planet: asPlanet(p), system: systemOfStar(world.starOf(asPlanet(p))), byResource });
    }
  }

  return { turn: world.turn, planets, edgeFlows: buildEdgeFlows(world) };
}

/** Edge-keyed active flows this turn, aggregated by (edge, direction, resource).
 *  A leg is `through` when it neither leaves the source star nor enters the final
 *  star — a relay reads as a waypoint, not a producer (§4.2). */
function buildEdgeFlows(world: World): EdgeFlowRead[] {
  const agg = new Map<string, { e: EdgeId; from: SystemId; to: SystemId; res: ResourceId; units: number; through: boolean }>();
  world.ring.forEachLive((slot) => {
    const v = world.ring.view(slot);
    const route = world.topology.getRoute(v.routeRef);
    const fromStar = route.hops[v.hopIndex]!;
    const toStar = route.hops[v.hopIndex + 1]!;
    const edge = world.topology.edgeId(fromStar, toStar);
    const srcStar = world.starOf(v.srcPlanet);
    const finalStar = world.starOf(v.dstPlanet);
    const through = (fromStar as number) !== (srcStar as number) && (toStar as number) !== (finalStar as number);
    const fromSys = systemOfStar(fromStar);
    const toSys = systemOfStar(toStar);
    const key = `${edge}:${fromSys}:${toSys}:${v.resource}`;
    const cur = agg.get(key);
    if (cur) { cur.units += v.qtyMilli; cur.through = cur.through && through; }
    else agg.set(key, { e: edge, from: fromSys, to: toSys, res: v.resource, units: v.qtyMilli, through });
  });
  const out: EdgeFlowRead[] = [];
  for (const a of agg.values()) {
    out.push({ edge: a.e, fromSystem: a.from, toSystem: a.to, resource: a.res, unitsMilli: a.units, through: a.through });
  }
  // Deterministic order: by edge, then resource, then direction.
  out.sort((x, y) =>
    (x.edge as number) - (y.edge as number) ||
    (x.resource as number) - (y.resource as number) ||
    (x.fromSystem as number) - (y.fromSystem as number));
  return out;
}

/** The in-transit story for (planet, resource): every flow currently inbound,
 *  cheapest-arrival-first (§4.2 drill-down, the getInTransitTo query).
 *  `nowTurn` is the turn the read is anchored to (the just-processed turn, so it
 *  agrees with the digest's turn and inbound window rather than the engine's
 *  already-incremented next turn). */
export function getInTransitTo(world: World, p: PlanetId, r: ResourceId, nowTurn: number): Delivery[] {
  const out: Delivery[] = [];
  world.ring.forEachLive((slot) => {
    const v = world.ring.view(slot);
    if ((v.dstPlanet as number) !== (p as number) || (v.resource as number) !== (r as number)) return;
    const route = world.topology.getRoute(v.routeRef);
    out.push({
      sourcePlanet: v.srcPlanet,
      qtyMilli: v.qtyMilli,
      currentStar: route.hops[v.hopIndex]! as number,
      finalArrival: v.finalArrival,
      turnsRemaining: v.finalArrival - nowTurn,
    });
  });
  out.sort((a, b) => a.finalArrival - b.finalArrival || (a.sourcePlanet as number) - (b.sourcePlanet as number));
  return out;
}

/** The binding shortfall reason + buildable fix for (planet, resource), or null
 *  if served / not demanding (§4.2 drill-down, the explainShortfall query). */
export function explainShortfall(
  world: World, p: PlanetId, r: ResourceId, reasons: ReadonlyMap<number, ShortfallReason>,
): ShortfallRecord | null {
  const reason = reasons.get((p as number) * world.R + (r as number));
  if (reason === undefined) return null;
  return { reason, fix: SHORTFALL_FIX[reason] };
}
