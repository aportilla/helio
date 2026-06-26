// step reducer invariants — state seeding, the flat placeholder attack, turn advance + round wrap, a
// non-attack pass, downing, and a full encounter run to the side-elimination terminal. Drives REAL
// ship combatants (the E1 adapter) so the command lookup (small-laser:laser is an attack;
// small-engine:flee is navigation) is exercised end to end. Runs under `node --test` type-stripping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createEncounterState, endPhase, selectActor } from '../step.ts';
import { shipsToCombatants, shipToCombatant } from '../ships-to-combatants.ts';
import { buildEncounterSpec } from '../encounter-spec.ts';
import { isTerminal } from '../terminal.ts';
import { ENERGY_STAT, isDown, withStat, type EncounterEvent, type EncounterState, type ShipCombatant } from '../state.ts';
import { deriveCommands } from '../../actions/derive.ts';
import { SHIP_CATEGORIES } from '../../actions/registry.ts';
import { COMPONENT_BY_TYPE } from '../../ships/components/registry.ts';
import { PLACEHOLDER_DAMAGE_MILLI, PLACEHOLDER_HULL_MILLI } from '../tuning.ts';
import type { Ship } from '../../game-state-codec.ts';

const LASER = 'small-laser:laser'; // an ATTACK command on the corvette loadout
const RAISE = 'small-shield:raise-shields'; // a SUPPORT command that installs a timed shield on resolve

const ship = (id: string, factionId: Ship['factionId']): Ship => ({
  id, systemId: 'sol', factionId, classId: 'corvette', name: id, status: 'ready',
});

function encounterOf(ships: readonly Ship[], initiatorId = ships[0]!.id): EncounterState {
  const sides = shipsToCombatants(ships);
  return createEncounterState(buildEncounterSpec(sides, { actorId: initiatorId, actionId: LASER, targetIds: [] }));
}
// The hull POOL's current — the bones HP that an attack depletes (combatants here carry one band).
const hullOf = (s: EncounterState, id: string) => s.combatants.find((c) => c.id === id)?.pools?.find((p) => p.key === 'hull')?.current;

test('createEncounterState stamps placeholder hull and starts at the initiator', () => {
  const s = encounterOf([ship('p1', 'player'), ship('r1', 'rival')], 'r1');
  assert.equal(s.round, 1);
  assert.equal(s.activeId, s.combatants.find((c) => c.id === 'r1')!.combatId, 'the initiator acts first');
  assert.equal(hullOf(s, 'p1'), PLACEHOLDER_HULL_MILLI);
  assert.equal(hullOf(s, 'r1'), PLACEHOLDER_HULL_MILLI);
});

test('an attack removes the flat placeholder hull and emits a damage event; the turn passes', () => {
  const s0 = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]); // p1 = combatId 0, acts first
  const { state: s1, events } = applyCommand(s0, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] });
  assert.equal(hullOf(s1, 'r1'), PLACEHOLDER_HULL_MILLI - PLACEHOLDER_DAMAGE_MILLI);
  assert.equal(hullOf(s1, 'p1'), PLACEHOLDER_HULL_MILLI, 'the attacker is untouched');
  assert.deepEqual(events, [{ kind: 'damage', source: 0, target: 1, amount: PLACEHOLDER_DAMAGE_MILLI }]);
  assert.equal(s1.activeId, 1, "now r1's turn");
  assert.equal(s1.round, 1);
});

test('the round bumps when the cursor wraps back to the top', () => {
  let s = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]);
  ({ state: s } = applyCommand(s, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] })); // active 0 → 1
  assert.equal(s.round, 1);
  ({ state: s } = applyCommand(s, { actorId: 'r1', actionId: LASER, targetIds: ['p1'] })); // active 1 → 0, wrap
  assert.equal(s.activeId, 0);
  assert.equal(s.round, 2);
});

test('a target reaching 0 hull is downed (event + isDown + terminal)', () => {
  // Bring r1 one hit from death, then land it.
  const base = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]);
  const low: EncounterState = {
    ...base,
    combatants: base.combatants.map((c) =>
      c.id === 'r1' ? { ...c, pools: [{ key: 'hull', current: PLACEHOLDER_DAMAGE_MILLI, max: PLACEHOLDER_HULL_MILLI }] } : c),
  };
  const { state, events } = applyCommand(low, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] });
  assert.equal(hullOf(state, 'r1'), 0);
  assert.ok(events.some((e) => e.kind === 'down' && e.combatId === 1), 'a down event for r1');
  assert.equal(isDown(state.combatants.find((c) => c.id === 'r1')!), true);
  assert.equal(isTerminal(state), true, 'rival eliminated → terminal');
});

