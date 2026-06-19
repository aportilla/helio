// The EconomyEngine — the one mutating entry point (§9). step() runs the turn
// pipeline (§8) in order; everything else is a read-only query over the last
// turn's state. The read surface and its drill-downs are strict sinks (§4.1):
// nothing they return ever re-enters the sim or the save.

import { advanceArrivals } from './arrivals.ts';
import type { ArrivalsResult } from './arrivals.ts';
import { produceConsume, consumeResidual } from './produce.ts';
import { quantify } from './quantify.ts';
import type { Quantified } from './quantify.ts';
import { allocate } from './allocate.ts';
import { dispatch } from './dispatch.ts';
import type { LocalTransfer } from './dispatch.ts';
import { assertConservation, assertNoNegativeStock, assertLedgerMatchesRing } from './invariants.ts';
import { buildReadDigest, getInTransitTo, explainShortfall } from './read-surface.ts';
import type { ReadDigest, PlanetRead, Delivery, ShortfallRecord } from './read-surface.ts';
import { serialize } from './serialize.ts';
import type { ShortfallReason } from './shortfall.ts';
import type { World } from './world.ts';
import type { BalanceConfig } from './constants.ts';
import type { PlanetId, ResourceId, SystemId } from './ids.ts';
import { systemOfStar } from './geometry.ts';

export interface TurnReport {
  readonly turn: number;
  readonly produced: number;
  readonly consumed: number;
  readonly dispatched: number; // interstellar volume that left sources into transit
  readonly localDelivered: number; // intra-cluster volume deposited same-turn (0-turn transfers)
  readonly delivered: number;
  readonly rerouted: number;
  readonly continued: number;
  readonly records: number; // new transfer records minted this turn
  readonly inFlight: number; // live transfers at end of turn
  readonly unmet: number; // demands left with a shortfall reason
}

export interface EngineOptions {
  /** Run the conservation/ledger/no-negative invariants every turn (DEV). */
  readonly checkInvariants?: boolean;
}

export class EconomyEngine {
  readonly world: World;
  private readonly check: boolean;

  private lastQ: Quantified | null = null;
  private lastReasons: ReadonlyMap<number, ShortfallReason> = new Map();
  private lastDigest: ReadDigest | null = null;
  /** Intra-cluster moves the last step() deposited instantly (§ 0-turn transfers).
   *  A strict sink: the viz sources internal lanes from these. Empty until step(). */
  private lastLocalTransfers: readonly LocalTransfer[] = [];
  /** The turn step() last processed (the read surface anchors "now" here, so the
   *  digest and the drill-down queries agree on the same turn). */
  private lastProcessedTurn = -1;

  constructor(world: World, opts: EngineOptions = {}) {
    this.world = world;
    this.check = opts.checkInvariants ?? true;
  }

  /** Apply a reach/speed tech intent (P0/P1): retune the balance config and
   *  rebuild the jump graph. In-flight cargo keeps its committed leg; the next
   *  arrivals pass re-evaluates onward edges against the new topology (§3.7). */
  applyTech(tier: Partial<Pick<BalanceConfig, 'jumpRadius' | 'travelSpeedTier'>>): void {
    this.world.cfg = { ...this.world.cfg, ...tier };
    this.world.topology.rebuild(this.world.cfg);
  }

  /** Tombstone a colony (an exogenous P0 intent). Its index is never reused;
   *  in-flight cargo bound for it will re-route (§3.7). */
  killPlanet(p: PlanetId): void {
    this.world.kill(p);
  }

