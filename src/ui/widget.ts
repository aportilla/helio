// Widget base for "rectangular textured surface in the HUD ortho pass."
// Owns one Mesh + MeshBasicMaterial + (optionally) one CanvasTexture +
// one Bounds rect. Provides a single owned-texture lifecycle: subclass
// paints a canvas, calls setTexture(canvas, w, h), Widget swaps the
// material map and resizes the geometry.
//
// IconButton (and any other "pre-built texture pool" pattern) bypasses
// setTexture and pokes `this.material.map` directly — `material` is
// protected for that reason.
//
// All sizes are in HUD buffer pixels (1 HUD unit = 1 buffer pixel,
// origin bottom-left, Y-up).

import {
  CanvasTexture,
  ClampToEdgeWrapping,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  Scene,
} from 'three';

export type Anchor = 'tl' | 'tr' | 'bl' | 'br';

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
  contains(bx: number, by: number): boolean;
}

function makeBounds(x: number, y: number, w: number, h: number): Bounds {
  return {
    x, y, w, h,
    contains(bx, by) { return bx >= x && bx < x + w && by >= y && by < y + h; },
  };
}

const ZERO_BOUNDS: Bounds = makeBounds(0, 0, 0, 0);

// Build a NearestFilter, ClampToEdge CanvasTexture from a 2D canvas.
// Exported for IconButton + any other widget that pre-builds a texture
// pool outside the standard owned-texture path.
//
// colorSpace intentionally left at default. With ColorManagement disabled
// and outputColorSpace = LinearSRGBColorSpace (set in scene.ts), the whole
// pipeline is raw sRGB end-to-end, so we want the sampler to return the
// canvas pixels untouched.
export function paintToTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(canvas);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  return t;
}

export abstract class Widget {
  readonly mesh: Mesh;
  // protected so subclasses (IconButton) can swap material.map directly
  // without going through setTexture's dispose-prev path.
  protected readonly material: MeshBasicMaterial;
  // Texture owned by Widget — disposed on next setTexture() call and on
  // dispose(). null when the subclass manages textures itself (e.g.
  // IconButton holds a private states-map and never calls setTexture).
  private ownedTexture: CanvasTexture | null = null;

  protected w = 0;
  protected h = 0;
  protected hitPad = 0;
  bounds: Bounds = ZERO_BOUNDS;
  // Visible bounds (un-padded by hitPad). Used for relative placement
  // where the gap is from the visible edge, not the inflated hit zone
  // (e.g. settings panel above settings icon — gap is from the icon's
  // visible top, not from its hit-pad-inflated top).
  visibleBounds: Bounds = ZERO_BOUNDS;

  constructor(renderOrder = 100) {
    this.material = new MeshBasicMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  // Owned-texture path. Disposes the previous owned texture, builds a
  // fresh NearestFilter CanvasTexture from `canvas`, swaps the material
  // map, resizes the geometry if (w, h) actually changed, shows the mesh.
  protected setTexture(canvas: HTMLCanvasElement, w: number, h: number): void {
    if (this.ownedTexture) this.ownedTexture.dispose();
    this.ownedTexture = paintToTexture(canvas);
    this.material.map = this.ownedTexture;
    this.material.needsUpdate = true;
    if (this.w !== w || this.h !== h) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = new PlaneGeometry(w, h);
      this.w = w;
      this.h = h;
    }
    this.mesh.visible = true;
  }

  // Update internal w/h without painting a texture. Used by IconButton
  // (which manages textures itself) so bounds and geometry track its
  // declared size at construction time.
  protected setSize(w: number, h: number): void {
    if (this.w === w && this.h === h) return;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new PlaneGeometry(w, h);
    this.w = w;
    this.h = h;
  }

  // Place at integer (left, bottom) in HUD buffer coords. Updates both
  // bounds (hit-pad inflated) and visibleBounds (raw).
  placeAt(left: number, bottom: number): void {
    this.mesh.position.set(left + this.w / 2, bottom + this.h / 2, 0);
    this.visibleBounds = makeBounds(left, bottom, this.w, this.h);
    this.bounds = this.hitPad > 0
      ? makeBounds(left - this.hitPad, bottom - this.hitPad, this.w + 2 * this.hitPad, this.h + 2 * this.hitPad)
      : this.visibleBounds;
  }

  // Place via screen-corner anchor + inset offsets. Inset values are the
  // distance from the chosen edge inward (positive = into the canvas).
  anchorTo(anchor: Anchor, bufW: number, bufH: number, ox = 0, oy = 0): void {
    let left: number, bottom: number;
    switch (anchor) {
      case 'tl': left = ox;                 bottom = bufH - oy - this.h; break;
      case 'tr': left = bufW - ox - this.w; bottom = bufH - oy - this.h; break;
      case 'bl': left = ox;                 bottom = oy;                 break;
      case 'br': left = bufW - ox - this.w; bottom = oy;                 break;
    }
    this.placeAt(left, bottom);
  }

  setVisible(v: boolean): void { this.mesh.visible = v; }
  get visible(): boolean { return this.mesh.visible; }

  // Current rendered size in buffer pixels, regardless of placement.
  // Read these (not visibleBounds.w/h) when computing a position from
  // a corner anchor — visibleBounds is populated by placeAt(), so it's
  // still ZERO before the widget has ever been placed, and the first
  // layout pass after a setTexture() would otherwise compute its
  // position with a 0-size and land off-screen.
  get width(): number { return this.w; }
  get height(): number { return this.h; }

  setHitPad(n: number): void {
    this.hitPad = n;
    // Re-derive bounds from current visibleBounds so the next pointer
    // event sees the new hit zone without waiting for a placeAt.
    if (this.w > 0 && this.h > 0) {
      const v = this.visibleBounds;
      this.bounds = n > 0
        ? makeBounds(v.x - n, v.y - n, v.w + 2 * n, v.h + 2 * n)
        : v;
    }
  }

  addTo(scene: Scene): void { scene.add(this.mesh); }

  dispose(): void {
    if (this.ownedTexture) {
      this.ownedTexture.dispose();
      this.ownedTexture = null;
    }
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
