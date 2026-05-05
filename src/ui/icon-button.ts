// Square icon button with N pre-built state textures swapped on
// (hover, selected) transitions. Two variants:
//
//   - 2-state: { off, hover } — close-X buttons.
//   - 4-state: { off, hover, on, onHover } — settings trigger
//     (selected when its panel is open).
//
// Texture ownership: IconButton holds the states-map but does NOT
// dispose them in its own dispose(). The orchestrator that built the
// textures is the single owner — needed because the same close-X pair
// can be shared across multiple IconButton instances (info card +
// settings panel both use the off/hover pair).
//
// State swaps poke `this.material.map` directly (no setTexture call,
// no canvas allocation, no dispose-prev). All four state textures sit
// resident in GPU memory; the swap is just a uniform update.

import { CanvasTexture } from 'three';
import { Widget } from './widget';

export interface IconButtonStates {
  off: CanvasTexture;
  hover: CanvasTexture;
  on?: CanvasTexture;        // present iff the button has a selected state
  onHover?: CanvasTexture;
}

export interface IconButtonOpts {
  renderOrder?: number;
  hitPad?: number;
}

export class IconButton extends Widget {
  private hover = false;
  private selected = false;

  constructor(
    size: number,
    private readonly states: IconButtonStates,
    opts?: IconButtonOpts,
  ) {
    super(opts?.renderOrder ?? 100);
    if (opts?.hitPad !== undefined) this.setHitPad(opts.hitPad);
    this.setSize(size, size);
    this.applyTexture();
    this.mesh.visible = true;
  }

  setHover(h: boolean): void {
    if (this.hover === h) return;
    this.hover = h;
    this.applyTexture();
  }

  setSelected(s: boolean): void {
    if (this.selected === s) return;
    this.selected = s;
    this.applyTexture();
  }

  // Forces hover → false. Called when the host widget hides (e.g. info
  // card cleared) so the next time it appears, the X starts in its off
  // color regardless of where the cursor was last.
  resetHover(): void { this.setHover(false); }

  private applyTexture(): void {
    let tex: CanvasTexture;
    if (this.selected) {
      // 4-state path. Fall back to off/hover textures if on/onHover
      // weren't provided (caller used a 2-state config but called
      // setSelected anyway — degrade gracefully rather than throw).
      tex = this.hover
        ? (this.states.onHover ?? this.states.hover)
        : (this.states.on ?? this.states.off);
    } else {
      tex = this.hover ? this.states.hover : this.states.off;
    }
    this.material.map = tex;
    this.material.needsUpdate = true;
  }

  // Override to NOT dispose the states-map textures — orchestrator owns
  // them. Only the mesh + material need cleanup here.
  override dispose(): void {
    super.dispose();
  }
}
