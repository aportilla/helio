// turn-order invariants — the side-aware Press-Turn cursor (§3.8): nextActor walks the active side's
// living ships while it holds icons (round-robin within the side, re-offering a lone ship), yields when
// the pool is spent or no living same-side ship remains; nextLivingSide finds the next side that can
// act; firstLivingOfSide opens a side's phase; sideOrderOf is the deterministic rotation. Pure;
// synthetic combatants (no registry, no scene).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstActableOfSide, firstLivingOfSide, neighborActor, nextActor, nextLivingSide, sideOrderOf } from '../turn-order.ts';
import type { Combatant, EncounterState } from '../state.ts';
import type { ActionCommand } from '../../actions/types.ts';
import type { FactionType } from '../../factions/types.ts';

// hull defaults to a living value; pass 0 for a downed combatant (an empty pool band reads as 0 HP).
const c = (combatId: number, factionId: FactionType, hull = 100): Combatant => ({
  kind: 'ship', id: `c${combatId}`, combatId, factionId, classId: 'corvette', commands: [], pools: [{ key: 'hull', current: hull, max: hull }],
});
// A synthetic state at (active, phaseSide, pool). initiatorSide is irrelevant to these (no round bump),
// so it tracks phaseSide; the per-side pool is the spent-down record the cursor reads.
const at = (combatants: readonly Combatant[], activeId: number, phaseSide: FactionType, initiative: Record<FactionType, number>): EncounterState =>
  ({ combatants, activeId, round: 1, effects: [], nextEffectId: 0, initiative, phaseSide, initiatorSide: phaseSide, damageThisRound: false, disengaged: false });

test('nextActor round-robins within the active side, skipping the other side', () => {
  const cs = [c(0, 'player'), c(1, 'rival'), c(2, 'player')];
  // player phase with 2 icons: from combatId 0 the next living PLAYER is 2 (rival 1 is skipped)
  assert.equal(nextActor(at(cs, 0, 'player', { player: 2, rival: 0 })), 2);
  // from 2 it wraps cyclically back to 0 (the other player)
  assert.equal(nextActor(at(cs, 2, 'player', { player: 2, rival: 0 })), 0);
});

test('nextActor re-offers a lone living same-side ship while icons remain (a ship may act again)', () => {
  const cs = [c(0, 'player'), c(1, 'rival')];
  assert.equal(nextActor(at(cs, 0, 'player', { player: 2, rival: 0 })), 0, 'the only player ship is offered again');
});

test('nextActor yields (undefined) when the side has spent its icons', () => {
  const cs = [c(0, 'player'), c(1, 'rival')];
  assert.equal(nextActor(at(cs, 0, 'player', { player: 0, rival: 0 })), undefined);
});

test('nextActor yields when no living same-side combatant remains', () => {
  const cs = [c(0, 'player', 0), c(1, 'rival')]; // the only player is downed
  assert.equal(nextActor(at(cs, 0, 'player', { player: 1, rival: 0 })), undefined);
});

test('nextActor skips a downed same-side ship and finds a living one', () => {
  const cs = [c(0, 'player'), c(1, 'player', 0), c(2, 'player')]; // combatId 1 is down
  assert.equal(nextActor(at(cs, 0, 'player', { player: 3, rival: 0 })), 2);
});

test('nextLivingSide returns the next side that fields a living combatant, else undefined', () => {
  const cs = [c(0, 'player'), c(1, 'rival')];
  assert.equal(nextLivingSide(at(cs, 0, 'player', { player: 0, rival: 0 })), 'rival');
  assert.equal(nextLivingSide(at(cs, 0, 'rival', { player: 0, rival: 0 })), 'player');
  const eliminated = [c(0, 'player'), c(1, 'rival', 0)]; // rival down
  assert.equal(nextLivingSide(at(eliminated, 0, 'player', { player: 0, rival: 0 })), undefined);
});

