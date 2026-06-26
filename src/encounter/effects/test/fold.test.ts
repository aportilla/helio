// Effect-fold invariants — collectInstalls (the deriveCommands twin), installEffects (monotonic ids,
// self-sourced, install handler pool splice + install beat), tickTurnStart (a timed instance counts
// down, and on expiry runs the expire handler to pop its shield band + emit an expire beat, touching
// ONLY the active owner; a permanent one rides on), and foldPhaseStart (a side's phaseStart outcomes:
// recharge tops EVERY living same-side ship's energy toward energyMax + emits a beat each; SideDeltas
// fold into the pool presence-not-count, living carriers only). Pure; synthetic combatants + effects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectInstalls, foldPhaseStart, installEffects, tickTurnStart, type MintRequest } from '../fold.ts';
import type { ActiveEffect, EffectInstall } from '../types.ts';
import { ENERGY_MAX_STAT, ENERGY_STAT, type Combatant, type EncounterState } from '../../state.ts';

const c = (combatId: number, factionId: Combatant['factionId'], stats?: Combatant['stats'], pools?: Combatant['pools']): Combatant => ({
  kind: 'ship', id: `c${combatId}`, combatId, factionId, classId: 'corvette', commands: [], stats, pools,
});
const stateOf = (combatants: readonly Combatant[], effects: readonly ActiveEffect[], nextEffectId = effects.length): EncounterState =>
  ({ combatants, activeId: 0, round: 1, effects, nextEffectId, initiative: { player: 0, rival: 0 }, phaseSide: 'player', initiatorSide: 'player', damageThisRound: false, disengaged: false });
const TACTICAL = (ownerId: number, id: number): ActiveEffect =>
  ({ id, key: 'tactical-command', ownerId, sourceId: ownerId, remainingCycles: -1, params: { initiative: 1 } });
const RECHARGE = (amount: number, remaining = -1): EffectInstall => ({ effectKey: 'recharge', remaining, params: { amount } });
const SHIELD = (capacity: number, remaining = 3): EffectInstall => ({ effectKey: 'shield-segment', remaining, params: { capacity } });
const energy = (s: EncounterState, combatId: number) => s.combatants[combatId]!.stats?.[ENERGY_STAT];

// The build pass: each combatant's installs, self-sourced, drawn from the monotonic counter at 0.
const selfMint = (combatants: readonly Combatant[], installsOf: (c: Combatant) => readonly EffectInstall[]) =>
  installEffects({ combatants, effects: [], nextEffectId: 0 }, combatants.flatMap((cb): MintRequest[] =>
    installsOf(cb).map((install) => ({ install, ownerId: cb.combatId, sourceId: cb.combatId }))));

test('collectInstalls flatMaps provider installs; a provider with none is a no-op', () => {
  const i1 = RECHARGE(3000);
  assert.deepEqual(collectInstalls([{ installs: [i1] }, {}, { installs: [] }]), [i1]);
});

test('installEffects assigns monotonic ids, self-sourced, per owner', () => {
  const combatants = [c(0, 'player', {}), c(1, 'rival', {})];
  const { slice } = selfMint(combatants, (cb) => (cb.combatId === 0 ? [RECHARGE(3000)] : []));
  assert.equal(slice.effects.length, 1);
  assert.deepEqual(slice.effects[0], { id: 0, key: 'recharge', ownerId: 0, sourceId: 0, remainingCycles: -1, params: { amount: 3000 } });
  assert.equal(slice.nextEffectId, 1);
});

test('the install handler splices a band stamped with the installing effect id; an install beat fires', () => {
  const combatants = [c(0, 'player', {}, [{ key: 'hull', current: 100, max: 100 }])];
  const { slice, events } = selfMint(combatants, () => [SHIELD(50)]);
  const pools = slice.combatants[0]!.pools!;
  assert.deepEqual(pools.map((p) => p.key), ['shields', 'hull'], 'shields spliced above hull');
  assert.equal(pools[0]!.sourceEffectId, slice.effects[0]!.id, 'the band carries its installing effect id');
  assert.deepEqual(events, [{ kind: 'install', combatId: 0, effectKey: 'shield-segment', effectId: 0 }]);
});