test('an attack on an unpooled target is a visible 0-damage hit that never downs it (the reducer stays total)', () => {
  const base = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]);
  const unpooled: EncounterState = { ...base, combatants: base.combatants.map((c) => (c.id === 'r1' ? { ...c, pools: undefined } : c)) };
  const { state, events } = applyCommand(unpooled, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] });
  assert.ok(events.some((e) => e.kind === 'damage' && e.target === 1 && e.amount === 0), 'a visible 0-damage hit');
  assert.ok(!events.some((e) => e.kind === 'down'), 'no down event');
  assert.equal(isDown(state.combatants.find((c) => c.id === 'r1')!), false, 'an unpooled target cannot be downed');
});

test('an attack with multiple targets hits each in target order', () => {
  const s = encounterOf([ship('p1', 'player'), ship('r1', 'rival'), ship('r2', 'rival')]); // p1=0, r1=1, r2=2
  const { state, events } = applyCommand(s, { actorId: 'p1', actionId: LASER, targetIds: ['r1', 'r2'] });
  assert.equal(hullOf(state, 'r1'), PLACEHOLDER_HULL_MILLI - PLACEHOLDER_DAMAGE_MILLI);
  assert.equal(hullOf(state, 'r2'), PLACEHOLDER_HULL_MILLI - PLACEHOLDER_DAMAGE_MILLI);
  assert.deepEqual(events, [
    { kind: 'damage', source: 0, target: 1, amount: PLACEHOLDER_DAMAGE_MILLI },
    { kind: 'damage', source: 0, target: 2, amount: PLACEHOLDER_DAMAGE_MILLI },
  ]);
});

test('an attack stacks duplicate target ids cumulatively (the per-target rebind, not a stale snapshot)', () => {
  // r1 starts at exactly two hits of hull and is named twice in ONE intent → 0 hull, downed. If the
  // loop re-read the original snapshot each iteration, the second hit would compute off 2×DMG too.
  const base = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]);
  const low: EncounterState = {
    ...base,
    combatants: base.combatants.map((c) =>
      c.id === 'r1' ? { ...c, pools: [{ key: 'hull', current: 2 * PLACEHOLDER_DAMAGE_MILLI, max: PLACEHOLDER_HULL_MILLI }] } : c),
  };
  const { state, events } = applyCommand(low, { actorId: 'p1', actionId: LASER, targetIds: ['r1', 'r1'] });
  assert.equal(hullOf(state, 'r1'), 0, 'both hits landed cumulatively');
  assert.deepEqual(events, [
    { kind: 'damage', source: 0, target: 1, amount: PLACEHOLDER_DAMAGE_MILLI },
    { kind: 'damage', source: 0, target: 1, amount: PLACEHOLDER_DAMAGE_MILLI },
    { kind: 'down', combatId: 1 },
  ]);
});

test('a combatant spends its salvo energy firing, then recharges at its side phase start', () => {
  // p1 (combatId 0) acts first on a charged start (energy = energyMax). Firing the laser spends its full
  // salvo (cost == energyMax), draining p1 to 0; a full round later the player phase re-opens and
  // small-engine's declared 3000 recharge folds at that PHASE start (foldPhaseStart). For a lone-ship
  // side, phase-start and the ship's own activation coincide; the multi-ship test below shows they differ.
  let s = applyCommand(
    encounterOf([ship('p1', 'player'), ship('r1', 'rival')]),
    { actorId: 'p1', actionId: LASER, targetIds: ['r1'] }, // p1 fires → drains to 0 → r1's phase
  ).state;
  assert.equal(s.combatants.find((c) => c.id === 'p1')!.stats?.[ENERGY_STAT], 0, 'firing spent p1\'s full salvo (no recharge during r1\'s phase)');
  s = applyCommand(s, { actorId: 'r1', actionId: LASER, targetIds: ['p1'] }).state; // r1 acts → wraps → player phase opens
  assert.equal(s.combatants.find((c) => c.id === 'p1')!.stats?.[ENERGY_STAT], 3000, 'p1 recharged 3000 at the player phase start');
});

