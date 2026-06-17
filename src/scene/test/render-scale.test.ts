// Pins the documented dpr→N boundary table and the resolution-preference bias
// clamp. computeRenderScale/effectiveScale are pure (no window, no three), and
// they encode the project's #1 commitment — pixel-crisp integer-multiple upscale
// — so a silent boundary shift here is a visible-on-screen regression.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRenderScale, effectiveScale } from '../../render-scale.ts';

test('computeRenderScale: dpr boundaries match the documented N = round((4/3)·dpr) table', () => {
  // Just below / at each integer-N boundary (raw crosses .5 at these dprs).
  assert.equal(computeRenderScale(1.124), 1);
  assert.equal(computeRenderScale(1.125), 2); // round(1.5) = 2
  assert.equal(computeRenderScale(1.874), 2);
  assert.equal(computeRenderScale(1.875), 3); // round(2.5) = 3
  assert.equal(computeRenderScale(2), 3);     // retina → 3 (the hardcoded-behavior anchor)
  assert.equal(computeRenderScale(2.624), 3);
  assert.equal(computeRenderScale(2.625), 4); // round(3.5) = 4
  assert.equal(computeRenderScale(3), 4);
});

test('computeRenderScale: clamps to {1..4} and survives degenerate dpr', () => {
  assert.equal(computeRenderScale(10), 4);    // never exceeds 4
  assert.equal(computeRenderScale(0), 1);     // non-positive → safe dpr 1
  assert.equal(computeRenderScale(-2), 1);
  assert.equal(computeRenderScale(NaN), 1);
  assert.equal(computeRenderScale(Infinity), 1); // non-finite → safe dpr 1
});

test('effectiveScale: low=+1 / medium=auto / high=-1, clamped to {1..4}', () => {
  assert.equal(effectiveScale(3, 'medium'), 3);
  assert.equal(effectiveScale(3, 'low'), 4);
  assert.equal(effectiveScale(3, 'high'), 2);
  assert.equal(effectiveScale(2, 'low'), 3);
  assert.equal(effectiveScale(2, 'high'), 1);
  // Clamp swallows the bias at the extremes (the case the UI disables the radio for).
  assert.equal(effectiveScale(4, 'low'), 4);
  assert.equal(effectiveScale(1, 'high'), 1);
});
