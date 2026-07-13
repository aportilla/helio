// Ship-marker geometry — the pure raster + layout math behind the galaxy ship-marker overlay
// (ship-markers.ts wraps this with Three.js). Kept Three-free (only a type-only Ship import) so it
// loads cleanly under `node --test`, like selection-policy.ts. Two jobs:
//   1. triangleMask — rasterize the arrow glyph from (w, h) so the shape is a one-line tweak, never a
//      hand-drawn pixel file.
//   2. packStationedOffsets — flow a system's stationed markers into a screen-space grid beside the star,
//      reading each marker's own (w, h) so the muster reads as a little mixed-size fleet once S/M/L lands.

import type { Ship } from '../game-state-codec';

// ---- size classes (the S/M/L hook) ----------------------------------------------------------------

// A ship's marker size class. v1 renders only 'M' (shipMarkerSize stubs to it); 'S'/'L' dims are carried
// now so the real per-ship derivation is a data + one-function change, not new plumbing.
export type ShipMarkerSize = 'S' | 'M' | 'L';

export interface MarkerDims {
  readonly w: number;
  readonly h: number;
}

// Triangle dims per size class, in ENV pixels (the render-buffer grid the nearest-neighbor upscale blows
// up by N). 'M' 5×3 is the locked default eyeballed against the mockup; 'S'/'L' are proportional
// placeholders exercised only once shipMarkerSize returns them.
export const SHIP_MARKER_SIZES: Record<ShipMarkerSize, MarkerDims> = {
  S: { w: 3, h: 3 },
  M: { w: 5, h: 3 },
  L: { w: 7, h: 5 },
};

// Derive a ship's marker size class. A stub returning 'M' today; wired to the ship's components later
// (bigger hulls → 'L'), the same place energyMax / build-time derive. No marker-code change needed then.
export function shipMarkerSize(_ship: Ship): ShipMarkerSize {
  return 'M';
}

// ---- triangle rasterizer --------------------------------------------------------------------------

// Fill-rule tuning knob (the other visual knob besides (w, h)): how far a row's 1-px cell may reach past
// the triangle's continuous edge before it fills. 0 = cover-the-center (a thin arrow); 0.5 = overlap-the-
// cell (the chunky default). Raising it fattens the arrow; both this and SHIP_MARKER_SIZES are the whole
// visual surface.
export const MARKER_FILL_OVERLAP = 0.5;

// Rasterize a right-pointing filled triangle for any w×h into a row-major boolean mask (index r*w + c,
// r=0 top). Base is the full-height left column (c=0); the vertical span tapers linearly to the apex at
// the right-middle (c=w−1, row=(h−1)/2). Vertically symmetric about the mid row, so the paint step's
// canvas-Y orientation and any top/bottom flip are immaterial. The horizontal mirror (◄) is applied at
// paint time, not here.
export function triangleMask(w: number, h: number): boolean[] {
  const mask = new Array<boolean>(w * h).fill(false);
  const mid = (h - 1) / 2;
  for (let c = 0; c < w; c++) {
    // Half-extent tapers from `mid` (full height at the base) to 0 at the apex. Guard w=1 (single column
    // is the full-height base).
    const halfExtent = w > 1 ? mid * (w - 1 - c) / (w - 1) : mid;
    for (let r = 0; r < h; r++) {
      if (Math.abs(r - mid) <= halfExtent + MARKER_FILL_OVERLAP) mask[r * w + c] = true;
    }
  }
  return mask;
}

// ---- stationed grid packing -----------------------------------------------------------------------

// Grid geometry, all in ENV pixels, all hoisted so the muster's look is a one-line tweak.
// Gap between the star's on-screen disc EDGE and the formation's left edge (ENV px). The renderer adds this
// to the star's live disc radius each tick, so the muster clears the disc at every zoom.
export const STAR_MARKER_CLEARANCE_GAP = 3;
// Gap between adjacent cells, both within a column (vertical) and between columns (horizontal).
export const MARKER_CELL_GAP = 2;
// Markers stacked per column before wrapping to the next column further right.
export const MARKERS_PER_COLUMN = 3;
// Hard cap on stationed markers per system (grid wraps into extra columns until here, then silently drops;
// no "+N" overflow affordance in v1).
export const MAX_MARKERS_PER_SYSTEM = 12;