test('ids stay monotonic across a drop — an on-resolve mint never reuses a freed id', () => {
  const combatants = [c(0, 'player', {}, [{ key: 'hull', current: 100, max: 100 }])];
  const built = selfMint(combatants, () => [SHIELD(50, 1)]); // a 1-cycle band, id 0
  const ticked = tickTurnStart(stateOf(built.slice.combatants, built.slice.effects, built.slice.nextEffectId), 0);
  assert.equal(ticked.state.effects.length, 0, 'the timed band expired and dropped');
  const resolved = installEffects(
    { combatants: ticked.state.combatants, effects: ticked.state.effects, nextEffectId: ticked.state.nextEffectId },
    [{ install: SHIELD(50), ownerId: 0, sourceId: 0 }],
  );
  assert.equal(resolved.slice.effects[0]!.id, 1, 'the new band took id 1, not the freed id 0');
});

test('foldPhaseStart: recharge tops EVERY living same-side ship toward energyMax, a beat per change', () => {
  // recharge is a phaseStart effect: when a side's phase opens, every one of its ships recharges at once
  // (the per-owner stat outcome the fold applies to each carrier), each clamped to energyMax and emitting
  // an `effect` beat on a real change. The other side is untouched (only the entering side folds).
  const combatants = [
    c(0, 'player', { [ENERGY_STAT]: 1000, [ENERGY_MAX_STAT]: 9000 }),
    c(1, 'player', { [ENERGY_STAT]: 8000, [ENERGY_MAX_STAT]: 9000 }),
    c(2, 'rival', { [ENERGY_STAT]: 1000, [ENERGY_MAX_STAT]: 9000 }),
  ];
  const effects: readonly ActiveEffect[] = [
    { id: 0, key: 'recharge', ownerId: 0, sourceId: 0, remainingCycles: -1, params: { amount: 3000 } },
    { id: 1, key: 'recharge', ownerId: 1, sourceId: 1, remainingCycles: -1, params: { amount: 3000 } },
    { id: 2, key: 'recharge', ownerId: 2, sourceId: 2, remainingCycles: -1, params: { amount: 3000 } },
  ];
  const { state, events } = foldPhaseStart(stateOf(combatants, effects), 'player');
  assert.equal(energy(state, 0), 4000, 'player ship 0: 1000 + 3000');
  assert.equal(energy(state, 1), 9000, 'player ship 1: 8000 + 3000 clamped to energyMax');
  assert.equal(energy(state, 2), 1000, 'the rival ship does NOT recharge on the player phase');
  assert.equal(events.filter((e) => e.kind === 'effect' && e.effectKey === 'recharge').length, 2, 'one beat per player ship that changed');
});

test('foldPhaseStart: recharge emits NO beat for a ship already at energyMax', () => {
  const combatants = [c(0, 'player', { [ENERGY_STAT]: 9000, [ENERGY_MAX_STAT]: 9000 })];
  const full = [{ id: 0, key: 'recharge', ownerId: 0, sourceId: 0, remainingCycles: -1, params: { amount: 3000 } }] as const;
  const { state, events } = foldPhaseStart(stateOf(combatants, full), 'player');
  assert.equal(energy(state, 0), 9000, 'already full → the clamp swallows the delta');
  assert.deepEqual(events, [], 'no real change → no beat');
});

test('tickTurnStart counts down ONLY the active owner\'s timed effects', () => {
  // tickTurnStart runs at a combatant's own activation: it touches only THAT owner's effects. Two 2-cycle
  // shields, one per ship; ticking ship 1 decrements only ship 1's band.
  const band = (id: number) => ({ key: 'shields' as const, current: 50, max: 50, sourceEffectId: id });
  const combatants = [
    c(0, 'player', {}, [band(0), { key: 'hull', current: 100, max: 100 }]),
    c(1, 'rival', {}, [band(1), { key: 'hull', current: 100, max: 100 }]),
  ];
  const effects: readonly ActiveEffect[] = [
    { id: 0, key: 'shield-segment', ownerId: 0, sourceId: 0, remainingCycles: 2, params: { capacity: 50 } },
    { id: 1, key: 'shield-segment', ownerId: 1, sourceId: 1, remainingCycles: 2, params: { capacity: 50 } },
  ];
  const { state } = tickTurnStart(stateOf(combatants, effects), 1); // tick combatId 1 only
  assert.equal(state.effects.find((e) => e.id === 0)!.remainingCycles, 2, 'owner 0 untouched');
  assert.equal(state.effects.find((e) => e.id === 1)!.remainingCycles, 1, 'owner 1 decremented');
});

