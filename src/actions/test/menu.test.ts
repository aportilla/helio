// ActionMenu state-machine invariants — the two-level stack (category → command) with the
// orthogonal target LOCK on the command level (vertical = command, horizontal = target), the
// always-present Pass, and the two shipped targeting descriptors (single = player-picked among
// candidates, self = forced to the actor). After the inversion the actor carries RESOLVED
// ActionCommands (id + grant + count + totalCost); the menu reads them inline, no central lookup.
// Runs under `node --test` type-stripping.
//
// Seams not yet exercised by content: energy-cost greying, and 'all'/'multi'/'ally' targeting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionMenu, filterCandidates, type TargetResolver } from '../menu.ts';
import type { Actor, ActionCommand, ActionGrant, TargetCandidate } from '../types.ts';

const grant = (over: Partial<ActionGrant> & Pick<ActionGrant, 'key' | 'category' | 'targeting'>): ActionGrant => ({
  label: over.key,
  color: '#ffffff',
  kind: 'immediate',
  ...over,
});
const cmd = (id: string, g: ActionGrant): ActionCommand => ({ id, grant: g, count: 1, totalCost: 0 });

const attackCmd = cmd('attack', grant({ key: 'attack', label: 'Attack', category: 'attack', targeting: 'single', kind: 'encounter' }));
const fleeCmd = cmd('flee', grant({ key: 'flee', label: 'Flee', category: 'navigation', targeting: 'self' }));
const actor: Actor = { id: 'a1', commands: [attackCmd, fleeCmd] };

const enemyCands: readonly TargetCandidate[] = [
  { id: 'e1', kind: 'ship', allegiance: 'enemy', tags: [] },
  { id: 'e2', kind: 'ship', allegiance: 'enemy', tags: [] },
];
const enemies = enemyCands.map((c) => c.id); // ['e1', 'e2'] — the ids the view exposes
const resolve: TargetResolver = (command) => (command.grant.targeting === 'single' ? enemyCands : []);

const keys = (m: ActionMenu) => m.view().rows.map((r) => r.key);

test('opens at the category level with the spanned categories + an always-present Pass', () => {
  const m = new ActionMenu(actor, resolve);
  const v = m.view();
  assert.equal(v.level, 'category');
  assert.deepEqual(keys(m), ['attack', 'navigation', 'pass']);
  assert.equal(v.rows.at(-1)?.isPass, true);
  assert.equal(v.targets, undefined, 'no target axis at the category level');
});

test('drilling a category scopes into the command list with a target auto-locked', () => {
  const m = new ActionMenu(actor, resolve);
  m.enter(); // attack → command
  const v = m.view();
  assert.equal(v.level, 'command');
  assert.equal(v.selectedCategory, 'attack');
  assert.deepEqual(keys(m), ['attack']); // the weapon (its command id), not a target list
  assert.deepEqual(v.targets, enemies, 'candidate targets are live on the command level');
  assert.equal(v.targetCursor, 0, 'first target auto-locked on entry');
});

test('horizontal moves the target lock; vertical stays on the command', () => {
  const m = new ActionMenu(actor, resolve);
  m.enter();
  m.moveTarget(1);
  assert.equal(m.view().targetCursor, 1);
  m.moveTarget(1); // wraps over the 2 candidates
  assert.equal(m.view().targetCursor, 0);
  m.moveCursor(1); // only one weapon → stays
  assert.equal(m.view().cursor, 0);
});

test('confirm fires the cursored command at the LOCKED target', () => {
  const m = new ActionMenu(actor, resolve);
  m.enter();        // → command, target e1
  m.moveTarget(1);  // lock e2
  assert.deepEqual(m.confirm(), { actorId: 'a1', actionId: 'attack', targetIds: ['e2'] });
  assert.equal(m.closed, true);
});

