// TransitLines — the galaxy-view overlay for ships in warp: per transiting ship, a DOTTED line from its
// origin cluster's COM to its destination's, with a faction-coloured progress HEAD stepped by the integer
// turn fraction (departedOnTurn/arrivesOnTurn make it exact — never recomputed from live stats). The first
// ship rendering in the galaxy view, so v1 scope is deliberately tight: a dotted line + a head dot, no
// labels, no hover, no per-frame tweening (the head jumps a step each turn). Spoken in the dropline dot
// vocabulary (pixel-snapped points), floated over the field (depthTest off) like the selection chrome.

import { BufferAttribute, BufferGeometry, Color, Group, Points, type ShaderMaterial } from 'three';
import { snappedDotsMat } from './materials';

export interface TransitView {
  readonly o: { readonly x: number; readonly y: number; readonly z: number }; // origin COM
  readonly d: { readonly x: number; readonly y: number; readonly z: number }; // destination COM
  readonly frac: number;  // progress 0..1 (departed → arrives)
  readonly color: string; // faction color (sRGB hex; ColorManagement is off so it renders verbatim)
}

const DOTS_PER_LY = 1.2;        // dotted-line sampling density along the leg
const MAX_DOTS_PER_LINE = 48;   // cap the dot count on a max-range leg
const LINE_COLOR = 0x3a6ea5;    // a dim blue, the dropline family
const LINE_OPACITY = 0.5;
const HEAD_SIZE = 3;            // the progress head, a touch larger than the 1-px line dots

export class TransitLines {
  readonly group = new Group();
  private readonly lineGeom = new BufferGeometry();
  private readonly headGeom = new BufferGeometry();
  private readonly lineMat: ShaderMaterial;
  private readonly headMat: ShaderMaterial;
  private readonly scratch = new Color();

  constructor() {
    this.lineMat = snappedDotsMat({ color: LINE_COLOR, opacity: LINE_OPACITY, size: 1 });
    this.headMat = snappedDotsMat({ vertexColors: true, size: HEAD_SIZE });
    // Float the transit chrome over the star field rather than letting the opaque stars' depth occlude it
    // (the same "chrome, not world geometry" treatment the brackets get).
    this.lineMat.depthTest = false;
    this.headMat.depthTest = false;
    const lineDots = new Points(this.lineGeom, this.lineMat);
    const heads = new Points(this.headGeom, this.headMat);
    lineDots.renderOrder = 6;
    heads.renderOrder = 7;
    this.group.add(lineDots);
    this.group.add(heads);
    this.setTransits([]); // seed empty position/color attributes so the first frame has valid geometry
  }

  // Rebuild the overlay from the current transits (a handful, changing only on a turn advance — no need to
  // pool). Empty ⇒ nothing draws.
  setTransits(transits: readonly TransitView[]): void {
    const line: number[] = [];
    const headPos: number[] = [];
    const headCol: number[] = [];
    for (const t of transits) {
      const dx = t.d.x - t.o.x, dy = t.d.y - t.o.y, dz = t.d.z - t.o.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const n = Math.max(2, Math.min(MAX_DOTS_PER_LINE, Math.round(len * DOTS_PER_LY)));
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        line.push(t.o.x + dx * f, t.o.y + dy * f, t.o.z + dz * f);
      }
      const frac = Math.min(1, Math.max(0, t.frac));
      headPos.push(t.o.x + dx * frac, t.o.y + dy * frac, t.o.z + dz * frac);
      this.scratch.set(t.color);
      headCol.push(this.scratch.r, this.scratch.g, this.scratch.b);
    }
    this.lineGeom.setAttribute('position', new BufferAttribute(new Float32Array(line), 3));
    this.headGeom.setAttribute('position', new BufferAttribute(new Float32Array(headPos), 3));
    this.headGeom.setAttribute('color', new BufferAttribute(new Float32Array(headCol), 3));
  }

  dispose(): void {
    this.lineGeom.dispose();
    this.headGeom.dispose();
    this.lineMat.dispose();
    this.headMat.dispose();
  }
}
