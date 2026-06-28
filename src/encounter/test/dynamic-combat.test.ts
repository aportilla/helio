// Dynamic-combat demo, end to end — the laser/cannon effectiveness 2×2 and the always-on fritz shield,
// driven through the real reducer with real `gunship` loadouts (engine + laser + cannon + shield
// generator). Proves the headline play: strip a shield with the LASER (which fritzes it), then crater the
// exposed hull with the CANNON — and that firing the wrong weapon at the wrong defensive state wastes the
// shot. Pure: builds combatants from the neutral ship registry, no DOM/sim. Runs under `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createEncounterState, endPhase } from '../step.ts';
import { shipsToCombatants } from '../ships-to-combatants.ts';
import { buildEncounterSpec } from '../encounter-spec.ts';
import { ENERGY_STAT, type EncounterEvent, type EncounterState } from '../state.ts';
import type { Ship } from '../../game-state-codec.ts';

const LASER = 'small-laser:laser';
const CANNON = 'small-cannon:cannon';

const gunship = (id: string, factionId: Ship['factionId']): Ship => ({ id, systemId: 'sol', factionId, components: ['small-engine', 'small-laser', 'small-cannon', 'small-shield-generator'], name: id, status: 'ready' });
const corvette = (id: string, factionId: Ship['factionId']): Ship => ({ id, systemId: 'sol', factionId, components: ['small-engine', 'small-laser'], name: id, status: 'ready' });

// Open an encounter (no shot fired yet — the launch intent is just the initiator anchor).
const open = (initiatorId: string, ships: readonly Ship[]): EncounterState =>
  createEncounterState(buildEncounterSpec(shipsToCombatants(ships), { actorId: initiatorId, actionId: LASER, targetIds: [] }));

const bandOf = (s: EncounterState, id: string, key: string) =>
  s.combatants.find((c) => c.id === id)?.pools?.find((p) => p.key === key)?.current;
const shieldsOf = (s: EncounterState, id: string) => bandOf(s, id, 'shields');
const hullOf = (s: EncounterState, id: string) => bandOf(s, id, 'hull');
const cooldownOf = (s: EncounterState, id: string) => s.combatants.find((c) => c.id === id)?.stats?.shieldCooldown ?? 0;
const damageAmounts = (events: readonly EncounterEvent[]): number[] => events.flatMap((e) => (e.kind === 'damage' ? [e.amount] : []));

test('a gunship enters combat with a full shield band over hull (the generator installs at build)', () => {
  const s = open('p1', [gunship('p1', 'player'), gunship('r1', 'rival')]);
  const r1 = s.combatants.find((c) => c.id === 'r1')!;
  assert.deepEqual(r1.pools?.map((p) => p.key), ['shields', 'hull'], 'shields spliced above hull — absorbs first');
  assert.equal(shieldsOf(s, 'r1'), 50_000, 'shield at full capacity');
  assert.equal(hullOf(s, 'r1'), 100_000);
});

test('effectiveness 2×2: the laser shreds shields, the cannon craters hull', () => {
  // vs a FULL shield (gunship): the laser strips it (a huge hit), the cannon barely dents it.
  const shielded = open('p1', [gunship('p1', 'player'), gunship('r1', 'rival')]);
  const laserVsShield = damageAmounts(applyCommand(shielded, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] }).events)[0]!;
  const cannonVsShield = damageAmounts(applyCommand(shielded, { actorId: 'p1', actionId: CANNON, targetIds: ['r1'] }).events)[0]!;
  // vs BARE hull (corvette, no shield): the inverse — the cannon craters, the laser glances.
  const bare = open('p1', [gunship('p1', 'player'), corvette('r1', 'rival')]);
  const laserVsHull = damageAmounts(applyCommand(bare, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] }).events)[0]!;
  const cannonVsHull = damageAmounts(applyCommand(bare, { actorId: 'p1', actionId: CANNON, targetIds: ['r1'] }).events)[0]!;
  // The DYNAMIC (robust to re-tuning): each weapon dominates on its own axis.
  assert.ok(laserVsShield > cannonVsShield, 'the LASER is the shield-stripper');
  assert.ok(cannonVsHull > laserVsHull, 'the CANNON is the hull-killer');
  // The exact tuned values — pins the effectiveness cascade math end to end. The laser strips the whole 50k
  // shield and spills ~4k to hull (53999); the cannon does 50% to the shield (20000); the cannon does 140%
  // to bare hull (56000); the laser 60% (24000).
  assert.equal(laserVsShield, 53_999);
  assert.equal(cannonVsShield, 20_000);
  assert.equal(cannonVsHull, 56_000);
  assert.equal(laserVsHull, 24_000);
});

