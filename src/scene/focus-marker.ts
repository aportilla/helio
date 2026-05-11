// Focus-point indicator: a small ring at view.target, with an optional
// vertical dropline down to the selected cluster's plane.
//
// The ring renders whenever view.target sits past a small threshold from
// the nearest "anchor" star — when a cluster is selected, that's the
// selection COM; otherwise it's the nearest cluster COM, so the marker
// fades in as the user pans into empty space between stars and stays
// hidden while sitting on or near a star (including initial-load at Sol).
//
// The dropline portion exists only when a cluster is selected — that's
// the only state where a plane exists to drop to. Without a selection
// the ring renders alone.
//
// Geometry is anchored at the group's local origin and the group is
// translated to view.target each tick. Top of the dropline stays at local
// (0,0,0); bottom rewrites to (0,0, planeZ - view.target.z). Dots span the
// same local Z range at fixed-period offsets — same pattern density as
// the per-cluster droplines (DOT_PERIOD_LY) so the depth cue reads
// consistently. Solid/dotted swap by camera side of plane mirrors
// droplines.ts.

import {
  BufferGeometry,
  Camera,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  Line,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { STAR_CLUSTERS } from '../data/stars';
import { snappedDotsMat, snappedLineMat } from './materials';

// Match droplines.ts so the focus-marker line uses the same
// premultiplied-against-black palette as the rest of the dropline
// subsystem — keeps the visual language coherent.
const COLOR_SOLID = 0x123d42;
const COLOR_DOTS  = 0x15464c;

// Ring matches the grid rings (same blue, same base opacity at full ramp)
// so the marker reads as a small companion to them rather than a different
// element class.
const RING_COLOR = 0x1e6fc4;
const RING_BASE_OPACITY = 0.32;
const RING_RADIUS_LY = 0.4;
const RING_SEGMENTS = 32;

// Distance ramp keyed to |view.target − anchor COM| (selected cluster, or
// nearest cluster when nothing is selected). Below NEAR the marker is
// hidden outright; above FAR it sits at full base opacity. Linear in
// between — pure function of the current pan offset, no animation state,
// so the marker tracks view.target frame-by-frame without lag.
const FOCUS_MARKER_NEAR = 0.5;
const FOCUS_MARKER_FAR  = 1.5;

// Same epsilon as droplines.ts: a dropline whose top is within this
// distance of the plane has effectively no length and the line is hidden.
// The ring still renders — it locates the focus laterally even when
// the pan stayed in-plane.
const DEGENERATE_PLANE_DIST = 0.01;

// Z-spacing for the dotted (far-side) variant. Same value as
// droplines.ts so the two pattern densities match when both render
// simultaneously.
const DOT_PERIOD_LY = 0.25;

// Pre-allocated capacity. Most pans stay near the selection plane, but
// Z/X keyboard fly can put view.target tens of ly off — give the buffer
// enough room that the user can't pan past it.
const MAX_DOTS = 200;

export class FocusMarker {
  readonly group = new Group();
  private readonly ring: Line;
  private readonly solid: Line;
  private readonly dots: Points;
  private readonly ringMat: ShaderMaterial;
  private readonly solidMat: ShaderMaterial;
  private readonly dotsMat: ShaderMaterial;
  private selectedCluster = -1;

  constructor() {
    this.group.visible = false;

    const ringPts: Vector3[] = [];
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      ringPts.push(new Vector3(Math.cos(a) * RING_RADIUS_LY, Math.sin(a) * RING_RADIUS_LY, 0));
    }
    this.ringMat = snappedLineMat({ color: RING_COLOR, opacity: 0 });
    this.ring = new Line(new BufferGeometry().setFromPoints(ringPts), this.ringMat);
    this.group.add(this.ring);

    this.solidMat = snappedLineMat({ color: COLOR_SOLID, opacity: 0 });
    const solidGeom = new BufferGeometry().setFromPoints([
      new Vector3(0, 0, 0),
      new Vector3(0, 0, 0),
    ]);
    (solidGeom.attributes.position as Float32BufferAttribute).setUsage(DynamicDrawUsage);
    this.solid = new Line(solidGeom, this.solidMat);
    this.group.add(this.solid);

    this.dotsMat = snappedDotsMat({ color: COLOR_DOTS, opacity: 0 });
    const dotsArr = new Float32Array(MAX_DOTS * 3);
    const dotsGeom = new BufferGeometry();
    const dotsAttr = new Float32BufferAttribute(dotsArr, 3);
    dotsAttr.setUsage(DynamicDrawUsage);
    dotsGeom.setAttribute('position', dotsAttr);
    dotsGeom.setDrawRange(0, 0);
    this.dots = new Points(dotsGeom, this.dotsMat);
    this.group.add(this.dots);
  }

  setSelectedCluster(clusterIdx: number): void {
    this.selectedCluster = clusterIdx;
  }

  update(viewTarget: Vector3, camera: Camera, focusAnimating: boolean): void {
    // Suppress during the focus glide — the pivot is in transit toward a
    // new COM, not parked off a star, so the "where am I looking" hint
    // would just trail the camera as it zooms in and read as noise.
    if (focusAnimating) {
      this.group.visible = false;
      return;
    }

    // Anchor distance — selection COM when selected, otherwise nearest
    // cluster COM. The latter keeps the marker hidden while view.target
    // sits on/near any star (Sol on initial load, or any star the camera
    // happens to be lined up with) and fades it in as the user pans into
    // empty space between stars.
    const anchorDist = this.selectedCluster >= 0
      ? this.distToCluster(viewTarget, this.selectedCluster)
      : this.distToNearestCluster(viewTarget);

    if (anchorDist <= FOCUS_MARKER_NEAR) {
      this.group.visible = false;
      return;
    }

    this.group.visible = true;
    this.group.position.copy(viewTarget);

    const ramp = anchorDist >= FOCUS_MARKER_FAR
      ? 1
      : (anchorDist - FOCUS_MARKER_NEAR) / (FOCUS_MARKER_FAR - FOCUS_MARKER_NEAR);
    this.ringMat.uniforms.uOpacity.value = ramp * RING_BASE_OPACITY;

    // Dropline portion: only when a cluster is selected — that's the
    // only state where a plane exists to drop to. Ring renders alone
    // otherwise.
    if (this.selectedCluster < 0) {
      this.solid.visible = false;
      this.dots.visible = false;
      return;
    }

    const planeZ = STAR_CLUSTERS[this.selectedCluster].com.z;
    const localBottomZ = planeZ - viewTarget.z;
    const dropLen = Math.abs(localBottomZ);

    if (dropLen < DEGENERATE_PLANE_DIST) {
      this.solid.visible = false;
      this.dots.visible = false;
      return;
    }

    // Solid when view.target sits on the camera's side of the plane,
    // dotted on the far side — same rule as the per-cluster pins so the
    // depth language stays uniform across the scene.
    const camAbove = camera.position.z >= planeZ;
    const targetAbove = viewTarget.z >= planeZ;
    const sameSide = targetAbove === camAbove;

    if (sameSide) {
      this.solid.visible = true;
      this.dots.visible = false;
      const pos = this.solid.geometry.attributes.position as Float32BufferAttribute;
      pos.setXYZ(1, 0, 0, localBottomZ);
      pos.needsUpdate = true;
      this.solidMat.uniforms.uOpacity.value = ramp;
    } else {
      this.solid.visible = false;
      this.dots.visible = true;
      const pos = this.dots.geometry.attributes.position as Float32BufferAttribute;
      const dir = localBottomZ >= 0 ? 1 : -1;
      let count = 0;
      // Skip the plane-side endpoint by starting one period in; stop
      // strictly before the ring at the top. Sub-period drops still get
      // a single midpoint dot so the line never disappears entirely.
      for (let off = DOT_PERIOD_LY; off < dropLen && count < MAX_DOTS; off += DOT_PERIOD_LY) {
        pos.setXYZ(count, 0, 0, dir * off);
        count++;
      }
      if (count === 0) {
        pos.setXYZ(0, 0, 0, dir * dropLen * 0.5);
        count = 1;
      }
      pos.needsUpdate = true;
      this.dots.geometry.setDrawRange(0, count);
      this.dotsMat.uniforms.uOpacity.value = ramp;
    }
  }

  private distToCluster(viewTarget: Vector3, clusterIdx: number): number {
    const com = STAR_CLUSTERS[clusterIdx].com;
    const dx = viewTarget.x - com.x;
    const dy = viewTarget.y - com.y;
    const dz = viewTarget.z - com.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Linear scan over all cluster COMs. ~70 clusters in the 50 ly catalog
  // and no per-iteration allocation, so the cost is trivial at 60 fps.
  // Returns the smallest distance; callers compare it to FOCUS_MARKER_NEAR
  // / FAR to decide visibility and ramp.
  private distToNearestCluster(viewTarget: Vector3): number {
    let bestSq = Infinity;
    for (let i = 0; i < STAR_CLUSTERS.length; i++) {
      const com = STAR_CLUSTERS[i].com;
      const dx = viewTarget.x - com.x;
      const dy = viewTarget.y - com.y;
      const dz = viewTarget.z - com.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestSq) bestSq = d2;
    }
    return Math.sqrt(bestSq);
  }
}
