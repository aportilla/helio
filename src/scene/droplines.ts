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
import { STARS, STAR_CLUSTERS } from '../data/stars';
import { snappedDotsMat, snappedLineMat } from './materials';
import {
  PIVOT_FADE_NEAR,
  PIVOT_FADE_FAR,
  CAMERA_FADE_NEAR,
  CAMERA_FADE_FAR,
} from './cluster-fade';

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
// pattern density it always had. 0.25 ly was tuned to mirror the legacy
// 1-px-on / 3-px-off screen-space pattern at a mid-range orbit.
const DOT_PERIOD_LY = 0.25;

// Pre-allocated dot capacity per pin (= 125 ly of length at DOT_PERIOD_LY).
// Comfortably covers the 50 ly catalog's full Z extent before the camera-fade
// hides the pin at CAMERA_FADE_FAR. We rewrite z-values in place each time
// the selection plane shifts and use setDrawRange to reveal the active slice
// — avoids reallocating attributes on every selection change.
const MAX_DOTS_PER_PIN = 500;

// A pin whose top (cluster COM) lands within this distance of the focus
// plane has effectively no length and is hidden. The selected cluster
// itself sits exactly on its own focus plane (dz = 0) and so this is also
// what hides its self-referential pin.
const DEGENERATE_PLANE_DIST = 0.01;

// Distance fade thresholds live in ./cluster-fade so pin and label flip in/out
// together as either gets tuned. PIVOT ramp + CAMERA ramp multiply; either
// FAR hides the pin outright; hover/selection bypass both ramps AND the
// master visibility toggle.

interface Drop {
  solid: Line;
  dots: Points;
  solidMat: ShaderMaterial;
  dotsMat: ShaderMaterial;
  // Cluster center of mass — fixed for the lifetime of the pin. The pin's
  // bottom endpoint snaps to the selected cluster's COM.z (rewritten on
  // selection change); the top stays anchored here.
  com: Vector3;
  clusterIdx: number;
  // Primary's world position — the fade ramps key off this (matching labels)
  // so a cluster's pin and its label flip in/out at the same camera distance.
  // The pin geometry is anchored at the cluster COM; only the *fade
  // distance* is measured from the primary.
  primaryWorld: Vector3;
}

// A vertical pin from each cluster's center of mass to the *selected*
// cluster's focus plane (z = STAR_CLUSTERS[selected].com.z). One pin per
// cluster — non-primary cluster members (Sirius B, Alpha Cen B, Proxima,
// the Gliese 570 BC pair, etc.) share the cluster's pin rather than getting
// their own. The COM (not the primary's position) is the geometry anchor
// so a binary/triple reads as a single system whose pin emerges from the
// geometric middle of the ring rather than from one of its members.
//
// Selection-gated: with nothing selected, the entire system is hidden
// (the range rings vanish too — see scene.ts). When a cluster is selected,
// every other cluster's pin drops to the selected cluster's altitude,
// visualizing relative Z offsets from the system under inspection. The
// selected cluster's own pin collapses onto the plane (dz=0) and is
// hidden by the degeneracy check.
//
// Each pin renders as EITHER a solid Line (same-side as camera relative
// to the focus plane) or a dotted Points (far-side), driven per frame by
// the camera's z relative to the selected cluster's COM.z. Materials are
// cloned per-drop so each pin can carry its own opacity for the
// camera-and-pivot fade ramps.
export class Droplines {
  readonly group = new Group();
  private readonly drops: Drop[] = [];
  // Master toggle (HUD button) and current selection / hover. Selected and
  // hovered always render at full opacity — the user can dim everything else
  // off while keeping a depth cue for the system they're inspecting or just
  // pointing at. Visibility + opacity is applied per-drop in update() rather
  // than via group.visible so those overrides can punch through.
  private masterVisible: boolean;
  private selectedCluster = -1;
  private hoveredCluster = -1;

