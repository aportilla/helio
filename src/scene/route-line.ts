// RouteLine — the PROPOSED warp route highlighted during a destination pick: a thick GOLD line from the
// origin cluster's COM to the locked destination's. Distinct from TransitLines (dim blue, dotted, an
// ORDERED in-flight leg) — this is the bright "here's where I'm about to send it" affordance, shown only
// while a destination is locked in the pick and cleared on unlock/teardown.
//
// Drawn as a single screen-space quad ribbon (snappedThickLineMat): 4 corners riding ±half-width off the
// origin→destination centerline, pixel-snapped, solid gold, AA-off → a crisp constant-pixel-width band at
// any zoom or angle. Floated over the field (depthTest off) like the rest of the pick chrome. The quad is
// static; only the material's uO/uD endpoints change per lock, so re-locking never rebuilds geometry.

import { BufferAttribute, BufferGeometry, Group, Mesh, type ShaderMaterial } from 'three';
import { snappedThickLineMat } from './materials';

// = theme navGold (#f2c14e); ColorManagement is off so the numeric renders verbatim, matching the banner.
const ROUTE_COLOR = 0xf2c14e;
const ROUTE_WIDTH_PX = 3;       // band thickness in buffer px — "thick" but crisp

interface Vector3Like { readonly x: number; readonly y: number; readonly z: number }

export class RouteLine {
  readonly group = new Group();
  private readonly geom = new BufferGeometry();
  private readonly mat: ShaderMaterial;

  constructor() {
    this.mat = snappedThickLineMat({ color: ROUTE_COLOR, halfWidthPx: ROUTE_WIDTH_PX / 2 });
    this.mat.depthTest = false;
    // A static unit quad: two triangles over 4 corners. The shader reads the real endpoints from uO/uD;
    // `position` only exists so three knows the vertex count. aEnd picks the endpoint, aSide the offset.
    this.geom.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
    this.geom.setAttribute('aEnd', new BufferAttribute(new Float32Array([0, 0, 1, 1]), 1));
    this.geom.setAttribute('aSide', new BufferAttribute(new Float32Array([-1, 1, -1, 1]), 1));
    this.geom.setIndex([0, 2, 1, 1, 2, 3]);
    const mesh = new Mesh(this.geom, this.mat);
    mesh.frustumCulled = false; // endpoints live in the shader; the default (origin) bounds would cull it
    mesh.renderOrder = 5;       // over the stars, under the transit heads (6/7) + brackets/labels
    this.group.add(mesh);
    this.group.visible = false;
  }

  // Show the gold route between two cluster COMs. Null hides it (no destination locked). The uniform
  // values are three Vector3s (typed `any` on IUniform), so we set their components directly.
  setRoute(o: Vector3Like | null, d?: Vector3Like): void {
    if (!o || !d) { this.group.visible = false; return; }
    this.mat.uniforms.uO!.value.set(o.x, o.y, o.z);
    this.mat.uniforms.uD!.value.set(d.x, d.y, d.z);
    this.group.visible = true;
  }

  clear(): void {
    this.group.visible = false;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