test('recharge folds at the SIDE phase start for ALL its ships, not per-activation', () => {
  // The user-facing rule (§3.8.5): when the baton returns to a side, EVERY one of its ships recharges at
  // once — not just the ship that acts, and not mid-phase. Two player ships share ONE initiative icon
  // (floor(2 × ½)), so the side acts ONCE per phase; p2 is drained but never activated, yet still
  // recharges at the player phase start (a per-activation turnStart tick would leave it untouched).
  const base = encounterOf([ship('p1', 'player'), ship('p2', 'player'), ship('r1', 'rival')]);
  let s: EncounterState = { ...base, combatants: base.combatants.map((c) => (c.id === 'p2' ? withStat(c, ENERGY_STAT, 1000) : c)) };
  const energyOf = (id: string) => s.combatants.find((c) => c.id === id)!.stats?.[ENERGY_STAT];
  s = applyCommand(s, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] }).state; // p1 spends the side's lone icon → rival phase
  assert.equal(energyOf('p2'), 1000, 'p2 does NOT recharge mid-phase (it was never activated)');
  s = applyCommand(s, { actorId: 'r1', actionId: LASER, targetIds: ['p1'] }).state; // r1 acts → wraps → player phase opens
  assert.equal(energyOf('p2'), 4000, 'p2 recharged 3000 at the player phase start despite never acting');
  assert.equal(energyOf('p1'), 3000, 'p1 (which fired) also recharged at that same phase start');
});

test('a self shield absorbs before hull, then expires after 3 of its owner\'s cycles', () => {
  // p1 flies a small-engine (no action — recharge only) + a small-shield (raise-shields); r1 is a plain
  // corvette (laser). Built inline because the small-shield component is live in the registry, just not on
  // the corvette default loadout (engine + laser).
  const p1Commands = deriveCommands([
    { id: 'small-engine', grants: COMPONENT_BY_TYPE.get('small-engine')!.grants },
    { id: 'small-shield', grants: COMPONENT_BY_TYPE.get('small-shield')!.grants },
  ]);
  const p1: ShipCombatant = { kind: 'ship', id: 'p1', combatId: 0, factionId: 'player', classId: 'corvette', commands: p1Commands, categories: SHIP_CATEGORIES };
  const r1 = shipToCombatant(ship('r1', 'rival'), 1);
  const spec = buildEncounterSpec(
    [{ factionId: 'player', controlled: true, combatants: [p1] }, { factionId: 'rival', controlled: false, combatants: [r1] }],
    { actorId: 'p1', actionId: RAISE, targetIds: [] },
  );
  let s = createEncounterState(spec);

  // p1 raises shields → a `shields` band splices ABOVE hull, plus an install beat.
  const raised = applyCommand(s, { actorId: 'p1', actionId: RAISE, targetIds: [] });
  s = raised.state;
  const shielded = s.combatants.find((c) => c.id === 'p1')!;
  assert.deepEqual(shielded.pools?.map((p) => p.key), ['shields', 'hull'], 'the shield sits above hull (absorbs first)');
  assert.ok(raised.events.some((e) => e.kind === 'install' && e.effectKey === 'shield-segment'), 'an install event fired');
  // Raising shields is a NON-ATTACK command: it deals no damage and passes the turn (its only beat is the
  // install). This is the standalone "non-attack passes" coverage now that there is no pure-pass flee.
  assert.ok(!raised.events.some((e) => e.kind === 'damage'), 'a support command deals no damage');
  assert.equal(s.activeId, 1, 'the non-attack command passed the turn to r1');
  const cap = shielded.pools!.find((p) => p.key === 'shields')!.max;

  // r1 attacks p1 → the shield eats the hit; hull is untouched behind it.
  ({ state: s } = applyCommand(s, { actorId: 'r1', actionId: LASER, targetIds: ['p1'] }));
  const hit = s.combatants.find((c) => c.id === 'p1')!;
  assert.equal(hit.pools?.find((p) => p.key === 'shields')?.current, cap - PLACEHOLDER_DAMAGE_MILLI, 'the shield absorbed the hit');
  assert.equal(hit.pools?.find((p) => p.key === 'hull')?.current, PLACEHOLDER_HULL_MILLI, 'hull is untouched behind the shield');

  // Run turns (p1 ends its phase, r1 attacks) until the band is gone — it ticks at p1's turn starts and
  // pops on the 3rd (3→2→1→0 → expire). p1 never re-shields, so exactly one band lives the whole time.
  const expires: EncounterEvent[] = [];
  let guard = 0;
  while (s.combatants.find((c) => c.id === 'p1')!.pools!.some((p) => p.key === 'shields') && guard++ < 12) {
    const active = s.combatants[s.activeId]!;
    const res = active.id === 'p1'
      ? endPhase(s) // p1 has no attack and there is no flee — it forfeits its phase to advance the round
      : applyCommand(s, { actorId: 'r1', actionId: LASER, targetIds: ['p1'] });
    s = res.state;
    for (const e of res.events) if (e.kind === 'expire') expires.push(e);
  }
  assert.ok(expires.some((e) => e.kind === 'expire' && e.effectKey === 'shield-segment'), 'the shield expired');
  assert.equal(s.combatants.find((c) => c.id === 'p1')!.pools!.some((p) => p.key === 'shields'), false, 'the band popped on expiry');
  assert.ok(!isDown(s.combatants.find((c) => c.id === 'p1')!), 'p1 survived — the shield bought time');
});

