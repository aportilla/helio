import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isqrt, ceilDiv, clampInt } from '../src/math.ts';

test('isqrt: exact for perfect squares and floors otherwise', () => {
  for (let n = 0; n < 1000; n++) {
    const r = isqrt(n);
    assert.ok(r * r <= n && (r + 1) * (r + 1) > n, `isqrt(${n}) = ${r}`);
  }
});

test('isqrt: large values stay exact within the sim domain', () => {
  for (const n of [3_600, 1_000_000, 2_499_999, 250_000_000]) {
    const r = isqrt(n);
    assert.ok(r * r <= n && (r + 1) * (r + 1) > n, `isqrt(${n}) = ${r}`);
  }
});

test('isqrt: rejects non-integers and negatives', () => {
  assert.throws(() => isqrt(-1));
  assert.throws(() => isqrt(2.5));
});

test('ceilDiv rounds up; exact divisions are unchanged', () => {
  assert.equal(ceilDiv(0, 3), 0);
  assert.equal(ceilDiv(1, 3), 1);
  assert.equal(ceilDiv(3, 3), 1);
  assert.equal(ceilDiv(4, 3), 2);
  assert.equal(ceilDiv(640, 100), 7);
  assert.throws(() => ceilDiv(5, 0));
});

test('clampInt bounds to [lo, hi]', () => {
  assert.equal(clampInt(5, 1, 10), 5);
  assert.equal(clampInt(-3, 1, 10), 1);
  assert.equal(clampInt(99, 1, 10), 10);
});
