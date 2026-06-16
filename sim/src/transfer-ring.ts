// The TransferRing (§3.5, §9) — the ONE in-flight store, and the single source
// of truth for everything in transit. A timing wheel: every transfer lives in
// the bucket of its *current leg's* arrival turn. Drain is amortized O(1) per
// transfer. Cargo is durable, so there is no decay column (§3.6).
//
// EtaBuckets is the DERIVED inbound ledger (§3.5), keyed by the *final* arrival
// turn and final destination, so quantify can subtract only inbound landing
// within horizon H. It is maintained incrementally for O(1) reads and rebuilt
// from the ring for the dev-only `Σ inboundReserved == Σ in-flight` check
// (§11 rule 10) — the ring is authoritative, the ledger is its cache.

import { asTransfer } from './ids.ts';
import type { PlanetId, ResourceId, TransferId } from './ids.ts';

const NIL = -1;

/** A live transfer's fields, materialized from the SoA columns for a consumer. */
export interface TransferView {
  readonly slot: number;
  readonly id: TransferId;
  readonly resource: ResourceId;
  readonly qtyMilli: number;
  readonly srcPlanet: PlanetId;
  readonly dstPlanet: PlanetId;
  readonly arrivalTurn: number; // current leg
  readonly finalArrival: number;
  readonly hopIndex: number;
  readonly routeRef: number;
}

export interface MintArgs {
  readonly resource: ResourceId;
  readonly qtyMilli: number;
  readonly srcPlanet: PlanetId;
  readonly dstPlanet: PlanetId;
  readonly arrivalTurn: number;
  readonly finalArrival: number;
  readonly hopIndex: number;
  readonly routeRef: number;
}

export class TransferRing {
  readonly ringSpan: number; // bucket count (>= maxTransit + 2)
  readonly capacity: number; // SoA pool size (famine worst case, §7)

  // Parallel SoA columns, indexed by a dense slot.
  readonly transferId: Int32Array;
  readonly resource: Int32Array;
  readonly qtyMilli: Int32Array;
  readonly srcPlanet: Int32Array;
  readonly dstPlanet: Int32Array;
  readonly arrivalTurn: Int32Array;
  readonly finalArrival: Int32Array;
  readonly hopIndex: Int32Array;
  readonly routeRef: Int32Array;
  /** Intrusive list: serves both the per-bucket chain and the free chain. */
  readonly nextInBucket: Int32Array;

  readonly bucketHead: Int32Array; // ringSpan entries -> first slot due that turn
  private freeHead: number;
  liveCount = 0;
  inFlightTotal = 0; // Σ qtyMilli over live slots (maintained; conservation)
  nextTransferId = 1; // monotonic, never recycled (§3.7)

  constructor(ringSpan: number, capacity: number) {
    this.ringSpan = ringSpan;
    this.capacity = capacity;
    this.transferId = new Int32Array(capacity);
    this.resource = new Int32Array(capacity);
    this.qtyMilli = new Int32Array(capacity);
    this.srcPlanet = new Int32Array(capacity);
    this.dstPlanet = new Int32Array(capacity);
    this.arrivalTurn = new Int32Array(capacity);
    this.finalArrival = new Int32Array(capacity);
    this.hopIndex = new Int32Array(capacity);
    this.routeRef = new Int32Array(capacity);
    this.nextInBucket = new Int32Array(capacity);
    this.bucketHead = new Int32Array(this.ringSpan).fill(NIL);
    // Thread the free chain through every slot.
    for (let i = 0; i < capacity - 1; i++) this.nextInBucket[i] = i + 1;
    this.nextInBucket[capacity - 1] = NIL;
    this.freeHead = capacity > 0 ? 0 : NIL;
  }

