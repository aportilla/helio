// EconomyBridge — the live wiring from placed facilities to a running economy
// sim, plus the read-back the system view draws. The src/facilities/ package is
// the app's only window onto the sim runtime; the boundary guard
// (scripts/check-sim-boundary.mjs) keeps every other importer out.
//
// Lifecycle (AppController owns one): built once at startup — restored from the
// sim save when it still matches the current facilities, else cold-started.
// step() advances the sim one turn and persists. syncFacilities() reconciles
// after a build/remove WITHOUT zeroing accumulated stock, so the player's economy
// survives both reloads and edits (the committed persist-stock model).
//
// Transport model: a geometry node is a CLUSTER — one system with a shared pool
// of bodies (a cluster is NOT several systems). Every facility-bearing body is a
// planet sitting on its cluster's node, so all bodies in a cluster trade freely
// AND instantly — an intra-cluster move is delivered the same turn (0 turns of
// transit, never aloft), regardless of which member star they orbit; only crossing
// BETWEEN clusters costs jump range and shows ships in transit. The sim's
// system === node (1:1), so a sim "system" is exactly one of our clusters.

import { BODIES, STAR_CLUSTERS, clusterIndexFor, indexOfBodyId } from '../data/stars.ts';
import type { Body } from '../data/stars.ts';
import {
  EconomyEngine,
  makeWorld,
  deserialize,
  defaultBalance,
  TransportTier,
  ShortfallReason,
  SHORTFALL_FIX,
  asPlanet,
  asResource,
  type World,
  type StarGeometry,
  type ResourceTable,
  type BalanceConfig,
  type WorldSkeleton,
} from '../../sim/src/index.ts';
import { getGameState, ownerFactionId, type Facility } from '../game-state.ts';
import { CONTROLLED_FACTION_ID } from '../factions/registry.ts';
import { appResourceTable } from './resource-table.ts';
import type { EconResource } from './resource-vocab.ts';
import { buildShipLanes, intraInboundByResource, foldInboundNextTurn, type ShipLane } from './economy-read.ts';
import { captureArrivals, intraArrivals, buildTurnLog, type ArrivalRecord } from './economy-log.ts';
import { cloneWorldForSpeculation } from './speculation.ts';
import { projectWorld } from './project.ts';
import type { SimStarResolver } from './types.ts';
import { buildGeometry, LY_TO_SIM_UNITS } from './sim-geometry.ts';
import { sameBodyIds, transplantLiveState } from './world-sync.ts';
import { base64FromBytes, bytesFromBase64 } from './base64.ts';
import { slotKey, readRaw, writeRaw } from '../storage.ts';

const SIM_SAVE_KEY = slotKey('sim');

// Pinned, non-zero seed (Prng.fromSeed(0) is degenerate). The economy's RNG
// identity for a fresh game; a restored save's PRNG state takes over from here.
const WORLD_SEED = 0x5e1f0501;

// Current jump reach, in light-years — the farthest a single leg spans; longer
// hauls route multi-leg over the graph. ~9 ly comfortably exceeds the solar
// neighborhood's typical nearest-neighbor spacing (~5–6 ly), so systems connect
// into one routable graph rather than isolated islands, while reach still
// matters. jumpRadius is a runtime tech tier (excluded from the save's
// configHash), so retuning it never invalidates a save — a restored world simply
// adopts the current value (see enforceReach).
const REACH_LY = 9;
const REACH_UNITS = Math.round(REACH_LY * LY_TO_SIM_UNITS);

// A binding shortfall on a resource: why this turn's demand went unmet, plus the
// buildable fix. Compact reason label for the chip; full fix sentence for detail.
export interface ShortfallView {
  readonly label: string;
  readonly fix: string;
}

