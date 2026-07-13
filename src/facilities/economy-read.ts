// Node-pure read-surface derivations EconomyBridge exposes to the viz + sidebar.
// Extracted from economy-bridge.ts (the app-glue layer that drags in the catalog
// and localStorage) so this load-bearing logic unit-tests under `node --test`
// against a hand-built sim world, exactly like world-sync.ts / speculation.ts.
// Sim-importing, node-pure: takes plain sim state + a planet→Body.id table, returns
// app DTOs. No catalog, no DOM, no localStorage. Strict sink: no sim type escapes.

import { classifyFlow } from './flow-class.ts';
import type { World, LocalTransfer } from '../../sim/src/index.ts';
import type { EconResource } from './resource-vocab.ts';

// One lane of cargo traffic the system view renders as a stream of dots, classified
// relative to the viewed cluster. The four kinds are the cells of a 2×2 on (is the
// source in this cluster? × is the destination in this cluster?), plus the relay
// case where neither endpoint is here but the route passes through:
//   internal — both bodies in this cluster (body → body, fully on-screen)
//   outgoing — source here, destination elsewhere (body → off the top)
//   incoming — destination here, source elsewhere (off the top → body)
//   through  — neither here, but routed across this cluster (crosses sideways)
// amountMilli is the shipped volume on the lane (an integer). Internal lanes are
// sourced from the engine's intra-cluster moves (`getLocalTransfers` — the instant,
// never-ringed intra-system reallocation), while outgoing/incoming/through come from
// the transfer ring. bodyIds are stable Body.id strings.
export type ShipLane =
  | { readonly kind: 'internal'; readonly srcBodyId: string; readonly dstBodyId: string; readonly resource: EconResource; readonly amountMilli: number }
  | { readonly kind: 'outgoing'; readonly srcBodyId: string; readonly resource: EconResource; readonly amountMilli: number }
  | { readonly kind: 'incoming'; readonly dstBodyId: string; readonly resource: EconResource; readonly amountMilli: number }
  | { readonly kind: 'through'; readonly dir: 'ltr' | 'rtl'; readonly resource: EconResource; readonly amountMilli: number };

