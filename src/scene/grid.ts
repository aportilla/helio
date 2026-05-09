import { BufferGeometry, Group, Line, LineSegments, ShaderMaterial, Vector3 } from 'three';
import { snappedLineMat } from './materials';

// Base opacities at fade=1. setFade(t) scales both linearly so the rings/arrow
// keep their relative weight as the grid cross-fades on selection change.
const GRID_OPACITY  = 0.32;
const ARROW_OPACITY = 0.45;

const RING_RADII = [5, 10, 15, 20];
const RING_SEGMENTS = 128;

function ring(radius: number, segments: number): Vector3[] {
  const pts: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  return pts;
}

export class Grid {
  readonly group = new Group();
  // Held so setFade() can mutate the uOpacity uniforms each frame during a
  // selection cross-fade. Both materials are constructed here and not shared
  // with any other object — safe to drive directly.
  private readonly lineMat: ShaderMaterial;
  private readonly arrowMat: ShaderMaterial;

  constructor() {
    this.lineMat = snappedLineMat({ color: 0x1e6fc4, opacity: GRID_OPACITY });

    for (const r of RING_RADII) {
      const geom = new BufferGeometry().setFromPoints(ring(r, RING_SEGMENTS));
      this.group.add(new Line(geom, this.lineMat));
    }

    const xAxis = new BufferGeometry().setFromPoints([
      new Vector3(-20, 0, 0), new Vector3(20, 0, 0),
    ]);
    this.group.add(new Line(xAxis, this.lineMat));
    const yAxis = new BufferGeometry().setFromPoints([
      new Vector3(0, -20, 0), new Vector3(0, 20, 0),
    ]);
    this.group.add(new Line(yAxis, this.lineMat));

    this.arrowMat = snappedLineMat({ color: 0x1e6fc4, opacity: ARROW_OPACITY });
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

  // Cross-fade hook driven by the scene on selection change. t in [0, 1]:
  // 0 = invisible, 1 = the configured base opacities. Scales both materials
  // together so the arrow stays a touch brighter than the rings throughout
  // the fade, matching the static-state visual weighting.
  setFade(t: number): void {
    this.lineMat.uniforms.uOpacity.value  = GRID_OPACITY  * t;
    this.arrowMat.uniforms.uOpacity.value = ARROW_OPACITY * t;
  }
}
