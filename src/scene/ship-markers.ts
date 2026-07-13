// ShipMarkers — a fixed-size arrow glyph for every ship visible in the galaxy view: a stationed muster
// beside each star holding ready ships, and one triangle riding each transit leg. A sibling of Labels: it
// owns its own ortho overlay scene, projects world anchors with the MAIN camera each frame via
// projectWorldToBuffer, and places constant-on-screen-size textured quads at the resulting buffer-pixel
// coords. Constant-size + pixel-crisp is why this is an overlay and not a 3D sprite — a perspective sprite
// balloons as you zoom in; the overlay quad never grows with zoom.
//
// The glyph is procedural (triangleMask → a white bitmap, faction-tinted by the material color with
// ColorManagement off), so its shape/size is a one-line tweak and a size class is a data edit. Textures
// bake lazily per (size, facing); the shape/layout math lives in the Three-free ship-marker-geometry.ts.

import {
  type Camera,
  CanvasTexture,
  ClampToEdgeWrapping,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';
import { placeAtBufferPixel, projectWorldToBuffer } from './project-buffer';
import { renderedStarPxSize } from './materials';
import { STAR_MARKER_CLEARANCE_GAP, triangleMask } from './ship-marker-geometry';

type Facing = 'left' | 'right';

// A star's world position + per-class disc size (Star.pxSize) — the pair renderedStarPxSize needs to size
// that star's live on-screen disc. A stationed marker carries its whole cluster's members so the muster
// clears every disc, not just the primary's (multi-star clusters overlap otherwise).
export interface StarAnchor {
  readonly world: Vector3;
  readonly pxSize: number;
}

export interface MarkerSpec {
  // World anchor projected each frame: the cluster primary (stationed) or the step-midpoint on the leg
  // (transit). Cheap to re-project a few dozen per tick.
  readonly world: Vector3;
  // Formation-LOCAL offset of the marker CENTER, ENV px (transit: 0,0). +X right, +Y up. For a stationed
  // marker the renderer adds the cluster's live disc CLEARANCE to X (see update), so the muster rides just
  // off the disc(s) at every zoom; the formation is vertically centered on the star (see packStationedOffsets).
  readonly offsetX: number;
  readonly offsetY: number;
  // Triangle dims (ENV px) — picks the cached texture + the quad scale.
  readonly w: number;
  readonly h: number;
  // Stationed only: the cluster's member stars, for the live disc-clearance extent (the muster clears every
  // member disc, so a multi-star cluster doesn't overlap). null for a transit glyph (no clearance).
  readonly members: readonly StarAnchor[] | null;
  // Faction tint (sRGB hex; ColorManagement off so material.color multiplies the white texel verbatim).
  readonly color: string;
  // Transit: the destination anchor — facing = sign of on-screen dx, recomputed per tick (orbiting can flip
  // a leg's left/right). Stationed: null ⇒ face right (►).
  readonly toward: Vector3 | null;
}

// Bake a white right-pointing triangle (or its ◄ mirror) onto a transparent w×h canvas → a CanvasTexture
// mirroring makeLabelTexture's setup (NearestFilter, no mipmaps, ClampToEdge, default/raw-sRGB colorspace).
// White so the per-marker material color tints it to any faction hex. 'left' mirrors the mask across X
// (still exact-pixel).
function makeTriangleTexture(w: number, h: number, facing: Facing): CanvasTexture {
  const mask = triangleMask(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(w, h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const src = facing === 'left' ? (w - 1 - c) : c;
      if (mask[r * w + src]) {
        const o = (r * w + c) * 4;
        img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255; img.data[o + 3] = 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  return tex;
}

interface TexturePair {
  readonly right: CanvasTexture;
  readonly left: CanvasTexture;
}

export class ShipMarkers {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferH = 1;
  // Horizontal projection extent = the 3D content-rect width (buffer minus the sidebar strip), like Labels:
  // the ortho camera spans the full buffer, but anchors project into [0, contentW] so a marker tracks its
  // star instead of drifting under the sidebar.
  private contentW = 1;

  // Two textures (►/◄) per distinct (w,h), baked lazily and keyed `${w}x${h}`, so distinct sizes cost one
  // bake each and adding S/M/L is a data edit.
  private readonly texCache = new Map<string, TexturePair>();
  // One shared unit plane scaled to (w,h) per marker, so any size reuses one geometry.
  private readonly unitPlane = new PlaneGeometry(1, 1);
  // Grown on demand; surplus hidden per frame (the same hide-unused discipline as a label pool). Per-mesh
  // material so color + map (►/◄) differ per marker.
  private readonly pool: Mesh[] = [];

  private markers: readonly MarkerSpec[] = [];
  // Last hex tint applied to each pooled mesh, parallel to `pool`. Gates the per-tick material.color.set so
  // an unchanged color skips the hex reparse (the map swap above the color set is guarded the same way).
  private readonly poolTint: string[] = [];

  // Per-frame scratch (no allocation in update). _anchor projects the marker's own world anchor; _toward the
  // transit facing probe; _member each cluster member's screen pos + _view its view-space transform (for the
  // disc-clearance extent) — kept separate so they coexist within one marker's placement.
  private readonly _anchor = new Vector3();
  private readonly _toward = new Vector3();
  private readonly _member = new Vector3();
  private readonly _view = new Vector3();

  resize(bufferW: number, bufferH: number, contentW: number): void {
    this.bufferH = bufferH;
    this.contentW = contentW;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
  }

  // Replace the marker list. Rebuilt only when the ship set changes (turn advance, warp confirm, galaxy
  // resume) — never per frame; update() re-projects the stored anchors each tick.
  setMarkers(list: readonly MarkerSpec[]): void {
    this.markers = list;
  }

  // Re-project every anchor with the main camera and place the pooled quads. Runs each tick.
  update(camera: Camera, viewTarget: Vector3): void {
    this.ensurePool(this.markers.length);
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i]!;
      const mesh = this.pool[i]!;
      if (!projectWorldToBuffer(m.world, camera, viewTarget, this.contentW, this.bufferH, this._anchor)) {
        mesh.visible = false;
        continue;
      }
      const ax = this._anchor.x, ay = this._anchor.y;
      // Facing: stationed ⇒ right; transit ⇒ sign of the on-screen origin→destination dx (≥0 breaks the
      // near-vertical tie to right deterministically). Recomputed every tick — orbiting flips a leg's
      // left/right. A destination behind the frustum keeps the default right (rare, harmless).
      let facing: Facing = 'right';
      if (m.toward
        && projectWorldToBuffer(m.toward, camera, viewTarget, this.contentW, this.bufferH, this._toward)) {
        facing = this._toward.x >= ax ? 'right' : 'left';
      }
      // Stationed clearance: push the muster clear of the cluster's on-screen RIGHT extent so it never
      // overlaps at any zoom. The disc(s) grow as you zoom in, so a fixed gap would be overrun — instead take
      // the rightmost member disc edge across EVERY member (not just the primary, so multi-star clusters don't
      // overlap). renderedStarPxSize mirrors the star shader (its uPxScale is bufferH/2, the value scene feeds
      // StarPoints); view-space z drives the depth attenuation. Directional (right side only) + recomputed per
      // tick since orbit moves which member is rightmost. Transit glyphs ride the leg (members null) → none.
      let clearanceX = 0;
      if (m.members) {
        let rightExtent = ax; // primary is always a member and projects to ax, so this is the floor
        for (const mem of m.members) {
          if (!projectWorldToBuffer(mem.world, camera, viewTarget, this.contentW, this.bufferH, this._member)) continue;
          const viewZ = this._view.copy(mem.world).applyMatrix4(camera.matrixWorldInverse).z;
          const discR = renderedStarPxSize(mem.pxSize, viewZ, this.bufferH * 0.5) * 0.5;
          rightExtent = Math.max(rightExtent, this._member.x + discR);
        }
        clearanceX = (rightExtent - ax) + STAR_MARKER_CLEARANCE_GAP;
      }
      const mat = mesh.material as MeshBasicMaterial;
      const tex = this.texFor(m.w, m.h, facing);
      // needsUpdate only when the bound texture actually changes: the first assignment (null→tex) must
      // recompile with USE_MAP, and a facing flip swaps textures; identical frames skip it.
      if (mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; }
      // Reparse the hex only when the tint actually changes (fixed for the life of a marker list).
      if (this.poolTint[i] !== m.color) { mat.color.set(m.color); this.poolTint[i] = m.color; }
      mesh.scale.set(m.w, m.h, 1);
      placeAtBufferPixel(mesh, ax + clearanceX + m.offsetX, ay + m.offsetY, m.w, m.h);
      mesh.visible = true;
    }
    for (let i = this.markers.length; i < this.pool.length; i++) this.pool[i]!.visible = false;
  }

  dispose(): void {
    for (const { right, left } of this.texCache.values()) { right.dispose(); left.dispose(); }
    this.texCache.clear();
    this.unitPlane.dispose();
    for (const mesh of this.pool) (mesh.material as MeshBasicMaterial).dispose();
  }

  private ensurePool(n: number): void {
    while (this.pool.length < n) {
      const mesh = new Mesh(
        this.unitPlane,
        new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }),
      );
      mesh.visible = false;
      this.pool.push(mesh);
      this.poolTint.push(''); // empty sentinel — first update() differs from any real hex, forcing the set
      this.scene.add(mesh);
    }
  }

  private texFor(w: number, h: number, facing: Facing): CanvasTexture {
    const key = `${w}x${h}`;
    let pair = this.texCache.get(key);
    if (!pair) {
      pair = { right: makeTriangleTexture(w, h, 'right'), left: makeTriangleTexture(w, h, 'left') };
      this.texCache.set(key, pair);
    }
    return facing === 'left' ? pair.left : pair.right;
  }
}
