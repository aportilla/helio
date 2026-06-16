// The World — Struct-of-Arrays state keyed by dense integer ids (§9).
//
// Planets are the v1 node-contributors (colonies): each emits demand/exportable
// from its own per-(planet, resource) stock, production, consumption, and
// hysteresis state. Hubs/depots/factories are future node types that add rows or
// policy modifiers; the matcher already reads emissions uniformly (§6.0), so
// they slot in without a kernel branch. Everything here is integer milli.

import { Prng } from './prng.ts';
import { Topology } from './topology.ts';
import { TransferRing, EtaBuckets } from './transfer-ring.ts';
import type { StarGeometry } from './geometry.ts';
import type { ResourceTable } from './resources.ts';
import type { BalanceConfig } from './constants.ts';
import { asPlanet, asStar } from './ids.ts';
import type { PlanetId, StarId } from './ids.ts';

/** A sentinel "effectively uncapped" storage ceiling (well inside Int32). */
export const STORAGE_UNCAPPED = 1 << 30;

export interface PlanetSpec {
  readonly star: number;
  /** Per-resource initial stock (milli); missing entries default to 0. */
  readonly stock?: readonly number[];
  /** Per-resource production per turn (milli). */
  readonly production?: readonly number[];
  /** Per-resource consumption per turn (milli). */
  readonly consumption?: readonly number[];
  /** Per-resource storage ceiling (milli); defaults to uncapped. */
  readonly storageCeiling?: readonly number[];
}

export interface WorldSpec {
  readonly geometry: StarGeometry;
  readonly resources: ResourceTable;
  readonly cfg: BalanceConfig;
  readonly seed: number;
  readonly planets: readonly PlanetSpec[];
}

export class World {
  /** Mutable so reach/speed tech intents can retune topology mid-game; quantify
   *  and allocate read it live, and topology rebuilds off it (§6). */
  cfg: BalanceConfig;
  readonly resources: ResourceTable;
  readonly geometry: StarGeometry;
  readonly topology: Topology;
  readonly prng: Prng;

  turn = 0;
  readonly planetCount: number;
  readonly R: number;

  // Per-planet columns.
  readonly star: Int32Array;
  readonly tombstone: Uint8Array; // 1 = dead, slot never reused (§3.7)

  // Per-(planet, resource) columns — flat, indexed by pr(p, r).
  readonly stock: Int32Array;
  readonly production: Int32Array;
  readonly consumption: Int32Array;
  readonly storageCeiling: Int32Array;
  readonly emaConsume: Int32Array;
  readonly ordering: Uint8Array; // hysteresis state machine flag (§7)
  readonly starveTurns: Int32Array; // consecutive turns underserved (§5)

  readonly ring: TransferRing;
  readonly ledger: EtaBuckets;
  readonly ringSpan: number;
  readonly maxTransit: number;

  constructor(spec: WorldSpec) {
    this.cfg = spec.cfg;
    this.resources = spec.resources;
    this.geometry = spec.geometry;
    this.prng = Prng.fromSeed(spec.seed);
    this.topology = new Topology(spec.geometry, spec.cfg);

    const P = spec.planets.length;
    const R = spec.resources.count;
    this.planetCount = P;
    this.R = R;

    this.star = new Int32Array(P);
    this.tombstone = new Uint8Array(P);
    this.stock = new Int32Array(P * R);
    this.production = new Int32Array(P * R);
    this.consumption = new Int32Array(P * R);
    this.storageCeiling = new Int32Array(P * R).fill(STORAGE_UNCAPPED);
    this.emaConsume = new Int32Array(P * R);
    this.ordering = new Uint8Array(P * R);
    this.starveTurns = new Int32Array(P * R);

    spec.planets.forEach((ps, p) => {
      if (ps.star < 0 || ps.star >= spec.geometry.starCount) {
        throw new Error(`World: planet ${p} references star ${ps.star} out of range`);
      }
      this.star[p] = ps.star;
      for (let r = 0; r < R; r++) {
        const i = p * R + r;
        this.stock[i] = ps.stock?.[r] ?? 0;
        this.production[i] = ps.production?.[r] ?? 0;
        this.consumption[i] = ps.consumption?.[r] ?? 0;
        this.storageCeiling[i] = ps.storageCeiling?.[r] ?? STORAGE_UNCAPPED;
        // Seed the EMA from declared consumption so demand is correct on turn 1
        // (an EMA ramping from zero would understate the setpoint at game start).
        this.emaConsume[i] = ps.consumption?.[r] ?? 0;
      }
    });

    // The ring buckets by current-leg arrival (<= maxLegTurns ahead), but its
    // span (and the derived ledger modulus) must exceed BOTH the full-route
    // worst case (so live final-arrival turns never alias) AND the horizon H
    // (so EtaBuckets.inboundWithinH's H-wide window read never aliases a cell).
    this.maxTransit = Math.max(1, spec.geometry.starCount) * spec.cfg.maxLegTurns;
    this.ringSpan = Math.max(this.maxTransit, spec.cfg.horizonH) + 2;
    if (spec.cfg.horizonH >= this.ringSpan) throw new Error('World: horizonH must be < ringSpan');
    this.ring = new TransferRing(this.ringSpan, spec.cfg.transferPoolCapacity);
    this.ledger = new EtaBuckets(R, this.ringSpan);
  }

  /** Flat index into a per-(planet, resource) column. */
  pr(p: PlanetId, r: number): number {
    return (p as number) * this.R + r;
  }

  starOf(p: PlanetId): StarId {
    return asStar(this.star[p as number]!);
  }

  isLive(p: PlanetId): boolean {
    return this.tombstone[p as number] === 0;
  }

  /** Tombstone a planet (colony lost). Its dense index is never reused, so
   *  in-flight cargo bound for it cannot misdeliver — it re-routes (§3.7). */
  kill(p: PlanetId): void {
    this.tombstone[p as number] = 1;
  }

  /** Lowest-PlanetId living planet on a given star, or -1 if none (§3.7
   *  re-home target; hubs/depots will refine this when they exist). */
  holdingPlanetOnStar(s: StarId): PlanetId {
    for (let p = 0; p < this.planetCount; p++) {
      if (this.tombstone[p] === 0 && this.star[p] === (s as number)) return asPlanet(p);
    }
    return asPlanet(-1);
  }

  /** Fallback holding planet anywhere (lowest live PlanetId) for a relay star
   *  with no friendly presence — keeps re-routed cargo from being lost (§3.7). */
  anyHoldingPlanet(): PlanetId {
    for (let p = 0; p < this.planetCount; p++) if (this.tombstone[p] === 0) return asPlanet(p);
    return asPlanet(-1);
  }

  /** Σ of all living planets' stock (the economically-available total). */
  totalStock(): number {
    let s = 0;
    for (let p = 0; p < this.planetCount; p++) {
      if (this.tombstone[p]) continue;
      for (let r = 0; r < this.R; r++) s += this.stock[p * this.R + r]!;
    }
    return s;
  }

  /** Σ of stock over EVERY slot, dead included (§3.6 conservation). A kill is an
   *  exogenous event, not an economic loss term; summing dead slots' frozen
   *  stock keeps `produced − consumed = Δ(stock + in-transit)` exact across a
   *  kill turn without a special "destroyed" term. */
  totalStockAll(): number {
    let s = 0;
    for (let i = 0; i < this.stock.length; i++) s += this.stock[i]!;
    return s;
  }
}

export function makeWorld(spec: WorldSpec): World {
  return new World(spec);
}