// Compact, sidebar-width labels for the sim's single-cause shortfall reasons.
const SHORTFALL_LABEL: Readonly<Record<ShortfallReason, string>> = {
  [ShortfallReason.Unreachable]: 'no route',
  [ShortfallReason.SourceCflLimited]: 'throttled',
  [ShortfallReason.SourceExhausted]: 'no supply',
  [ShortfallReason.OutbidByPriority]: 'outbid',
};

// One transportable resource's standing on a body: how much it has, its intrinsic
// per-turn balance (production − consumption, before trade — the NAMEPLATE/installed
// intent, what a just-placed facility reads before the first step), and — once the
// sim has produced a read digest this session — the trade-aware signed cover
// (+surplus / −deficit), a binding shortfall, and a realized RATE: utilizationPct
// for a net-producer resource (made ÷ capacity, 0% idle … 100% maxed) or fillPct
// for a net-consumer resource (ate ÷ demand, 100% fed … less when hungry). Exactly
// one rate is set per resource (the side this body is net), or neither before the
// first step. Plain app values — no sim types cross this boundary.
//
// The `predicted*` fields are the FORWARD-LOOKING read off the speculative
// next-turn world (§ speculation.ts): what this body's cover/inbound WILL be once
// the player commits Next Turn, available even before the session's first real
// step (the clone is always stepped). Null when no prediction exists (the clone
// failed) or the resource is absent from the speculative digest (treat as the
// neutral baseline — the two digests prune zero rows independently). The "deficit
// now but improving" cue is the consumer's: realCover/netFlow < 0 yet
// predictedCover above it. The sidebar owns that comparison; the bridge only
// supplies the numbers.
export interface ResourceLevel {
  readonly key: EconResource;
  readonly name: string;
  readonly stockMilli: number;
  readonly netFlowMilli: number;
  readonly coverMilli: number | null;
  readonly shortfall: ShortfallView | null;
  // Realized rate as a clamped 0..1 fraction (display %), or null when the side
  // doesn't apply / no digest carries the resource. A net producer of the resource
  // reports utilizationPct (fillPct null); a net consumer reports fillPct
  // (utilizationPct null). Available from first paint — the live digest once a turn
  // has run, else the speculative next-turn one. Utilization 100% IS "maxed", 0% IS
  // idle; fill < 100% IS hungry.
  readonly utilizationPct: number | null;
  readonly fillPct: number | null;
  readonly predictedCoverMilli: number | null;
  readonly inboundNextTurnMilli: number | null;
}

export interface BodyEconomyView {
  readonly resources: readonly ResourceLevel[];
}

// A whole system's (one cluster's) net standing per resource — the galaxy
// info-card summary. Signed: + net exporter / − net importer. `predictedNetMilli`
// is the same sum off the speculative next-turn world (the forward-looking net),
// or null when no prediction exists.
export interface SystemResourceLevel {
  readonly name: string;
  readonly netMilli: number;
  readonly predictedNetMilli: number | null;
}

export interface SystemEconomyView {
  readonly resources: readonly SystemResourceLevel[];
}

// ShipLane (the system-view cargo-overlay DTO) and its assembly live in the
// node-pure `economy-read.ts` seam; re-exported here so the scene keeps importing it
// from the bridge — its established public surface. See that module for the
// internal/outgoing/incoming/through classification and how internal lanes are
// sourced from the instant intra-cluster moves rather than the ring.
export type { ShipLane } from './economy-read.ts';

interface Built {
  readonly engine: EconomyEngine;
  readonly bodyIdByPlanet: readonly string[];
  readonly planetByBodyId: ReadonlyMap<string, number>;
}

interface Restored {
  readonly world: World;
  readonly bodyIds: readonly string[];
}

export class EconomyBridge {
  private readonly geometry: StarGeometry;
  private readonly resources: ResourceTable;
  private readonly cfg: BalanceConfig;
  private readonly starOf: SimStarResolver;
  // The static inputs a clone (and a restored save) reconstructs against. The
  // SAME instances must be re-passed to deserialize or its configHash assert
  // throws — never rebuilt per clone.
  private readonly skeleton: WorldSkeleton;

