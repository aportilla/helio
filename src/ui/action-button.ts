// Labeled action button — pill border + centered text, two pre-built
// textures (off / hover). Uses paintPillButton for the visual so it stays
// in lockstep with the panel-row "Reset view" button styling.
//
// Owns its own textures (one (off, hover) pair per label string) and
// disposes them in dispose(). Differs from IconButton, which borrows from
// a shared texture pool — the orchestrator pattern only pays off when
// multiple instances share the same icon, and labeled buttons are unique
// per label.

import { CanvasTexture } from 'three';
import { getFont, measurePixelText } from '../data/pixel-font';
import { paintPillButton } from './painter';
import { Widget, paintToTexture } from './widget';

// Must match paintPillButton's internal padding so the pre-allocated
// canvas size matches what the painter will draw into.
const PILL_PAD_X = 6;
const PILL_PAD_Y = 3;

export interface ActionButtonOpts {
  renderOrder?: number;
  hitPad?: number;
}

export class ActionButton extends Widget {
  private hover = false;
  private readonly offTex: CanvasTexture;
  private readonly hoverTex: CanvasTexture;

  constructor(label: string, opts: ActionButtonOpts = {}) {
    super(opts.renderOrder ?? 100);
    if (opts.hitPad !== undefined) this.setHitPad(opts.hitPad);

    const w = measurePixelText(label) + PILL_PAD_X * 2;
    const h = getFont().lineHeight + PILL_PAD_Y * 2;

    this.offTex   = buildTexture(label, false, w, h);
    this.hoverTex = buildTexture(label, true,  w, h);

    this.setSize(w, h);
    this.material.map = this.offTex;
    this.material.needsUpdate = true;
    this.mesh.visible = true;
  }

  setHover(h: boolean): void {
    if (this.hover === h) return;
    this.hover = h;
    this.material.map = this.hover ? this.hoverTex : this.offTex;
    this.material.needsUpdate = true;
  }

  resetHover(): void { this.setHover(false); }

  override dispose(): void {
    this.offTex.dispose();
    this.hoverTex.dispose();
    super.dispose();
  }
}

function buildTexture(label: string, hover: boolean, w: number, h: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paintPillButton(c.getContext('2d')!, 0, 0, label, { hover });
  return paintToTexture(c);
}
