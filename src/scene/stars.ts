import { BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import { CLASS_COLOR, CLASS_SIZE, STARS } from '../data/stars';
import { makeStarsMaterial } from './materials';

// gl.POINTS-based starfield. Stars draw AFTER droplines so the dot always
// sits on top of the line endpoint, not behind it.
export class StarPoints {
  readonly points: Points;
  private readonly material: ShaderMaterial;

  constructor(initialPxScale: number) {
    const geom = new BufferGeometry();
    const positions = new Float32Array(STARS.length * 3);
    const colors    = new Float32Array(STARS.length * 3);
    const sizes     = new Float32Array(STARS.length);

    STARS.forEach((s, i) => {
      positions[i * 3 + 0] = s.x;
      positions[i * 3 + 1] = s.y;
      positions[i * 3 + 2] = s.z;
      const col = CLASS_COLOR[s.cls] ?? CLASS_COLOR.M;
      colors[i * 3 + 0] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
      sizes[i] = CLASS_SIZE[s.cls] ?? CLASS_SIZE.M;
    });

    geom.setAttribute('position', new BufferAttribute(positions, 3));
    geom.setAttribute('color',    new BufferAttribute(colors, 3));
    geom.setAttribute('aSize',    new BufferAttribute(sizes, 1));

    this.material = makeStarsMaterial(initialPxScale);
    this.points = new Points(geom, this.material);
    this.points.renderOrder = 5;
  }

  setPxScale(s: number): void {
    this.material.uniforms.uPxScale.value = s;
  }
}