  private engine: EconomyEngine;
  private bodyIdByPlanet: readonly string[];
  private planetByBodyId: ReadonlyMap<string, number>;
  // The live read digest exists only after a step (it isn't serialized), so cover
  // and shortfall are unavailable until the first Next Turn of a session —
  // including right after a reload. Until then the chip shows stock + intrinsic
  // flow, and the utilization/fill rate falls back to the speculative next-turn
  // read (always stepped). Reset whenever the engine is rebuilt.
  private stepped = false;
  // The speculative next-turn world: a throwaway clone of the live world, stepped
  // once, that drives the predictive viz (predicted ship lanes + forward-looking
  // sidebar hints). NEVER assigned to `this.engine`, never persisted. Recomputed
  // only on real-world change (ctor / syncFacilities / step), so the
  // serialize+deserialize+step cost stays off the per-frame path. Null when the
  // clone or its step throws — the viz degrades to the live read.
  private specEngine: EconomyEngine | null = null;

  constructor() {
    // One geometry node per cluster, at its center of mass.
    this.geometry = buildGeometry(STAR_CLUSTERS.map((c) => c.com));
    this.resources = appResourceTable();
    this.cfg = defaultBalance({ jumpRadius: REACH_UNITS });
    this.skeleton = { geometry: this.geometry, resources: this.resources, cfg: this.cfg };
    this.starOf = (body) => clusterNodeOfBody(body);

    const built = this.build(facilitiesByBodyId(), this.restore());
    this.engine = built.engine;
    this.bodyIdByPlanet = built.bodyIdByPlanet;
    this.planetByBodyId = built.planetByBodyId;
    // Persist immediately so a freshly cold-started game has a save to reload.
    this.persist();
    // Seed the next-turn prediction so the viz shows forward flows from first paint.
    this.recomputeSpeculative();
  }

  // Advance the sim one turn and persist. A step can throw (transfer-pool
  // exhaustion, a tripped DEV invariant); we degrade rather than crash the turn
  // UI, and skip persisting a partially-stepped world.
  step(): void {
    // Capture this turn's interstellar arrivals BEFORE stepping — the step's
    // arrivals pass drains them from the ring, so they must be read off the live
    // world first (DEV log only; skipped entirely in a production build).
    const arrivals = import.meta.env.DEV ? captureArrivals(this.engine.world) : null;
    try {
      this.engine.step();
    } catch (e) {
      if (import.meta.env.DEV) console.warn('[economy] step failed — degrading:', e);
      return;
    }
    this.stepped = true;
    this.persist();
    // The previous prediction has become reality (turn advanced); re-predict the
    // new next turn from the world we just stepped.
    this.recomputeSpeculative();
    if (import.meta.env.DEV && arrivals) this.logTurn(arrivals);
  }

  // Reconcile the live world to the current game-state facilities after a
  // build/remove, carrying stock across by Body.id. Cheap no-op when nothing
  // changed (the adopt-untouched path).
  syncFacilities(): void {
    const built = this.build(facilitiesByBodyId(), {
      world: this.engine.world,
      bodyIds: this.bodyIdByPlanet,
    });
    this.engine = built.engine;
    this.bodyIdByPlanet = built.bodyIdByPlanet;
    this.planetByBodyId = built.planetByBodyId;
    this.persist();
    // Re-predict off the RECONCILED world (the one Next Turn will actually step),
    // so a new provider's outbound lanes and a relieved deficit appear the instant
    // the edit lands — without waiting for the player to commit the turn.
    this.recomputeSpeculative();
  }

