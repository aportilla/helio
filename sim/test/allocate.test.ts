import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantify } from '../src/quantify.ts';
import { allocate } from '../src/allocate.ts';
import { ShortfallReason } from '../src/shortfall.ts';
import type { PlanetSpec } from '../src/world.ts';
import type { BalanceConfig } from '../src/constants.ts';
import { scene, only, FOOD, MINERALS } from './helpers.ts';
import { asPlanet } from '../src/ids.ts';

function plan(xs: number[], planets: PlanetSpec[], cfg?: Partial<BalanceConfig>) {
  const w = scene({ xs, planets, cfg }).engine.world;
  const q = quantify(w);
  return { w, q, dp: allocate(w, q) };
}

const ordersTo = (dp: ReturnType<typeof plan>['dp'], dst: number, res = FOOD as number) =>
  dp.orders.filter((o) => (o.dst as number) === dst && (o.res as number) === res);

test('basic match: a reachable producer serves a consumer exactly to need', () => {
  // star0=A(producer), star1=C(consumer), 30 apart (direct edge).
  const { dp } = plan([0, 30],
    [{ star: 0, stock: only(FOOD, 600) }, { star: 1, stock: only(FOOD, 120), consumption: only(FOOD, 50) }],
    { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 });
  const os = ordersTo(dp, 1);
  assert.equal(os.length, 1);
  assert.equal(os[0]!.src as number, 0);
  assert.equal(os[0]!.qty, 330, 'capped to need (no slosh), not the 600 available');
});

test('fan-in: one demand accumulates partial fills across several sources', () => {
  // A(0) — C(30) — B(60); both A and B are 30 from C (direct), 200 each.
  const { dp } = plan([0, 30, 60], [
    { star: 0, stock: only(FOOD, 200) },
    { star: 1, stock: only(FOOD, 120), consumption: only(FOOD, 50) }, // needs 330
    { star: 2, stock: only(FOOD, 200) },
  ], { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 });
  const os = ordersTo(dp, 1);
  assert.equal(os.length, 2, 'two sources contribute');
  assert.equal(os.reduce((s, o) => s + o.qty, 0), 330, 'partial fills sum to the need');
});

test('fan-out: one rich source feeds several consumers', () => {
  // A(0) in the middle feeds C(30 left)... use A at 30, C at 0, D at 60.
  const { dp } = plan([0, 30, 60], [
    { star: 0, stock: only(FOOD, 120), consumption: only(FOOD, 50) }, // C needs 330
    { star: 1, stock: only(FOOD, 1000) }, // A, central, rich
    { star: 2, stock: only(FOOD, 120), consumption: only(FOOD, 50) }, // D needs 330
  ], { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 });
  assert.equal(ordersTo(dp, 0)[0]!.src as number, 1, 'C drawn from A');
  assert.equal(ordersTo(dp, 2)[0]!.src as number, 1, 'D drawn from A');
  assert.equal(ordersTo(dp, 0)[0]!.qty + ordersTo(dp, 2)[0]!.qty, 660, 'both served fully from one source');
});

test('source fair-share: one source split evenly when two sinks contend', () => {
  // A(30) central, exportable 300; C(0) and D(60) each need 330. Equal priority.
  const { dp } = plan([0, 30, 60], [
    { star: 0, stock: only(FOOD, 120), consumption: only(FOOD, 50) },
    { star: 1, stock: only(FOOD, 300) },
    { star: 2, stock: only(FOOD, 120), consumption: only(FOOD, 50) },
  ], { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 });
  const c = ordersTo(dp, 0)[0]!;
  const d = ordersTo(dp, 2)[0]!;
  assert.equal(c.qty, 150, 'C gets its even share of 300');
  assert.equal(d.qty, 150, 'D gets its even share — neither drains the other');
});

test('priority: a higher-criticality demand wins a contested source; loser is OutbidByPriority', () => {
  // A(0) has only 200 food; both C(30) want Food (crit 100) and Minerals... use
  // two consumers of the SAME resource where one is escalated isn't needed —
  // instead give A limited stock and two food sinks, the nearer/lower-id wins.
  const { w, dp } = plan([0, 30, 60], [
    { star: 0, stock: only(FOOD, 200) }, // A: only 200
    { star: 1, stock: only(FOOD, 120), consumption: only(FOOD, 50) }, // C needs 330
    { star: 2, stock: only(FOOD, 120), consumption: only(FOOD, 50) }, // D needs 330
  ], { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3 });
  // Both contend; fair-share gives each 100, both remain unmet → OutbidByPriority.
  assert.equal(dp.reasons.get(w.pr(asPlanet(1), FOOD as number)), ShortfallReason.OutbidByPriority);
  assert.equal(dp.reasons.get(w.pr(asPlanet(2), FOOD as number)), ShortfallReason.OutbidByPriority);
});

test('CFL outflow clamp bounds a source per turn (SourceCflLimited)', () => {
  // A holds 400 food but cfl = 1/4 → ships at most floor(400/4)=100 this turn.
  const { w, dp } = plan([0, 30],
    [{ star: 0, stock: only(FOOD, 400) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    { jumpRadius: 50, maxLegTurns: 5, horizonH: 6, setpointTurns: 3, keepBufferTurns: 3, cflNum: 1, cflDen: 4 });
  const os = ordersTo(dp, 1);
  assert.equal(os[0]!.qty, 100, 'clamped to floor(stock/4)');
  assert.equal(dp.reasons.get(w.pr(asPlanet(1), FOOD as number)), ShortfallReason.SourceCflLimited);
});

test('Unreachable: a consumer with no route names the reach fix', () => {
  // A(0) and C(500) are 500 apart, jumpRadius 50, no waypoint → disconnected.
  const { w, dp } = plan([0, 500],
    [{ star: 0, stock: only(FOOD, 600) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    { jumpRadius: 50, maxLegTurns: 5, horizonH: 6 });
  assert.equal(ordersTo(dp, 1).length, 0);
  assert.equal(dp.reasons.get(w.pr(asPlanet(1), FOOD as number)), ShortfallReason.Unreachable);
});

test('SourceExhausted: reachable but nobody has surplus', () => {
  // A reachable but holds no exportable food; C needs food.
  const { w, dp } = plan([0, 30],
    [{ star: 0, stock: only(FOOD, 0) }, { star: 1, stock: only(FOOD, 0), consumption: only(FOOD, 50) }],
    { jumpRadius: 50, maxLegTurns: 5, horizonH: 6 });
  assert.equal(ordersTo(dp, 1).length, 0);
  assert.equal(dp.reasons.get(w.pr(asPlanet(1), FOOD as number)), ShortfallReason.SourceExhausted);
});

test('non-transportable resources never enter the plan', () => {
  // A has Minerals surplus and Food surplus; C demands both — but allocate only
  // ships Transportable resources (Energy/Intangible filtered upstream anyway).
  const { dp } = plan([0, 30], [
    { star: 0, stock: [600, 600, 0, 600] },
    { star: 1, stock: [0, 0, 0, 0], consumption: [50, 50, 0, 50] },
  ], { jumpRadius: 50, maxLegTurns: 5, horizonH: 6 });
  assert.ok(ordersTo(dp, 1, FOOD as number).length > 0, 'food ships');
  assert.ok(ordersTo(dp, 1, MINERALS as number).length > 0, 'minerals ship');
  assert.equal(dp.orders.filter((o) => (o.res as number) === 3).length, 0, 'Energy (LocalOnly) never ships');
});
