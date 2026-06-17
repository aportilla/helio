// EconomyBridge — the live wiring from placed facilities to a running economy
// sim, plus the read-back the system view draws. This (with project.ts,
// resource-vocab.ts, and sim-geometry.ts) is the app's only window onto the sim
// runtime; the boundary guard (scripts/check-sim-boundary.mjs) keeps every other
// importer out.
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
// over the sim's 1-turn local self-leg regardless of which member star they
// orbit; only crossing BETWEEN clusters costs jump range. The sim's
// system === node (1:1), so a sim "system" is exactly one of our clusters.

import { BODIES, STAR_CLUSTERS, clusterIndexFor } from '../data/stars.ts';
import type { Body } from '../data/stars.ts';
import {
  EconomyEngine,
  makeWorld,
  deserialize,
  defaultBalance,
  TransportTier,
  ThrottleReason,
  ShortfallReason,
  SHORTFALL_FIX,
  asPlanet,
  asResource,
  type World,
  type StarGeometry,
  type ResourceTable,
  type BalanceConfig,
} from '../../sim/src/index.ts';
import { getGameState, type Facility } from '../game-state.ts';
import { appResourceTable, type EconResource } from './resource-vocab.ts';
import { projectWorld } from './project.ts';
import type { SimStarResolver } from './types.ts';
import { buildGeometry, LY_TO_SIM_UNITS } from './sim-geometry.ts';
import { sameBodyIds, transplantLiveState } from './world-sync.ts';

const SIM_SAVE_KEY = 'helio.sim';

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
// per-turn balance (production − consumption, before trade), and — once the sim
// has produced a read digest this session — the trade-aware signed cover
// (+surplus / −deficit), a binding shortfall, and whether production is glutted
// (storage full). Plain app values — no sim types cross this boundary.
export interface ResourceLevel {
  readonly key: EconResource;
  readonly name: string;
  readonly stockMilli: number;
  readonly netFlowMilli: number;
  readonly coverMilli: number | null;
  readonly shortfall: ShortfallView | null;
  readonly glut: boolean;
}

export interface BodyEconomyView {
  readonly resources: readonly ResourceLevel[];
}

// A whole system's (one cluster's) net standing per resource — the galaxy
// info-card summary. Signed: + net exporter / − net importer.
export interface SystemResourceLevel {
  readonly name: string;
  readonly netMilli: number;
}

