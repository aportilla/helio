// Per-turn DEV economy log. A node-pure read derivation off a stepped engine:
// formats every facility-bearing body's realized production / consumption (with the
// % of capacity / demand it ran at) and every delivery that landed this turn (with
// where it came from), into console-ready lines. Sim-importing, node-pure — the
// bridge supplies a planet→label resolver from its bodyIdByPlanet table, so this
// stays clear of the catalog + DOM and unit-tests on a hand-built world (like
// economy-read.ts). Strict sink: nothing here re-enters the sim.

import { TransportTier } from '../../sim/src/index.ts';
import type { World, ReadDigest, ResourceTable, LocalTransfer } from '../../sim/src/index.ts';

// One delivery's source / destination / resource / volume, aggregated by that
// triple. Used for both the interstellar arrivals captured off the ring and the
// instant intra-cluster moves read off the engine.
export interface ArrivalRecord {
  readonly srcPlanet: number;
  readonly dstPlanet: number;
  readonly resource: number;
  readonly qtyMilli: number;
}

// Capture the interstellar deliveries that reach their FINAL destination THIS turn.
// MUST be called BEFORE engine.step() — the step's arrivals pass drains them from
// the ring, so afterwards they're gone. `finalArrival` is fixed when a transfer is
// minted, so `finalArrival === world.turn` is exactly the set landing this turn
// (a re-route onto a dead colony is the rare exception; for a dev log we accept it
// reading as a delivery). Aggregated by (src, dst, resource) so one body feeding
// another over several minted transfers reads as a single line.
export function captureArrivals(world: World): ArrivalRecord[] {
  const turn = world.turn;
  const agg = new Map<string, { src: number; dst: number; res: number; qty: number }>();
  world.ring.forEachLive((slot) => {
    const v = world.ring.view(slot);
    if (v.finalArrival !== turn) return;
    const src = v.srcPlanet as number;
    const dst = v.dstPlanet as number;
    const res = v.resource as number;
    const key = `${src} ${dst} ${res}`;
    const cur = agg.get(key);
    if (cur) cur.qty += v.qtyMilli;
    else agg.set(key, { src, dst, res, qty: v.qtyMilli });
  });
  return aggToRecords(agg);
}

// Fold the engine's instant intra-cluster moves into the same (src, dst, resource)
// shape — these arrive same-turn (0-turn transit, never ringed), so they're
// "arrivals" too. Self-legs (src === dst) aren't transfers; skipped defensively.
export function intraArrivals(localTransfers: readonly LocalTransfer[]): ArrivalRecord[] {
  const agg = new Map<string, { src: number; dst: number; res: number; qty: number }>();
  for (const lt of localTransfers) {
    const src = lt.srcPlanet as number;
    const dst = lt.dstPlanet as number;
    if (src === dst) continue;
    const res = lt.resource as number;
    const key = `${src} ${dst} ${res}`;
    const cur = agg.get(key);
    if (cur) cur.qty += lt.qtyMilli;
    else agg.set(key, { src, dst, res, qty: lt.qtyMilli });
  }
  return aggToRecords(agg);
}

export interface TurnLogInput {
  readonly digest: ReadDigest;
  readonly world: World;
  readonly resources: ResourceTable;
  // Interstellar arrivals captured BEFORE the step (captureArrivals); the instant
  // intra-cluster moves are read off the stepped engine (intraArrivals).
  readonly interstellar: readonly ArrivalRecord[];
  readonly intra: readonly ArrivalRecord[];
  readonly labelOf: (planet: number) => string;
}

// Build the formatted block for one turn: a "produced / consumed" section (one line
// per body, each resource showing realized ÷ rate and the % of capacity / demand it
// ran at) and an "arrivals" section (one line per delivery, source → destination,
// tagged interstellar vs intra-system). Returns the lines; the caller owns the
// console group. Bodies/resources come from the digest, which already prunes the
// quiescent (no rate, no flow), so the block lists only what's economically live.
export function buildTurnLog(input: TurnLogInput): string[] {
  const { digest, world, resources, interstellar, intra, labelOf } = input;
  const R = world.R;
  const name = (r: number): string => resources.metas[r]!.name;

  const lines: string[] = ['produced / consumed (realized ÷ rate):'];
  let anyFlow = false;
  // digest.planets iterates in ascending PlanetId order (buildReadDigest fills it
  // that way), so the block is stable turn to turn without an explicit sort.
  for (const pr of digest.planets.values()) {
    const p = pr.planet as number;
    const parts: string[] = [];
    for (const [rid, rr] of pr.byResource) {
      const r = rid as number;
      if (resources.metas[r]!.tier !== TransportTier.Transportable) continue;
      const i = p * R + r;
      const prodRate = world.production[i]!;
      const consRate = world.consumption[i]!;
      const clauses: string[] = [];
      if (prodRate > 0) {
        clauses.push(`+${u(rr.realizedProductionMilli)}/${u(prodRate)} (${pct(rr.realizedProductionMilli, prodRate)}% cap)`);
      }
      if (consRate > 0) {
        clauses.push(`−${u(rr.realizedConsumptionMilli)}/${u(consRate)} (${pct(rr.realizedConsumptionMilli, consRate)}% dem)`);
      }
      if (clauses.length === 0) continue;
      // END-OF-TURN stock — the larder after this turn's deposits AND the residual
      // consume pass (P7.5) that eats same-turn intra-cluster arrivals. So fill%
      // already reflects what landed this turn; [stock N] is what's left over after
      // the body ate to its rate (the anti-bullwhip buffer it carries forward).
      const stock = world.stock[i]!;
      const stockTag = stock !== 0 ? ` [stock ${u(stock)}]` : '';
      parts.push(`${name(r)} ${clauses.join(' ')}${stockTag}`);
    }
    if (parts.length > 0) {
      anyFlow = true;
      lines.push(`  ${labelOf(p)}: ${parts.join(' · ')}`);
    }
  }
  if (!anyFlow) lines.push('  (nothing produced or consumed)');

  lines.push('arrivals (delivered this turn):');
  const arrivalLines = [
    ...interstellar.map((a) => arrivalLine(a, name, labelOf, 'interstellar')),
    ...intra.map((a) => arrivalLine(a, name, labelOf, 'intra-system')),
  ];
  if (arrivalLines.length > 0) lines.push(...arrivalLines);
  else lines.push('  (nothing arrived)');

  return lines;
}

// — internals —

function aggToRecords(agg: Map<string, { src: number; dst: number; res: number; qty: number }>): ArrivalRecord[] {
  const out = [...agg.values()].map((e) => ({ srcPlanet: e.src, dstPlanet: e.dst, resource: e.res, qtyMilli: e.qty }));
  // Deterministic order: by destination, then source, then resource.
  out.sort((a, b) => a.dstPlanet - b.dstPlanet || a.srcPlanet - b.srcPlanet || a.resource - b.resource);
  return out;
}

function arrivalLine(
  a: ArrivalRecord, name: (r: number) => string, labelOf: (p: number) => string, tag: string,
): string {
  return `  ${name(a.resource)} ${u(a.qtyMilli)} from ${labelOf(a.srcPlanet)} → ${labelOf(a.dstPlanet)} (${tag})`;
}

// Integer-milli → display units (×1000 down), matching scripts/inspect-economy.ts.
function u(milli: number): number {
  return milli / 1000;
}

// Realized ÷ rate as a rounded whole-percent. Caller guarantees rate > 0.
function pct(realizedMilli: number, rateMilli: number): number {
  return Math.round((realizedMilli / rateMilli) * 100);
}
