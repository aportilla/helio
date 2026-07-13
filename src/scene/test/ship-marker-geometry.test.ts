// Pins the pure ship-marker geometry — the triangle rasterizer's default shape and the stationed-grid
// packer. These are the visual knobs (a fill-rule / size tweak reshapes the glyph) and the layout math the
// overlay renders verbatim, so both are worth freezing against silent regression. Three-free, so it loads
// cleanly under node --test (like selection-policy.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  triangleMask,
  packStationedOffsets,
  packStationedGroups,
  SHIP_MARKER_SIZES,
  MARKER_CELL_GAP,
  MARKER_GROUP_GAP,
  MARKERS_PER_COLUMN,
  type MarkerDims,
} from '../ship-marker-geometry.ts';

// Render a mask as a #/· grid string, row 0 first — the exact form the plan's D3 diagram uses.
function show(mask: boolean[], w: number, h: number): string {
  const rows: string[] = [];
  for (let r = 0; r < h; r++) {
    let row = '';
    for (let c = 0; c < w; c++) row += mask[r * w + c] ? '#' : '·';
    rows.push(row);
  }
  return rows.join('\n');
}

test('triangleMask: default 5×3 is the chunky arrow from D3', () => {
  const { w, h } = SHIP_MARKER_SIZES.M;
  assert.deepEqual([w, h], [5, 3]);
  assert.equal(show(triangleMask(w, h), w, h), [
    '###··',
    '#####',
    '###··',
  ].join('\n'));
});

test('triangleMask: symmetric top↔bottom about the mid row', () => {
  const w = 5, h = 3;
  const mask = triangleMask(w, h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      assert.equal(mask[r * w + c], mask[(h - 1 - r) * w + c], `row ${r} vs ${h - 1 - r}, col ${c}`);
    }
  }
});

test('triangleMask: base column full, apex column only the mid row', () => {
  const w = 5, h = 3;
  const mask = triangleMask(w, h);
  for (let r = 0; r < h; r++) assert.equal(mask[r * w + 0], true, `base col row ${r}`);
  assert.equal(mask[1 * w + (w - 1)], true, 'apex mid row');
  assert.equal(mask[0 * w + (w - 1)], false, 'apex top row');
  assert.equal(mask[2 * w + (w - 1)], false, 'apex bottom row');
});

test('triangleMask: 1×1 degenerate is a single filled texel (no divide-by-zero)', () => {
  assert.deepEqual(triangleMask(1, 1), [true]);
});

test('packStationedOffsets: a lone marker is vertically centered, local X = half its width', () => {
  const M: MarkerDims = SHIP_MARKER_SIZES.M;
  const [first] = packStationedOffsets([M]);
  assert.ok(first);
  assert.equal(first.offsetX, M.w / 2, 'first column left edge at local X = 0 (clearance is added by the renderer)');
  assert.equal(first.offsetY, 0, 'a single-marker column centers on the star Y');
});

test('packStationedOffsets: a column is vertically centered on the star (symmetric, top→down)', () => {
  const M: MarkerDims = SHIP_MARKER_SIZES.M;
  const offs = packStationedOffsets(Array.from({ length: MARKERS_PER_COLUMN }, () => M));
  // Same X down the column; Y strictly descends; the column straddles 0 symmetrically.
  for (let i = 1; i < MARKERS_PER_COLUMN; i++) {
    assert.equal(offs[i]!.offsetX, offs[0]!.offsetX, `row ${i} same X`);
    assert.ok(offs[i]!.offsetY < offs[i - 1]!.offsetY, `row ${i} lower`);
  }
  assert.equal(offs[0]!.offsetY, -offs[MARKERS_PER_COLUMN - 1]!.offsetY, 'top and bottom mirror about 0');
});

test('packStationedOffsets: wraps to a new column further right, re-centered', () => {
  const M: MarkerDims = SHIP_MARKER_SIZES.M;
  const offs = packStationedOffsets(Array.from({ length: MARKERS_PER_COLUMN + 1 }, () => M));
  const wrapped = offs[MARKERS_PER_COLUMN]!;
  assert.equal(wrapped.offsetX, offs[0]!.offsetX + M.w + MARKER_CELL_GAP, 'column advanced by width + gap');
  assert.equal(wrapped.offsetY, 0, 'the new (single-marker) column re-centers on the star Y');
});

test('packStationedOffsets: empty in → empty out', () => {
  assert.deepEqual(packStationedOffsets([]), []);
});

test('packStationedGroups: the second faction block sits entirely right of the first (+ group gap)', () => {
  const M: MarkerDims = SHIP_MARKER_SIZES.M;
  const mine = [M, M, M, M, M]; // 5 → two columns (3 + 2)
  const others = [M];           // 1 → one column
  const offs = packStationedGroups([mine, others]);
  assert.equal(offs.length, mine.length + others.length);
  // Rightmost edge of the first (player) block.
  const mineRight = Math.max(...offs.slice(0, mine.length).map((o) => o.offsetX + M.w / 2));
  const otherLeft = offs[mine.length]!.offsetX - M.w / 2; // left edge of the first "other" marker
  assert.ok(otherLeft >= mineRight, 'other faction starts at or past the player block right edge');
  assert.equal(otherLeft, mineRight + MARKER_GROUP_GAP, 'separated by exactly the group gap');
});

test('packStationedGroups: a single group equals packStationedOffsets (no shift), empties skipped', () => {
  const M: MarkerDims = SHIP_MARKER_SIZES.M;
  const dims = [M, M];
  assert.deepEqual(packStationedGroups([dims]), packStationedOffsets(dims));
  assert.deepEqual(packStationedGroups([[], dims]), packStationedOffsets(dims));
});