  /** Run one turn (§8). The single mutating call. */
  step(): TurnReport {
    const w = this.world;
    const turn = w.turn;

    // Conservation window baseline (after any P0 intents the caller applied).
    const before = w.totalStockAll() + w.ring.inFlightTotal;

    // P2 — arrivals first.
    const arr: ArrivalsResult = advanceArrivals(w);
    // P3 — produce + consume.
    const prod = produceConsume(w);
    // P4 — quantify supply/demand (single authority).
    const q = quantify(w);
    // P5 — price field: deferred (banner).
    // P6 — allocate (pure plan).
    const plan = allocate(w, q);
    // P7 — dispatch (single conservation chokepoint) + transit advance.
    const disp = dispatch(w, plan);
    // P7.5 — residual consume. Dispatch just deposited this turn's instant
    // intra-cluster cargo into destination stock (P7); let a starved consumer eat
    // that same-system supply THIS turn rather than next turn's P3. Mints nothing
    // and touches neither ring nor ledger, so it shifts an already-conserved unit
    // from "stock" to "consumed" within the same window.
    const consume2 = consumeResidual(w, prod.realizedConsumption);
    const consumed = prod.consumed + consume2.extraConsumed;

    // P8 — telemetry + commit. Serialize-before-float-telemetry holds because
    // every value here is integer (the read digest is built from integer state).
    // `produced` is born in two places — P3 self-feed + P7 export mint — so the
    // conservation tally sums both halves; the identity (produced − consumed ==
    // Δ(stock + in-transit)) is unchanged because mint adds to stock and every
    // dispatch move conserves stock + in-flight. The `after` snapshot and the
    // asserts run AFTER P7.5, and `consumed` includes its top-up, so the same
    // identity still closes (both sides drop by extraConsumed).
    const produced = prod.producedLocalTotal + disp.producedMintedTotal;
    const after = w.totalStockAll() + w.ring.inFlightTotal;
    if (this.check) {
      assertConservation(before, after, produced, consumed);
      assertNoNegativeStock(w);
      assertLedgerMatchesRing(w);
    }

    // Realized production per (planet, resource) = self-feed (P3) + export mint
    // (P7) — the numerator of the read surface's utilization %.
    const realizedProduction = new Int32Array(w.planetCount * w.R);
    for (let i = 0; i < realizedProduction.length; i++) {
      realizedProduction[i] = prod.producedLocal[i]! + disp.producedMinted[i]!;
    }

    this.lastQ = q;
    this.lastReasons = plan.reasons;
    // The digest reports the FOLDED realized consumption (P3 + the P7.5 top-up), so
    // fill% reflects same-turn intra-cluster arrivals. cover/netDemand stay as
    // quantified at P4 (the order placed this turn, still sized against pre-arrival
    // stock) — same-turn CONSUMPTION, not same-turn demand re-sizing.
    this.lastDigest = buildReadDigest(w, q, plan.reasons, realizedProduction, consume2.realizedConsumption);
    this.lastLocalTransfers = disp.localTransfers;
    this.lastProcessedTurn = turn;

    w.turn = turn + 1;

    return {
      turn,
      produced,
      consumed,
      dispatched: disp.dispatched,
      localDelivered: disp.localDelivered,
      delivered: arr.delivered,
      rerouted: arr.rerouted,
      continued: arr.continued,
      records: disp.records,
      inFlight: w.ring.liveCount,
      unmet: plan.reasons.size,
    };
  }

  // — Read surface (strict sinks, §4) —

  getReadDigest(): ReadDigest {
    if (!this.lastDigest) throw new Error('getReadDigest: call step() first');
    return this.lastDigest;
  }

  /** Intra-cluster (same-node) moves the last step() deposited instantly — the
   *  intra-system reallocation that resolves with 0 turns of transit, so it never
   *  appears in the ring or `getInTransitTo`. A strict sink, empty before the
   *  first step(); the viz reads it to draw internal lanes. */
  getLocalTransfers(): readonly LocalTransfer[] {
    return this.lastLocalTransfers;
  }

  getResourceCover(p: PlanetId, r: ResourceId): number {
    if (!this.lastQ) throw new Error('getResourceCover: call step() first');
    return this.lastQ.cover[(p as number) * this.world.R + (r as number)]!;
  }

  getInTransitTo(p: PlanetId, r: ResourceId): readonly Delivery[] {
    return getInTransitTo(this.world, p, r, this.lastProcessedTurn);
  }

  explainShortfall(p: PlanetId, r: ResourceId): ShortfallRecord | null {
    return explainShortfall(this.world, p, r, this.lastReasons);
  }

  getSystemRead(s: SystemId): readonly PlanetRead[] {
    const digest = this.getReadDigest();
    const out: PlanetRead[] = [];
    for (const pr of digest.planets.values()) if ((pr.system as number) === (s as number)) out.push(pr);
    return out;
  }

  serialize(): Uint8Array {
    return serialize(this.world);
  }

  systemOfPlanet(p: PlanetId): SystemId {
    return systemOfStar(this.world.starOf(p));
  }
}
