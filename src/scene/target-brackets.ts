// TargetBrackets — dotted corner brackets around EVERY reachable star during a warp destination pick, marking
// which systems are potential targets (a click near one locks it; see StarmapScene's proximity pick). The
// multi-cluster sibling of ClusterBrackets: it pools one 'dots' bracket per target and reuses the SAME
// bbox-sizing (bracketGeomForCluster) so a target's dots sit exactly where its selection arms would once
// locked — a target just "upgrades" from dots to arms in place. Lives in the labels overlay scene (1 unit =
// 1 buffer pixel), like the other brackets.

import { type Camera, type CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, Group, Vector3 } from 'three';
import { bracketGeomForCluster, buildBracketTexture } from './cluster-brackets';
import { placeAtBufferPixel } from './project-buffer';

export class TargetBrackets {
  readonly group = new Group();

  // Content-rect width for the projection extent + the stars' uPxScale mirror (for the disc-bbox sizing) —
  // set from scene.ts exactly like ClusterBrackets.
  private projW = 1;
  private bufferH = 1;
  private pxScale = 1;

  // One 'dots' bracket texture per distinct integer SIZE, baked lazily + shared across pooled meshes (bracket
  // textures are tiny — four corner texels — so the cache never needs eviction).
  private readonly texCache = new Map<number, CanvasTexture>();
  // One shared unit plane scaled to (size, size) per bracket, so any size reuses one geometry.
  private readonly unitPlane = new PlaneGeometry(1, 1);
  // Grown on demand; surplus hidden per frame (the label/marker pool discipline). Per-mesh material so the map
  // (size-specific texture) can differ per bracket.
  private readonly pool: Mesh[] = [];

  private targets: readonly number[] = [];

  // The reachable clusters to bracket (the pick's targetable set, origin excluded). Empty ⇒ nothing draws.
  setTargets(clusterIdxs: readonly number[]): void {
    this.targets = clusterIdxs;
  }

  resize(projW: number, bufferH: number): void {
    this.projW = projW;
    this.bufferH = bufferH;
  }

  setPxScale(s: number): void {
    this.pxScale = s;
  }

  // Re-project each target and size its bracket to the cluster's on-screen disc bbox (via the shared helper),
  // then place the pooled quad. Runs each tick while the pick is armed.
  update(camera: Camera, viewTarget: Vector3): void {
    this.ensurePool(this.targets.length);
    for (let i = 0; i < this.targets.length; i++) {
      const mesh = this.pool[i]!;
      const geom = bracketGeomForCluster(this.targets[i]!, camera, viewTarget, this.projW, this.bufferH, this.pxScale);
      if (!geom) { mesh.visible = false; continue; }
      const tex = this.texFor(geom.size);
      const mat = mesh.material as MeshBasicMaterial;
      // needsUpdate only when the bound texture changes: the first assignment (null→tex) must recompile with
      // USE_MAP, and a zoom step swaps sizes; identical frames skip it.
      if (mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; }
      mesh.scale.set(geom.size, geom.size, 1);
      placeAtBufferPixel(mesh, geom.cx, geom.cy, geom.size, geom.size);
      mesh.visible = true;
    }
    for (let i = this.targets.length; i < this.pool.length; i++) this.pool[i]!.visible = false;
  }

  dispose(): void {
    for (const t of this.texCache.values()) t.dispose();
    this.texCache.clear();
    this.unitPlane.dispose();
    for (const mesh of this.pool) (mesh.material as MeshBasicMaterial).dispose();
  }

  private ensurePool(n: number): void {
    while (this.pool.length < n) {
      const mesh = new Mesh(this.unitPlane, new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }));
      mesh.renderOrder = 3; // same overlay depth as the other brackets
      mesh.visible = false;
      this.pool.push(mesh);
      this.group.add(mesh);
    }
  }

  private texFor(size: number): CanvasTexture {
    let t = this.texCache.get(size);
    if (!t) { t = buildBracketTexture(size, 'dots'); this.texCache.set(size, t); }
    return t;
  }
}
