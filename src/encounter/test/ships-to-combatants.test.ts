// ships-to-combatants adapter invariants — the combat specialization of ships-to-actors: ready
// ships split by faction into sides of Combatants, the controlled-side flag, the 'building' filter,
// the dense ships-first combatId numbering, and the DERIVED loadout shared with the live view.
// Runs under `node --test` type-stripping: the Ship import is a type (erased), so only node-pure
// modules load (the registry DEV blocks are skipped — import.meta.env is undefined). Like the actor
// adapter, this pulls in no sim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipsToCombatants, shipToCombatant, combatantInstallsOnResolve, combatantEnergyMax } from '../ships-to-combatants.ts';
import type { Combatant, CombatantSide } from '../state.ts';
import { shipLoadout } from '../../actions/ships-to-actors.ts';
import type { Ship } from '../../game-state-codec.ts';

const ship = (id: string, factionId: Ship['factionId'], status: Ship['status'] = 'ready'): Ship => ({
  id,
  systemId: 'sol',
  factionId,
  classId: 'corvette',
  name: id,
  status,
});

const flat = (sides: readonly CombatantSide[]) => sides.flatMap((s) => s.combatants);

test('splits ready ships by faction, preserving first-seen faction order', () => {
  const sides = shipsToCombatants([ship('p1', 'player'), ship('r1', 'rival'), ship('p2', 'player')]);
  assert.equal(sides.length, 2);
  assert.deepEqual(sides.map((s) => s.factionId), ['player', 'rival']);
  assert.deepEqual(sides[0]!.combatants.map((c) => c.id), ['p1', 'p2']);
  assert.deepEqual(sides[1]!.combatants.map((c) => c.id), ['r1']);
});

test('marks the controlled side (factionId === CONTROLLED_FACTION_ID)', () => {
  const sides = shipsToCombatants([ship('p1', 'player'), ship('r1', 'rival')]);
  assert.equal(sides.find((s) => s.factionId === 'player')?.controlled, true);
  assert.equal(sides.find((s) => s.factionId === 'rival')?.controlled, false);
});

test("'building' ships are excluded (not in the field yet)", () => {
  const sides = shipsToCombatants([ship('p1', 'player'), ship('pb', 'player', 'building')]);
  assert.equal(sides.length, 1);
  assert.deepEqual(sides[0]!.combatants.map((c) => c.id), ['p1']);
});

test('combatId is dense and ships-first across the whole roster (faction order × ship order)', () => {
  // player seen first → its ships number 0,1; rival's ship continues at 2. The dense total order is
  // what makes the turn-order tiebreak replay-stable, independent of the id strings.
  const all = flat(shipsToCombatants([ship('p1', 'player'), ship('r1', 'rival'), ship('p2', 'player')]));
  assert.deepEqual(all.map((c) => [c.id, c.combatId]), [['p1', 0], ['p2', 1], ['r1', 2]]);
});

test('a combatant is an Actor + combat identity: kind, classId, palette, derived loadout', () => {
  const c = shipToCombatant(ship('p1', 'player'), 7);
  assert.equal(c.kind, 'ship');
  assert.equal(c.id, 'p1');
  assert.equal(c.combatId, 7);
  assert.equal(c.factionId, 'player');
  assert.equal(c.classId, 'corvette');
  // A ship shows only Attack (no flee ⇒ no Navigation; Support is the body's); same SHIP_CATEGORIES
  // as the live view.
  assert.deepEqual(c.categories, ['attack']);
  // Commands ARE the ship's derived loadout — the SAME projection the system-view actor uses, so a
  // combatant and a live-view ship offer an identical menu.
  assert.deepEqual(c.commands, shipLoadout(ship('p1', 'player')));
});

test('no ready ships → no sides', () => {
  assert.deepEqual(shipsToCombatants([]), []);
  assert.deepEqual(shipsToCombatants([ship('pb', 'player', 'building')]), []);
});

test('combatantInstallsOnResolve resolves a ship grant\'s timed installs by component, else empty', () => {
  const s = shipToCombatant(ship('p1', 'player'), 0);
  // The real shield grant on the small-shield component → its declared timed install.
  assert.deepEqual(
    combatantInstallsOnResolve(s, 'small-shield:raise-shields'),
    [{ effectKey: 'shield-segment', remaining: 3, params: { capacity: 50_000 } }],
  );
  // The laser grant now carries a one-shot `damage` install on resolve — the on-resolve path is how the
  // hit lands (no reducer attack branch). Asserted structurally so the placeholder magnitude can become a
  // real formula without churning this adapter test.
  const laser = combatantInstallsOnResolve(s, 'small-laser:laser');
  assert.equal(laser.length, 1);
  assert.equal(laser[0]!.effectKey, 'damage');
  assert.equal(laser[0]!.remaining, 0, 'a one-shot hit, never a rider');
  assert.ok((laser[0]!.params.amount ?? 0) > 0, 'a positive hit magnitude');
  // A known component + an unknown grant key → empty (no install for that grant).
  assert.deepEqual(combatantInstallsOnResolve(s, 'small-laser:no-such-grant'), []);
  // A no-colon id (whole id is the provider) and an unknown provider → empty, no throw.
  assert.deepEqual(combatantInstallsOnResolve(s, 'bareword'), []);
  assert.deepEqual(combatantInstallsOnResolve(s, 'nonexistent:foo'), []);
  // A namespaced provider id splits on the LAST colon (providerId 'a:b', key 'c') → unknown → empty.
  assert.deepEqual(combatantInstallsOnResolve(s, 'a:b:c'), []);
  // A body combatant has no ship components (its E5 producer adds bodies) → empty.
  const body: Combatant = { kind: 'body', id: 'b1', combatId: 1, factionId: 'player', bodyId: 'sol-3', commands: [] };
  assert.deepEqual(combatantInstallsOnResolve(body, 'small-shield:raise-shields'), []);
});

test('combatantEnergyMax sums the loadout component batteries (D3: a weapon carries its own battery)', () => {
  // The corvette loadout is small-engine (no battery) + small-laser (9_000) → Σ = 9_000, so a full
  // charge fires exactly one laser salvo (cost == battery). This is what seedCombatant seeds as
  // energyMax + the charged start, derived not placeholder.
  assert.equal(combatantEnergyMax(shipToCombatant(ship('p1', 'player'), 0)), 9_000);
  // A body carries no ship components until E5 → 0 (no costed grants yet, so no salvo budget needed).
  const body: Combatant = { kind: 'body', id: 'b1', combatId: 1, factionId: 'player', bodyId: 'sol-3', commands: [] };
  assert.equal(combatantEnergyMax(body), 0);
});