test('enter at the command level also fires (keyboard ↵ parity)', () => {
  const m = new ActionMenu(actor, resolve);
  m.enter(); // category → command (target e1 locked)
  assert.deepEqual(m.enter(), { actorId: 'a1', actionId: 'attack', targetIds: ['e1'] });
});

test('clicking a target locks it by id', () => {
  const m = new ActionMenu(actor, resolve);
  m.enter();
  m.setTargetById('e2');
  assert.equal(m.view().targetCursor, 1);
  m.setTargetById('nope'); // non-candidate → no-op
  assert.equal(m.view().targetCursor, 1);
  assert.deepEqual(m.confirm(), { actorId: 'a1', actionId: 'attack', targetIds: ['e2'] });
});

test('back pops command → category, then cancels at the top', () => {
  const m = new ActionMenu(actor, resolve);
  m.enter();
  assert.equal(m.view().level, 'command');
  m.back();
  assert.equal(m.view().level, 'category');
  assert.equal(m.view().cursor, 0, 'parent cursor restored');
  assert.equal(m.closed, false);
  m.back();
  assert.equal(m.closed, true);
});

test('a self-targeted command locks onto the actor, never calling the resolver', () => {
  let resolverCalls = 0;
  const counting: TargetResolver = (command) => {
    resolverCalls += 1;
    return resolve(command, actor);
  };
  const m = new ActionMenu(actor, counting);
  m.setCursor(1); // navigation category
  m.enter();      // → command (flee)
  assert.deepEqual(keys(m), ['flee']);
  assert.deepEqual(m.view().targets, ['a1'], 'self targeting locks the actor');
  assert.equal(resolverCalls, 0, 'the resolver is bypassed for self targeting');
  assert.deepEqual(m.confirm(), { actorId: 'a1', actionId: 'flee', targetIds: ['a1'] });
});

test('Pass commits from the category level (confirm and enter)', () => {
  const viaConfirm = new ActionMenu(actor, resolve);
  viaConfirm.setCursor(2);
  assert.deepEqual(viaConfirm.confirm(), { actorId: 'a1', actionId: 'pass', targetIds: [] });

  const viaEnter = new ActionMenu(actor, resolve);
  viaEnter.setCursor(2);
  assert.deepEqual(viaEnter.enter(), { actorId: 'a1', actionId: 'pass', targetIds: [] });
});

test('an actor with no commands still offers Pass', () => {
  const m = new ActionMenu({ id: 'a2', commands: [] }, resolve);
  assert.deepEqual(keys(m), ['pass']);
  assert.deepEqual(m.confirm(), { actorId: 'a2', actionId: 'pass', targetIds: [] });
});

test('moveTarget is inert at the category level (no target axis there)', () => {
  const m = new ActionMenu(actor, resolve);
  m.moveTarget(1);
  assert.equal(m.view().cursor, 0);
  assert.equal(m.view().level, 'category');
});

test('a closed menu ignores further input', () => {
  const m = new ActionMenu(actor, resolve);
  m.cancel();
  assert.equal(m.enter(), null);
  assert.equal(m.confirm(), null);
  m.moveCursor(1);
  m.moveTarget(1);
  assert.equal(m.view().closed, true);
});

// -- a merged command shows its stack count in the row label (D2) ------

test('a merged command (count > 1) renders "(xN)" in its menu row', () => {
  const stacked: Actor = {
    id: 's1',
    commands: [{ ...attackCmd, count: 3 }],
  };
  const m = new ActionMenu(stacked, resolve);
  m.enter(); // attack → command
  assert.deepEqual(m.view().rows.map((r) => r.label), ['Attack (x3)']);
});

// -- the category palette (always-show, greyed when empty) -------------

// A body-shaped actor: it declares a fixed Attack + Support palette and carries only a
// Support command (establish), so Attack is an empty-but-shown category.
const establishCmd = cmd('colony:establish', grant({ key: 'establish', label: 'Establish', category: 'support', targeting: 'self' }));
const palettedActor: Actor = {
  id: 'body:5',
  commands: [establishCmd],
  categories: ['attack', 'support'],
};

