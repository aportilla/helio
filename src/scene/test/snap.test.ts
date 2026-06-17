// Pins the parity-aware pixel snap — the invariant whose own comment warns it is
// "NOT interchangeable with snapPx": an even-diameter disc must center on a pixel
// boundary (integer), an odd-diameter disc on a pixel center (integer+0.5). A
// half-pixel slip here is the canonical pixel-crisp violation (sub-pixel blur).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapPx, snapPxParity, bandZ } from '../system-diagram/geom/snap.ts';

test('snapPxParity: even diameter centers on an integer, odd on integer+0.5', () => {
  // Even → nearest integer.
  assert.equal(snapPxParity(10.3, 4), 10);
  assert.equal(snapPxParity(10.7, 4), 11);
  assert.equal(snapPxParity(10.3, 4) % 1, 0);
  // Odd → floor + 0.5 (always lands on a pixel center).
  assert.equal(snapPxParity(10.3, 5), 10.5);
  assert.equal(snapPxParity(10.9, 5), 10.5);
  assert.equal(snapPxParity(11.0, 5), 11.5);
  assert.equal(snapPxParity(10.3, 5) % 1, 0.5);
});

test('snapPx: plain round-to-nearest-integer', () => {
  assert.equal(snapPx(10.4), 10);
  assert.equal(snapPx(10.6), 11);
  assert.equal(snapPx(10.5), 11); // round half up
});

test('bandZ: higher row draws on top, layer sub-offset orders within a row, stride is constant', () => {
  assert.ok(bandZ(2, 0) > bandZ(1, 0), 'a higher row index → larger world z (drawn on top)');
  assert.ok(bandZ(1, +1) > bandZ(1, -1), 'positive layerZ draws over the disc, negative under');
  // Constant per-row stride (no baked numeric value — assert the relationship).
  assert.equal(bandZ(3, 0) - bandZ(2, 0), bandZ(2, 0) - bandZ(1, 0));
});
