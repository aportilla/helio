// A single data-driven RANGE RING — the reach boundary drawn around a ship's origin while picking a warp
// destination. Spoken in the selection grid's visual language (the same blue, segment count, and
// camera-distance zoom-fade) but a SIBLING to Grid, not one of its A/B choreographed frames, so the
// pick's "one ring means one thing" reads cleanly against the suppressed selection grid.

import { BufferGeometry, Group, Line, ShaderMaterial, Vector3 } from 'three';
import { snappedLineMat } from './materials';
import { ringPoints } from './grid';
import { GRID_FADE_NEAR, GRID_FADE_FAR, clampRamp } from './cluster-fade';

const RING_SEGMENTS = 128;
// A touch brighter than the grid's own rings so the reach reads as a deliberate boundary, not chrome.
const RING_OPACITY = 0.42;
const RING_COLOR = 0x1e6fc4; // the grid blue

export class RangeRing {
  readonly group = new Group();
  private readonly line: Line;
  private readonly mat: ShaderMaterial;
  private readonly com = new Vector3();
  private lastRamp = -1;

  constructor() {
    this.mat = snappedLineMat({ color: RING_COLOR, opacity: RING_OPACITY });
    // A UNIT circle scaled to the radius via group.scale, so arming a different range never rebuilds geometry.
    const geom = new BufferGeometry().setFromPoints(ringPoints(1, RING_SEGMENTS));
    this.line = new Line(geom, this.mat);
    this.group.add(this.line);
    this.group.visible = false;
  }

  // Show the ring centred at (x,y,z) with radius `radiusLy` (world light-years). Hidden until called.
  setRing(x: number, y: number, z: number, radiusLy: number): void {
    this.com.set(x, y, z);
    this.group.position.set(x, y, z);
    this.group.scale.setScalar(radiusLy);
    this.group.visible = true;
    this.lastRamp = -1; // force the next fade write
  }

  clear(): void {
    this.group.visible = false;
  }

  // Per-tick zoom-fade off the camera's distance to the ring centre — matching the grid so the ring dims
  // out as the camera retreats. No-op while hidden or at a steady zoom.
  update(cameraPos: Vector3): void {
    if (!this.group.visible) return;
    const ramp = clampRamp(cameraPos.distanceTo(this.com), GRID_FADE_NEAR, GRID_FADE_FAR);
    if (Math.abs(ramp - this.lastRamp) < 1e-4) return;
    this.lastRamp = ramp;
    this.mat.uniforms.uOpacity!.value = ramp * RING_OPACITY;
  }

  dispose(): void {
    this.line.geometry.dispose();
    this.mat.dispose();
  }
}
