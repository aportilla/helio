// Bottom-left scale bar: a horizontal bar with two end ticks and a label
// underneath ("N Light Year(s)"). Bar + ticks share one MeshBasicMaterial
// (same color, no texture); label gets its own material because its
// texture changes when the step value changes.
//
// Composite of 4 Meshes — does NOT extend Widget (Widget is single-mesh).

import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Scene,
} from 'three';
import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { colors, sizes } from '../theme';
import { paintToTexture } from '../widget';

function buildScaleLabelTexture(text: string): { tex: CanvasTexture; w: number; h: number } {
  const padX = 1;
  const padY = 1;
  const tw = measurePixelText(text);
  const W = tw + padX * 2;
  const H = getFont().lineHeight + padY * 2;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  // colors.scaleBar is numeric (used as MeshBasicMaterial.color); the
  // hex string here matches its sRGB value — the bar quad and the label
  // text need to render at exactly the same color.
  drawPixelText(g, text, padX, padY, '#e8f6ff');
  return { tex: paintToTexture(c), w: W, h: H };
}

export class ScaleBar {
  private readonly bar: Mesh;
  private readonly leftTick: Mesh;
  private readonly rightTick: Mesh;
  private readonly label: Mesh;
  private readonly labelMat: MeshBasicMaterial;
  private step = -1;
  private widthPx = 0;
  private labelH = 0;

  constructor() {
    const barMat = new MeshBasicMaterial({
      color: colors.scaleBar,
      transparent: false,
      depthTest: false,
      depthWrite: false,
    });
    this.bar = new Mesh(new PlaneGeometry(1, 1), barMat);
    this.leftTick  = new Mesh(new PlaneGeometry(1, sizes.scaleTickH), barMat);
    this.rightTick = new Mesh(new PlaneGeometry(1, sizes.scaleTickH), barMat);
    this.bar.renderOrder = 100;
    this.leftTick.renderOrder = 100;
    this.rightTick.renderOrder = 100;
    this.bar.visible = false;
    this.leftTick.visible = false;
    this.rightTick.visible = false;

    this.labelMat = new MeshBasicMaterial({
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.label = new Mesh(new PlaneGeometry(1, 1), this.labelMat);
    this.label.renderOrder = 100;
    this.label.visible = false;
  }

  addTo(scene: Scene): void {
    scene.add(this.bar);
    scene.add(this.leftTick);
    scene.add(this.rightTick);
    scene.add(this.label);
  }

  // Visible label height in buffer pixels. Returns 0 until the first
  // set() call. Used by the orchestrator to position elements that sit
  // above the scale bar (e.g. the settings icon).
  get labelHeight(): number { return this.labelH; }

  // Set the scale step + bar width. Cheap when both are unchanged.
  // Rebuilds the label texture only when the step changes (label text
  // depends on step, not on widthPx).
  set(step: number, widthPx: number): void {
    if (this.step === step && this.widthPx === widthPx) return;

    if (this.step !== step) {
      const text = step === 1 ? '1 Light Year' : `${step} Light Years`;
      if (this.labelMat.map) this.labelMat.map.dispose();
      const lab = buildScaleLabelTexture(text);
      this.labelMat.map = lab.tex;
      this.labelMat.needsUpdate = true;
      this.labelH = lab.h;
      this.label.geometry.dispose();
      this.label.geometry = new PlaneGeometry(lab.w, lab.h);
    }
    this.step = step;
    this.widthPx = widthPx;

    this.bar.visible = true;
    this.leftTick.visible = true;
    this.rightTick.visible = true;
    this.label.visible = true;
  }

  // Position the bar group at (edgePad, edgePad) from the bottom-left
  // corner. Assumes set() has been called at least once.
  layout(edgePad: number): void {
    if (this.widthPx <= 0) return;

    // Layout from bottom up: label, gap, then the tick block with the
    // bar running through its vertical center.
    const labelCY = edgePad + this.labelH / 2;
    const tickBottom = labelCY + this.labelH / 2 + sizes.scaleLabelGap;
    const barCY = tickBottom + sizes.scaleTickH / 2;

    const barLeft = edgePad;
    const barRight = barLeft + this.widthPx;

    this.bar.scale.set(this.widthPx, 1, 1);
    this.bar.position.set(barLeft + this.widthPx / 2, barCY, 0);

    // Ticks are 1-px-wide vertical bars at each end, aligned to the
    // integer pixel column (offset by 0.5 because mesh center sits at
    // pixel center).
    this.leftTick.scale.set(1, sizes.scaleTickH, 1);
    this.leftTick.position.set(barLeft + 0.5, barCY, 0);
    this.rightTick.scale.set(1, sizes.scaleTickH, 1);
    this.rightTick.position.set(barRight - 0.5, barCY, 0);

    // Label centered horizontally under the bar. Round the natural
    // center to land the quad's edges on integer pixel boundaries —
    // without this, an odd-bar-width label looks fuzzy/off-grid.
    this.label.position.set(Math.round(barLeft + this.widthPx / 2), labelCY, 0);
  }

  dispose(): void {
    this.bar.geometry.dispose();
    this.leftTick.geometry.dispose();
    this.rightTick.geometry.dispose();
    this.label.geometry.dispose();
    (this.bar.material as MeshBasicMaterial).dispose();
    if (this.labelMat.map) this.labelMat.map.dispose();
    this.labelMat.dispose();
  }
}
