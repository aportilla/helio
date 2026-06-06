// Planet-grid disc layer — renders the 30 synthetic test bodies through the
// exact same disc path the system diagram uses (buildBodyDiscGeometry →
// makePlanetMaterial, disc + halo split). No pick/hover, no moons/rings, no
// PlanetCenterIndex: this is a pure visual sweep laid out on a fixed grid, so
// the layer only needs to size the geometry once and rewrite positions each
// resize. The disc/halo two-pass mirrors PlanetsLayer so the halo blends over
// neighbors correctly even though here the cells never overlap.

import {
  BufferGeometry, DataTexture, Points, Scene, ShaderMaterial,
} from 'three';
import { makePlanetMaterial } from '../materials';
import { buildBodyDiscGeometry } from '../system-diagram/layers/body-disc';
import { disableCulling } from '../system-diagram/geom/cull';
import { disposePool } from '../system-diagram/layers/dispose';
import {
  RENDER_ORDER_PLANET, RENDER_ORDER_PLANET_HALO, Z_PLANET,
} from '../system-diagram/layout/constants';
import { writeLightUniforms } from '../system-diagram/lighting';
import type { StarLightSource } from '../system-diagram/types';
import { GRID_COL_COUNT, GRID_ROW_COUNT, type TestCell } from './test-bodies';

// One disc center in buffer-pixel coords. Published from layout() so the
// caption layer can anchor each label under the same disc it sits beneath.
export interface GridCenter {
  cx: number;
  cy: number;
  discPx: number;
}

// Uniform disc diameter for every test cell (env-px). The grid is a visual
// reference sweep, so all discs render at one size rather than the catalog's
// radius-derived sizing — comparing the resource/tier variation is the point,
// and a constant disc keeps the eye on the surface texture, not the silhouette.
// 64 leaves the procedural suite (surface worley + clouds + craters) plenty of
// pixels to resolve while still fitting 8 across a typical landscape viewport.
const GRID_DISC_PX = 64;

// Minimum edge-to-edge gap between adjacent discs (env-px), in both axes. The
// pitch never compresses below disc + this gap; on a viewport too narrow for
// that, the discs shrink via the clamp in layout() rather than overlapping.
const GRID_MIN_GAP = 10;

// Vertical headroom reserved BELOW each disc within its cell for the caption
// (env-px). The cell's vertical pitch budgets this so a label never collides
// with the disc beneath it. Comfortably exceeds the Monaco-11 body line height.
const GRID_CAPTION_GAP = 16;

// Clear space (env-px) between the viewport edge and the nearest disc OR caption
// edge on every side — the grid's outer breathing room. Measured to the disc
// edge, not its center, so layout() reserves the disc radius (and the caption
// reserve below) on top of this; the sweep reads as a comfortably framed table
// rather than running into the edges or under the HUD chrome.
const GRID_OUTER_PAD = 48;

// Vertical room (env-px) reserved BELOW each disc center for its caption — the
// caption gap plus one body-font line — so the bottom row's label clears the
// viewport edge. Comfortably exceeds the Monaco-11 caption (gap + line height).
const GRID_CAPTION_RESERVE = 20;

export class PlanetGridLayer {
  private readonly cellCount: number;
  private readonly geometry: BufferGeometry | null;
  // Two materials + two Points sharing one geometry, mirroring PlanetsLayer:
  // disc renders at RENDER_ORDER_PLANET and discards halo fragments, halo
  // renders at RENDER_ORDER_PLANET_HALO and discards disc fragments. The split
  // keeps the halo blending correctly over neighbors (see makePlanetMaterial's
  // mode arg).
  private readonly discMaterial: ShaderMaterial | null;
  private readonly haloMaterial: ShaderMaterial | null;
  private readonly discPoints: Points | null;
  private readonly haloPoints: Points | null;
  // Per-body cloud texture, kept so dispose() can free it (Three.js won't
  // release it with the geometry/material).
  private readonly cloudTex: DataTexture | null;

  // Published disc centers, rewritten in place each layout pass so the caption
  // layer can place captions without re-deriving the grid math. One entry per
  // cell; allocated once in the constructor (no per-layout allocation).
  private readonly centers: GridCenter[];

  constructor(scene: Scene, cells: readonly TestCell[]) {
    this.cellCount = cells.length;
    this.centers = cells.map(() => ({ cx: 0, cy: 0, discPx: GRID_DISC_PX }));

    if (this.cellCount === 0) {
      this.geometry = null;
      this.discMaterial = null;
      this.haloMaterial = null;
      this.discPoints = null;
      this.haloPoints = null;
      this.cloudTex = null;
      return;
    }

    const { geometry, cloudTex } = buildBodyDiscGeometry(
      cells.map(c => ({ body: c.body, discPx: GRID_DISC_PX })),
    );
    this.geometry = geometry;
    this.cloudTex = cloudTex;
    this.discMaterial = makePlanetMaterial(1.0, 'disc');
    this.haloMaterial = makePlanetMaterial(1.0, 'halo');
    for (const m of [this.discMaterial, this.haloMaterial]) {
      m.uniforms.uCloudLayerData.value = cloudTex;
      m.uniforms.uCloudLayerRows.value = this.cellCount;
    }
    this.discPoints = new Points(this.geometry, this.discMaterial);
    this.discPoints.renderOrder = RENDER_ORDER_PLANET;
    this.haloPoints = new Points(this.geometry, this.haloMaterial);
    this.haloPoints.renderOrder = RENDER_ORDER_PLANET_HALO;
    // Position attribute is rewritten each layout — see disableCulling.
    disableCulling(this.discPoints);
    disableCulling(this.haloPoints);
    scene.add(this.discPoints);
    scene.add(this.haloPoints);
  }

