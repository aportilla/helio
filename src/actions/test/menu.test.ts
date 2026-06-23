// ActionMenu state-machine invariants — the two-level stack (category → command) with the
// orthogonal target LOCK on the command level (vertical = command, horizontal = target), the
// always-present Pass, and the two shipped targeting descriptors (single = player-picked among
// candidates, self = forced to the actor). Runs under `node --test` type-stripping.
//
// Seams not yet exercised by content: isAvailable greying, and 'all'/'multi'/'ally' targeting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionMenu, type TargetResolver } from '../menu.ts';
import type { Actor } from '../types.ts';

const actor: Actor = { id: 'a1', commands: [{ id: 'attack' }, { id: 'flee' }] };
const enemies = ['e1', 'e2'];
const resolve: TargetResolver = (def) => (def.targeting === 'single' ? enemies : []);

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
  assert.deepEqual(keys(m), ['attack']); // the weapon, not a target list
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
  const counting: TargetResolver = (def) => {
    resolverCalls += 1;
    return resolve(def, actor);
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
