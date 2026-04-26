import { BufferGeometry, Camera, Group, Line, ShaderMaterial, Vector3 } from 'three';
import { STARS } from '../data/stars';
import { snappedLineMat } from './materials';

const BASE_SOLID_OPACITY  = 0.85;
const BASE_DASHED_OPACITY = 0.75;

interface Drop {
  solid: Line;
  dashed: Line;
  solidMat: ShaderMaterial;
  dashedMat: ShaderMaterial;
  z: number;
  anchor: Vector3;
}

// A vertical pin from each star to the galactic plane. Each star gets BOTH a
// solid and a dashed line sharing one geometry; the tick loop picks which to
// show based on which side of the plane the camera views from, and modulates
// opacity by camera proximity for a subtle depth cue.
export class Droplines {
  readonly group = new Group();
  private readonly drops: Drop[] = [];
  private readonly _tmp = new Vector3();
  private readonly _viewDir = new Vector3();

  constructor() {
    for (const s of STARS) {
      if (s.name === 'Sun') continue;
      const geom = new BufferGeometry().setFromPoints([
        new Vector3(s.x, s.y, s.z),
        new Vector3(s.x, s.y, 0),
      ]);
      const solidMat  = snappedLineMat({ color: 0x3ad1e6, opacity: BASE_SOLID_OPACITY });
      const dashedMat = snappedLineMat({ color: 0x3ad1e6, opacity: BASE_DASHED_OPACITY, dashPx: 1, gapPx: 5 });
      const solid  = new Line(geom, solidMat);
      const dashed = new Line(geom, dashedMat);
      this.group.add(solid);
      this.group.add(dashed);
      this.drops.push({ solid, dashed, solidMat, dashedMat, z: s.z, anchor: new Vector3(s.x, s.y, 0) });
    }
  }

  update(camera: Camera, target: Vector3): void {
    const camAbove = camera.position.z >= target.z;
    this._viewDir.subVectors(target, camera.position).normalize();
    const camPos = camera.position;

    // Pass 1: signed depth per drop along view axis + collect min/max.
    let minD = Infinity, maxD = -Infinity;
    const depths = new Array<number>(this.drops.length);
    for (let i = 0; i < this.drops.length; i++) {
      const depth = this._tmp.subVectors(this.drops[i].anchor, camPos).dot(this._viewDir);
      depths[i] = depth;
      if (depth < minD) minD = depth;
      if (depth > maxD) maxD = depth;
    }
    const range = Math.max(maxD - minD, 1e-4);

    // Pass 2: visibility (solid/dashed) and opacity multiplier in [1.0, 0.35].
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      const sameSide = (d.z >= 0) === camAbove;
      d.solid.visible  =  sameSide;
      d.dashed.visible = !sameSide;
      const mul = 1.0 - ((depths[i] - minD) / range) * 0.65;
      d.solidMat.uniforms.uOpacity.value  = BASE_SOLID_OPACITY  * mul;
      d.dashedMat.uniforms.uOpacity.value = BASE_DASHED_OPACITY * mul;
    }
  }
}
