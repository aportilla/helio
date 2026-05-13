import { BufferAttribute, BufferGeometry, Points, ShaderMaterial, Vector3 } from 'three';
import { CLASS_COLOR, STARS, clusterIndexFor } from '../data/stars';
import { makeStarsMaterial } from './materials';

// gl.POINTS-based starfield. Stars draw AFTER droplines so the dot always
// sits on top of the line endpoint, not behind it.
export class StarPoints {
  readonly points: Points;
  private readonly material: ShaderMaterial;

  constructor(initialPxScale: number) {
    const geom = new BufferGeometry();
    const positions  = new Float32Array(STARS.length * 3);
    const colors     = new Float32Array(STARS.length * 3);
    const sizes      = new Float32Array(STARS.length);
    const clusterIdx = new Float32Array(STARS.length);

    STARS.forEach((s, i) => {
      positions[i * 3 + 0] = s.x;
      positions[i * 3 + 1] = s.y;
      positions[i * 3 + 2] = s.z;
      const col = CLASS_COLOR[s.cls] ?? CLASS_COLOR.M;
      colors[i * 3 + 0] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
      sizes[i] = s.pxSize;
      clusterIdx[i] = clusterIndexFor(i);
    });

    geom.setAttribute('position',    new BufferAttribute(positions, 3));
    geom.setAttribute('color',       new BufferAttribute(colors, 3));
    geom.setAttribute('aSize',       new BufferAttribute(sizes, 1));
    // Per-star cluster index so the shader can pop selected/candidate
    // cluster members back to full brightness while the pivot/camera fade
    // dims everything else. Static at construction; updates are uniforms.
    geom.setAttribute('aClusterIdx', new BufferAttribute(clusterIdx, 1));

    this.material = makeStarsMaterial(initialPxScale);
    this.points = new Points(geom, this.material);
    this.points.renderOrder = 5;
  }

  setPxScale(s: number): void {
    this.material.uniforms.uPxScale.value = s;
  }

  // Drives the focus-target short-circuit in the vertex shader. The vertex
  // whose attribute position matches this world coord exactly bypasses the
  // noisy matrix projection and snaps to buffer center — kills the 1 px disc
  // twitch on the focused star while the camera orbits around it.
  setFocus(world: Vector3): void {
    this.material.uniforms.uFocusWorld.value.copy(world);
  }

  // Orbit pivot in world space — anchor for the pivot fade ramp that dims
  // stars outside the local focus volume. Kept separate from uFocusWorld so
  // the "snap-to-NDC-zero" key and the fade anchor stay semantically
  // distinct even when they share a value today.
  setPivot(world: Vector3): void {
    this.material.uniforms.uPivotWorld.value.copy(world);
  }

  // Selected + candidate cluster indices. Members bypass the dim ramp so
  // the dot stays at full brightness regardless of distance from pivot —
  // parallels the yellow-label promotion in labels.ts. -1 = none.
  setSelectedCluster(idx: number): void {
    this.material.uniforms.uSelectedCluster.value = idx;
  }

  setCandidateCluster(idx: number): void {
    this.material.uniforms.uCandidateCluster.value = idx;
  }

  // How much of the pivot-dim effect to apply (1=full, 0=off). Scene drives
  // this from view.distance each tick so zooming out smoothly restores all
  // stars to full brightness — using a per-star camera-distance ramp here
  // would never re-brighten on zoom-out (every star is far from a zoomed-
  // out camera, including the nearby ones we want bright).
  setDimAmount(a: number): void {
    this.material.uniforms.uDimAmount.value = a;
  }
}