  // The selected body's economy for the sidebar: per transportable resource it
  // holds or moves — stock and intrinsic net flow always, plus trade-aware cover,
  // a shortfall reason, and a realized utilization/fill rate (from the live digest
  // once a turn has run, else the speculative next-turn one, so it shows from first
  // paint). Null if the body hosts no facility (not a sim node) or carries nothing
  // noteworthy yet.
  bodyEconomy(bodyId: string): BodyEconomyView | null {
    const p = this.planetByBodyId.get(bodyId);
    if (p === undefined) return null;
    const w = this.engine.world;
    const R = w.R;
    // The trade-aware read, when a digest exists this session.
    const pr = this.stepped ? (this.engine.getReadDigest().planets.get(asPlanet(p)) ?? null) : null;
    // The forward-looking read off the speculative next-turn world. Always has a
    // digest (the clone is stepped), so predicted cover can exist even before the
    // session's first real step — the turn-0 / post-reload baseline.
    const specPr = this.specEngine ? (this.specEngine.getReadDigest().planets.get(asPlanet(p)) ?? null) : null;
    // Intra-cluster relief the speculative next turn will deposit straight into
    // THIS body (instant, so it is NOT ledger-inbound). Folded into the inbound
    // number below (foldInboundNextTurn), so the "++ inbound next turn" cue fires
    // for an intra-system fix too, not just an interstellar haul.
    const specIntraIn = this.specEngine
      ? intraInboundByResource(this.specEngine.getLocalTransfers(), p)
      : new Map<number, number>();

    const out: ResourceLevel[] = [];
    for (let r = 0; r < R; r++) {
      const meta = this.resources.metas[r]!;
      if (meta.tier !== TransportTier.Transportable) continue; // Energy is local-only
      const i = p * R + r;
      const stockMilli = w.stock[i]!;
      const netFlowMilli = w.production[i]! - w.consumption[i]!;

      const rr = pr ? (pr.byResource.get(asResource(r)) ?? null) : null;
      // Per-resource lookup into the speculative (next-turn) digest; a missing key is
      // the neutral baseline (null), never assume the two digests share keys. Always
      // present (the clone is stepped), so it backs the forward-looking cues AND the
      // realized rates before the session's first real step.
      const sr = specPr ? (specPr.byResource.get(asResource(r)) ?? null) : null;
      const coverMilli = rr ? rr.coverMilli : null;
      const shortfall: ShortfallView | null = rr && rr.shortfall !== null
        ? { label: SHORTFALL_LABEL[rr.shortfall], fix: SHORTFALL_FIX[rr.shortfall] }
        : null;
      // Realized rate, the side this body is NET on: utilization for a net producer
      // of r (made ÷ capacity), fill for a net consumer (ate ÷ demand). Both
      // denominators are the static rate, so the % is stable across turns. Read off
      // the live digest once a turn has run, else the speculative next-turn digest —
      // so a just-placed or just-loaded body shows its rate immediately rather than
      // blank until the first Next Turn. Null only when neither digest carries the
      // resource (not this body's net side). A balanced/self-feeding body reports fill.
      const prodRate = w.production[i]!;
      const consRate = w.consumption[i]!;
      const rateRead = rr ?? sr;
      let utilizationPct: number | null = null;
      let fillPct: number | null = null;
      if (rateRead) {
        if (prodRate > consRate) utilizationPct = clamp01(rateRead.realizedProductionMilli / prodRate);
        else if (consRate > 0) fillPct = clamp01(rateRead.realizedConsumptionMilli / consRate);
      }

      const predictedCoverMilli = sr ? sr.coverMilli : null;
      // Inbound next turn = interstellar ledger-inbound (from the digest) + the
      // instant intra-cluster relief (from the speculative localTransfers); null
      // only when there's neither, preserving the no-prediction baseline.
      const inboundNextTurnMilli = foldInboundNextTurn(sr ? sr.inboundWithinHMilli : null, specIntraIn.get(r) ?? 0);

      const noteworthy = stockMilli !== 0 || netFlowMilli !== 0
        || (coverMilli !== null && coverMilli !== 0) || shortfall !== null;
      if (!noteworthy) continue;

      out.push({
        key: r as EconResource, name: meta.name, stockMilli, netFlowMilli, coverMilli, shortfall,
        utilizationPct, fillPct, predictedCoverMilli, inboundNextTurnMilli,
      });
    }
    return out.length > 0 ? { resources: out } : null;
  }

