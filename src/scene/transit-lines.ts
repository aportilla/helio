// TransitLines — the galaxy-view overlay for ships in warp: per transiting ship, a DOTTED line from its
// origin cluster's COM to its destination's. The moving glyph that rides the leg is a ShipMarkers triangle
// (see ship-markers.ts), so this overlay is now just the dotted path — no head, no labels, no hover, no
// per-frame tweening. Spoken in the dropline dot vocabulary (pixel-snapped points), floated over the field
// (depthTest off) like the selection chrome.

import { BufferAttribute, BufferGeometry, Group, Points, type ShaderMaterial } from 'three';
import { snappedDotsMat } from './materials';

export interface TransitView {
  readonly o: { readonly x: number; readonly y: number; readonly z: number }; // origin COM
  readonly d: { readonly x: number; readonly y: number; readonly z: number }; // destination COM
}

const DOTS_PER_LY = 1.2;        // dotted-line sampling density along the leg
const MAX_DOTS_PER_LINE = 48;   // cap the dot count on a max-range leg
const LINE_COLOR = 0x3a6ea5;    // a dim blue, the dropline family
const LINE_OPACITY = 0.5;

export class TransitLines {
  readonly group = new Group();
  private readonly lineGeom = new BufferGeometry();
  private readonly lineMat: ShaderMaterial;

  constructor() {
    this.lineMat = snappedDotsMat({ color: LINE_COLOR, opacity: LINE_OPACITY, size: 1 });
    // Float the transit chrome over the star field rather than letting the opaque stars' depth occlude it
    // (the same "chrome, not world geometry" treatment the brackets get).
    this.lineMat.depthTest = false;
    const lineDots = new Points(this.lineGeom, this.lineMat);
    lineDots.renderOrder = 6;
    this.group.add(lineDots);
    this.setTransits([]); // seed an empty position attribute so the first frame has valid geometry
  }

  // Rebuild the overlay from the current transits (a handful, changing only on a turn advance — no need to
  // pool). Empty ⇒ nothing draws.
  setTransits(transits: readonly TransitView[]): void {
    const line: number[] = [];
    for (const t of transits) {
      const dx = t.d.x - t.o.x, dy = t.d.y - t.o.y, dz = t.d.z - t.o.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const n = Math.max(2, Math.min(MAX_DOTS_PER_LINE, Math.round(len * DOTS_PER_LY)));
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        line.push(t.o.x + dx * f, t.o.y + dy * f, t.o.z + dz * f);
      }
    }
    this.lineGeom.setAttribute('position', new BufferAttribute(new Float32Array(line), 3));
  }

  dispose(): void {
    this.lineGeom.dispose();
    this.lineMat.dispose();
  }
}