export interface SystemEconomyView {
  readonly resources: readonly SystemResourceLevel[];
}

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

  private engine: EconomyEngine;
  private bodyIdByPlanet: readonly string[];
  private planetByBodyId: ReadonlyMap<string, number>;
  // The read digest exists only after a step (it isn't serialized), so cover /
  // shortfall / glut are unavailable until the first Next Turn of a session —
  // including right after a reload. Until then the chip shows stock + intrinsic
  // flow only. Reset whenever the engine is rebuilt.
  private stepped = false;

  constructor() {
    // One geometry node per cluster, at its center of mass.
    this.geometry = buildGeometry(STAR_CLUSTERS.map((c) => c.com));
    this.resources = appResourceTable();
    this.cfg = defaultBalance({ jumpRadius: REACH_UNITS });
    this.starOf = (body) => clusterNodeOfBody(body);

    const built = this.build(facilitiesByBodyId(), this.restore());
    this.engine = built.engine;
    this.bodyIdByPlanet = built.bodyIdByPlanet;
    this.planetByBodyId = built.planetByBodyId;
    // Persist immediately so a freshly cold-started game has a save to reload.
    this.persist();
  }

  // Advance the sim one turn and persist. A step can throw (transfer-pool
  // exhaustion, a tripped DEV invariant); we degrade rather than crash the turn
  // UI, and skip persisting a partially-stepped world.
  step(): void {
    try {
      this.engine.step();
    } catch (e) {
      if (import.meta.env.DEV) console.warn('[economy] step failed — degrading:', e);
      return;
    }
    this.stepped = true;
    this.persist();
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
  }

  // The selected body's economy for the sidebar: per transportable resource it
  // holds or moves — stock and intrinsic net flow always, plus trade-aware cover,
  // a shortfall reason, and a glut flag once a turn has run this session. Null if
  // the body hosts no facility (not a sim node) or carries nothing noteworthy yet.
  bodyEconomy(bodyId: string): BodyEconomyView | null {
    const p = this.planetByBodyId.get(bodyId);
    if (p === undefined) return null;
    const w = this.engine.world;
    const R = w.R;
    // The trade-aware read, when a digest exists this session.
    const pr = this.stepped ? (this.engine.getReadDigest().planets.get(asPlanet(p)) ?? null) : null;

    const out: ResourceLevel[] = [];
    for (let r = 0; r < R; r++) {
      const meta = this.resources.metas[r]!;
      if (meta.tier !== TransportTier.Transportable) continue; // Energy is local-only
      const i = p * R + r;
      const stockMilli = w.stock[i]!;
      const netFlowMilli = w.production[i]! - w.consumption[i]!;

      const rr = pr ? (pr.byResource.get(asResource(r)) ?? null) : null;
      const coverMilli = rr ? rr.coverMilli : null;
      const shortfall: ShortfallView | null = rr && rr.shortfall !== null
        ? { label: SHORTFALL_LABEL[rr.shortfall], fix: SHORTFALL_FIX[rr.shortfall] }
        : null;
      const glut = rr ? rr.throttle === ThrottleReason.OutputFull : false;

      const noteworthy = stockMilli !== 0 || netFlowMilli !== 0
        || (coverMilli !== null && coverMilli !== 0) || shortfall !== null || glut;
      if (!noteworthy) continue;

      out.push({ key: r as EconResource, name: meta.name, stockMilli, netFlowMilli, coverMilli, shortfall, glut });
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

    const net = new Array<number>(R).fill(0);
    const cover = new Array<number>(R).fill(0);
    let hosted = false;
    for (let p = 0; p < w.planetCount; p++) {
      if (w.tombstone[p]) continue;
      if (w.star[p] !== clusterIdx) continue; // w.star is the cluster node (= our system)
      hosted = true;
      for (let r = 0; r < R; r++) net[r]! += w.production[p * R + r]! - w.consumption[p * R + r]!;
      const pr = digest ? digest.planets.get(asPlanet(p)) : undefined;
      if (pr) for (const [rid, rr] of pr.byResource) cover[rid as number]! += rr.coverMilli;
    }
    if (!hosted) return null;

    const resources: SystemResourceLevel[] = [];
    for (let r = 0; r < R; r++) {
      const meta = this.resources.metas[r]!;
      if (meta.tier !== TransportTier.Transportable) continue;
      const netMilli = digest ? cover[r]! : net[r]!;
      if (netMilli === 0) continue;
      resources.push({ name: meta.name, netMilli });
    }
    return resources.length > 0 ? { resources } : null;
  }

  // — internals —

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
      localStorage.setItem(SIM_SAVE_KEY, payload);
    } catch {
      // localStorage full/disabled (mirrors game-state/settings) — the session
      // still runs, it just won't persist.
    }
  }

  private restore(): Restored | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(SIM_SAVE_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { v?: number; bodyIds?: unknown; bytes?: unknown };
      if (parsed.v !== 1 || !Array.isArray(parsed.bodyIds) || typeof parsed.bytes !== 'string') {
        return null;
      }
      const world = deserialize(
        { geometry: this.geometry, resources: this.resources, cfg: this.cfg },
        bytesFromBase64(parsed.bytes),
      );
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
  return clusterIndexFor(b.hostStarIdx ?? 0);
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

// Browser-safe base64 of the sim's binary save (chunked so a large byte array
// can't overflow the String.fromCharCode argument stack).
function base64FromBytes(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