test('firstLivingOfSide is the lowest-combatId living combatant of a side', () => {
  const cs = [c(0, 'player', 0), c(1, 'player'), c(2, 'rival')]; // player 0 down
  assert.equal(firstLivingOfSide(cs, 'player'), 1);
  assert.equal(firstLivingOfSide(cs, 'rival'), 2);
  assert.equal(firstLivingOfSide([c(0, 'player', 0)], 'player'), undefined);
});

test('sideOrderOf is the first-seen faction order', () => {
  assert.deepEqual(sideOrderOf([c(0, 'rival'), c(1, 'player'), c(2, 'rival')]), ['rival', 'player']);
});

// A fixed-cost attack command + a combatant carrying it with an explicit energy stat — the affordability
// inputs firstActableOfSide reads (cost ≤ energy). Energy `undefined` ⇒ no energy model ⇒ permissive.
const fire = (totalCost: number): ActionCommand => ({
  id: 'mod:fire', count: 1, totalCost,
  grant: { key: 'fire', label: 'Fire', color: '#ffffff', category: 'attack', targeting: 'single', kind: 'encounter' },
});
const armed = (combatId: number, factionId: FactionType, energy: number | undefined, cost = 9000, hull = 100): Combatant => ({
  kind: 'ship', id: `c${combatId}`, combatId, factionId, classId: 'corvette',
  commands: [fire(cost)], pools: [{ key: 'hull', current: hull, max: hull }],
  ...(energy === undefined ? {} : { stats: { energy } }),
});

test('firstActableOfSide opens on the lowest-combatId same-side ship that can afford an action', () => {
  // c0 drained (0 < 9000), c1 charged → the opener skips c0 and lands on c1; the rival is never offered.
  const cs = [armed(0, 'player', 0), armed(1, 'player', 9000), armed(2, 'rival', 9000)];
  assert.equal(firstActableOfSide(cs, 'player'), 1);
});

test('firstActableOfSide skips downed/unaffordable ships and yields undefined when the side is spent', () => {
  const spent = [armed(0, 'player', 9000, 9000, 0), armed(1, 'player', 1000)]; // c0 down, c1 can't afford
  assert.equal(firstActableOfSide(spent, 'player'), undefined);
  // A ship with no commands cannot act; a ship with no energy stat is permissively affordable (no model).
  assert.equal(firstActableOfSide([c(0, 'player')], 'player'), undefined, 'no commands ⇒ not actable');
  assert.equal(firstActableOfSide([armed(0, 'player', undefined)], 'player'), 0, 'no energy model ⇒ affordable');
});

// ── neighborActor — the player's free in-phase actor cycle (◄ ►, §3.8) ────────

test('neighborActor cycles to the next / prev living same-side ship (wrapping), skipping the other side', () => {
  const cs = [c(0, 'player'), c(1, 'rival'), c(2, 'player')];
  const st = at(cs, 0, 'player', { player: 2, rival: 0 });
  assert.equal(neighborActor(st, 1), 2, '+1 from 0 → the next player (rival 1 skipped)');
  assert.equal(neighborActor(st, -1), 2, '−1 from 0 wraps back to 2');
  assert.equal(neighborActor(at(cs, 2, 'player', { player: 2, rival: 0 }), 1), 0, '+1 from 2 wraps to 0');
});

test('neighborActor returns the lone living same-side ship itself (a no-op switch)', () => {
  const cs = [c(0, 'player'), c(1, 'rival')];
  assert.equal(neighborActor(at(cs, 0, 'player', { player: 1, rival: 0 }), 1), 0);
  assert.equal(neighborActor(at(cs, 0, 'player', { player: 1, rival: 0 }), -1), 0);
});

test('neighborActor skips a downed same-side ship', () => {
  const cs = [c(0, 'player'), c(1, 'player', 0), c(2, 'player')]; // combatId 1 is down
  assert.equal(neighborActor(at(cs, 0, 'player', { player: 3, rival: 0 }), 1), 2, '+1 from 0 skips downed 1 → 2');
  assert.equal(neighborActor(at(cs, 2, 'player', { player: 3, rival: 0 }), -1), 0, '−1 from 2 skips downed 1 → 0');
});
