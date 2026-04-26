import { BufferGeometry, Group, Line, LineSegments, ShaderMaterial, Vector3 } from 'three';
import { snappedLineMat } from './materials';

const ARROW_OPACITY_BASE = 0.9;
const ARROW_OPACITY_DIM  = 0.45;
const RING_OPACITY_BASE  = 0.75;
const RING_OPACITY_DIM   = 0.45;
const AXIS_OPACITY_BASE  = RING_OPACITY_BASE;
const AXIS_OPACITY_DIM   = RING_OPACITY_DIM;

const RING_RADII = [5, 10, 15, 20];

// Quadrants 0..3 starting at +X,+Y (angle 0..π/2) going CCW.
const QUAD_ANGLES: ReadonlyArray<readonly [number, number]> = [
  [0,             Math.PI * 0.5],  // Q0: +X, +Y
  [Math.PI * 0.5, Math.PI       ],  // Q1: -X, +Y
  [Math.PI,       Math.PI * 1.5 ],  // Q2: -X, -Y
  [Math.PI * 1.5, Math.PI * 2   ],  // Q3: +X, -Y
];

// Half-axes: split each cross-axis so an axis is dim only when BOTH flanking
// quadrants are dim (otherwise it IS the boundary between dim and bright).
interface HalfAxisSpec {
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  flankQuads: readonly [number, number];
}

const HALF_AXES: readonly HalfAxisSpec[] = [
  { from: [0, 0, 0], to: [ 20,   0, 0], flankQuads: [0, 3] }, // +X between Q0 & Q3
  { from: [0, 0, 0], to: [  0,  20, 0], flankQuads: [0, 1] }, // +Y between Q0 & Q1
  { from: [0, 0, 0], to: [-20,   0, 0], flankQuads: [1, 2] }, // -X between Q1 & Q2
  { from: [0, 0, 0], to: [  0, -20, 0], flankQuads: [2, 3] }, // -Y between Q2 & Q3
];

function arc(radius: number, a0: number, a1: number, segments: number, mat: ShaderMaterial): Line {
  const pts: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = a0 + (a1 - a0) * t;
    pts.push(new Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  return new Line(new BufferGeometry().setFromPoints(pts), mat);
}

interface RingArc { mat: ShaderMaterial; }
interface HalfAxis { mat: ShaderMaterial; flankQuads: readonly [number, number]; }

export class Grid {
  readonly group = new Group();
  private readonly ringQuads: RingArc[][] = [[], [], [], []];
  private readonly halfAxes: HalfAxis[] = [];
  private readonly arrowMat: ShaderMaterial;

  constructor() {
    // Concentric rings on the galactic plane, split into 4 arcs per ring.
    for (const r of RING_RADII) {
      const baseColor = (r === 20) ? 0x3a8fe0 : 0x1e6fc4;
      for (let q = 0; q < 4; q++) {
        const mat = snappedLineMat({ color: baseColor, opacity: RING_OPACITY_BASE });
        const [a0, a1] = QUAD_ANGLES[q];
        this.group.add(arc(r, a0, a1, 32, mat));
        this.ringQuads[q].push({ mat });
      }
    }

    // Cross axes split into independently-dimmable halves.
    for (const spec of HALF_AXES) {
      const mat = snappedLineMat({ color: 0x1e6fc4, opacity: AXIS_OPACITY_BASE });
      const geom = new BufferGeometry().setFromPoints([
        new Vector3(...spec.from), new Vector3(...spec.to),
      ]);
      this.group.add(new Line(geom, mat));
      this.halfAxes.push({ mat, flankQuads: spec.flankQuads });
    }

    // Galactic-centre arrow (toward +x).
    this.arrowMat = snappedLineMat({ color: 0x3a8fe0, opacity: ARROW_OPACITY_BASE });
    const shaft = new BufferGeometry().setFromPoints([
      new Vector3(20, 0, 0), new Vector3(24, 0, 0),
    ]);
    this.group.add(new Line(shaft, this.arrowMat));
    const head = new BufferGeometry().setFromPoints([
      new Vector3(24, 0, 0), new Vector3(22.8,  0.7, 0),
      new Vector3(24, 0, 0), new Vector3(22.8, -0.7, 0),
    ]);
    this.group.add(new LineSegments(head, this.arrowMat));
  }

  // Dim the half (two adjacent quadrants) furthest from the camera. The
  // dividing axis is chosen by whichever world axis the camera is more
  // aligned with — gives a clean "near half is bright, far half is dim" cue.
  update(camPosX: number, camPosY: number, targetX: number, targetY: number): void {
    const cx = camPosX - targetX;
    const cy = camPosY - targetY;
    let farQuads: readonly number[];
    if (Math.abs(cx) > Math.abs(cy)) {
      farQuads = (cx >= 0) ? [1, 2] : [0, 3];
    } else {
      farQuads = (cy >= 0) ? [2, 3] : [0, 1];
    }

    for (let q = 0; q < 4; q++) {
      const opacity = farQuads.includes(q) ? RING_OPACITY_DIM : RING_OPACITY_BASE;
      for (const { mat } of this.ringQuads[q]) {
        mat.uniforms.uOpacity.value = opacity;
      }
    }

    // Half-axis bright unless BOTH flanking quadrants are far. Otherwise it
    // sits on the near/far boundary and we keep it bright.
    for (const { mat, flankQuads } of this.halfAxes) {
      const bothFar = farQuads.includes(flankQuads[0]) && farQuads.includes(flankQuads[1]);
      mat.uniforms.uOpacity.value = bothFar ? AXIS_OPACITY_DIM : AXIS_OPACITY_BASE;
    }

    // Galactic-centre arrow lies on +X (between Q0 and Q3); same rule.
    const arrowDim = farQuads.includes(0) && farQuads.includes(3);
    this.arrowMat.uniforms.uOpacity.value = arrowDim ? ARROW_OPACITY_DIM : ARROW_OPACITY_BASE;
  }
}
