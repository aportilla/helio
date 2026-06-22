// OverlayStack (overlay-stack.ts) — the pure push/pop/current spine AppController's
// view-swap rides on. No Three.js/DOM, so it loads cleanly under node --test. Guards
// the depth-1 (galaxy↔system/test) round-trip against the depth-N generalization that
// lets a modal sit over the system view (the encounter modal, combat plan §2.2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverlayStack } from '../overlay-stack.ts';

const ROOT = 'root';

test('an empty stack reports the root, depth 0, and no overlay', () => {
  const s = new OverlayStack<string>();
  assert.equal(s.depth, 0);
  assert.equal(s.hasOverlay, false);
  assert.equal(s.current(ROOT), ROOT);
});

test('depth-1: push makes the overlay current; pop restores the exact pre-push state', () => {
  const s = new OverlayStack<string>();
  s.push('system');
  assert.equal(s.depth, 1);
  assert.equal(s.hasOverlay, true);
  assert.equal(s.current(ROOT), 'system');

  assert.equal(s.pop(), 'system');
  assert.equal(s.depth, 0);
  assert.equal(s.hasOverlay, false);
  assert.equal(s.current(ROOT), ROOT); // identical to the empty-stack baseline
});

test('depth-2: the top overlay is current; popping returns to the layer beneath, not the root', () => {
  const s = new OverlayStack<string>();
  s.push('system');
  s.push('encounter');
  assert.equal(s.depth, 2);
  assert.equal(s.current(ROOT), 'encounter'); // topmost wins

  assert.equal(s.pop(), 'encounter');
  assert.equal(s.current(ROOT), 'system'); // back to the system view, still paused beneath
  assert.equal(s.pop(), 'system');
  assert.equal(s.current(ROOT), ROOT);
});

test('pop on an empty stack is undefined and leaves the root current', () => {
  const s = new OverlayStack<string>();
  assert.equal(s.pop(), undefined);
  assert.equal(s.depth, 0);
  assert.equal(s.current(ROOT), ROOT);
});

test('clear empties the stack and returns every overlay bottom-to-top (teardown order)', () => {
  const s = new OverlayStack<string>();
  s.push('system');
  s.push('encounter');
  assert.deepEqual(s.clear(), ['system', 'encounter']);
  assert.equal(s.depth, 0);
  assert.equal(s.hasOverlay, false);
  assert.equal(s.current(ROOT), ROOT);
});