// Every cargo lane that touches one cluster (= one system view), classified for the
// ship-dot overlay, from a (ring, intra-cluster moves) pair. RING transfers are
// classified by their endpoints' cluster nodes (world.star) into outgoing/incoming,
// or, when neither endpoint is here, kept only if their multi-leg route passes
// THROUGH this cluster (relay traffic) — the ring carries only inter-cluster cargo
// now (a legacy same-cluster transfer from a pre-0-turn save still classifies as
// internal while it drains). INTERNAL lanes come from `localTransfers`: the
// intra-cluster moves the dispatch plan resolves instantly this turn (no longer in
// the ring), each already intra by construction. Lanes aggregate by their rendered
// identity so a body trading with several off-cluster systems reads as one stream,
// not a redundant stack. `bodyIdByPlanet` resolves dense PlanetIds (stable across
// serialize/deserialize, so a speculative clone's ring + moves resolve too).
export function buildShipLanes(
  w: World,
  localTransfers: readonly LocalTransfer[],
  clusterIdx: number,
  bodyIdByPlanet: readonly string[],
): ShipLane[] {
  const internal = new Map<string, { src: string; dst: string; res: number; amt: number }>();
  const outgoing = new Map<string, { src: string; res: number; amt: number }>();
  const incoming = new Map<string, { dst: string; res: number; amt: number }>();
  const through  = new Map<string, { dir: 'ltr' | 'rtl'; res: number; amt: number }>();

  w.ring.forEachLive((slot) => {
    const v = w.ring.view(slot);
    const src = v.srcPlanet as number;
    const dst = v.dstPlanet as number;
    // getRoute is an O(1) array deref, so classifying every transfer (not just the
    // relay case) costs nothing and keeps the logic in one pure helper.
    const cls = classifyFlow(w.star[src]!, w.star[dst]!, clusterIdx, w.topology.getRoute(v.routeRef).hops);
    const res = v.resource as number;
    const qty = v.qtyMilli;

    switch (cls.kind) {
      case 'none': return;
      case 'internal': {
        const a = bodyIdByPlanet[src]!;
        const b = bodyIdByPlanet[dst]!;
        const key = `${a} ${b} ${res}`;
        const cur = internal.get(key);
        if (cur) cur.amt += qty; else internal.set(key, { src: a, dst: b, res, amt: qty });
        return;
      }
      case 'outgoing': {
        const a = bodyIdByPlanet[src]!;
        const key = `${a} ${res}`;
        const cur = outgoing.get(key);
        if (cur) cur.amt += qty; else outgoing.set(key, { src: a, res, amt: qty });
        return;
      }
      case 'incoming': {
        const b = bodyIdByPlanet[dst]!;
        const key = `${b} ${res}`;
        const cur = incoming.get(key);
        if (cur) cur.amt += qty; else incoming.set(key, { dst: b, res, amt: qty });
        return;
      }
      case 'through': {
        const entry = cls.entry;
        const exit = cls.exit;
        const dir = cls.dir;
        const key = `${entry} ${exit} ${res}`;
        const cur = through.get(key);
        if (cur) cur.amt += qty; else through.set(key, { dir, res, amt: qty });
        return;
      }
    }
  });

  // Internal lanes: the intra-cluster moves resolved instantly this turn (the
  // dispatch plan's same-node deposits, never in the ring). Source is in this
  // cluster ⇒ destination is too (intra by construction), so filtering on the
  // source is sufficient. Merge into the same `internal` bucket the ring drain
  // feeds, so a legacy same-cluster ring transfer and a fresh deposit on the same
  // (src,dst,res) read as one stream.
  for (const lt of localTransfers) {
    const src = lt.srcPlanet as number;
    if (w.star[src] !== clusterIdx) continue;
    const dst = lt.dstPlanet as number;
    const res = lt.resource as number;
    const a = bodyIdByPlanet[src]!;
    const b = bodyIdByPlanet[dst]!;
    const key = `${a} ${b} ${res}`;
    const cur = internal.get(key);
    if (cur) cur.amt += lt.qtyMilli; else internal.set(key, { src: a, dst: b, res, amt: lt.qtyMilli });
  }

  const out: ShipLane[] = [];
  for (const e of internal.values()) out.push({ kind: 'internal', srcBodyId: e.src, dstBodyId: e.dst, resource: e.res as EconResource, amountMilli: e.amt });
  for (const e of outgoing.values()) out.push({ kind: 'outgoing', srcBodyId: e.src, resource: e.res as EconResource, amountMilli: e.amt });
  for (const e of incoming.values()) out.push({ kind: 'incoming', dstBodyId: e.dst, resource: e.res as EconResource, amountMilli: e.amt });
  for (const e of through.values())  out.push({ kind: 'through', dir: e.dir, resource: e.res as EconResource, amountMilli: e.amt });
  return out;
}

// Σ speculative intra-cluster deposits landing in `planet` next turn, keyed by
// resource id — the instant relief that is NOT ledger-inbound (it never flies), so
// the M3 "++ inbound next turn" cue must fold it in by hand (foldInboundNextTurn).
export function intraInboundByResource(
  localTransfers: readonly LocalTransfer[],
  planet: number,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const lt of localTransfers) {
    if ((lt.dstPlanet as number) !== planet) continue;
    const k = lt.resource as number;
    out.set(k, (out.get(k) ?? 0) + lt.qtyMilli);
  }
  return out;
}

// The forward-looking inbound the M3 cue reads for one (planet, resource):
// interstellar ledger-inbound (from the speculative digest, `null` when that digest
// has no row for the pair) PLUS the instant intra-cluster relief. Null only when
// there is neither — the no-prediction baseline that keeps the cue silent, so it
// fires for an interstellar prediction and for an intra-system fix alike.
export function foldInboundNextTurn(
  ledgerInboundMilli: number | null,
  intraInboundMilli: number,
): number | null {
  if (ledgerInboundMilli !== null) return ledgerInboundMilli + intraInboundMilli;
  return intraInboundMilli > 0 ? intraInboundMilli : null;
}
