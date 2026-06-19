// Pins the node-pure per-turn DEV economy log (economy-log.ts): captureArrivals
// (the pre-step ring scan for deliveries landing this turn), intraArrivals (the
// instant intra-cluster moves), and buildTurnLog (the formatted produced/consumed +
// arrivals block). Like economy-read.test.ts, this runs the load-bearing logic on a
// hand-built / stepped sim world — the bridge itself drags in the catalog +
// localStorage, so it isn't node-testable. The catalog never loads.

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
  type PlanetSpec,
  type LocalTransfer,
} from '../../../sim/src/index.ts';
import { captureArrivals, intraArrivals, buildTurnLog } from '../economy-log.ts';

const FOOD = 0;

function lt(src: number, dst: number, qtyMilli: number, res = FOOD): LocalTransfer {
  return { srcPlanet: asPlanet(src), dstPlanet: asPlanet(dst), resource: asResource(res), qtyMilli };
}

// — intraArrivals: fold the instant intra-cluster moves into (src,dst,res) —

test('intraArrivals aggregates moves by (src,dst,res) and drops self-legs', () => {
  const recs = intraArrivals([lt(0, 1, 300), lt(0, 1, 50), lt(2, 2, 999), lt(0, 1, 10, 1)]);
  // Two FOOD deposits 0→1 merge to 350; the 0→1 of resource 1 stays separate; the
  // 2→2 self-leg is dropped.
  assert.equal(recs.length, 2);
  const food = recs.find((r) => r.resource === FOOD)!;
  assert.deepEqual(food, { srcPlanet: 0, dstPlanet: 1, resource: FOOD, qtyMilli: 350 });
  assert.ok(!recs.some((r) => r.srcPlanet === 2));
});

// — captureArrivals: the pre-step ring scan —

test('captureArrivals returns deliveries landing at their final destination this turn', () => {
  // Two clusters 30 apart, jump reach 35 ⇒ one legal hop. A producer in cluster 0
  // feeding a consumer in cluster 1 puts cargo in the ring (interstellar).
  const geometry = makeGeometry([[0, 0, 0], [30, 0, 0]]);
  const resources = defaultResourceTable();
  const cfg = defaultBalance({ jumpRadius: 35, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 });
  const planets: PlanetSpec[] = [
    { star: 0, stock: [9000, 0, 0, 0], production: [120, 0, 0, 0] },
    { star: 1, stock: [0, 0, 0, 0], consumption: [80, 0, 0, 0] },
  ];
  const engine = new EconomyEngine(makeWorld({ geometry, resources, cfg, seed: 7, planets }), { checkInvariants: true });

  // Step until cargo is aloft, then walk turns until a delivery is due. captureArrivals
  // reads the LIVE world before the next step would drain it.
  let landed = null as ReturnType<typeof captureArrivals> | null;
  for (let i = 0; i < 12; i++) {
    engine.step();
    const arr = captureArrivals(engine.world);
    if (arr.length > 0) { landed = arr; break; }
  }
  assert.ok(landed && landed.length > 0, 'a delivery should land within a few turns');
  const d = landed![0]!;
  assert.equal(d.srcPlanet, 0, 'sourced from the cluster-0 producer');
  assert.equal(d.dstPlanet, 1, 'bound for the cluster-1 consumer');
  assert.equal(d.resource, FOOD);
  assert.ok(d.qtyMilli > 0);
});

// — buildTurnLog: the formatted block —

test('buildTurnLog formats produced/consumed with capacity·demand % and tagged arrivals', () => {
  // One intra-cluster producer→consumer; after a step the digest carries realized
  // rates and the move is an instant intra arrival.
  const geometry = makeGeometry([[0, 0, 0]]);
  const resources = defaultResourceTable();
  const cfg = defaultBalance({ jumpRadius: 50, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 });
  const planets: PlanetSpec[] = [
    { star: 0, stock: [5000, 0, 0, 0], production: [80, 0, 0, 0] },
    { star: 0, stock: [0, 0, 0, 0], consumption: [50, 0, 0, 0] },
  ];
  const engine = new EconomyEngine(makeWorld({ geometry, resources, cfg, seed: 7, planets }), { checkInvariants: true });
  engine.step();

  const lines = buildTurnLog({
    digest: engine.getReadDigest(),
    world: engine.world,
    resources,
    interstellar: [],
    intra: intraArrivals(engine.getLocalTransfers()),
    labelOf: (p) => ['Producer', 'Consumer'][p] ?? `p${p}`,
  });
  const block = lines.join('\n');

  // Producer line shows a capacity %, consumer line a demand %.
  assert.match(block, /Producer:.*% cap\)/);
  // The consumer eats its intra relief the SAME turn (P7.5 residual consume), so it
  // reads 100% demand-filled on its first turn — not 0% — and the [stock N] tag
  // shows the anti-bullwhip buffer it carries forward after eating to its rate.
  assert.match(block, /Consumer:.*\(100% dem\).*\[stock /);
  // The instant intra move is an arrival, tagged intra-system, Producer → Consumer.
  assert.match(block, /arrivals \(delivered this turn\):/);
  assert.match(block, /from Producer → Consumer \(intra-system\)/);
});

test('buildTurnLog reports the empty cases rather than blank sections', () => {
  const geometry = makeGeometry([[0, 0, 0]]);
  const resources = defaultResourceTable();
  const cfg = defaultBalance();
  // A single inert planet: no production, no consumption, nothing aloft.
  const engine = new EconomyEngine(
    makeWorld({ geometry, resources, cfg, seed: 1, planets: [{ star: 0 }] }),
    { checkInvariants: true },
  );
  engine.step();

  const lines = buildTurnLog({
    digest: engine.getReadDigest(),
    world: engine.world,
    resources,
    interstellar: [],
    intra: [],
    labelOf: (p) => `p${p}`,
  });
  const block = lines.join('\n');
  assert.match(block, /\(nothing produced or consumed\)/);
  assert.match(block, /\(nothing arrived\)/);
});
