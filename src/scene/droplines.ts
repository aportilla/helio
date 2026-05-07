import { BufferGeometry, Camera, Float32BufferAttribute, Group, Line, Points, ShaderMaterial, Vector3 } from 'three';
import { STARS, STAR_CLUSTERS } from '../data/stars';
import { snappedDotsMat, snappedLineMat } from './materials';

// Premultiplied against black bg — these are the on-screen colors at full
// opacity. Solid (near-side) sits at ~32% of the original 0x3ad1e6; dots
// (far-side) are ~15% brighter than solid so the broken-up dot pattern still
// reads at distance against the dark background.
const COLOR_SOLID = 0x123d42;
const COLOR_DOTS  = 0x15464c;

// World-space spacing between dots on the dotted (far-side-of-plane) variant.
// Dots are baked into the geometry at fixed Z intervals so perspective
// compresses them at distance and stretches them up close — a distant
// dropline stays visually tight while the focused one carries the same
// pattern density it always had. 0.25 ly mirrors the legacy 1px-on / 3px-off
// proportion at the default 50 ly orbit (~17 px/ly = ~4 px between dots).
const DOT_PERIOD_LY = 0.25;

// Distance fade — kept in sync with the cluster-label fade in labels.ts so a
// pin and its label flip in/out together (both keyed to the cluster primary).
// Two ramps multiply; either FAR threshold hides the pin outright. Hover and
// selection bypass both ramps AND the master visibility toggle.
const FADE_NEAR     = 8;
const FADE_FAR      = 14;
const CAM_FADE_NEAR = 25;
const CAM_FADE_FAR  = 55;

interface Drop {
  solid: Line;
  dots: Points;
  solidMat: ShaderMaterial;
  dotsMat: ShaderMaterial;
  z: number;
  clusterIdx: number;
  // Primary's world position — the fade ramps key off this (matching labels)
  // so a cluster's pin and its label flip in/out at the same camera distance.
  // The pin geometry is still anchored at the cluster COM; only the *fade
  // distance* is measured from the primary.
  primaryWorld: Vector3;
}

// A vertical pin from each cluster's center of mass to the galactic plane.
// One pin per cluster — non-primary cluster members (Sirius B, Alpha Cen B,
// Proxima, the Gliese 570 BC pair, etc.) share the cluster's pin rather than
// getting their own. The COM (not the primary's position) is the geometry
// anchor so a binary/triple reads as a single system whose pin emerges from
// the geometric middle of the ring rather than from one of its members.
//
// Each pin renders as EITHER a solid Line (same-side as camera) or a dotted
// Points (far-side), driven per frame by the camera's z relative to the
// plane. Materials are cloned per-drop so each pin can carry its own opacity
// for the focus/camera fade ramps.
export class Droplines {
  readonly group = new Group();
  private readonly drops: Drop[] = [];
  // Master toggle (HUD button) and current selection / hover. Selected and
  // hovered always render at full opacity — the user can dim everything else
  // off while keeping a depth cue for the system they're inspecting or just
  // pointing at. Visibility + opacity is applied per-drop in update() rather
  // than via group.visible so those overrides can punch through.
  private masterVisible = true;
  private selectedCluster = -1;
  private hoveredCluster = -1;

  constructor() {
    for (let cIdx = 0; cIdx < STAR_CLUSTERS.length; cIdx++) {
      const cluster = STAR_CLUSTERS[cIdx];
      // Skip Sol's cluster — its COM sits at the origin so a pin would
      // be a zero-length degenerate.
      if (STARS[cluster.primary].name === 'Sol') continue;
      const com = cluster.com;
      const primary = STARS[cluster.primary];

      // Per-drop material clones so each pin can carry its own opacity for
      // the per-cluster fade ramps below. Cost: ~70 ShaderMaterials total.
      const solidMat = snappedLineMat({ color: COLOR_SOLID });
      const dotsMat  = snappedDotsMat({ color: COLOR_DOTS });

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
      this.drops.push({
        solid, dots, solidMat, dotsMat,
        z: com.z,
        clusterIdx: cIdx,
        primaryWorld: new Vector3(primary.x, primary.y, primary.z),
      });
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

  setHovered(clusterIdx: number): void {
    this.hoveredCluster = clusterIdx;
  }

  // Per-drop visibility + opacity:
  //   - render if masterVisible OR this is the selected OR hovered cluster
  //   - hover / selection render at full opacity (bypass fade)
  //   - everything else fades by primary-distance ramps mirroring labels
  //   - within a rendered drop, choose solid/dots by side of plane (solid
  //     when COM is on the same side as camera, dotted on the far side)
  // Comparing plane-side against z=0 (not target.z) means orbiting a high-z
  // system from below — while still above the plane — keeps every above-plane
  // dropline solid.
  update(camera: Camera, viewTarget: Vector3): void {
    const camAbove = camera.position.z >= 0;
    for (const d of this.drops) {
      const isSelected = d.clusterIdx === this.selectedCluster;
      const isHovered  = d.clusterIdx === this.hoveredCluster;
      const bypassFade = isSelected || isHovered;

      if (!this.masterVisible && !bypassFade) {
        d.solid.visible = false;
        d.dots.visible = false;
        continue;
      }

      let opacity = 1;
      if (!bypassFade) {
        const dCam = d.primaryWorld.distanceTo(camera.position);
        const dFocus = d.primaryWorld.distanceTo(viewTarget);
        if (dFocus >= FADE_FAR || dCam >= CAM_FADE_FAR) {
          d.solid.visible = false;
          d.dots.visible = false;
          continue;
        }
        if (dFocus > FADE_NEAR) {
          opacity *= 1 - (dFocus - FADE_NEAR) / (FADE_FAR - FADE_NEAR);
        }
        if (dCam > CAM_FADE_NEAR) {
          opacity *= 1 - (dCam - CAM_FADE_NEAR) / (CAM_FADE_FAR - CAM_FADE_NEAR);
        }
      }

      const sameSide = (d.z >= 0) === camAbove;
      d.solid.visible = sameSide;
      d.dots.visible  = !sameSide;
      d.solidMat.uniforms.uOpacity.value = opacity;
      d.dotsMat.uniforms.uOpacity.value  = opacity;
    }
  }
}