  // Aggregate economy for one cluster (= one system): per transportable resource,
  // the system's net signed balance (trade-aware cover once a digest exists this
  // session, else intrinsic production − consumption). Null when no facility sits
  // in the cluster. Summing cover gives the system's surplus/deficit AFTER its own
  // internal + cross-system trade — what a player scanning the galaxy wants: which
  // systems feed, which starve.
  systemEconomy(clusterIdx: number): SystemEconomyView | null {
    const w = this.engine.world;
    const R = w.R;
    const digest = this.stepped ? this.engine.getReadDigest() : null;
    const specDigest = this.specEngine ? this.specEngine.getReadDigest() : null;

    const net = new Array<number>(R).fill(0);
    const cover = new Array<number>(R).fill(0);
    const specCover = new Array<number>(R).fill(0);
    let hosted = false;
    for (let p = 0; p < w.planetCount; p++) {
      if (w.tombstone[p]) continue;
      if (w.star[p] !== clusterIdx) continue; // w.star is the cluster node (= our system)
      hosted = true;
      for (let r = 0; r < R; r++) net[r]! += w.production[p * R + r]! - w.consumption[p * R + r]!;
      const pr = digest ? digest.planets.get(asPlanet(p)) : undefined;
      if (pr) for (const [rid, rr] of pr.byResource) cover[rid as number]! += rr.coverMilli;
      const spr = specDigest ? specDigest.planets.get(asPlanet(p)) : undefined;
      if (spr) for (const [rid, rr] of spr.byResource) specCover[rid as number]! += rr.coverMilli;
    }
    if (!hosted) return null;

    const resources: SystemResourceLevel[] = [];
    for (let r = 0; r < R; r++) {
      const meta = this.resources.metas[r]!;
      if (meta.tier !== TransportTier.Transportable) continue;
      const netMilli = digest ? cover[r]! : net[r]!;
      if (netMilli === 0) continue;
      const predictedNetMilli = specDigest ? specCover[r]! : null;
      resources.push({ name: meta.name, netMilli, predictedNetMilli });
    }
    return resources.length > 0 ? { resources } : null;
  }

  // Every cargo lane that touches one cluster (= one system view), classified for
  // the ship-dot overlay (`buildShipLanes`, the node-pure seam). Two named accessors,
  // each reading a (ring, intra-cluster moves) pair off the SAME engine — internal
  // lanes from `getLocalTransfers` (the instant intra-system reallocation), the rest
  // from that world's transfer ring:
  //
  //   clusterFlows          — the LIVE engine (cargo in flight now + this turn's
  //                           intra deposits).
  //   predictedClusterFlows — the SPECULATIVE next-turn engine (the cargo the
  //                           economy is about to dispatch + the intra moves it will
  //                           resolve instantly). This is what the system view
  //                           draws: it shows forward flows, so a new provider's
  //                           lanes and a relieved deficit appear the instant an
  //                           edit lands — and never blank out, because the
  //                           speculative world re-dispatches every recompute even
  //                           when a structural edit dropped the live ring. Degrades
  //                           to the live engine when no prediction exists.
  clusterFlows(clusterIdx: number): ShipLane[] {
    return buildShipLanes(this.engine.world, this.engine.getLocalTransfers(), clusterIdx, this.bodyIdByPlanet);
  }

  predictedClusterFlows(clusterIdx: number): ShipLane[] {
    const e = this.specEngine ?? this.engine;
    return buildShipLanes(e.world, e.getLocalTransfers(), clusterIdx, this.bodyIdByPlanet);
  }

  // — internals —