  /** Mint a new transfer into its current-leg arrival bucket. Throws when the
   *  pool is exhausted — the v1 hard stop standing in for the active-flow cap. */
  mint(a: MintArgs): number {
    const slot = this.freeHead;
    if (slot === NIL) throw new Error('TransferRing: pool exhausted (active-flow cap)');
    this.freeHead = this.nextInBucket[slot]!;
    const id = this.nextTransferId++;
    this.transferId[slot] = id;
    this.resource[slot] = a.resource as number;
    this.qtyMilli[slot] = a.qtyMilli;
    this.srcPlanet[slot] = a.srcPlanet as number;
    this.dstPlanet[slot] = a.dstPlanet as number;
    this.arrivalTurn[slot] = a.arrivalTurn;
    this.finalArrival[slot] = a.finalArrival;
    this.hopIndex[slot] = a.hopIndex;
    this.routeRef[slot] = a.routeRef;
    this.linkIntoBucket(slot, a.arrivalTurn);
    this.liveCount++;
    this.inFlightTotal += a.qtyMilli;
    return slot;
  }

  /** Restore a serialized transfer verbatim (preserving its monotonic id) when
   *  deserializing — unlike mint(), does NOT bump nextTransferId. The caller
   *  restores nextTransferId afterward. Slots are pulled from the free chain in
   *  call order; the serialized bytes are slot-independent (sorted by id). */
  restoreTransfer(rec: MintArgs & { id: number }): void {
    const slot = this.freeHead;
    if (slot === NIL) throw new Error('TransferRing: pool exhausted on restore');
    this.freeHead = this.nextInBucket[slot]!;
    this.transferId[slot] = rec.id;
    this.resource[slot] = rec.resource as number;
    this.qtyMilli[slot] = rec.qtyMilli;
    this.srcPlanet[slot] = rec.srcPlanet as number;
    this.dstPlanet[slot] = rec.dstPlanet as number;
    this.arrivalTurn[slot] = rec.arrivalTurn;
    this.finalArrival[slot] = rec.finalArrival;
    this.hopIndex[slot] = rec.hopIndex;
    this.routeRef[slot] = rec.routeRef;
    this.linkIntoBucket(slot, rec.arrivalTurn);
    this.liveCount++;
    this.inFlightTotal += rec.qtyMilli;
  }

  private linkIntoBucket(slot: number, arrivalTurn: number): void {
    const b = ((arrivalTurn % this.ringSpan) + this.ringSpan) % this.ringSpan;
    this.nextInBucket[slot] = this.bucketHead[b]!;
    this.bucketHead[b] = slot;
  }

  /** Detach and return all slots due at `turn`, emptying that bucket. The caller
   *  (arrivals, §3.7) decides per slot whether to deliver, relink, or free.
   *  Returned in a deterministic order (bucket id ascending) — see note. */
  takeDue(turn: number): number[] {
    const b = ((turn % this.ringSpan) + this.ringSpan) % this.ringSpan;
    const out: number[] = [];
    let cur = this.bucketHead[b]!;
    while (cur !== NIL) {
      out.push(cur);
      cur = this.nextInBucket[cur]!;
    }
    this.bucketHead[b] = NIL;
    // Bucket chains are LIFO (head insertion); sort by transferId for a
    // deterministic, insertion-order-independent processing order.
    out.sort((p, q) => this.transferId[p]! - this.transferId[q]!);
    return out;
  }

  /** Re-link a slot (a continuing relay leg) into a new arrival bucket. The
   *  qty/route are unchanged — only the current-leg arrival and hopIndex move. */
  relink(slot: number, newArrivalTurn: number, newHopIndex: number): void {
    this.arrivalTurn[slot] = newArrivalTurn;
    this.hopIndex[slot] = newHopIndex;
    this.linkIntoBucket(slot, newArrivalTurn);
  }

  /** Free a delivered / re-routed slot back to the pool. */
  free(slot: number): void {
    this.inFlightTotal -= this.qtyMilli[slot]!;
    this.liveCount--;
    this.nextInBucket[slot] = this.freeHead;
    this.freeHead = slot;
  }

  view(slot: number): TransferView {
    return {
      slot,
      id: asTransfer(this.transferId[slot]!),
      resource: this.resource[slot]! as ResourceId,
      qtyMilli: this.qtyMilli[slot]!,
      srcPlanet: this.srcPlanet[slot]! as PlanetId,
      dstPlanet: this.dstPlanet[slot]! as PlanetId,
      arrivalTurn: this.arrivalTurn[slot]!,
      finalArrival: this.finalArrival[slot]!,
      hopIndex: this.hopIndex[slot]!,
      routeRef: this.routeRef[slot]!,
    };
  }

