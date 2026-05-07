import { BufferGeometry, Group, Line, LineSegments, Vector3 } from 'three';
import { snappedLineMat } from './materials';

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

  constructor() {
    const lineMat = snappedLineMat({ color: 0x1e6fc4, opacity: GRID_OPACITY });

    for (const r of RING_RADII) {
      const geom = new BufferGeometry().setFromPoints(ring(r, RING_SEGMENTS));
      this.group.add(new Line(geom, lineMat));
    }

    const xAxis = new BufferGeometry().setFromPoints([
      new Vector3(-20, 0, 0), new Vector3(20, 0, 0),
    ]);
    this.group.add(new Line(xAxis, lineMat));
    const yAxis = new BufferGeometry().setFromPoints([
      new Vector3(0, -20, 0), new Vector3(0, 20, 0),
    ]);
    this.group.add(new Line(yAxis, lineMat));

    const arrowMat = snappedLineMat({ color: 0x1e6fc4, opacity: ARROW_OPACITY });
    const shaft = new BufferGeometry().setFromPoints([
      new Vector3(20, 0, 0), new Vector3(24, 0, 0),
    ]);
    this.group.add(new Line(shaft, arrowMat));
    const head = new BufferGeometry().setFromPoints([
      new Vector3(24, 0, 0), new Vector3(22.8,  0.7, 0),
      new Vector3(24, 0, 0), new Vector3(22.8, -0.7, 0),
    ]);
    this.group.add(new LineSegments(head, arrowMat));
  }
}
