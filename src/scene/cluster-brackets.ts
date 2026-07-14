// Yellow corner brackets enclosing every member of a cluster's rendered
// disc bbox. Used in two display states:
//   - 'arms': full L-corner reticle (the selected cluster's "active" indicator)
//   - 'dots': single-pixel corners (the candidate cluster's "potential
//     selection" indicator — pan the pivot away and the nearest cluster
//     gets bracketed; spacebar switches selection to it)
//
// Both styles share the bbox-of-members projection math, the corner
// positions, and the color (matches colors.starName so brackets read as
// part of the same "selected / about-to-select system" visual language as
// the info card). Texture and arm-length differ by style; the bracket
// CORNER positions are identical, so a candidate's dots sit exactly where
// the selection's arms would.
//
// One mesh per instance. Selection and candidate are two separate
// instances rendered simultaneously into the labels overlay scene at
// 1 unit = 1 buffer pixel. setCluster(-1) hides the mesh outright (no
// fade ramp — visibility is binary, snap on / snap off).

import {
  Camera,
  CanvasTexture,
  ClampToEdgeWrapping,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  Vector3,
} from 'three';
import { STARS, STAR_CLUSTERS } from '../data/stars';
import { renderedStarPxSize } from './materials';
import { projectWorldToBuffer } from './project-buffer';

export type BracketStyle = 'arms' | 'dots';

const BRACKET_GAP_PX  = 4;   // pixels between outermost disc edge and bracket corner
const BRACKET_MIN_SIZE = 12; // floor (per axis) so tiny stars still get a visible bracket
const BRACKET_COLOR   = '#ffe98a';

export function buildBracketTexture(size: number, style: BracketStyle): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = BRACKET_COLOR;
  const S = size;
  if (style === 'arms') {
    // Arms scale with bracket size to preserve the original ~20% ratio (the
    // old fixed 25/5 pair), clamped so very small reticles still get a
    // visible bracket and very large ones don't grow ungainly arms.
    const A = Math.max(3, Math.min(8, Math.round(size * 0.2)));
    // Each corner = two 1px arms forming an L pointing outward into that
    // corner. Canvas Y is top-down here; the texture maps onto a quad whose
    // own coords are flipped, so visually all four corners are symmetric.
    g.fillRect(0, 0, A, 1);         g.fillRect(0, 0, 1, A);          // TL
    g.fillRect(S - A, 0, A, 1);     g.fillRect(S - 1, 0, 1, A);      // TR
    g.fillRect(0, S - 1, A, 1);     g.fillRect(0, S - A, 1, A);      // BL
    g.fillRect(S - A, S - 1, A, 1); g.fillRect(S - 1, S - A, 1, A);  // BR
  } else {
    // Single-pixel dot at each of the four corners. Same corner positions
    // as the 'arms' style so a candidate's dots line up exactly where a
    // selection's arms would — a candidate becoming the selection just
    // grows arms outward from the same dots, no positional shift.
    g.fillRect(0, 0, 1, 1);              // TL
    g.fillRect(S - 1, 0, 1, 1);          // TR
    g.fillRect(0, S - 1, 1, 1);          // BL
    g.fillRect(S - 1, S - 1, 1, 1);      // BR
  }
  const t = new CanvasTexture(c);
  t.minFilter = NearestFilter; t.magFilter = NearestFilter;
  t.wrapS = ClampToEdgeWrapping; t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  return t;
}

// Shared per-frame scratch for bracketGeomForCluster — module-level: it's called sequentially from each
// bracket overlay's update() within a tick, never re-entrantly.
const _bgWorld = new Vector3();
const _bgView = new Vector3();
const _bgScreen = new Vector3();