  /** Visit every live slot (any bucket). Used by the ledger rebuild, the
   *  edge-flow read, and getInTransitTo. Order is deterministic (by transferId)
   *  so consumers that materialize lists are stable. */
  forEachLive(cb: (slot: number) => void): void {
    const slots: number[] = [];
    for (let b = 0; b < this.ringSpan; b++) {
      let cur = this.bucketHead[b]!;
      while (cur !== NIL) { slots.push(cur); cur = this.nextInBucket[cur]!; }
    }
    slots.sort((p, q) => this.transferId[p]! - this.transferId[q]!);
    for (const s of slots) cb(s);
  }
}

/** The derived inbound ledger (§3.5). Keyed by (dstPlanet, resource, finalTurn),
 *  finalTurn taken mod ringSpan. Correctness needs ringSpan to exceed BOTH (a) the
 *  max live final-arrival span (so two in-flight finalTurns never alias) AND (b)
 *  the horizon H (so inboundWithinH's H-wide window read never sums one cell
 *  twice) — World sizes ringSpan = max(maxTransit, horizonH) + 2 and asserts
 *  horizonH < ringSpan. Maintained incrementally; rebuilt from the ring for the
 *  dev check. */
export class EtaBuckets {
  private readonly map = new Map<number, number>();
  private readonly resourceCount: number;
  private readonly ringSpan: number;

  constructor(resourceCount: number, ringSpan: number) {
    this.resourceCount = resourceCount;
    this.ringSpan = ringSpan;
  }

  private key(p: PlanetId, r: ResourceId, finalTurn: number): number {
    const t = ((finalTurn % this.ringSpan) + this.ringSpan) % this.ringSpan;
    return ((p as number) * this.resourceCount + (r as number)) * this.ringSpan + t;
  }

  add(p: PlanetId, r: ResourceId, finalTurn: number, qty: number): void {
    const k = this.key(p, r, finalTurn);
    this.map.set(k, (this.map.get(k) ?? 0) + qty);
  }

  sub(p: PlanetId, r: ResourceId, finalTurn: number, qty: number): void {
    const k = this.key(p, r, finalTurn);
    const v = (this.map.get(k) ?? 0) - qty;
    if (v < 0) throw new Error(`EtaBuckets: negative inbound for planet ${p} res ${r}`);
    if (v === 0) this.map.delete(k);
    else this.map.set(k, v);
  }

  /** Inbound to (p, r) landing within horizon H of the current turn (§3.5):
   *  finalTurn in (curTurn, curTurn + H]. */
  inboundWithinH(p: PlanetId, r: ResourceId, curTurn: number, h: number): number {
    let sum = 0;
    for (let t = curTurn + 1; t <= curTurn + h; t++) {
      sum += this.map.get(this.key(p, r, t)) ?? 0;
    }
    return sum;
  }

  /** Σ of all reserved inbound — compared against ring.inFlightTotal (§11 r.10). */
  total(): number {
    let s = 0;
    for (const v of this.map.values()) s += v;
    return s;
  }

  clear(): void {
    this.map.clear();
  }

  /** Rebuild the entire ledger from the authoritative ring (dev assert). */
  rebuildFrom(ring: TransferRing): void {
    this.clear();
    ring.forEachLive((slot) => {
      this.add(
        ring.dstPlanet[slot]! as PlanetId,
        ring.resource[slot]! as ResourceId,
        ring.finalArrival[slot]!,
        ring.qtyMilli[slot]!,
      );
    });
  }

  /** Cell-by-cell equality with another ledger (used by the dev rebuild check). */
  equals(other: EtaBuckets): boolean {
    if (this.map.size !== other.map.size) return false;
    for (const [k, v] of this.map) if (other.map.get(k) !== v) return false;
    return true;
  }
}