  // Lay the cells out as a GRID_COL_COUNT × GRID_ROW_COUNT block centered in
  // the viewport, writing integer-pixel centers into the geometry. The disc
  // size is fixed; the pitch (center-to-center spacing) expands to fill the
  // available span but never compresses below disc + GRID_MIN_GAP, so on a
  // viewport too small to hold the block at full size the whole block clamps
  // to its minimum footprint rather than overlapping discs.
  layout(bufferW: number, bufferH: number): void {
    if (!this.geometry) return;

    // Each cell reserves the disc plus its caption gap vertically; horizontally
    // just the disc plus the inter-disc gap. The minimum pitch is the floor the
    // expand-to-fill never drops below.
    const minPitchX = GRID_DISC_PX + GRID_MIN_GAP;
    const minPitchY = GRID_DISC_PX + GRID_CAPTION_GAP + GRID_MIN_GAP;

    // Inset rectangle the disc CENTERS may occupy while keeping disc + caption
    // GRID_OUTER_PAD clear of every viewport edge: reserve the disc radius on all
    // sides, plus the caption reserve below (labels hang under the bottom row).
    // The N centers span (N-1) pitches across the usable width/height.
    const halfDisc = GRID_DISC_PX * 0.5;
    const minCx = GRID_OUTER_PAD + halfDisc;
    const maxCx = bufferW - GRID_OUTER_PAD - halfDisc;
    const minCy = GRID_OUTER_PAD + halfDisc + GRID_CAPTION_RESERVE;
    const maxCy = bufferH - GRID_OUTER_PAD - halfDisc;
    const spanX = Math.max(0, maxCx - minCx);
    const spanY = Math.max(0, maxCy - minCy);
    const gapsX = GRID_COL_COUNT - 1;
    const gapsY = GRID_ROW_COUNT - 1;

    // Expand pitch to fill the usable span, but never below the minimum. (Guard
    // the single-column/row degenerate case where gaps = 0.)
    const fitPitchX = gapsX > 0 ? spanX / gapsX : 0;
    const fitPitchY = gapsY > 0 ? spanY / gapsY : 0;
    const pitchX = Math.max(minPitchX, fitPitchX);
    const pitchY = Math.max(minPitchY, fitPitchY);

    // Center the block within the usable inset rectangle (not the raw viewport),
    // so the asymmetric caption reserve at the bottom doesn't bias it upward.
    const blockW = gapsX * pitchX;
    const blockH = gapsY * pitchY;
    const startX = (minCx + maxCx) * 0.5 - blockW * 0.5;
    // Buffer coords are Y-UP, so the TOP row (row 0) gets the HIGHEST y: start at
    // the top of the centered block and step DOWN by pitchY per row.
    const topY = (minCy + maxCy) * 0.5 + blockH * 0.5;

    const positions = this.geometry.attributes.position.array as Float32Array;
    for (let row = 0; row < GRID_ROW_COUNT; row++) {
      for (let col = 0; col < GRID_COL_COUNT; col++) {
        const i = row * GRID_COL_COUNT + col;
        if (i >= this.cellCount) break;
        // Snap to integer pixels — the disc material's parity snap wants an
        // integer center so gl_FragCoord − vCenter lands on symmetric offsets.
        const cx = Math.round(startX + col * pitchX);
        const cy = Math.round(topY - row * pitchY);
        positions[i * 3 + 0] = cx;
        positions[i * 3 + 1] = cy;
        // Flat z — cells never overlap, so no per-cell banding is needed.
        positions[i * 3 + 2] = Z_PLANET;
        const c = this.centers[i];
        c.cx = cx;
        c.cy = cy;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
  }

  // Published disc centers from the last layout() pass. The diagram threads
  // these into the caption layer. Empty-array-safe before first layout (all
  // centers read 0,0 until then).
  getCenters(): readonly GridCenter[] {
    return this.centers;
  }

  // Push the synthetic light into both materials so the disc crescent lighting
  // resolves (mirror PlanetsLayer). Cheap — a handful of uniform writes.
  setLightSources(lights: readonly StarLightSource[]): void {
    if (!this.discMaterial || !this.haloMaterial) return;
    writeLightUniforms(this.discMaterial, lights);
    writeLightUniforms(this.haloMaterial, lights);
  }

  dispose(): void {
    // One geometry + cloudTex shared by both passes; the halo material is the
    // second consumer of that shared geometry, so it frees separately.
    disposePool({ geometry: this.geometry, material: this.discMaterial, cloudTex: this.cloudTex });
    this.haloMaterial?.dispose();
  }
}