export interface MarkerOffset {
  // Formation-LOCAL offset of the marker CENTER, in ENV pixels. +X right, +Y up. The formation's left edge
  // sits at localX = 0 and it is vertically CENTERED on 0 (the star's Y). The renderer adds the horizontal
  // CLEARANCE per tick (see ShipMarkers.update) so the whole muster rides just off the star's on-screen disc
  // — which grows as you zoom in — instead of a fixed gap that the disc would overrun.
  readonly offsetX: number;
  readonly offsetY: number;
}

// Flow a system's stationed markers into a grid beside the star: columns left→right, markers stacked
// top→down within a column, wrapping after MARKERS_PER_COLUMN. Each column is **vertically centered** on the
// star (offsetY straddles 0), reading as a fleet mustered to the star's side. Consumes each marker's own
// (w, h) — a column advances by its widest member, a row by that marker's height — so a mixed-size fleet
// packs without a fixed cell. v1 is uniform (one size), but reading per-marker dims means no rework when
// S/M/L arrives. Input order is the caller's stable muster order; output is 1:1 with it. Offsets are
// formation-LOCAL (left edge at x=0); the horizontal clearance off the disc is added by the renderer.
export function packStationedOffsets(dims: readonly MarkerDims[]): MarkerOffset[] {
  const out: MarkerOffset[] = new Array(dims.length);
  let colLeftX = 0; // left edge of the current column, from the formation's left edge
  for (let i = 0; i < dims.length; i += MARKERS_PER_COLUMN) {
    const col = dims.slice(i, i + MARKERS_PER_COLUMN);
    // Center the column on the star's Y: total height straddles 0, top marker highest (+Y up).
    const colH = col.reduce((s, d) => s + d.h, 0) + (col.length - 1) * MARKER_CELL_GAP;
    let cursorTop = colH / 2; // top edge of the column
    let colMaxW = 0;
    col.forEach((d, k) => {
      out[i + k] = { offsetX: colLeftX + d.w / 2, offsetY: cursorTop - d.h / 2 };
      cursorTop -= d.h + MARKER_CELL_GAP;
      colMaxW = Math.max(colMaxW, d.w);
    });
    colLeftX += colMaxW + MARKER_CELL_GAP;
  }
  return out;
}

// Gap between faction BLOCKS in a mixed muster (ENV px) — a touch wider than the inter-cell gap so the
// controlled side (left) and the others (right) read as two groups, echoing the system view's stand-off.
export const MARKER_GROUP_GAP = 4;

// Pack several faction groups side by side into one muster: each group flows through packStationedOffsets
// into its own columns, and later groups are shifted right past the earlier ones (+ MARKER_GROUP_GAP). The
// caller passes the controlled faction FIRST so the player's ships muster on the LEFT and other factions on
// the RIGHT — the galaxy echo of the system view's player-left / opponents-right stand-off. Output is each
// group's offsets concatenated in group order (1:1 with the flattened input).
export function packStationedGroups(groups: readonly (readonly MarkerDims[])[]): MarkerOffset[] {
  const out: MarkerOffset[] = [];
  let xShift = 0;
  for (const g of groups) {
    if (g.length === 0) continue;
    const local = packStationedOffsets(g);
    let rightExtent = 0;
    local.forEach((o, i) => {
      out.push({ offsetX: o.offsetX + xShift, offsetY: o.offsetY });
      rightExtent = Math.max(rightExtent, o.offsetX + g[i]!.w / 2); // right edge of this group
    });
    xShift += rightExtent + MARKER_GROUP_GAP;
  }
  return out;
}
