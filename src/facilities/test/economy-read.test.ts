// Pins the node-pure read seam (economy-read.ts) the EconomyBridge delegates to:
// buildShipLanes (the system-view cargo-overlay assembly) and the M3 inbound fold.
// The plan's §8 facilities/bridge cases live here — they can't run against the
// bridge itself (it drags in the catalog + localStorage), so the load-bearing logic
// was extracted to this seam and tested on hand-built sim worlds, exactly like
// world-sync.test.ts / speculation.test.ts. The catalog never loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EconomyEngine,
  makeGeometry,
  makeWorld,
  defaultResourceTable,
  defaultBalance,
  asPlanet,
  asResource,
  type World,
  type PlanetSpec,
  type LocalTransfer,
} from '../../../sim/src/index.ts';
import { buildShipLanes, intraInboundByResource, foldInboundNextTurn } from '../economy-read.ts';

const FOOD = asResource(0);
const BODY_IDS = ['a', 'b', 'c', 'd', 'e']; // planet index → Body.id

function lt(src: number, dst: number, qtyMilli: number, res = 0): LocalTransfer {
  return { srcPlanet: asPlanet(src), dstPlanet: asPlanet(dst), resource: asResource(res), qtyMilli };
}

// 3 stars (clusters 0,1,2) on a line; planets P0,P1 in cluster 0, P2,P3 in cluster
// 1, P4 in cluster 2. jumpRadius 35 makes each 30-apart hop legal but 60 illegal, so
// a cluster 0→2 haul must relay through cluster 1 (the `through` case).
function makeTestWorld(): World {
  const geometry = makeGeometry([[0, 0, 0], [30, 0, 0], [60, 0, 0]]);
  const resources = defaultResourceTable();
  const cfg = defaultBalance({ jumpRadius: 35, maxLegTurns: 5 });
  const planets: PlanetSpec[] = [
    { star: 0 }, { star: 0 }, { star: 1 }, { star: 1 }, { star: 2 },
  ];
  return makeWorld({ geometry, resources, cfg, seed: 1, planets });
}

function mintRing(w: World, srcPlanet: number, dstPlanet: number, qtyMilli: number): void {
  const rb = w.topology.routeBetween(w.starOf(asPlanet(srcPlanet)), w.starOf(asPlanet(dstPlanet)))!;
  w.ring.mint({
    resource: FOOD, qtyMilli, srcPlanet: asPlanet(srcPlanet), dstPlanet: asPlanet(dstPlanet),
    arrivalTurn: w.turn + rb.route.legTurns[0]!, finalArrival: w.turn + rb.route.totalTurns,
    hopIndex: 0, routeRef: rb.routeRef,
  });
}

// — buildShipLanes: internal lanes from localTransfers —

test('an intra-cluster localTransfer becomes one internal lane (instant, not ringed)', () => {
  const w = makeTestWorld();
  const lanes = buildShipLanes(w, [lt(0, 1, 300)], 0, BODY_IDS);
  assert.deepEqual(lanes, [{ kind: 'internal', srcBodyId: 'a', dstBodyId: 'b', resource: FOOD, amountMilli: 300 }]);
});

test('the cluster filter drops a localTransfer whose source is in another cluster', () => {
  const w = makeTestWorld();
  // Viewing cluster 0: the cluster-1 move (P2→P3) must NOT appear.
  const lanes = buildShipLanes(w, [lt(0, 1, 300), lt(2, 3, 150)], 0, BODY_IDS);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0]!.kind, 'internal');
  assert.equal((lanes[0] as { srcBodyId: string }).srcBodyId, 'a');
});

test('a legacy same-cluster ring transfer and a fresh localTransfer merge into one lane', () => {
  const w = makeTestWorld();
  mintRing(w, 0, 1, 200); // a pre-0-turn save's same-cluster cargo, still draining
  const lanes = buildShipLanes(w, [lt(0, 1, 300)], 0, BODY_IDS);
  assert.equal(lanes.length, 1, 'one internal lane, not two');
  assert.deepEqual(lanes[0], { kind: 'internal', srcBodyId: 'a', dstBodyId: 'b', resource: FOOD, amountMilli: 500 });
});

// — buildShipLanes: inter-cluster lanes from the ring —