test('runs a full encounter to the side-elimination terminal', () => {
  let s = encounterOf([ship('p1', 'player'), ship('r1', 'rival')]);
  let guard = 0;
  while (!isTerminal(s) && guard++ < 100) {
    const active = s.combatants[s.activeId]!;
    const enemy = s.combatants.find((c) => c.factionId !== active.factionId && !isDown(c));
    assert.ok(enemy, 'a living enemy exists while not terminal');
    ({ state: s } = applyCommand(s, { actorId: active.id, actionId: LASER, targetIds: [enemy!.id] }));
  }
  assert.ok(isTerminal(s));
  assert.ok(guard < 100, 'terminated well before the guard');
  const livingFactions = new Set(s.combatants.filter((c) => !isDown(c)).map((c) => c.factionId));
  assert.equal(livingFactions.size, 1, 'exactly one side left standing');
});

// ── Press-Turn initiative (§3.8) ─────────────────────────────────────────────

test('createEncounterState seeds per-side initiative and opens on the initiator side', () => {
  const s = encounterOf([ship('p1', 'player'), ship('r1', 'rival')], 'p1');
  assert.equal(s.phaseSide, 'player');
  assert.equal(s.initiatorSide, 'player');
  assert.equal(s.initiative.player, 1, '1 ship → max(1, floor(½)) = 1');
  assert.equal(s.initiative.rival, 1);
});

test('the fleet→icons ratio throttles a side (3 ships → 1 icon, not one per ship)', () => {
  const s = encounterOf([ship('p1', 'player'), ship('p2', 'player'), ship('p3', 'player'), ship('r1', 'rival')], 'p1');
  assert.equal(s.initiative.player, 1, 'floor(½ × 3) = 1');
});

test('a side with 2 icons activates twice in one phase, then the phase passes', () => {
  // 4 player ships → floor(½ × 4) = 2 icons; r1 absorbs two 40k hits (80k < 100k hull) and survives.
  let s = encounterOf(
    [ship('p1', 'player'), ship('p2', 'player'), ship('p3', 'player'), ship('p4', 'player'), ship('r1', 'rival')],
    'p1',
  );
  assert.equal(s.initiative.player, 2);
  ({ state: s } = applyCommand(s, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] }));
  assert.equal(s.phaseSide, 'player', 'one icon left → still the player phase');
  assert.equal(s.initiative.player, 1);
  assert.equal(s.combatants[s.activeId]!.factionId, 'player', 'a second player ship is now active (round-robin within the side)');
  const second = s.combatants[s.activeId]!.id;
  ({ state: s } = applyCommand(s, { actorId: second, actionId: LASER, targetIds: ['r1'] }));
  assert.equal(s.phaseSide, 'rival', 'both icons spent → the phase passed to the rival');
});

test('endPhase forfeits the side\'s remaining icons and hands the phase over (End Round)', () => {
  // 4 player ships → 2 icons; End Round before spending forfeits both (no banking, I6).
  let s = encounterOf(
    [ship('p1', 'player'), ship('p2', 'player'), ship('p3', 'player'), ship('p4', 'player'), ship('r1', 'rival')],
    'p1',
  );
  assert.equal(s.initiative.player, 2);
  ({ state: s } = endPhase(s));
  assert.equal(s.phaseSide, 'rival', 'the phase passed despite unspent icons');
});

test('a full round with no damage from either side mutually disengages', () => {
  let s = encounterOf([ship('p1', 'player'), ship('r1', 'rival')], 'p1');
  assert.equal(isTerminal(s), false);
  ({ state: s } = endPhase(s)); // player ends → rival phase, still round 1
  assert.equal(s.phaseSide, 'rival');
  assert.equal(isTerminal(s), false, 'one side passing is not yet terminal');
  ({ state: s } = endPhase(s)); // rival ends → wraps to the initiator: a damage-free round
  assert.equal(s.disengaged, true);
  assert.equal(isTerminal(s), true, 'a damage-free round mutually disengages');
});