// Project a cluster to its on-screen bracket geometry: the anchor (its COM in buffer px) + the square bracket
// SIZE that encloses every member's rendered disc (+ a gap), sized to what the camera actually shows. Anchors
// on the COM (not the per-member bbox midpoint) so projectWorldToBuffer's NDC-(0,0) short-circuit pins a
// focused cluster to exact buffer center — otherwise FP noise twitches the bracket 1px per orbit frame.
// Returns null when the COM projects off-screen. Shared by the single-cluster ClusterBrackets and the
// multi-cluster TargetBrackets so both size brackets identically. pxScale mirrors the stars shader's uPxScale.
export function bracketGeomForCluster(
  clusterIdx: number, camera: Camera, viewTarget: Vector3 | null,
  projW: number, bufferH: number, pxScale: number,
): { cx: number; cy: number; size: number } | null {
  const cluster = STAR_CLUSTERS[clusterIdx]!;
  _bgWorld.set(cluster.com.x, cluster.com.y, cluster.com.z);
  if (!projectWorldToBuffer(_bgWorld, camera, viewTarget, projW, bufferH, _bgScreen)) return null;
  const cx = _bgScreen.x, cy = _bgScreen.y;
  // Bracket size = max offset of any member's rendered disc from the anchor, so it grows symmetrically around
  // the stable COM (binaries/triples cover both members; a single member collapses to a tight square). A
  // member behind the camera is skipped rather than hiding the whole bracket.
  let radius = 0;
  for (const memIdx of cluster.members) {
    const s = STARS[memIdx]!;
    _bgWorld.set(s.x, s.y, s.z);
    if (!projectWorldToBuffer(_bgWorld, camera, viewTarget, projW, bufferH, _bgScreen)) continue;
    _bgView.set(s.x, s.y, s.z).applyMatrix4(camera.matrixWorldInverse);
    const r = renderedStarPxSize(s.pxSize, _bgView.z, pxScale) * 0.5;
    const dx = Math.abs(_bgScreen.x - cx) + r;
    const dy = Math.abs(_bgScreen.y - cy) + r;
    if (dx > radius) radius = dx;
    if (dy > radius) radius = dy;
  }
  return { cx, cy, size: Math.max(BRACKET_MIN_SIZE, Math.ceil(2 * (radius + BRACKET_GAP_PX))) };
}

export class ClusterBrackets {
  readonly mesh: Mesh;
  private readonly style: BracketStyle;
  // Horizontal projection extent = the 3D content-rect width (full buffer minus
  // the reserved sidebar strip), so a bracket lands on its cluster's disc rather
  // than drifting under the sidebar. The mesh lives in the labels overlay scene,
  // which spans the full buffer, so placement at x ≤ projW renders normally.
  private projW = 1;
  private bufferH = 1;
  // Mirrors the stars shader's uPxScale uniform — needed CPU-side to
  // compute each star's rendered size for the bbox.
  private pxScale = 1;
  private clusterIdx = -1;
  private currentSize = -1;

  constructor(style: BracketStyle) {
    this.style = style;
    const mat = new MeshBasicMaterial({
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), mat);
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  resize(projW: number, bufferH: number): void {
    this.projW = projW;
    this.bufferH = bufferH;
  }

  // Mirrors StarPoints.setPxScale — call from the same spot in scene.ts so
  // the bracket size formula sees the same uPxScale the shader does.
  setPxScale(s: number): void {
    this.pxScale = s;
  }

  // -1 hides the mesh. Otherwise the next update() projects the cluster's
  // members and sizes the bracket to enclose them.
  setCluster(idx: number): void {
    this.clusterIdx = idx;
  }

  // Rebuild the texture + quad when the bracket size changes. Cached by
  // integer size: the shader floors disc size to whole pixels, so during
  // continuous zoom we only rebuild on each integer step (~tens of times
  // across a full zoom range). Keeps GPU upload cost negligible.
  private ensureSize(size: number): void {
    if (size === this.currentSize) return;
    const mat = this.mesh.material as MeshBasicMaterial;
    if (mat.map) mat.map.dispose();
    mat.map = buildBracketTexture(size, this.style);
    mat.needsUpdate = true;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new PlaneGeometry(size, size);
    this.currentSize = size;
  }

  // Release the GPU resources this bracket owns: the current bracket
  // CanvasTexture, the quad geometry, and the material. The mesh lives in the
  // labels overlay scene that StarmapScene drops wholesale on teardown, but the
  // texture + geometry need explicit disposal. Idempotent — safe to call once
  // from StarmapScene.dispose().
  dispose(): void {
    const mat = this.mesh.material as MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
    this.mesh.geometry.dispose();
  }

  // Place the mesh so its top-left texel lands on an integer buffer pixel —
  // necessary so all four texture corners align with the buffer pixel grid
  // and every texel renders. Snapping just the center silently drops a row
  // or column of edge pixels for odd-dimension brackets.
  private placeAt(sx: number, sy: number, size: number): void {
    const cornerX = Math.round(sx - size * 0.5);
    const cornerY = Math.round(sy - size * 0.5);
    this.mesh.position.set(cornerX + size * 0.5, cornerY + size * 0.5, 0);
  }

  update(camera: Camera, viewTarget: Vector3): void {
    if (this.clusterIdx < 0) {
      this.mesh.visible = false;
      return;
    }
    const geom = bracketGeomForCluster(this.clusterIdx, camera, viewTarget, this.projW, this.bufferH, this.pxScale);
    if (!geom) {
      this.mesh.visible = false;
      return;
    }
    this.ensureSize(geom.size);
    this.mesh.visible = true;
    this.placeAt(geom.cx, geom.cy, geom.size);
  }
}
