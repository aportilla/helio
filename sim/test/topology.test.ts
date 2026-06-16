import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Topology } from '../src/topology.ts';
import { makeGeometry } from '../src/geometry.ts';
import { defaultBalance } from '../src/constants.ts';
import { asStar } from '../src/ids.ts';

function line(xs: number[]) {
  return makeGeometry(xs.map((x) => [x, 0, 0] as const));
}

const A = asStar(0), H = asStar(1), C = asStar(2);

test('edgeId is stable and symmetric across rebuilds', () => {
  const topo = new Topology(line([0, 30, 60]), defaultBalance({ jumpRadius: 50, maxLegTurns: 5 }));
  const e1 = topo.edgeId(A, H);
  assert.equal(e1, topo.edgeId(H, A), 'unordered: edge(a,b) == edge(b,a)');
  topo.rebuild(defaultBalance({ jumpRadius: 50, maxLegTurns: 5, travelSpeedTier: 1 }));
  assert.equal(topo.edgeId(A, H), e1, 'edge id survives a rebuild');
});

test('leg turns: 1 at zero distance, monotonic, capped at maxLegTurns', () => {
  const topo = new Topology(line([0, 30, 60, 100]), defaultBalance({ jumpRadius: 100, maxLegTurns: 8 }));
  assert.equal(topo.legTurns(A, A), 1);
  const near = topo.legTurns(asStar(0), asStar(1)); // d=30
  const far = topo.legTurns(asStar(0), asStar(3)); // d=100 == radius
  assert.ok(near < far, 'farther leg costs more turns');
  assert.equal(far, 8, 'a leg at the jump limit costs maxLegTurns');
});

test('edgeExists gates on the jump radius', () => {
  const topo = new Topology(line([0, 30, 60]), defaultBalance({ jumpRadius: 50, maxLegTurns: 5 }));
  assert.ok(topo.edgeExists(A, H), 'd=30 <= 50');
  assert.ok(!topo.edgeExists(A, C), 'd=60 > 50 — no direct leg');
});

test('routeBetween: direct when reachable, multi-leg when not', () => {
  const topo = new Topology(line([0, 30, 60]), defaultBalance({ jumpRadius: 50, maxLegTurns: 5 }));
  const direct = topo.routeBetween(A, H)!;
  assert.equal(direct.route.hops.length, 2, 'A→H is a single leg');
  assert.equal(direct.route.totalTurns, 3);

  const relay = topo.routeBetween(A, C)!;
  assert.deepEqual(relay.route.hops.map((h) => h as number), [0, 1, 2], 'A→C relays through H');
  assert.equal(relay.route.totalTurns, 6, '3 + 3');
  assert.equal(relay.route.totalTurns, topo.reachTurns(A, C));
});

test('routeBetween returns null for a disconnected star', () => {
  const topo = new Topology(line([0, 30, 60, 5000]), defaultBalance({ jumpRadius: 50, maxLegTurns: 5 }));
  assert.equal(topo.routeBetween(A, asStar(3)), null, 'far star is unreachable');
  assert.equal(topo.reachTurns(A, asStar(3)), Infinity);
});

test('reachability ≡ route existence (rule 5) — a hub bridges a gap', () => {
  // A and C are 60 apart (> 50). With only A and C, C is unreachable.
  const noBridge = new Topology(line([0, 60]), defaultBalance({ jumpRadius: 50, maxLegTurns: 5 }));
  assert.equal(noBridge.routeBetween(asStar(0), asStar(1)), null);
  // Insert a waypoint at 30: now a chain of legal legs exists.
  const bridged = new Topology(line([0, 30, 60]), defaultBalance({ jumpRadius: 50, maxLegTurns: 5 }));
  assert.ok(bridged.routeBetween(asStar(0), asStar(2)) !== null);
});

test('route table interns: same pair → same routeRef', () => {
  const topo = new Topology(line([0, 30, 60]), defaultBalance({ jumpRadius: 50, maxLegTurns: 5 }));
  const r1 = topo.routeBetween(A, C)!.routeRef;
  const r2 = topo.routeBetween(A, C)!.routeRef;
  assert.equal(r1, r2);
  assert.equal(topo.getRoute(r1).totalTurns, 6);
});

test('speed tier lowers turns on existing edges, never below 1', () => {
  const base = new Topology(line([0, 30, 60]), defaultBalance({ jumpRadius: 50, maxLegTurns: 5 }));
  const slow = base.legTurns(A, H); // 3
  base.rebuild(defaultBalance({ jumpRadius: 50, maxLegTurns: 5, travelSpeedTier: 1 }));
  assert.equal(base.legTurns(A, H), slow - 1, 'one tier removes one turn');
  base.rebuild(defaultBalance({ jumpRadius: 50, maxLegTurns: 5, travelSpeedTier: 10 }));
  assert.equal(base.legTurns(A, H), 1, 'floored at 1');
});
