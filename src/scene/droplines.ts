import { BufferGeometry, Camera, Float32BufferAttribute, Group, Line, Points, Vector3 } from 'three';
import { STARS, STAR_CLUSTERS, clusterIndexFor } from '../data/stars';
import { snappedDotsMat, snappedLineMat } from './materials';

// Premultiplied against black bg — these are the on-screen colors. Solid is
// the original 0x3ad1e6 cut to ~40% brightness; dots get a touch less so they
// still read as the "receding / behind the plane" variant.
const COLOR_SOLID = 0x164c53;
const COLOR_DOTS  = 0x134349;

// World-space spacing between dots on the dotted (far-side-of-plane) variant.
// Dots are baked into the geometry at fixed Z intervals so perspective
// compresses them at distance and stretches them up close — a distant
// dropline stays visually tight while the focused one carries the same
// pattern density it always had. 0.25 ly mirrors the legacy 1px-on / 3px-off
// proportion at the default 50 ly orbit (~17 px/ly = ~4 px between dots).
const DOT_PERIOD_LY = 0.25;

interface Drop {
  solid: Line;
  dots: Points;
  z: number;
}

// A vertical pin from each cluster's primary star to the galactic plane. One
// pin per cluster — non-primary members of multi-star clusters (Alpha Cen B,
// Proxima, Sirius B, …) share the cluster's depth context via the primary's
// pin and don't get their own. This matches the labelling model (one label
// per cluster, anchored at the primary) and avoids a forest of overlapping
// pins for tightly-coincident binary/triple systems.
//
// Each pin renders as EITHER a solid Line (same-side as camera) or a dotted
// Points (far-side), driven per frame by the camera's z relative to the
// plane. Materials are opaque (not alpha-blended) so a primary's pin
// rendering pixel-exactly at uColor isn't perturbed by any other geometry
// it might overlap.
export class Droplines {
  readonly group = new Group();
  private readonly drops: Drop[] = [];

  constructor() {
    // Materials are shared across all droplines — one solid, one dots —
    // so the GPU sees a single material per category.
    const solidMat = snappedLineMat({ color: COLOR_SOLID, opaque: true });
    const dotsMat  = snappedDotsMat({ color: COLOR_DOTS });

    for (let i = 0; i < STARS.length; i++) {
      const s = STARS[i];
      if (s.name === 'Sun') continue;
      // One dropline per cluster, anchored at the primary. Sirius A gets a
      // pin, Sirius B doesn't.
      if (STAR_CLUSTERS[clusterIndexFor(i)].primary !== i) continue;

      const solidGeom = new BufferGeometry().setFromPoints([
        new Vector3(s.x, s.y, s.z),
        new Vector3(s.x, s.y, 0),
      ]);
      const solid = new Line(solidGeom, solidMat);

      // Dots: one vertex per dot at z = k * DOT_PERIOD_LY along the line.
      // Start at one full period in (skipping the plane endpoint, which is
      // already drawn as the dropline anchor by other geometry visually) and
      // stop strictly before the star itself. A line shorter than one period
      // still gets a single dot at its midpoint so it never disappears.
      const dir  = Math.sign(s.z) || 1;
      const absZ = Math.abs(s.z);
      const positions: number[] = [];
      for (let z = DOT_PERIOD_LY; z < absZ; z += DOT_PERIOD_LY) {
        positions.push(s.x, s.y, dir * z);
      }
      if (positions.length === 0 && absZ > 0) {
        positions.push(s.x, s.y, dir * absZ * 0.5);
      }
      const dotsGeom = new BufferGeometry();
      dotsGeom.setAttribute('position', new Float32BufferAttribute(positions, 3));
      const dots = new Points(dotsGeom, dotsMat);

      this.group.add(solid);
      this.group.add(dots);
      this.drops.push({ solid, dots, z: s.z });
    }
  }

  // Solid if the star is on the same side of the galactic *plane* (z=0) as
  // the camera, dotted if on the far side. Comparing against z=0 (not the
  // target's z) means orbiting a high-z star from below — while still above
  // the plane — keeps every above-plane star's dropline solid.
  update(camera: Camera): void {
    const camAbove = camera.position.z >= 0;
    for (const d of this.drops) {
      const sameSide = (d.z >= 0) === camAbove;
      d.solid.visible = sameSide;
      d.dots.visible  = !sameSide;
    }
  }
}
