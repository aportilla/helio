// Bit-stable serialize / deserialize (§10). The bytes are authoritative; derived
// caches (the ETA ledger, topology adjacency, the Dijkstra cache) are excluded
// and rebuilt on load. The append-only route table IS serialized, because
// in-flight transfers hold routeRefs into it (§3.7). A same-machine save reloads
// and a replay-from-seed reproduces history exactly — the only determinism
// envelope this single-player sim needs (cross-machine equality is cut, banner).
//
// A configHash of the static skeleton (geometry + resources + balance) rides in
// the bytes; load asserts it matches the skeleton passed in, so a save can't be
// silently reloaded against a different map or tuning.

import { makeWorld, World } from './world.ts';
import { SCHEMA_VERSION } from './constants.ts';
import type { BalanceConfig } from './constants.ts';
import type { StarGeometry } from './geometry.ts';
import type { ResourceTable } from './resources.ts';
import { asPlanet, asResource, asStar, asEdge } from './ids.ts';
import type { Route } from './topology.ts';

/** The static inputs a save is reconstructed against (excluded from the bytes). */
export interface WorldSkeleton {
  readonly geometry: StarGeometry;
  readonly resources: ResourceTable;
  readonly cfg: BalanceConfig;
}

function fnv1a(values: Iterable<number>): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    // Fold a 32-bit integer in, byte by byte.
    const x = v | 0;
    h = Math.imul(h ^ (x & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((x >>> 8) & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((x >>> 16) & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((x >>> 24) & 0xff), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function configHash(sk: WorldSkeleton): number {
  // STATIC tuning identity only. jumpRadius and travelSpeedTier are runtime tech
  // tiers (mutated by applyTech) — they are serialized as STATE, not hashed here,
  // so a save taken after researching reach/speed still loads against the same
  // skeleton. maxLegTurns IS static (it sizes the ring) and is hashed.
  const nums: number[] = [];
  const c = sk.cfg;
  nums.push(c.horizonH, c.setpointTurns, c.keepBufferTurns, c.deadbandTurns, c.emaNum, c.emaDen,
    c.cflNum, c.cflDen, c.fanInK, c.starveEscalationTurns, c.starveBoost,
    c.maxLegTurns, c.transferPoolCapacity);
  nums.push(sk.geometry.starCount);
  for (let i = 0; i < sk.geometry.starCount; i++) nums.push(sk.geometry.x[i]!, sk.geometry.y[i]!, sk.geometry.z[i]!);
  nums.push(sk.resources.count);
  for (const m of sk.resources.metas) {
    nums.push(m.id, m.tier, m.criticality, m.transferChunkMilli);
    for (let i = 0; i < m.name.length; i++) nums.push(m.name.charCodeAt(i));
  }
  return fnv1a(nums);
}

export function serialize(world: World): Uint8Array {
  const P = world.planetCount;
  const R = world.R;
  const routes = world.topology.exportRoutes();

  // Live transfers, in monotonic-id order (slot-independent bytes).
  const live: number[][] = [];
  world.ring.forEachLive((slot) => {
    live.push([
      world.ring.transferId[slot]!, world.ring.resource[slot]!, world.ring.qtyMilli[slot]!,
      world.ring.srcPlanet[slot]!, world.ring.dstPlanet[slot]!, world.ring.arrivalTurn[slot]!,
      world.ring.finalArrival[slot]!, world.ring.hopIndex[slot]!, world.ring.routeRef[slot]!,
    ]);
  });

  let routeBytes = 4;
  for (const r of routes) routeBytes += 4 + r.hops.length * 4 + r.legTurns.length * 4 + r.edgeIds.length * 4 + 4;

  // 36 fixed header + 8 for the two runtime tech tiers (jumpRadius, travelSpeedTier).
  const size = 44 + P * 4 + P + 6 * (P * R) * 4 + (P * R) + 8 + live.length * 9 * 4 + routeBytes;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  const u32 = (v: number) => { dv.setUint32(o, v >>> 0, true); o += 4; };
  const i32 = (v: number) => { dv.setInt32(o, v | 0, true); o += 4; };
  const u8 = (v: number) => { dv.setUint8(o, v & 0xff); o += 1; };

  u32(SCHEMA_VERSION);
  u32(configHash(world));
  i32(world.turn);
  const st = world.prng.getState();
  u32(st[0]); u32(st[1]); u32(st[2]); u32(st[3]);
  // Runtime tech tiers (state, not hashed) — restored + topology rebuilt on load.
  i32(world.cfg.jumpRadius); i32(world.cfg.travelSpeedTier);
  i32(P); i32(R);
  for (let p = 0; p < P; p++) i32(world.star[p]!);
  for (let p = 0; p < P; p++) u8(world.tombstone[p]!);
  const cols = [world.stock, world.production, world.consumption, world.storageCeiling, world.emaConsume, world.starveTurns];
  for (const col of cols) for (let i = 0; i < P * R; i++) i32(col[i]!);
  for (let i = 0; i < P * R; i++) u8(world.ordering[i]!);

  u32(world.ring.nextTransferId);
  i32(live.length);
  for (const rec of live) for (const v of rec) i32(v);

  i32(routes.length);
  for (const r of routes) {
    i32(r.hops.length);
    for (const h of r.hops) i32(h as number);
    for (const t of r.legTurns) i32(t);
    for (const e of r.edgeIds) i32(e as number);
    i32(r.totalTurns);
  }

  return new Uint8Array(buf);
}

export function deserialize(skeleton: WorldSkeleton, bytes: Uint8Array): World {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
  const u8 = () => { const v = dv.getUint8(o); o += 1; return v; };

  const version = u32();
  if (version !== SCHEMA_VERSION) throw new Error(`deserialize: schema ${version} != ${SCHEMA_VERSION}`);
  const hash = u32();
  if (hash !== configHash(skeleton)) throw new Error('deserialize: configHash mismatch (different map/tuning)');
  const turn = i32();
  const prngState: [number, number, number, number] = [u32(), u32(), u32(), u32()];
  const jumpRadius = i32();
  const travelSpeedTier = i32();
  const P = i32();
  const R = i32();
  if (R !== skeleton.resources.count) throw new Error('deserialize: resource count mismatch');

  const star = new Array<number>(P);
  for (let p = 0; p < P; p++) star[p] = i32();
  // Reconstruct with the STATIC skeleton config, then restore the runtime tech
  // tiers and rebuild topology so reach/speed match the saved game exactly.
  const world = makeWorld({
    geometry: skeleton.geometry, resources: skeleton.resources, cfg: skeleton.cfg, seed: 0,
    planets: star.map((s) => ({ star: s })),
  });
  world.cfg = { ...skeleton.cfg, jumpRadius, travelSpeedTier };
  world.topology.rebuild(world.cfg);

  world.turn = turn;
  world.prng.setState(prngState);
  for (let p = 0; p < P; p++) world.tombstone[p] = u8();
  const cols = [world.stock, world.production, world.consumption, world.storageCeiling, world.emaConsume, world.starveTurns];
  for (const col of cols) for (let i = 0; i < P * R; i++) col[i] = i32();
  for (let i = 0; i < P * R; i++) world.ordering[i] = u8();

  const nextTransferId = u32();
  const liveCount = i32();
  const records: number[][] = [];
  for (let k = 0; k < liveCount; k++) {
    const rec: number[] = [];
    for (let f = 0; f < 9; f++) rec.push(i32());
    records.push(rec);
  }

  const routeCount = i32();
  const routes: Route[] = [];
  for (let r = 0; r < routeCount; r++) {
    const hopCount = i32();
    const hops = [];
    for (let h = 0; h < hopCount; h++) hops.push(asStar(i32()));
    const legTurns = [];
    for (let h = 0; h < hopCount - 1; h++) legTurns.push(i32());
    const edgeIds = [];
    for (let h = 0; h < hopCount - 1; h++) edgeIds.push(asEdge(i32()));
    const totalTurns = i32();
    routes.push({ hops, legTurns, edgeIds, totalTurns });
  }
  world.topology.importRoutes(routes);

  // Restore in-flight transfers (preserving monotonic ids), then the counter.
  for (const rec of records) {
    world.ring.restoreTransfer({
      id: rec[0]!, resource: asResource(rec[1]!), qtyMilli: rec[2]!,
      srcPlanet: asPlanet(rec[3]!), dstPlanet: asPlanet(rec[4]!),
      arrivalTurn: rec[5]!, finalArrival: rec[6]!, hopIndex: rec[7]!, routeRef: rec[8]!,
    });
  }
  world.ring.nextTransferId = nextTransferId;

  // The ETA ledger is derived — rebuild it from the authoritative ring.
  world.ledger.rebuildFrom(world.ring);

  return world;
}