  // DEV per-turn console digest: every facility-bearing body's realized
  // production / consumption (with the % of capacity / demand it ran at) and every
  // delivery that landed this turn, with where it came from. Interstellar arrivals
  // were captured pre-step; the instant intra-cluster moves come off the engine.
  // Grouped (collapsed) so a long game doesn't flood the console. Best-effort —
  // logging must never break a turn.
  private logTurn(interstellar: readonly ArrivalRecord[]): void {
    try {
      const digest = this.engine.getReadDigest();
      const lines = buildTurnLog({
        digest,
        world: this.engine.world,
        resources: this.resources,
        interstellar,
        intra: intraArrivals(this.engine.getLocalTransfers()),
        labelOf: (p) => this.planetLabel(p),
      });
      console.groupCollapsed(`[economy] turn ${digest.turn}`);
      for (const line of lines) console.log(line);
      console.groupEnd();
    } catch (e) {
      console.warn('[economy] turn log failed (non-fatal):', e);
    }
  }

  // A planet's display label for the log: its Body's catalog name, falling back to
  // the raw Body.id if the catalog no longer carries it (a stale save).
  private planetLabel(planet: number): string {
    const id = this.bodyIdByPlanet[planet] ?? `p${planet}`;
    const idx = indexOfBodyId(id);
    return idx >= 0 ? BODIES[idx]!.name : id;
  }

  // Refresh the speculative next-turn world from the current live world. Called
  // only on real-world change (ctor / step / syncFacilities). Clones AFTER the
  // live engine is the one Next Turn will step, so the prediction matches the
  // real next turn (the determinism guarantee). On failure the prediction is
  // dropped and the viz degrades to the live read.
  private recomputeSpeculative(): void {
    this.specEngine = cloneWorldForSpeculation(this.engine.world, this.skeleton);
    if (!this.specEngine && import.meta.env.DEV) {
      console.warn('[economy] speculative next-turn prediction unavailable — viz falls back to live');
    }
  }

  private build(facMap: ReadonlyMap<string, readonly Facility[]>, restored: Restored | null): Built {
    const projected = projectWorld(BODIES, facMap, this.starOf);

    // Restored save still describes exactly these planets → adopt it untouched,
    // preserving in-flight cargo and every derived counter.
    if (restored && sameBodyIds(restored.bodyIds, projected.bodyIdByPlanet)) {
      return this.engineFor(restored.world, projected.bodyIdByPlanet);
    }

    // Cold start, or the facility set changed → build fresh from the projection
    // and carry any prior live stock across by Body.id.
    const world = makeWorld({
      geometry: this.geometry,
      resources: this.resources,
      cfg: this.cfg,
      seed: WORLD_SEED,
      planets: projected.planets,
    });
    if (restored) {
      transplantLiveState(world, projected.bodyIdByPlanet, restored.world, restored.bodyIds);
    }
    return this.engineFor(world, projected.bodyIdByPlanet);
  }

  private engineFor(world: World, bodyIdByPlanet: readonly string[]): Built {
    enforceReach(world);
    const engine = new EconomyEngine(world, { checkInvariants: import.meta.env.DEV });
    this.stepped = false; // fresh engine carries no read digest until it steps
    const planetByBodyId = new Map<string, number>();
    bodyIdByPlanet.forEach((id, p) => planetByBodyId.set(id, p));
    return { engine, bodyIdByPlanet, planetByBodyId };
  }

  private persist(): void {
    try {
      const bytes = this.engine.serialize();
      const payload = JSON.stringify({
        v: 1,
        bodyIds: this.bodyIdByPlanet,
        bytes: base64FromBytes(bytes),
      });
      writeRaw(SIM_SAVE_KEY, payload);
    } catch {
      // serialize threw (a tripped DEV invariant) — skip this persist. Storage
      // errors are already swallowed inside writeRaw.
    }
  }