  // Last selection-plane Z we baked geometry against. NaN sentinel so the
  // first update() call after a selection always regenerates (the constructor
  // pre-seeds bottom = 0 and dots = empty; sentinel forces the first pass
  // through the dot-generation path so initial geometry is correct even when
  // the first selection lands exactly on z = 0).
  private lastPlaneZ = Number.NaN;

  constructor(initialMasterVisible: boolean) {
    this.masterVisible = initialMasterVisible;
    for (let cIdx = 0; cIdx < STAR_CLUSTERS.length; cIdx++) {
      const cluster = STAR_CLUSTERS[cIdx];
      // Sol's cluster used to be skipped (its COM at the origin gave a
      // zero-length pin against the fixed z=0 plane). With the focus plane
      // now keyed to the selected cluster's COM.z, Sol's pin is a real pin
      // whenever the user selects any non-Sol cluster — visualizes Sol's
      // altitude relative to the system under inspection. Per-frame
      // degeneracy hiding (DEGENERATE_PLANE_DIST) handles the on-plane case
      // (Sol selected, or any cluster co-planar with the selection).
      const com = cluster.com;
      const primary = STARS[cluster.primary];

      // Per-drop material clones so each pin can carry its own opacity for
      // the per-cluster fade ramps below. Cost: ~70 ShaderMaterials total.
      const solidMat = snappedLineMat({ color: COLOR_SOLID });
      const dotsMat  = snappedDotsMat({ color: COLOR_DOTS });

      // Solid line: top vertex pinned at COM, bottom rewritten on every
      // selection change (regenerateDrop). Pre-seed bottom at z=0 — first
      // selection's update() rewrites it. DynamicDrawUsage hints the GPU
      // at the upload pattern.
      const solidGeom = new BufferGeometry().setFromPoints([
        new Vector3(com.x, com.y, com.z),
        new Vector3(com.x, com.y, 0),
      ]);
      const solidPos = solidGeom.attributes.position as Float32BufferAttribute;
      solidPos.setUsage(DynamicDrawUsage);
      const solid = new Line(solidGeom, solidMat);

      // Dots: pre-allocate a fixed buffer of MAX_DOTS_PER_PIN positions; X
      // and Y stay constant (the pin is vertical) so we seed them once.
      // setDrawRange exposes the active count after each regenerate; Z
      // values get rewritten in regenerateDrop when the selection plane
      // shifts.
      const dotsArr = new Float32Array(MAX_DOTS_PER_PIN * 3);
      for (let i = 0; i < MAX_DOTS_PER_PIN; i++) {
        dotsArr[i * 3]     = com.x;
        dotsArr[i * 3 + 1] = com.y;
      }
      const dotsGeom = new BufferGeometry();
      const dotsAttr = new Float32BufferAttribute(dotsArr, 3);
      dotsAttr.setUsage(DynamicDrawUsage);
      dotsGeom.setAttribute('position', dotsAttr);
      dotsGeom.setDrawRange(0, 0);
      const dots = new Points(dotsGeom, dotsMat);

      this.group.add(solid);
      this.group.add(dots);
      this.drops.push({
        solid, dots, solidMat, dotsMat,
        com: new Vector3(com.x, com.y, com.z),
        clusterIdx: cIdx,
        primaryWorld: new Vector3(primary.x, primary.y, primary.z),
      });
    }
  }

  setMasterVisible(visible: boolean): void {
    this.masterVisible = visible;
  }

  // Pass a cluster index, or -1 to clear.
  setSelectedCluster(clusterIdx: number): void {
    this.selectedCluster = clusterIdx;
  }

  setHovered(clusterIdx: number): void {
    this.hoveredCluster = clusterIdx;
  }