test('a category palette shows ALL its categories (greyed when empty) + Pass', () => {
  const m = new ActionMenu(palettedActor, resolve);
  const v = m.view();
  assert.deepEqual(v.rows.map((r) => r.key), ['attack', 'support', 'pass']);
  assert.equal(v.rows.find((r) => r.key === 'attack')?.enabled, false, 'empty Attack is greyed');
  assert.equal(v.rows.find((r) => r.key === 'support')?.enabled, true, 'Support has establish');
});

test('a greyed (empty) palette category cannot be drilled', () => {
  const m = new ActionMenu(palettedActor, resolve);
  m.setCursor(0); // Attack — empty
  assert.equal(m.enter(), null, 'entering an empty category is a no-op');
  assert.equal(m.view().level, 'category', 'stayed at the category level');
  m.setCursor(1); // Support — has establish
  m.enter();
  assert.equal(m.view().level, 'command', 'a non-empty palette category still drills');
});

// -- energy-cost availability (D6) -------------------------------------

test('a command the actor cannot afford is greyed; an actor with no energy stat is permissive', () => {
  const costly: ActionCommand = { ...attackCmd, totalCost: 5 };
  const broke: Actor = { id: 'b1', commands: [costly], stats: { energy: 3 } };
  const flush: Actor = { id: 'b2', commands: [costly], stats: { energy: 5 } };
  const noModel: Actor = { id: 'b3', commands: [costly] }; // no stats ⇒ the bones default

  assert.equal(new ActionMenu(broke, resolve).view().rows.find((r) => r.key === 'attack')?.enabled, false);
  assert.equal(new ActionMenu(flush, resolve).view().rows.find((r) => r.key === 'attack')?.enabled, true);
  assert.equal(new ActionMenu(noModel, resolve).view().rows.find((r) => r.key === 'attack')?.enabled, true);

  // A greyed (unaffordable) command refuses to commit.
  const m = new ActionMenu(broke, resolve);
  m.enter(); // drill attack
  assert.equal(m.confirm(), null, 'an unaffordable command does not fire');
});

// -- the target criteria seam ------------------------------------------

const mixed: readonly TargetCandidate[] = [
  { id: 'enemy-colony', kind: 'body', allegiance: 'enemy', tags: ['colony'] },
  { id: 'my-colony', kind: 'body', allegiance: 'self', tags: ['colony'] },
  { id: 'enemy-ship', kind: 'ship', allegiance: 'enemy', tags: [] },
  { id: 'enemy-giant', kind: 'body', allegiance: 'enemy', tags: ['gas-giant'] },
];

test('filterCandidates: absent criteria is permissive (returns the candidates unchanged)', () => {
  assert.equal(filterCandidates(mixed, undefined, actor), mixed);
});

test('filterCandidates: a predicate selects over rich descriptors (kind/allegiance/tags)', () => {
  const enemyBodies = filterCandidates(mixed, (c) => c.allegiance === 'enemy' && c.kind === 'body', actor);
  assert.deepEqual(enemyBodies.map((c) => c.id), ['enemy-colony', 'enemy-giant']);

  // The open tag set drives arbitrarily specific rules — "only an opponent's gas giants".
  const enemyGasGiants = filterCandidates(mixed, (c) => c.allegiance === 'enemy' && c.tags.includes('gas-giant'), actor);
  assert.deepEqual(enemyGasGiants.map((c) => c.id), ['enemy-giant']);
});

test('filterCandidates: a criteria may also key off the acting actor', () => {
  // The predicate receives the Actor, so a rule can compare actor vs. candidate (e.g. never
  // target yourself) — exercised here by an id check.
  const notSelfActor = filterCandidates(mixed, (c) => c.id !== actor.id, actor);
  assert.equal(notSelfActor.length, mixed.length); // none of the mixed ids is 'a1'
});