  private restore(): Restored | null {
    const raw = readRaw(SIM_SAVE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { v?: number; bodyIds?: unknown; bytes?: unknown };
      if (parsed.v !== 1 || !Array.isArray(parsed.bodyIds) || typeof parsed.bytes !== 'string') {
        return null;
      }
      const world = deserialize(this.skeleton, bytesFromBase64(parsed.bytes));
      return { world, bodyIds: parsed.bodyIds as string[] };
    } catch (e) {
      // Schema/configHash mismatch (a catalog rebuild, scale or resource change)
      // or corrupt bytes → discard and cold-start, mirroring game-state's
      // skip-on-missing load.
      if (import.meta.env.DEV) console.warn('[economy] sim save discarded (incompatible):', e);
      return null;
    }
  }
}

// Group the current save's flat facility list by Body.id for the projector. The
// values (Facility) satisfy PlacedFacility, so they pass straight through.
function facilitiesByBodyId(): Map<string, Facility[]> {
  const map = new Map<string, Facility[]>();
  for (const f of getGameState().facilities) {
    // Ownership gate (M3): an enemy-held body's facilities must NOT feed the player's
    // economy. A body with no ownership record reads as player-owned (ownerFactionId
    // default), so this is a pure no-op until an addOpponentBody / capture flips a body.
    // Applied only at build() time (ctor + syncFacilities), NOT per step() — so a future
    // ownership flip must run the facility-edit reconcile (syncFacilities) to take effect;
    // writing the BodyOwnership overlay alone leaves the projected world stale.
    if (ownerFactionId(f.bodyId) !== CONTROLLED_FACTION_ID) continue;
    const list = map.get(f.bodyId);
    if (list) list.push(f);
    else map.set(f.bodyId, [f]);
  }
  return map;
}

// Map a body to its CLUSTER's geometry node. Walk to the body's host star
// (planets/belts host on a star; moons/rings host on a body, so chase hostBodyIdx
// up to the star-hosted parent), then to that star's cluster. STAR_CLUSTERS order
// is the geometry order, so the cluster index IS the node a PlanetSpec.star needs
// — and every body in the cluster resolves to the same node, the shared pool.
function clusterNodeOfBody(body: Body): number {
  let b: Body = body;
  let guard = 0;
  while (b.hostStarIdx === null && b.hostBodyIdx !== null && guard++ < 8) {
    b = BODIES[b.hostBodyIdx]!;
  }
  if (b.hostStarIdx === null) {
    // The walk bottomed out without a star-hosted parent — a malformed host chain
    // or one deeper than the guard. Falling back to cluster 0 keeps prod resilient,
    // but it silently mislocates the body's economy into that node's pool, so make
    // it observable in DEV (mirroring the catalog/registry drift warnings).
    if (import.meta.env.DEV) {
      console.warn(`[economy] body '${body.id}' resolved to no host star (guard ${guard}); economy mapped to cluster 0`);
    }
    return clusterIndexFor(0);
  }
  return clusterIndexFor(b.hostStarIdx);
}

// Make a world use the current build's jump reach. A fresh world already does
// (makeWorld got cfg carrying REACH_UNITS); a restored save carries its OWN saved
// reach, so bump it and rebuild the jump graph — the same retune
// EconomyEngine.applyTech performs, done before the engine wraps the world.
// In-flight cargo keeps its committed leg; the next arrivals pass re-evaluates
// onward edges against the new topology.
function enforceReach(world: World): void {
  if (world.cfg.jumpRadius === REACH_UNITS) return;
  world.cfg = { ...world.cfg, jumpRadius: REACH_UNITS };
  world.topology.rebuild(world.cfg);
}

// A realized rate (realized ÷ static rate) clamped to a 0..1 display fraction. The
// rate denominators are integers > 0 at the call sites, so this only guards FP edge
// rounding — a faucet maxed at capacity must read exactly 1.0, never 1.0000001.
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

