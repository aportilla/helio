// Facilities layer — a horizontal row of square color-tiles painted over each
// body that carries placed facilities, one tile per facility. The system view's
// at-a-glance "what's built here" readout, a peer to the sidebar's facility list.
//
// Static, unlike the ships layer: tiles are written at layout time (resize) and
// on facility edits (SystemDiagram.syncFacilities), never per frame. Each tile is
// a single snapped Points vertex — `color` carries the fill tint, `aSize` the
// edge length, `aRound` which corners to round — and `facilityChipMat` paints the
// gold frame, the 1-px inner shadow, and the dithered diagonal fill gradient per
// pixel (the look lives in that material's CHIP_* constants). Tiles in a row
// OVERLAP by FACILITY_ICON_OVERLAP px so adjacent frame columns coincide (one
// connected strip with a shared edge per junction); the rounding flag suppresses
// the chamfer on the abutting sides so only the row's outer ends round. Like the
// ships, the tiles run depthTest:false at a renderOrder between the bodies and the
// cargo dots, so they paint over every body but under the traffic. Fill color
// comes straight from the registry (facilityColor) — ColorManagement is OFF, so
// the hex lands verbatim.
//
// Reads placed facilities from the game-state store directly (same accessor the
// owning SystemScene uses to feed the sidebar), so a resize re-reads and the tiles
// persist; an add/remove edit re-runs layout() via SystemDiagram.syncFacilities.
//
// The geometry + material are built EAGERLY in the constructor (not lazily on the
// first tile): facilityChipMat registers in the snapped-viewport registry, and the
// first ViewportSizer.apply must reach it to seed uViewport — a material registered
// later (mid-layout) would keep uViewport (0,0) until the next resize and snap its
// vertices to NaN. Same reason the ships layer builds in its constructor.

import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Points } from 'three';
import type { Scene, ShaderMaterial } from 'three';
import { BODIES } from '../../../data/stars';
import { FACILITY_BY_TYPE, facilityColor, type FacilityType } from '../../../facilities';
import { facilitiesOnBody } from '../../../game-state';
import { facilityChipMat, unregisterSnappedMaterial } from '../../materials';
import { disableCulling } from '../geom/cull';
import { snapPx } from '../geom/snap';
import {
  FACILITY_ICON_FRAME_COLOR, FACILITY_ICON_OVERLAP, FACILITY_ICON_PX,
  FACILITY_ROW_MARGIN, RENDER_ORDER_FACILITY, Z_FACILITY,
} from '../layout/constants';
import type { BodyCenterIndex } from '../types';

// Initial vertex pool (1 per tile). Grows with headroom if a system places more.
const INITIAL_VERTS = 32;

// Per-tile corner-rounding flag for facilityChipMat's aRound (0 none / 1 left end
// / 2 right end / 3 both). A lone tile rounds all four corners; in a row only the
// outer ends round so the abutting sides share a square edge.
const ROUND_NONE = 0;
const ROUND_LEFT = 1;
const ROUND_RIGHT = 2;
const ROUND_BOTH = 3;

// A resolved tile: its snapped center, fill color as RGB fractions, round flag.
interface Tile {
  cx: number;
  cy: number;
  r: number;
  g: number;
  b: number;
  round: number;
}

// Stable left-to-right tile order within a body's row, independent of the order
// the player happened to place facilities in.
function byAddOrder(a: FacilityType, b: FacilityType): number {
  return (FACILITY_BY_TYPE.get(a)?.addOrder ?? 0) - (FACILITY_BY_TYPE.get(b)?.addOrder ?? 0);
}

export class FacilitiesLayer {
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly points: Points;
  private posAttr: BufferAttribute;
  private colAttr: BufferAttribute;
  private sizAttr: BufferAttribute;
  private rndAttr: BufferAttribute;
  private pos: Float32Array;
  private col: Float32Array;
  private siz: Float32Array;
  private rnd: Float32Array;
  private capacity: number; // in vertices

  // Reused for the per-tile hex → RGB-fraction conversion (ColorManagement OFF,
  // so the sRGB lands verbatim).
  private readonly scratchColor = new Color();

  constructor(scene: Scene) {
    this.capacity = INITIAL_VERTS;
    this.pos = new Float32Array(INITIAL_VERTS * 3);
    this.col = new Float32Array(INITIAL_VERTS * 3);
    this.siz = new Float32Array(INITIAL_VERTS);
    this.rnd = new Float32Array(INITIAL_VERTS);
    this.posAttr = this.makeAttr(this.pos, 3);
    this.colAttr = this.makeAttr(this.col, 3);
    this.sizAttr = this.makeAttr(this.siz, 1);
    this.rndAttr = this.makeAttr(this.rnd, 1);

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setAttribute('aSize', this.sizAttr);
    this.geometry.setAttribute('aRound', this.rndAttr);
    this.geometry.setDrawRange(0, 0);
    // facilityChipMat reads `color` (fill) + `aSize` (edge) + `aRound` (corners)
    // per vertex and paints the frame / inner shadow / dithered gradient.
    this.material = facilityChipMat(FACILITY_ICON_FRAME_COLOR);
    // Paint over every body regardless of its row z-band; renderOrder keeps the
    // tiles under the cargo dots. Mirrors the ships layer.
    this.material.depthTest = false;
    this.points = new Points(this.geometry, this.material);
    this.points.renderOrder = RENDER_ORDER_FACILITY;
    // Positions are CPU-written, so the cached bounding sphere goes stale.
    disableCulling(this.points);
    scene.add(this.points);
  }

