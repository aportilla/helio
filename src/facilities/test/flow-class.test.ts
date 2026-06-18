// Pins the within / to / from / through classification behind the cargo-ship
// overlay — the 2×2 of (source here? × destination here?) plus the relay case.
// hops is a transfer's full route as a cluster chain (endpoints included).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFlow } from '../flow-class.ts';

test('within: both endpoints in the viewed cluster (a same-system self-leg)', () => {
  assert.deepEqual(classifyFlow(3, 3, 3, [3, 3]), { kind: 'internal' });
});

test('from: source in the viewed cluster, destination elsewhere', () => {
  assert.deepEqual(classifyFlow(3, 7, 3, [3, 5, 7]), { kind: 'outgoing' });
});

test('to: destination in the viewed cluster, source elsewhere', () => {
  assert.deepEqual(classifyFlow(7, 3, 3, [7, 5, 3]), { kind: 'incoming' });
});

test('to/from never include within: a both-endpoints-here flow is internal, not from', () => {
  // src in is checked before "from", but a within flow has dst in too — it must
  // resolve to internal, the top-left 2x2 cell, not outgoing.
  assert.equal(classifyFlow(4, 4, 4, [4, 4]).kind, 'internal');
});

test('through: neither endpoint here, but the route relays across this cluster', () => {
  // 2 -> 5 -> 9, viewing 5: a relay. entry 2 < exit 9 -> left-to-right.
  assert.deepEqual(classifyFlow(2, 9, 5, [2, 5, 9]), { kind: 'through', dir: 'ltr', entry: 2, exit: 9 });
});

test('through direction flips with the entry/exit order', () => {
  assert.deepEqual(classifyFlow(9, 2, 5, [9, 5, 2]), { kind: 'through', dir: 'rtl', entry: 9, exit: 2 });
});

test('through carries its corridor (entry,exit) so distinct corridors stay distinct', () => {
  const a = classifyFlow(1, 8, 5, [1, 5, 8]);
  const b = classifyFlow(3, 6, 5, [3, 5, 6]);
  assert.equal(a.kind, 'through');
  assert.equal(b.kind, 'through');
  // Same viewed cluster + same direction, but different corridors.
  assert.notDeepEqual(a, b);
});

test('none: an unrelated transfer whose route never touches this cluster', () => {
  assert.deepEqual(classifyFlow(2, 9, 5, [2, 7, 9]), { kind: 'none' });
});

test('a longer relay route still resolves the cluster as an interior hop', () => {
  // 1 -> 4 -> 5 -> 8, viewing 5: interior. entry 4 < exit 8 -> ltr.
  assert.deepEqual(classifyFlow(1, 8, 5, [1, 4, 5, 8]), { kind: 'through', dir: 'ltr', entry: 4, exit: 8 });
});
