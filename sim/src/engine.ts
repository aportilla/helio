// The EconomyEngine — the one mutating entry point (§9). step() runs the turn
// pipeline (§8) in order; everything else is a read-only query over the last
// turn's state. The read surface and its drill-downs are strict sinks (§4.1):
// nothing they return ever re-enters the sim or the save.

import { advanceArrivals } from './arrivals.ts';
import type { ArrivalsResult } from './arrivals.ts';
import { produceConsume } from './produce.ts';
import { quantify } from './quantify.ts';
import type { Quantified } from './quantify.ts';
import { allocate } from './allocate.ts';
import { dispatch } from './dispatch.ts';
import { assertConservation, assertNoNegativeStock, assertLedgerMatchesRing } from './invariants.ts';
import { buildReadDigest, getInTransitTo, explainShortfall } from './read-surface.ts';
import type { ReadDigest, PlanetRead, Delivery, ShortfallRecord } from './read-surface.ts';
import { serialize } from './serialize.ts';
import { ThrottleReason } from './produce.ts';
import type { ShortfallReason } from './shortfall.ts';
import type { World } from './world.ts';
import type { BalanceConfig } from './constants.ts';
import type { PlanetId, ResourceId, SystemId } from './ids.ts';
import { systemOfStar } from './geometry.ts';

export interface TurnReport {
  readonly turn: number;
  readonly produced: number;
  readonly consumed: number;
  readonly dispatched: number;
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
  private lastThrottle: Int8Array;
  private lastDigest: ReadDigest | null = null;
  /** The turn step() last processed (the read surface anchors "now" here, so the
   *  digest and the drill-down queries agree on the same turn). */
  private lastProcessedTurn = -1;

  constructor(world: World, opts: EngineOptions = {}) {
    this.world = world;
    this.check = opts.checkInvariants ?? true;
    this.lastThrottle = new Int8Array(world.planetCount * world.R);
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

    // P8 — telemetry + commit. Serialize-before-float-telemetry holds because
    // every value here is integer (the read digest is built from integer state).
    const after = w.totalStockAll() + w.ring.inFlightTotal;
    if (this.check) {
      assertConservation(before, after, prod.produced, prod.consumed);
      assertNoNegativeStock(w);
      assertLedgerMatchesRing(w);
    }

    this.lastQ = q;
    this.lastReasons = plan.reasons;
    this.lastThrottle = prod.throttle;
    this.lastDigest = buildReadDigest(w, q, plan.reasons, prod.throttle);
    this.lastProcessedTurn = turn;

    w.turn = turn + 1;

    return {
      turn,
      produced: prod.produced,
      consumed: prod.consumed,
      dispatched: disp.dispatched,
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

  /** Current OUTPUT_FULL throttle state for (planet, resource), the glut signal. */
  throttleOf(p: PlanetId, r: ResourceId): ThrottleReason {
    return this.lastThrottle[(p as number) * this.world.R + (r as number)]! as ThrottleReason;
  }

  serialize(): Uint8Array {
    return serialize(this.world);
  }

  systemOfPlanet(p: PlanetId): SystemId {
    return systemOfStar(this.world.starOf(p));
  }
}