test('tickTurnStart: a timed effect counts down and drops at 0 (running expire); a permanent one persists', () => {
  // A 1-cycle shield drops on this tick — its expire pops the band — while a co-located PERMANENT effect
  // (a tactical-command; its phaseStart does nothing in a turn tick) rides on untouched.
  const combatants = [c(0, 'player', {}, [
    { key: 'shields', current: 50, max: 50, sourceEffectId: 1 },
    { key: 'hull', current: 100, max: 100 },
  ])];
  const effects: readonly ActiveEffect[] = [
    TACTICAL(0, 0),
    { id: 1, key: 'shield-segment', ownerId: 0, sourceId: 0, remainingCycles: 1, params: { capacity: 50 } },
  ];
  const { state, events } = tickTurnStart(stateOf(combatants, effects), 0);
  assert.deepEqual(state.effects.map((e) => e.id), [0], 'the timed shield dropped; the permanent tactical-command persists');
  assert.deepEqual(state.combatants[0]!.pools!.map((p) => p.key), ['hull'], 'the shield band popped on expiry');
  assert.ok(events.some((e) => e.kind === 'expire' && e.effectId === 1), 'an expire beat for the shield');
});

test('tickTurnStart: a multi-cycle timed effect decrements but stays', () => {
  const combatants = [c(0, 'player', {}, [{ key: 'shields', current: 50, max: 50, sourceEffectId: 0 }, { key: 'hull', current: 100, max: 100 }])];
  const timed: ActiveEffect = { id: 0, key: 'shield-segment', ownerId: 0, sourceId: 0, remainingCycles: 3, params: { capacity: 50 } };
  const { state } = tickTurnStart(stateOf(combatants, [timed]), 0);
  assert.equal(state.effects[0]!.remainingCycles, 2);
});

test('foldPhaseStart: a presence side-effect adds one icon to the side pool, regardless of carrier count', () => {
  // Two tactical-command carriers on the player side; presence-not-count → +1, NOT +2. The pool starts
  // at the fleet base the caller seeded (3 here) and the fold adds the effect tier on top.
  const combatants = [c(0, 'player'), c(1, 'player'), c(2, 'rival')];
  const base = { ...stateOf(combatants, [TACTICAL(0, 0), TACTICAL(1, 1)]), initiative: { player: 3, rival: 2 } };
  const { state } = foldPhaseStart(base, 'player');
  assert.equal(state.initiative.player, 4, 'presence: +1 once for two carriers, not +2');
  assert.equal(state.initiative.rival, 2, 'the other side is untouched');
});

test('foldPhaseStart: a downed carrier contributes no tempo (re-derived from the LIVING roster)', () => {
  const downed = c(0, 'player', undefined, [{ key: 'hull', current: 0, max: 100 }]); // 0 hull → down
  const base = { ...stateOf([downed, c(1, 'rival')], [TACTICAL(0, 0)]), initiative: { player: 1, rival: 1 } };
  const { state } = foldPhaseStart(base, 'player');
  assert.equal(state.initiative.player, 1, 'a downed tactical-command carrier adds nothing');
});

test('foldPhaseStart: only same-side carriers fold into a side pool', () => {
  // A tactical-command on the RIVAL side does not raise the PLAYER pool.
  const base = { ...stateOf([c(0, 'player'), c(1, 'rival')], [TACTICAL(1, 0)]), initiative: { player: 1, rival: 1 } };
  const { state } = foldPhaseStart(base, 'player');
  assert.equal(state.initiative.player, 1, "the rival's tactical-command does not fold into the player pool");
});
