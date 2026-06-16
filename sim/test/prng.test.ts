import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prng } from '../src/prng.ts';

test('same seed → identical stream (determinism)', () => {
  const a = Prng.fromSeed(12345);
  const b = Prng.fromSeed(12345);
  for (let i = 0; i < 1000; i++) assert.equal(a.next(), b.next());
});

test('different seeds → different streams', () => {
  const a = Prng.fromSeed(1);
  const b = Prng.fromSeed(2);
  let differ = 0;
  for (let i = 0; i < 100; i++) if (a.next() !== b.next()) differ++;
  assert.ok(differ > 90, `streams should mostly differ, got ${differ}/100`);
});

test('next() stays a uint32', () => {
  const p = Prng.fromSeed(99);
  for (let i = 0; i < 10000; i++) {
    const v = p.next();
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
  }
});

test('below(bound) is in range and covers the space', () => {
  const p = Prng.fromSeed(7);
  const seen = new Set<number>();
  for (let i = 0; i < 5000; i++) {
    const v = p.below(6);
    assert.ok(v >= 0 && v < 6);
    seen.add(v);
  }
  assert.equal(seen.size, 6, 'all six outcomes should appear');
});

test('below(1) is always 0; bad bounds throw', () => {
  const p = Prng.fromSeed(7);
  for (let i = 0; i < 10; i++) assert.equal(p.below(1), 0);
  assert.throws(() => p.below(0));
  assert.throws(() => p.below(2.5));
});

test('range(lo, hi) is inclusive and bounded', () => {
  const p = Prng.fromSeed(42);
  for (let i = 0; i < 2000; i++) {
    const v = p.range(-3, 3);
    assert.ok(v >= -3 && v <= 3);
  }
});

test('getState / setState round-trips and resumes the stream', () => {
  const p = Prng.fromSeed(2024);
  for (let i = 0; i < 50; i++) p.next();
  const snap = p.getState();
  const tail = [p.next(), p.next(), p.next()];

  const q = Prng.fromSeed(0);
  q.setState(snap);
  assert.deepEqual([q.next(), q.next(), q.next()], tail);
});

test('constructor forbids the all-zero state via seeding', () => {
  const p = Prng.fromSeed(0);
  const s = p.getState();
  assert.ok((s[0] | s[1] | s[2] | s[3]) !== 0);
  // and it still produces a non-degenerate stream
  assert.notEqual(p.next(), p.next());
});
