import { BufferGeometry, Camera, Group, Line, Vector3 } from 'three';
import { STARS } from '../data/stars';
import { snappedLineMat } from './materials';

// Premultiplied against black bg — these are the on-screen colors. Solid is
// the previous 0x3ad1e6 * 0.85; dashed gets a touch less so dashed lines
// still read as the "receding / behind the plane" variant.
const COLOR_SOLID  = 0x32b2c3;
const COLOR_DASHED = 0x2b9dac;

interface Drop {
  solid: Line;
  dashed: Line;
  z: number;
}

// A vertical pin from each star to the galactic plane. Each star gets BOTH a
// solid and a dashed line sharing one geometry; update() picks which to show
// based on which side of the plane the camera views from.
//
// Materials are opaque (not alpha-blended) — coincident droplines from binary
// or triple-star systems would otherwise stack alpha and render brighter than
// singles. Opaque rendering means each pixel is exactly uColor regardless of
// how many lines overlap it.
export class Droplines {
  readonly group = new Group();
  private readonly drops: Drop[] = [];

  constructor() {
    for (const s of STARS) {
      if (s.name === 'Sun') continue;
      const geom = new BufferGeometry().setFromPoints([
        new Vector3(s.x, s.y, s.z),
        new Vector3(s.x, s.y, 0),
      ]);
      const solidMat  = snappedLineMat({ color: COLOR_SOLID,  opaque: true });
      const dashedMat = snappedLineMat({ color: COLOR_DASHED, opaque: true, dashPx: 1, gapPx: 3 });
      const solid  = new Line(geom, solidMat);
      const dashed = new Line(geom, dashedMat);
      this.group.add(solid);
      this.group.add(dashed);
      this.drops.push({ solid, dashed, z: s.z });
    }
  }

  update(camera: Camera, target: Vector3): void {
    const camAbove = camera.position.z >= target.z;
    for (const d of this.drops) {
      const sameSide = (d.z >= 0) === camAbove;
      d.solid.visible  =  sameSide;
      d.dashed.visible = !sameSide;
    }
  }
}
