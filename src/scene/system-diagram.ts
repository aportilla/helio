// SystemDiagram — flat 2D screen diagram of one cluster's stars. Owns its
// own ortho scene at 1 unit = 1 buffer pixel (same convention as Labels and
// the HUD overlays). Renders crisp pixel discs for every member of the
// cluster and a name label above each.
//
// No camera, no orbit, no depth. SystemScene calls resize() with buffer
// dims and renders the scene each tick.

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  Scene,
  type ShaderMaterial,
} from 'three';
import { CLASS_COLOR, STARS, STAR_CLUSTERS } from '../data/stars';
import { makeLabelTexture, type LabelTextureResult } from '../data/pixel-font';
import { HEADER_HEIGHT } from '../ui/system-hud/header-bar';
import { makeFlatStarsMaterial } from './materials';

// Per-star disc-diameter multiplier on top of the galaxy-tuned pxSize. The
// system view has no depth attenuation, so this is the only knob controlling
// rendered disc size. Larger = bigger discs across the board, preserving
// the within-class size ratios that pxSize already encodes.
const DISC_SCALE = 6;

// Buffer-pixel gap between the disc edge and the label texture below it.
const LABEL_GAP = 4;

// Edge-to-edge horizontal gap between adjacent discs as a fraction of the
// largest member's disc diameter. Uniform across the row so a binary with
// a tiny WD next to a big A-class primary spaces consistently with the
// rest of the row.
const HORIZ_GAP_FACTOR = 0.4;

// Vertical gap from the bottom of the header bar to the top of the
// tallest disc. Keeps the star row clearly under the title bar without
// crowding it.
const TOP_GAP = 12;

interface MemberLabel {
  mesh: Mesh;
  w: number;
  h: number;
}

export class SystemDiagram {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  private readonly members: readonly number[];
  // Integer disc diameter (px) per member. Matches the shader's
  // floor(aSize * uDiscScale + 0.5), used CPU-side for ring sizing and
  // label placement.
  private readonly memberDiscPx: readonly number[];
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly points: Points;
  private readonly labels: MemberLabel[] = [];
  private readonly labelTextures: LabelTextureResult[] = [];

  constructor(clusterIdx: number) {
    const cluster = STAR_CLUSTERS[clusterIdx];
    this.members = cluster.members;

    const positions = new Float32Array(this.members.length * 3);
    const colors    = new Float32Array(this.members.length * 3);
    const sizes     = new Float32Array(this.members.length);
    const discPx: number[] = [];

    this.members.forEach((m, i) => {
      const s = STARS[m];
      // positions[] is overwritten on first resize() — fill is just defensive.
      positions[i * 3 + 0] = 0;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
      const col = CLASS_COLOR[s.cls] ?? CLASS_COLOR.M;
      colors[i * 3 + 0] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
      sizes[i] = s.pxSize;
      discPx.push(Math.floor(s.pxSize * DISC_SCALE + 0.5));
    });
    this.memberDiscPx = discPx;

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.geometry.setAttribute('color',    new BufferAttribute(colors, 3));
    this.geometry.setAttribute('aSize',    new BufferAttribute(sizes, 1));

    this.material = makeFlatStarsMaterial(DISC_SCALE);
    this.points = new Points(this.geometry, this.material);
    this.scene.add(this.points);

    // One label per member. Eager build avoids any first-frame canvas
    // work; cost is negligible (one small texture per member, at most a
    // handful per system).
    this.members.forEach(m => {
      const s = STARS[m];
      // Warm-white for Sol, cyan otherwise — same per-Sol rule the galaxy
      // view's plain label variant uses (labels.ts).
      const color = s.id === 'sol' ? '#ffffcc' : '#5ec8ff';
      const tex = makeLabelTexture(s.name, color);
      this.labelTextures.push(tex);
      const mat = new MeshBasicMaterial({
        map: tex.tex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new Mesh(new PlaneGeometry(tex.w, tex.h), mat);
      // Hidden until first resize() places them — avoids a one-frame flash
      // at (0,0) during the first render.
      mesh.visible = false;
      // Ensure labels paint on top of the disc points pass regardless of
      // scene insertion order.
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.labels.push({ mesh, w: tex.w, h: tex.h });
    });
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.layout();
  }

  private layout(): void {
    const N = this.members.length;
    if (N === 0) return;

    const positions = this.geometry.attributes.position.array as Float32Array;

    // Horizontal row anchored to the top of the content area (just below
    // the header). All disc centers share one baseline y so the row reads
    // as a horizontal alignment regardless of size variation. The wide
    // empty space below the row is reserved for the planets/ships layer
    // that lives there in a later pass.
    const maxDiscPx = Math.max(...this.memberDiscPx);
    const gap = N > 1 ? maxDiscPx * HORIZ_GAP_FACTOR : 0;
    let totalW = 0;
    for (const d of this.memberDiscPx) totalW += d;
    totalW += (N - 1) * gap;
    const startX = (this.bufferW - totalW) / 2;
    const cy = Math.round(this.bufferH - HEADER_HEIGHT - TOP_GAP - maxDiscPx / 2);

    let cursor = startX;
    for (let i = 0; i < N; i++) {
      const d = this.memberDiscPx[i];
      const cx = cursor + d / 2;
      positions[i * 3 + 0] = cx;
      positions[i * 3 + 1] = cy;
      positions[i * 3 + 2] = 0;
      cursor += d + gap;
    }
    this.geometry.attributes.position.needsUpdate = true;

    // Labels sit BELOW each disc: above-disc would push into the title
    // bar at this top anchor, and below keeps the labels grouped with
    // their stars rather than crowded against the header. Top-left corner
    // snapped to an integer buffer pixel so every texel renders cleanly
    // (same scheme as Labels.placeAt in labels.ts).
    for (let i = 0; i < N; i++) {
      const px = positions[i * 3 + 0];
      const py = positions[i * 3 + 1];
      const discR = this.memberDiscPx[i] / 2;
      const L = this.labels[i];
      const targetCenterX = px;
      const targetCenterY = py - discR - LABEL_GAP - L.h * 0.5;
      const cornerX = Math.round(targetCenterX - L.w * 0.5);
      const cornerY = Math.round(targetCenterY - L.h * 0.5);
      L.mesh.position.set(cornerX + L.w * 0.5, cornerY + L.h * 0.5, 0);
      L.mesh.visible = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    for (const L of this.labels) {
      L.mesh.geometry.dispose();
      (L.mesh.material as MeshBasicMaterial).dispose();
    }
    for (const T of this.labelTextures) T.tex.dispose();
  }
}
