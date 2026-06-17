// Pins the multiple-of-N buffer floor — the single most load-bearing piece of the
// pixel-crisp identity. The browser's `image-rendering: pixelated` upscale is only
// exactly N:1 when the physical-pixel dimension is a multiple of N; otherwise one
// buffer column gets squashed and mangles any label crossing it. snapPhysToMultiple
// guarantees the multiple; this pins it for N in {1,2,3,4}.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapPhysToMultiple, contentBufferWidth } from '../viewport-math.ts';

test('snapPhysToMultiple: result is always an exact multiple of N', () => {
  for (const n of [1, 2, 3, 4]) {
    for (const cssPx of [1366, 1367, 800, 1080, 1440]) {
      for (const dpr of [1, 2, 2.5, 3]) {
        const phys = snapPhysToMultiple(cssPx, dpr, n);
        assert.equal(phys % n, 0, `phys ${phys} not a multiple of N=${n} (cssPx=${cssPx}, dpr=${dpr})`);
        // It is the floor of the ideal physical count — never overshoots.
        assert.ok(phys <= cssPx * dpr + 1e-9, 'never exceeds the true physical pixel count');
        assert.ok(cssPx * dpr - phys < n, 'discards at most N-1 physical px');
      }
    }
  }
});

test('snapPhysToMultiple: the documented mangled-column case (1366 @ dpr2, N3) lands clean', () => {
  // 1366 × 2 = 2732 physical px; 2732 / 3 = 910.67. Floored to a multiple of 3:
  const phys = snapPhysToMultiple(1366, 2, 3);
  assert.equal(phys, 2730);
  assert.equal(phys % 3, 0);
});

test('contentBufferWidth: reserves the sidebar strip, floors at 1', () => {
  assert.equal(contentBufferWidth(1000, 120), 880);
  assert.equal(contentBufferWidth(1000, 0), 1000, 'reserving nothing leaves the full width');
  assert.equal(contentBufferWidth(50, 200), 1, 'a too-wide reservation never yields a zero/negative rect');
});