  // Repaint the tile overlay against the current body anchors + placed facilities.
  // Called from SystemDiagram.layout (resize) and SystemDiagram.syncFacilities
  // (after an add/remove edit). Cheap: a handful of facility-bearing bodies, each
  // ≤ a few tiles, and only on those two infrequent events.
  layout(centers: BodyCenterIndex): void {
    const tiles: Tile[] = [];
    // Center-to-center step: tiles overlap by FACILITY_ICON_OVERLAP so their
    // touching frame columns merge into one shared edge.
    const step = FACILITY_ICON_PX - FACILITY_ICON_OVERLAP;
    for (const [bodyIdx, c] of centers) {
      const body = BODIES[bodyIdx];
      if (!body) continue;
      const placed = facilitiesOnBody(body.id);
      if (placed.length === 0) continue;
      const types = placed.map((f) => f.type).sort(byAddOrder);
      const n = types.length;
      const rowW = (n - 1) * step + FACILITY_ICON_PX; // first to last edge, overlap-aware
      const x0 = c.cx - rowW / 2;
      // Belts: center the row ON the belt (no single rim). Planets/moons: hang it
      // just above the disc's top edge (toward screen-top — y grows upward here).
      const rowCy = body.kind === 'belt'
        ? c.cy
        : c.cy + c.r + FACILITY_ROW_MARGIN + FACILITY_ICON_PX / 2;
      const cy = snapPx(rowCy);
      for (let i = 0; i < n; i++) {
        const cx = snapPx(x0 + i * step + FACILITY_ICON_PX / 2);
        // Round only the row's outer ends; interior sides stay square so they abut.
        const round = n === 1 ? ROUND_BOTH : i === 0 ? ROUND_LEFT : i === n - 1 ? ROUND_RIGHT : ROUND_NONE;
        this.scratchColor.set(facilityColor(types[i]!));
        tiles.push({ cx, cy, r: this.scratchColor.r, g: this.scratchColor.g, b: this.scratchColor.b, round });
      }
    }

    const count = tiles.length;
    if (count === 0) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    this.ensureCapacity(count);
    const pos = this.pos;
    const col = this.col;
    const siz = this.siz;
    const rnd = this.rnd;
    for (let k = 0; k < count; k++) {
      const tile = tiles[k]!;
      pos[k * 3 + 0] = tile.cx;
      pos[k * 3 + 1] = tile.cy;
      pos[k * 3 + 2] = Z_FACILITY;
      col[k * 3 + 0] = tile.r;
      col[k * 3 + 1] = tile.g;
      col[k * 3 + 2] = tile.b;
      siz[k] = FACILITY_ICON_PX;
      rnd[k] = tile.round;
    }
    this.geometry.setDrawRange(0, count);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizAttr.needsUpdate = true;
    this.rndAttr.needsUpdate = true;
  }

  private makeAttr(arr: Float32Array, itemSize: number): BufferAttribute {
    const a = new BufferAttribute(arr, itemSize);
    a.setUsage(DynamicDrawUsage);
    return a;
  }

  // Grow the pool (with 2× headroom) when a layout needs more vertices than the
  // current cap. Swaps in larger backing arrays + fresh attributes on the same
  // geometry + material — layout rewrites every value after, so the lost contents
  // don't matter, and the (already-registered) material is untouched.
  private ensureCapacity(verts: number): void {
    if (verts <= this.capacity) return;
    const cap = Math.max(verts, this.capacity * 2);
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.siz = new Float32Array(cap);
    this.rnd = new Float32Array(cap);
    this.posAttr = this.makeAttr(this.pos, 3);
    this.colAttr = this.makeAttr(this.col, 3);
    this.sizAttr = this.makeAttr(this.siz, 1);
    this.rndAttr = this.makeAttr(this.rnd, 1);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setAttribute('aSize', this.sizAttr);
    this.geometry.setAttribute('aRound', this.rndAttr);
    this.capacity = cap;
  }

  dispose(): void {
    // Drop the material from the snapped-viewport registry before freeing it, so
    // the next scene's resize doesn't re-touch a dead GPU handle.
    unregisterSnappedMaterial(this.material);
    this.material.dispose();
    this.geometry.dispose();
  }
}
