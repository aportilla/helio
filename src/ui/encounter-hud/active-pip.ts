// ActivePip — the 'active initiative' marker: the acting side's FRONTIER pip (the icon about to be
// spent), animated so the current initiative shimmers. Rather than TRANSLATE the slanted slash — which
// crawls its jagged edges across the pixel grid — it holds a FIXED body and only ADDS / REMOVES whole
// pixel rows at the top + bottom: the slash appears to slide up-and-right / down-and-left along its own
// slant while every interior pixel stays put.
//
// The trick: a row's x-offset is a pure function of its ABSOLUTE texture-y (not its index within the
// slash), so the same absolute row draws identical pixels in every variant. Sliding a fixed-height
// window over that fixed pattern therefore leaves the overlap byte-identical — only the top gains a row
// and the bottom loses one. Implemented as a small set of pre-baked row-shift variants swapped per frame
// (the IconButton idiom — no per-frame canvas work); the controller picks the variant from a sine phase
// and recolors on a phase handoff. A separate Widget from the bar (which leaves a gap at this pip's slot
// and only repaints on settle).

import { CanvasTexture } from 'three';
import { Widget, paintToTexture } from '../widget';
import { PIP_W, PIP_H, SHEAR_SLOPE } from './pip';

// Max slide, in whole pixel rows. MUST keep AMP × SHEAR_SLOPE integral (AMP even for the 1-in-2 lean) so
// the resting variant's stair-steps land on the SAME columns as the bar's static pips — otherwise shift 0
// wouldn't seam into the row. AMP=2 is the natural minimum: a subtle ±2px shimmer.
const AMP = 2;
const TH = PIP_H + 2 * AMP; // texture height: the pip plus head + tail room for the slide
const MAX_Y = TH - 1;
// x-offset of a texture row as a pure function of its ABSOLUTE y — the property that keeps the body
// crawl-free across variants.
const offAbs = (y: number): number => Math.round((MAX_Y - y) * SHEAR_SLOPE);
const TW = PIP_W + offAbs(0); // texture width: body + the topmost row's lean
const X_PAD = offAbs(AMP + PIP_H - 1); // the resting slash's bottom-row x within the texture (home nudge)

export class ActivePip extends Widget {
  private textures: CanvasTexture[] = []; // one per shift in [-AMP, +AMP]
  private color = '';
  private applied = -1;

  constructor() {
    super(120);
    this.setSize(TW, TH);
    this.setVisible(false);
  }

  // (Re)bake the shift variants in the acting side's color — only on a color change (a phase handoff).
  setColor(color: string): void {
    if (color === this.color && this.textures.length) return;
    this.color = color;
    for (const t of this.textures) t.dispose();
    this.textures = [];
    for (let shift = -AMP; shift <= AMP; shift++) {
      const c = document.createElement('canvas');
      c.width = TW;
      c.height = TH;
      const g = c.getContext('2d')!;
      g.fillStyle = color;
      const top = AMP - shift; // the slash's top row within the texture (shift > 0 slides it up)
      for (let r = 0; r < PIP_H; r++) {
        const y = top + r;
        g.fillRect(offAbs(y), y, PIP_W, 1);
      }
      this.textures.push(paintToTexture(c));
    }
    this.applied = -1;
  }

  // Slide phase in [-1, 1] (a sine): snap to the nearest whole-row shift + swap the variant. A steady
  // frame re-pokes nothing.
  setPhase(phase: number): void {
    if (!this.textures.length) return;
    const idx = Math.round(phase * AMP) + AMP;
    if (idx === this.applied) return;
    this.applied = idx;
    this.material.map = this.textures[idx]!;
    this.material.needsUpdate = true;
  }

  // Place so the RESTING slash sits at (pipLeft, pipBottom) — the frontier pip's home bottom-left — with
  // the texture's head/tail padding backed out so shift 0 seams into the bar's row exactly.
  moveTo(pipLeft: number, pipBottom: number): void {
    this.placeAt(Math.round(pipLeft - X_PAD), Math.round(pipBottom - AMP));
  }

  override dispose(): void {
    for (const t of this.textures) t.dispose();
    super.dispose();
  }
}