  // Rewrite a pin's geometry to terminate at z = planeZ. Cheap: 1 vertex
  // for the solid line, up to MAX_DOTS_PER_PIN for the dots. Called only
  // when the selection plane actually shifts — most frames are no-ops.
  private regenerateDrop(d: Drop, planeZ: number): void {
    const com = d.com;

    const solidPos = d.solid.geometry.attributes.position as Float32BufferAttribute;
    solidPos.setXYZ(1, com.x, com.y, planeZ);
    solidPos.needsUpdate = true;

    const dz = com.z - planeZ;
    const len = Math.abs(dz);
    const dir = dz >= 0 ? 1 : -1;
    const dotsPos = d.dots.geometry.attributes.position as Float32BufferAttribute;
    let count = 0;
    // Start one full period in from the plane endpoint (skips the bottom
    // anchor visually) and stop strictly before the COM. A pin shorter
    // than one period still gets a single midpoint dot so it never
    // disappears entirely.
    for (let off = DOT_PERIOD_LY; off < len && count < MAX_DOTS_PER_PIN; off += DOT_PERIOD_LY) {
      dotsPos.setXYZ(count, com.x, com.y, planeZ + dir * off);
      count++;
    }
    if (count === 0 && len > DEGENERATE_PLANE_DIST) {
      dotsPos.setXYZ(0, com.x, com.y, planeZ + dir * len * 0.5);
      count = 1;
    }
    dotsPos.needsUpdate = true;
    d.dots.geometry.setDrawRange(0, count);
  }

  // Per-drop visibility + opacity:
  //   - selection gates the whole subsystem: with nothing selected, every
  //     drop is hidden and the range rings disappear too (see scene.ts).
  //   - otherwise plane Z = selected cluster's COM.z; bottom endpoints +
  //     dot positions are regenerated when that plane shifts.
  //   - render a non-selected drop only if masterVisible OR it's hovered.
  //     The selected cluster bypasses fade but its own pin is degenerate
  //     (dz=0) and hides naturally.
  //   - hover renders at full opacity (bypass fade); other drops fade by
  //     primary-distance ramps mirroring labels. Fade is keyed to the
  //     orbital pivot (viewTarget), not the locked rings — "what's near
  //     where the camera is looking right now" still applies even after
  //     the user pans away from the selection.
  //   - within a rendered drop, choose solid/dots by side of plane (solid
  //     when COM is on the same side as camera, dotted on the far side).
  //   - hide pins whose COM has collapsed onto the plane.
  update(camera: Camera, viewTarget: Vector3): void {
    if (this.selectedCluster < 0) {
      for (const d of this.drops) {
        d.solid.visible = false;
        d.dots.visible = false;
      }
      return;
    }

    const planeZ = STAR_CLUSTERS[this.selectedCluster].com.z;
    if (planeZ !== this.lastPlaneZ) {
      for (const d of this.drops) this.regenerateDrop(d, planeZ);
      this.lastPlaneZ = planeZ;
    }

    const camAbove = camera.position.z >= planeZ;
    for (const d of this.drops) {
      const dz = d.com.z - planeZ;
      if (Math.abs(dz) < DEGENERATE_PLANE_DIST) {
        d.solid.visible = false;
        d.dots.visible = false;
        continue;
      }

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
        if (dFocus >= PIVOT_FADE_FAR || dCam >= CAMERA_FADE_FAR) {
          d.solid.visible = false;
          d.dots.visible = false;
          continue;
        }
        if (dFocus > PIVOT_FADE_NEAR) {
          opacity *= 1 - (dFocus - PIVOT_FADE_NEAR) / (PIVOT_FADE_FAR - PIVOT_FADE_NEAR);
        }
        if (dCam > CAMERA_FADE_NEAR) {
          opacity *= 1 - (dCam - CAMERA_FADE_NEAR) / (CAMERA_FADE_FAR - CAMERA_FADE_NEAR);
        }
      }

      const sameSide = (dz >= 0) === camAbove;
      d.solid.visible = sameSide;
      d.dots.visible  = !sameSide;
      d.solidMat.uniforms.uOpacity.value = opacity;
      d.dotsMat.uniforms.uOpacity.value  = opacity;
    }
  }
}
