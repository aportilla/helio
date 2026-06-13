// Per-cell captions for the planet-test-grid — one bitmap-font label under each
// disc naming its shellFraction / surfaceAge sweep position. Display-only: no fade, no
// selection, no projection (the grid lives entirely in buffer space, so the
// caption anchors come straight from the layer's published disc centers).
// Mirrors labels.ts's overlay idiom (CanvasTexture quad + integer top-left
// snap) so glyphs land on the pixel grid and read crisp.

import {
  Mesh, MeshBasicMaterial, PlaneGeometry, Scene,
} from 'three';
import { makeLabelTexture, type LabelTextureResult } from '../../data/pixel-font';
import { colors, fonts } from '../../ui/theme';
import type { GridCenter } from './planet-grid-layer';
import type { TestCell } from './test-bodies';

// Buffer-pixel gap between a disc's bottom edge and the caption's top edge.
const CAPTION_GAP_PX = 3;

interface Caption {
  mesh: Mesh;
  geometry: PlaneGeometry;
  material: MeshBasicMaterial;
  tex: LabelTextureResult['tex'];
  w: number;
  h: number;
}

export class GridLabels {
  private readonly captions: Caption[] = [];

  constructor(scene: Scene, cells: readonly TestCell[]) {
    // One caption mesh per cell, built once here (never in layout). Body font +
    // textBody color match the HUD's value rows so the grid reads as a peer of
    // the rest of the UI. depthTest/Write off so captions overlay the discs.
    for (const cell of cells) {
      const { tex, w, h } = makeLabelTexture(cell.label, colors.textBody, { font: fonts.body });
      const geometry = new PlaneGeometry(w, h);
      const material = new MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      });
      const mesh = new Mesh(geometry, material);
      // Above the discs (renderOrder 10/20) so a tall caption can't be hidden
      // by a neighbor's halo.
      mesh.renderOrder = 30;
      scene.add(mesh);
      this.captions.push({ mesh, geometry, material, tex, w, h });
    }
  }

  // Place each caption centered horizontally on its disc and just below it.
  // Top-left is snapped to integer buffer pixels (same reason as labels.ts:
  // snapping only the center silently drops an edge row/column for odd-sized
  // textures). centers[i] pairs with captions[i] by construction order.
  layout(centers: readonly GridCenter[]): void {
    const n = Math.min(centers.length, this.captions.length);
    for (let i = 0; i < n; i++) {
      const center = centers[i]!;
      const cap = this.captions[i]!;
      // Caption sits under the disc: its top edge is CAPTION_GAP_PX below the
      // disc's bottom edge. Buffer coords are Y-UP, so "below" is a LOWER y.
      const topY = center.cy - center.discPx * 0.5 - CAPTION_GAP_PX;
      // Snap the top-left texel to an integer pixel, then re-center the mesh on
      // that snapped box (PlaneGeometry is centered on its origin).
      const cornerX = Math.round(center.cx - cap.w * 0.5);
      const cornerY = Math.round(topY - cap.h);
      cap.mesh.position.set(cornerX + cap.w * 0.5, cornerY + cap.h * 0.5, 0);
    }
  }

  dispose(): void {
    for (const cap of this.captions) {
      cap.geometry.dispose();
      cap.material.dispose();
      cap.tex.dispose();
    }
    this.captions.length = 0;
  }
}
