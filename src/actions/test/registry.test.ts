// The action vocabulary's central remainder after the inversion — the menu-injected Pass
// primitive, the per-actor-TYPE category palettes, and the grant-keyed display helpers. There is
// no longer an ACTION_DEFS registry / ActionType union to guard; the frozen wire contract now
// lives on the providers (FacilityType + each grant key) and is exercised by their suites. Runs
// under `node --test` (type-stripping): the ActionCommand import is erased, so only the node-pure
// registry leaf loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PASS_ACTION_ID,
  PASS_LABEL,
  SHIP_CATEGORIES,
  BODY_CATEGORIES,
  commandLabel,
  commandColor,
} from '../registry.ts';
import type { ActionCategory, ActionCommand } from '../types.ts';

const command = (count: number): ActionCommand => ({
  id: 'missile-battery:missile',
  grant: { key: 'missile', label: 'Missile', color: '#ffb24d', category: 'attack', targeting: 'single', kind: 'encounter' },
  count,
  totalCost: 0,
});

test('Pass is a bare, provider-less id with a stable label', () => {
  assert.equal(PASS_ACTION_ID, 'pass', 'the injected decline verb keeps its plain wire form');
  assert.equal(PASS_LABEL, 'Pass');
});

test('the category palettes are well-formed subsets of the category vocabulary', () => {
  const valid: ReadonlySet<ActionCategory> = new Set(['attack', 'support', 'navigation']);
  for (const [name, palette] of [['ship', SHIP_CATEGORIES], ['body', BODY_CATEGORIES]] as const) {
    assert.equal(new Set(palette).size, palette.length, `${name} palette has a duplicate category`);
    for (const c of palette) assert.ok(valid.has(c), `${name} palette has an unknown category '${c}'`);
  }
  // The shipped split: a ship navigates + attacks, a body supports + attacks (never navigates).
  assert.deepEqual([...SHIP_CATEGORIES].sort(), ['attack', 'navigation']);
  assert.deepEqual([...BODY_CATEGORIES].sort(), ['attack', 'support']);
});

test('commandLabel suffixes the stack count only when more than one merged (D2)', () => {
  assert.equal(commandLabel(command(1)), 'Missile', 'a single command shows the bare label');
  assert.equal(commandLabel(command(3)), 'Missile (x3)', 'a merged command shows its count');
});

test('commandColor reads the grant accent (a well-formed sRGB hex)', () => {
  const color = commandColor(command(1));
  assert.equal(color, '#ffb24d');
  assert.match(color, /^#[0-9a-fA-F]{6}$/);
});