test('an inter-cluster ring transfer reads as outgoing from the source cluster, incoming at the dest', () => {
  const w = makeTestWorld();
  mintRing(w, 0, 2, 400); // cluster 0 → cluster 1
  const fromSrc = buildShipLanes(w, [], 0, BODY_IDS);
  assert.deepEqual(fromSrc, [{ kind: 'outgoing', srcBodyId: 'a', resource: FOOD, amountMilli: 400 }]);
  const atDst = buildShipLanes(w, [], 1, BODY_IDS);
  assert.deepEqual(atDst, [{ kind: 'incoming', dstBodyId: 'c', resource: FOOD, amountMilli: 400 }]);
});

test('a relay haul reads as through when viewed from an interior cluster', () => {
  const w = makeTestWorld();
  mintRing(w, 0, 4, 250); // cluster 0 → cluster 2, relaying through cluster 1
  const lanes = buildShipLanes(w, [], 1, BODY_IDS);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0]!.kind, 'through');
  assert.equal((lanes[0] as { resource: number }).resource, FOOD as number);
});

// — the M3 inbound fold —

test('foldInboundNextTurn: ledger inbound + instant intra relief, null only when neither', () => {
  assert.equal(foldInboundNextTurn(null, 0), null, 'no prediction + no intra → null (baseline)');
  assert.equal(foldInboundNextTurn(null, 5), 5, 'intra relief alone still surfaces');
  assert.equal(foldInboundNextTurn(0, 0), 0, 'a present-but-zero ledger row stays 0, not null');
  assert.equal(foldInboundNextTurn(3, 5), 8, 'interstellar + intra add');
});

test('intraInboundByResource sums deposits into a body, keyed by resource, filtered by planet', () => {
  const moves = [lt(0, 1, 300, 0), lt(0, 1, 50, 0), lt(0, 1, 20, 1), lt(0, 2, 999, 0)];
  const into1 = intraInboundByResource(moves, 1);
  assert.equal(into1.get(0), 350, 'two FOOD deposits into P1 sum');
  assert.equal(into1.get(1), 20, 'a different resource stays separate');
  assert.equal(into1.has(undefined as unknown as number), false);
  assert.equal(intraInboundByResource(moves, 2).get(0), 999, 'deposits into P2 are scoped to P2');
});

// — end-to-end: a real stepped engine drives the seam (the bridge's actual inputs) —

test('a stepped intra-cluster economy yields an internal lane + a positive folded inbound', () => {
  const geometry = makeGeometry([[0, 0, 0]]);
  const resources = defaultResourceTable();
  const cfg = defaultBalance({ jumpRadius: 50, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 });
  const planets: PlanetSpec[] = [
    { star: 0, stock: [5000, 0, 0, 0], production: [80, 0, 0, 0] },
    { star: 0, stock: [0, 0, 0, 0], consumption: [50, 0, 0, 0] },
  ];
  const engine = new EconomyEngine(makeWorld({ geometry, resources, cfg, seed: 7, planets }), { checkInvariants: true });
  engine.step();

  const lanes = buildShipLanes(engine.world, engine.getLocalTransfers(), 0, ['prod', 'cons']);
  assert.equal(lanes.length, 1, 'the producer→consumer move is one internal lane');
  const lane = lanes[0]!;
  if (lane.kind !== 'internal') throw new Error(`expected an internal lane, got ${lane.kind}`);
  assert.equal(lane.srcBodyId, 'prod');
  assert.equal(lane.dstBodyId, 'cons');
  assert.equal(lane.resource, FOOD);
  assert.ok(lane.amountMilli > 0);
  assert.equal(engine.world.ring.inFlightTotal, 0, 'nothing aloft — the relief is not ledger-inbound');

  // The consumer (P1)'s M3 inbound: ledger inbound is 0 (instant intra), so the cue
  // would wrongly stay silent without the fold; with it, the intra relief surfaces.
  const intraInto1 = intraInboundByResource(engine.getLocalTransfers(), 1).get(FOOD as number) ?? 0;
  assert.ok(intraInto1 > 0);
  assert.ok((foldInboundNextTurn(0, intraInto1) ?? 0) > 0, 'the cue fires for an intra-system relief');
});
