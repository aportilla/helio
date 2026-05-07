import { BufferGeometry, Camera, Float32BufferAttribute, Group, Line, Points, Vector3 } from 'three';
import { STARS, STAR_CLUSTERS } from '../data/stars';
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
  // Cluster index this drop belongs to. Used to keep the selected cluster's
  // pin visible when the master toggle is off.
  clusterIdx: number;
}

// A vertical pin from each cluster's center of mass to the galactic plane.
// One pin per cluster — non-primary members of multi-star systems (Alpha
// Cen B, Proxima, Sirius B, …) share the cluster's depth context via this
// pin and don't get their own. The COM (not the primary's position) is the
// anchor so a binary/triple reads as a single system whose pin emerges from
// the geometric middle of the ring rather than from one of its members.
//
// Each pin renders as EITHER a solid Line (same-side as camera) or a dotted
// Points (far-side), driven per frame by the camera's z relative to the
// plane. Materials are opaque (not alpha-blended) so a pin rendering
// pixel-exactly at uColor isn't perturbed by any other geometry it might
// overlap.
export class Droplines {
  readonly group = new Group();
  private readonly drops: Drop[] = [];
  // Master toggle (HUD button) and current selection. The selected cluster's
  // pin always renders, even when the master toggle is off — so the user
  // doesn't lose the depth context for the system whose info card they have
  // open. Visibility is applied per-drop in update() rather than via
  // group.visible so the selection-override can punch through.
  private masterVisible = true;
  private selectedCluster = -1;

  constructor() {
    // Materials are shared across all droplines — one solid, one dots —
    // so the GPU sees a single material per category.
    const solidMat = snappedLineMat({ color: COLOR_SOLID, opaque: true });
    const dotsMat  = snappedDotsMat({ color: COLOR_DOTS });

    for (let cIdx = 0; cIdx < STAR_CLUSTERS.length; cIdx++) {
      const cluster = STAR_CLUSTERS[cIdx];
      // Skip the Sun's cluster — its COM sits at the origin so a pin would
      // be a zero-length degenerate.
      if (STARS[cluster.primary].name === 'Sun') continue;
      const com = cluster.com;

      const solidGeom = new BufferGeometry().setFromPoints([
        new Vector3(com.x, com.y, com.z),
        new Vector3(com.x, com.y, 0),
      ]);
      const solid = new Line(solidGeom, solidMat);

      // Dots: one vertex per dot at z = k * DOT_PERIOD_LY along the line.
      // Start at one full period in (skipping the plane endpoint, which is
      // already drawn as the dropline anchor by other geometry visually) and
      // stop strictly before the COM itself. A line shorter than one period
      // still gets a single dot at its midpoint so it never disappears.
      const dir  = Math.sign(com.z) || 1;
      const absZ = Math.abs(com.z);
      const positions: number[] = [];
      for (let z = DOT_PERIOD_LY; z < absZ; z += DOT_PERIOD_LY) {
        positions.push(com.x, com.y, dir * z);
      }
      if (positions.length === 0 && absZ > 0) {
        positions.push(com.x, com.y, dir * absZ * 0.5);
      }
      const dotsGeom = new BufferGeometry();
      dotsGeom.setAttribute('position', new Float32BufferAttribute(positions, 3));
      const dots = new Points(dotsGeom, dotsMat);

      this.group.add(solid);
      this.group.add(dots);
      this.drops.push({ solid, dots, z: com.z, clusterIdx: cIdx });
    }
  }

  setMasterVisible(visible: boolean): void {
    this.masterVisible = visible;
  }

  // Pass a cluster index, or -1 to clear. Selecting a cluster whose pin
  // doesn't exist (the Sun's) is a no-op.
  setSelectedCluster(clusterIdx: number): void {
    this.selectedCluster = clusterIdx;
  }

  // Per-drop visibility: render if master toggle on OR this is the selected
  // cluster's pin. Within a rendered drop, choose solid/dots by side of
  // plane — solid when the COM is on the same side as the camera, dotted
  // on the far side. Comparing against z=0 (not the target's z) means
  // orbiting a high-z system from below — while still above the plane —
  // keeps every above-plane dropline solid.
  update(camera: Camera): void {
    const camAbove = camera.position.z >= 0;
    for (const d of this.drops) {
      const shouldRender = this.masterVisible || d.clusterIdx === this.selectedCluster;
      if (!shouldRender) {
        d.solid.visible = false;
        d.dots.visible = false;
        continue;
      }
      const sameSide = (d.z >= 0) === camAbove;
      d.solid.visible = sameSide;
      d.dots.visible  = !sameSide;
    }
  }
}