test('the laser strips the shield and FRITZES it, then the cannon craters the exposed hull', () => {
  let s = open('p1', [gunship('p1', 'player'), gunship('r1', 'rival')]);
  // 1) LASER strips r1's shield. By the time the rival phase opens, r1's generator has noticed the collapse:
  //    it drops the dead band and arms the fritz lockout. The laser barely scratched the hull behind it.
  let r = applyCommand(s, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] });
  s = r.state;
  assert.equal(shieldsOf(s, 'r1'), undefined, 'the shield band was dropped — fritzed');
  assert.ok(cooldownOf(s, 'r1') > 0, 'the fritz lockout is armed');
  const hullAfterLaser = hullOf(s, 'r1')!;
  assert.ok(hullAfterLaser > 90_000, 'the laser barely scratched hull (it is the shield weapon)');
  // 2) r1 forfeits, back to the player — the CANNON now hits the EXPOSED hull hard.
  ({ state: s } = endPhase(s));
  r = applyCommand(s, { actorId: 'p1', actionId: CANNON, targetIds: ['r1'] });
  s = r.state;
  assert.equal(damageAmounts(r.events)[0], 56_000, 'the cannon craters the unshielded hull (140%)');
  assert.equal(hullOf(s, 'r1'), hullAfterLaser - 56_000, 'hull dropped by a full cannon bite');
});

test('the shield REBOOTS to full after the fritz lockout window', () => {
  let s = open('p1', [gunship('p1', 'player'), gunship('r1', 'rival')]);
  ({ state: s } = applyCommand(s, { actorId: 'p1', actionId: LASER, targetIds: ['r1'] })); // strip + fritz r1
  assert.equal(shieldsOf(s, 'r1'), undefined, 'r1 shield is down (fritzing)');
  // Pass phases (no one fires) until r1's generator reboots its shield — within a bounded lockout window.
  let guard = 0;
  while (shieldsOf(s, 'r1') === undefined && guard++ < 12) ({ state: s } = endPhase(s));
  assert.ok(guard < 12, 'the shield rebooted within the lockout window');
  assert.equal(shieldsOf(s, 'r1'), 50_000, 'it rebooted to FULL (not a re-fritzing cold band)');
  assert.equal(cooldownOf(s, 'r1'), 0, 'the fritz timer cleared');
});

test('a partially-hit shield regenerates next phase, and the generator pays energy upkeep', () => {
  let s = open('p1', [gunship('p1', 'player'), gunship('r1', 'rival')]);
  const energyBefore = s.combatants.find((c) => c.id === 'r1')!.stats?.[ENERGY_STAT] ?? 0; // charged, not yet folded
  // A cannon does only 20k to the 50k shield (→30k); then r1's phase opens and its generator regens +15k
  // (→45k) while drawing upkeep — so the shield climbs back rather than sticking at 30k.
  ({ state: s } = applyCommand(s, { actorId: 'p1', actionId: CANNON, targetIds: ['r1'] }));
  assert.equal(shieldsOf(s, 'r1'), 45_000, 'the shield regenerated toward cap after the partial hit');
  const energyAfter = s.combatants.find((c) => c.id === 'r1')!.stats?.[ENERGY_STAT] ?? 0;
  assert.ok(energyAfter < energyBefore, 'the generator drew energy upkeep (net of recharge)');
});