test('a damage-dealing round does NOT disengage (the accumulator resets each round)', () => {
  let s = encounterOf([ship('p1', 'player'), ship('r1', 'rival')], 'p1');
  ({ state: s } = applyCommand(s, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] })); // player deals damage
  ({ state: s } = endPhase(s)); // rival ends its phase → wrap to player
  assert.equal(s.disengaged, false, 'damage this round keeps it off the mutual-disengage terminal');
  assert.equal(s.round, 2);
});

test('a tactical-command effect refills a side to base + 1 at its phase start (presence tempo)', () => {
  // Ride a permanent tactical-command on p1 (as the module's build-time install would). After a full
  // round wraps back to the player, its phase re-folds: fleet base(1) + presence(1) = 2.
  let s = encounterOf([ship('p1', 'player'), ship('r1', 'rival')], 'p1');
  s = {
    ...s,
    effects: [...s.effects, { id: s.nextEffectId, key: 'tactical-command', ownerId: 0, sourceId: 0, remainingCycles: -1, params: { initiative: 1 } }],
    nextEffectId: s.nextEffectId + 1,
  };
  ({ state: s } = applyCommand(s, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] })); // player → rival
  ({ state: s } = applyCommand(s, { actorId: 'r1', actionId: LASER, targetIds: ['p1'] })); // rival → wrap to player
  assert.equal(s.phaseSide, 'player');
  assert.equal(s.initiative.player, 2, 'fleet base 1 + tactical-command 1');
});

test('selectActor re-points to a chosen living same-side combatant; no icon spent (free actor choice)', () => {
  // 4 player ships → 2 icons; the player jumps the cursor to p3 instead of the round-robin next.
  let s = encounterOf([ship('p1', 'player'), ship('p2', 'player'), ship('p3', 'player'), ship('p4', 'player'), ship('r1', 'rival')], 'p1');
  const p3 = s.combatants.find((c) => c.id === 'p3')!.combatId;
  const before = s.initiative.player;
  s = selectActor(s, p3);
  assert.equal(s.activeId, p3, 'the cursor moved to the chosen ship');
  assert.equal(s.initiative.player, before, 'selecting spends no icon');
});

test('selectActor rejects an enemy, downed, or out-of-range pick (state unchanged by reference)', () => {
  const s = encounterOf([ship('p1', 'player'), ship('p2', 'player'), ship('r1', 'rival')], 'p1');
  const r1 = s.combatants.find((c) => c.id === 'r1')!.combatId;
  const p2 = s.combatants.find((c) => c.id === 'p2')!.combatId;
  assert.equal(selectActor(s, r1), s, 'cannot select an enemy during the player phase');
  assert.equal(selectActor(s, 99), s, 'an out-of-range combatId is a no-op');
  assert.equal(selectActor(s, s.activeId), s, 'the already-active actor is a no-op (same ref)');
  const downed: EncounterState = { ...s, combatants: s.combatants.map((c) => (c.id === 'p2' ? { ...c, pools: [{ key: 'hull', current: 0, max: PLACEHOLDER_HULL_MILLI }] } : c)) };
  assert.equal(selectActor(downed, p2), downed, 'cannot select a downed same-side ship');
});

test('a malformed intent is a strict no-op — no icon spent, no turn advance (the AI/replay guard)', () => {
  // DEV throws (import.meta.env undefined under node --test, so the prod no-op path runs). An unknown
  // action on the active actor, and an unknown actor, both leave the state IDENTICAL — a stale intent
  // can't silently drain tempo or skip a phase.
  const s0 = encounterOf([ship('p1', 'player'), ship('r1', 'rival')], 'p1');
  const badAction = applyCommand(s0, { actorId: 'p1', actionId: 'small-laser:no-such-grant', targetIds: ['r1'] });
  assert.equal(badAction.state, s0, 'unknown action: state returned unchanged');
  assert.deepEqual(badAction.events, []);
  const badActor = applyCommand(s0, { actorId: 'ghost', actionId: LASER, targetIds: ['r1'] });
  assert.equal(badActor.state, s0, 'unknown actor: state returned unchanged');
  assert.deepEqual(badActor.events, []);
});
