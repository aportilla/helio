import {
  Camera,
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
import { STARS, STAR_CLUSTERS, clusterIndexFor } from '../data/stars';
import { makeLabelTexture } from '../data/pixel-font';

// Labels render in their own ortho overlay pass at 1 unit = 1 buffer pixel,
// the same scheme as Hud. World-locked anchors (cluster primary, galactic-
// centre, axis ticks) are projected by the *main* camera each frame and the
// overlay mesh is placed at the resulting buffer-pixel coords.
//
// Why an overlay instead of in-scene Sprites: under perspective, a 3D Sprite
// scales with depth. With stars now depth-attenuated, also depth-attenuating
// labels would make distant labels illegible. Constant on-screen size keeps
// typography stable while the stars do the depth-cueing work.

interface ClusterLabel {
  mesh: Mesh;        // plain text, anchored above primary, depth-sorted
  hoverMesh: Mesh;   // boxed variant for hover emphasis, hidden by default
  clusterIdx: number;
  primaryStarIdx: number;
  w: number;
  h: number;
  hoverW: number;
  hoverH: number;
}

interface AnchoredLabel {
  mesh: Mesh;
  worldPos: Vector3;
  w: number;
  h: number;
}

// Buffer-pixel gap between a star's projected position and its label.
const LABEL_OFFSET_PX = 6;

// Cluster-label distance fade. Two independent ramps multiply into a final
// opacity; either gate can hide the label outright at its FAR threshold.
// Hover and selection bypass both ramps so pointing at or clicking a far
// star always shows its label. Distance is measured to the primary, not the
// cluster COM, since the label itself is anchored at the primary.
//
// Focus ramp (orbit `view.target` → primary): the dominant gate at close
// zoom — keeps the visible label set scoped to the user's current point of
// interest.
//
// Camera ramp (camera position → primary): kicks in as the user zooms out.
// CAM_NEAR is chosen larger than FADE_FAR plus a "reasonably close" orbit
// radius (~10 ly), so at close zoom every label that survives the focus gate
// is also inside the camera bubble — only the focus gate effectively fires.
// As orbit distance grows past CAM_NEAR, stars exit the camera bubble and
// the labels dim independent of how the focus bubble would rate them.
const LABEL_FADE_NEAR     = 8;
const LABEL_FADE_FAR      = 14;
const LABEL_CAM_FADE_NEAR = 25;
const LABEL_CAM_FADE_FAR  = 55;

// Yellow corner-bracket reticle around the selected cluster. The brackets
// enclose every member's *rendered* disc each frame (see computeRenderedStarSize)
// so a single dwarf gets a tight square, a tilted binary ring gets a
// rectangular bbox showing the system's screen orientation, and a close-up
// class-O gets a big one — fixed-size looked equally wrong at every extreme.
// Color matches the info-card star-name color (`colors.starName`) so the
// reticle reads as part of the same "selected system" visual language as
// the card itself.
const RETICLE_GAP_PX  = 4;   // pixels between outermost disc edge and bracket corner
const RETICLE_MIN_SIZE = 12; // floor (per axis) so tiny stars still get a visible reticle
const RETICLE_COLOR   = '#ffe98a';

// Stars shader constants — kept here so computeRenderedStarSize can mirror
// the GPU-side size formula. If you change these in materials.ts, change
// them here too. Sharing a const isn't worth the cross-module coupling for
// two numbers that haven't moved in this file's history.
const STAR_REF_DIST = 50;
const STAR_PX_SCALE_DIVISOR = 800;

function buildReticleTexture(size: number, armLen: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = RETICLE_COLOR;
  const S = size;
  const A = armLen;
  // Each corner = two 1px arms forming an L pointing outward into that
  // corner. Canvas Y is top-down here; the texture maps onto a quad whose
  // own coords are flipped, so visually all four corners are symmetric.
  g.fillRect(0, 0, A, 1);         g.fillRect(0, 0, 1, A);          // TL
  g.fillRect(S - A, 0, A, 1);     g.fillRect(S - 1, 0, 1, A);      // TR
  g.fillRect(0, S - 1, A, 1);     g.fillRect(0, S - A, 1, A);      // BL
  g.fillRect(S - A, S - 1, A, 1); g.fillRect(S - 1, S - A, 1, A);  // BR
  const t = new CanvasTexture(c);
  t.minFilter = NearestFilter; t.magFilter = NearestFilter;
  t.wrapS = ClampToEdgeWrapping; t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  return t;
}

function labelMat(tex: ReturnType<typeof makeLabelTexture>['tex']): MeshBasicMaterial {
  return new MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
}

export class Labels {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;
  // Mirrors the stars shader's uPxScale uniform — needed CPU-side to compute
  // each star's rendered size for the dynamic selection reticle.
  private pxScale = 1;

  private readonly clusterLabels: ClusterLabel[] = [];
  private readonly gcLabel: AnchoredLabel;

  private showLabels = true;
  private hoveredCluster = -1;
  private selectedCluster = -1;

  private readonly reticleMesh: Mesh;
  private currentReticleSize = -1;

  // Reusable per-frame scratch.
  private readonly _proj = new Vector3();
  private readonly _world = new Vector3();
  private readonly _view = new Vector3();
  private readonly _screen = { x: 0, y: 0 };

  // Set per-frame from scene.ts so projectToBuffer can short-circuit the
  // focused star to exact buffer-center coords (see projectToBuffer).
  private viewTarget: Vector3 | null = null;

  constructor() {
    // One label per cluster, displayed at the primary's projected position.
    // Sol's label is warm-white rather than yellow so it stays readable when
    // its quad overlaps the equally-yellow Sol dot. Multi-star clusters get
    // a " +N" suffix in dim cyan to indicate hidden members.
    //
    // We build TWO meshes per cluster: a plain text label (default) and a
    // boxed variant used as the hover-emphasis state. Eager build avoids any
    // first-hover canvas work and the memory cost is negligible (~80 small
    // textures). The hover mesh sits at a fixed high renderOrder so it
    // always paints above the depth-sorted plain labels and the reticle.
    STAR_CLUSTERS.forEach((cluster, clusterIdx) => {
      const primary = STARS[cluster.primary];
      const isSol = primary.name === 'Sol';
      const nameColor = isSol ? '#ffffcc' : '#5ec8ff';
      const extras = cluster.members.length - 1;
      const segments = extras > 0
        ? [{ text: primary.name, color: nameColor }, { text: ` +${extras}`, color: '#2d7ab8' }]
        : [{ text: primary.name, color: nameColor }];
      const plain = makeLabelTexture(segments);
      const mesh = new Mesh(new PlaneGeometry(plain.w, plain.h), labelMat(plain.tex));
      mesh.renderOrder = 1;
      mesh.visible = false;
      this.scene.add(mesh);

      const boxed = makeLabelTexture(segments, { box: true });
      const hoverMesh = new Mesh(new PlaneGeometry(boxed.w, boxed.h), labelMat(boxed.tex));
      hoverMesh.renderOrder = 4;
      hoverMesh.visible = false;
      this.scene.add(hoverMesh);

      this.clusterLabels.push({
        mesh, hoverMesh,
        clusterIdx,
        primaryStarIdx: cluster.primary,
        w: plain.w, h: plain.h,
        hoverW: boxed.w, hoverH: boxed.h,
      });
    });

    // Galactic-centre pointer label.
    // noHalo so the label color matches the literal grid-arrow hex, not a
    // subtly darkened halo'd version.
    const gc = makeLabelTexture('GALACTIC CENTRE', '#1e6fc4', { noHalo: true });
    const gcMesh = new Mesh(new PlaneGeometry(gc.w, gc.h), labelMat(gc.tex));
    gcMesh.renderOrder = 1;
    this.scene.add(gcMesh);
    // worldPos is the arrow tip; the per-frame placement nudges the label
    // past it along the projected arrow direction so the arrow line passes
    // through the label's center from any view angle (see update()).
    this.gcLabel = { mesh: gcMesh, worldPos: new Vector3(24, 0, 0), w: gc.w, h: gc.h };

    // Selection reticle — texture and quad rebuilt on size change in
    // ensureReticleSize(). Start with a 1×1 placeholder; first selection
    // triggers the real build.
    const reticleMat = new MeshBasicMaterial({
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.reticleMesh = new Mesh(new PlaneGeometry(1, 1), reticleMat);
    this.reticleMesh.renderOrder = 3;
    this.reticleMesh.visible = false;
    this.scene.add(this.reticleMesh);
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
  }

  // Mirrors StarPoints.setPxScale — call from the same spot in scene.ts so
  // the reticle's size formula sees the same uPxScale the shader does.
  setPxScale(s: number): void {
    this.pxScale = s;
  }

  setShowLabels(show: boolean): void {
    this.showLabels = show;
    // Cluster labels are gated per-frame (and the hovered label always
    // shows regardless); only the static ancillary labels need direct
    // visibility toggles here.
    this.gcLabel.mesh.visible = show;
  }

  setHovered(starIdx: number): void {
    this.hoveredCluster = starIdx >= 0 ? clusterIndexFor(starIdx) : -1;
  }

  setSelectedCluster(clusterIdx: number): void {
    this.selectedCluster = clusterIdx;
  }

  // Project a world position into buffer-pixel coords (Y-up, origin at
  // bottom-left). Returns false if the point sits behind the near plane or
  // beyond the far plane — caller should hide the mesh in that case.
  //
  // Special-cases the camera's orbit target: by construction it projects to
  // NDC (0,0), but the matrix math doesn't cancel exactly under FP and the
  // result oscillates by ~1e-7 NDC as yaw/pitch rotate. That sub-pixel noise
  // crosses the integer/half-integer threshold in placeAt() and produces a
  // 1px x/y twitch on the focused star's label every orbit frame. Other
  // labels see the same noise but it's swamped by their legitimate per-frame
  // motion, so we only short-circuit the equality case.
  private projectToBuffer(world: Vector3, camera: Camera): boolean {
    if (this.viewTarget && world.equals(this.viewTarget)) {
      this._screen.x = this.bufferW * 0.5;
      this._screen.y = this.bufferH * 0.5;
      return true;
    }
    this._proj.copy(world).project(camera);
    if (this._proj.z < -1 || this._proj.z > 1) return false;
    this._screen.x = (this._proj.x * 0.5 + 0.5) * this.bufferW;
    this._screen.y = (this._proj.y * 0.5 + 0.5) * this.bufferH;
    return true;
  }

  // CPU mirror of the stars shader's depth-attenuated size formula
  // (materials.ts → makeStarsMaterial). Returns the on-screen disc diameter
  // in buffer pixels for the given star under the current camera. Lets the
  // selection reticle's outer size track what the user actually sees rather
  // than sitting at a fixed 25 px around tiny dwarfs and close-up giants
  // alike. Keep this in sync with the shader if either drifts — there's
  // unfortunately no shared source for the formula.
  private computeRenderedStarSize(starIdx: number, camera: Camera): number {
    const s = STARS[starIdx];
    this._view.set(s.x, s.y, s.z).applyMatrix4(camera.matrixWorldInverse);
    const dist = Math.max(-this._view.z, 0.5);
    const rawScale = STAR_REF_DIST / dist;
    const depthScale = rawScale > 1 ? Math.pow(rawScale, 1 / 3) : rawScale;
    const sz = Math.max(s.pxSize * (this.pxScale / STAR_PX_SCALE_DIVISOR) * depthScale, 2);
    return Math.floor(sz + 0.5);
  }

  // Rebuild the reticle texture + quad when the target size changes. Cached
  // by integer size: the shader floors disc size to whole pixels, so during
  // continuous zoom we only rebuild on each integer step (~tens of times
  // across a full zoom range). Keeps GPU upload cost negligible.
  private ensureReticleSize(size: number): void {
    if (size === this.currentReticleSize) return;
    // Arms scale with reticle size to preserve the original ~20% ratio (the
    // old fixed 25/5 pair), clamped so very small reticles still get a
    // visible bracket and very large ones don't grow ungainly arms.
    const armLen = Math.max(3, Math.min(8, Math.round(size * 0.2)));
    const mat = this.reticleMesh.material as MeshBasicMaterial;
    if (mat.map) mat.map.dispose();
    mat.map = buildReticleTexture(size, armLen);
    mat.needsUpdate = true;
    this.reticleMesh.geometry.dispose();
    this.reticleMesh.geometry = new PlaneGeometry(size, size);
    this.currentReticleSize = size;
  }

  // Place a label so its top-left texel lands on an integer buffer pixel —
  // necessary so all four texture corners align with the buffer pixel grid
  // and every texel renders. Snapping just the center silently drops a row
  // or column of edge pixels for odd-dimension labels.
  private placeAt(mesh: Mesh, sx: number, sy: number, w: number, h: number): void {
    const cornerX = Math.round(sx - w * 0.5);
    const cornerY = Math.round(sy - h * 0.5);
    mesh.position.set(cornerX + w * 0.5, cornerY + h * 0.5, 0);
  }

  update(camera: Camera, viewTarget: Vector3): void {
    this.viewTarget = viewTarget;

    // Cluster labels — each anchored above its primary star, in one of two
    // states:
    //   - plain: depth-sorted (renderOrder = -distance) so nearer labels
    //     overlap farther ones. All values stay <= 0, safely below the
    //     reticle (3) and the hover variant (4).
    //   - boxed hover: shown only for the hovered cluster, fixed renderOrder
    //     4 so it always paints above every other overlay element. Same
    //     anchor offset as plain, so the text shifts ~2 px from the box's
    //     extra padding/border — a deliberate state-change cue.
    // Hover on a *selected* cluster falls through to the plain branch: the
    // reticle already provides the "this is the active system" feedback, so
    // adding the boxed hover on top would be redundant chrome.
    // Hover ignores `showLabels` on purpose: with labels off, the boxed
    // hover (or, when selected, the plain label) is the only feedback that
    // pointing at a star did anything.
    // Without the per-renderOrder depth sort, all cluster labels would share
    // renderOrder 1 with uniform z, and draw order would fall back to scene-
    // add (catalog) order — far labels could paint over near ones.
    for (const L of this.clusterLabels) {
      const isHover = L.clusterIdx === this.hoveredCluster;
      const isSelected = L.clusterIdx === this.selectedCluster;
      const bypassFade = isHover || isSelected;
      if (!this.showLabels && !isHover) {
        L.mesh.visible = false; L.hoverMesh.visible = false; continue;
      }
      const s = STARS[L.primaryStarIdx];
      this._world.set(s.x, s.y, s.z);
      if (!this.projectToBuffer(this._world, camera)) {
        L.mesh.visible = false; L.hoverMesh.visible = false; continue;
      }
      const dCam = this._world.distanceTo(camera.position);
      let opacity = 1;
      if (!bypassFade) {
        const dFocus = this._world.distanceTo(viewTarget);
        if (dFocus >= LABEL_FADE_FAR || dCam >= LABEL_CAM_FADE_FAR) {
          L.mesh.visible = false; L.hoverMesh.visible = false; continue;
        }
        if (dFocus > LABEL_FADE_NEAR) {
          opacity *= 1 - (dFocus - LABEL_FADE_NEAR) / (LABEL_FADE_FAR - LABEL_FADE_NEAR);
        }
        if (dCam > LABEL_CAM_FADE_NEAR) {
          opacity *= 1 - (dCam - LABEL_CAM_FADE_NEAR) / (LABEL_CAM_FADE_FAR - LABEL_CAM_FADE_NEAR);
        }
      }
      if (isHover && !isSelected) {
        L.mesh.visible = false;
        L.hoverMesh.visible = true;
        (L.hoverMesh.material as MeshBasicMaterial).opacity = opacity;
        // -1 keeps the glyphs at the same screen position as the plain
        // label: the boxed canvas uses pad=4 (vs plain's pad=3) so its
        // glyph row sits 1px lower inside the canvas. Without this offset
        // the bottom-anchored quads end up rendering the text 1px higher
        // on screen in the hover state — visually the text twitches up.
        const cy = this._screen.y + LABEL_OFFSET_PX + L.hoverH * 0.5 - 1;
        this.placeAt(L.hoverMesh, this._screen.x, cy, L.hoverW, L.hoverH);
      } else {
        L.hoverMesh.visible = false;
        L.mesh.visible = true;
        (L.mesh.material as MeshBasicMaterial).opacity = opacity;
        const cy = this._screen.y + LABEL_OFFSET_PX + L.h * 0.5;
        this.placeAt(L.mesh, this._screen.x, cy, L.w, L.h);
        L.mesh.renderOrder = -dCam;
      }
    }

    // Galactic-centre label — pushed past the arrow tip along the arrow's
    // screen-space direction, so the arrow line passes through the label's
    // center regardless of yaw/pitch. A fixed screen-x offset (the prior
    // approach) flipped to the wrong side of the arrow when viewed from the
    // -X half-space, since "+x in screen" no longer corresponds to "+X in
    // world". Project (24,0,0) for the tip and (25,0,0) for a step along the
    // arrow line; the normalized screen delta is the direction the arrow
    // visually points, and we offset by w/2 + gap along it.
    this.gcLabel.mesh.visible = false;
    if (this.showLabels && this.projectToBuffer(this.gcLabel.worldPos, camera)) {
      const tipX = this._screen.x;
      const tipY = this._screen.y;
      this._world.set(25, 0, 0);
      if (this.projectToBuffer(this._world, camera)) {
        let dx = this._screen.x - tipX;
        let dy = this._screen.y - tipY;
        const len = Math.hypot(dx, dy);
        // Camera looking nearly along ±X collapses the projected arrow to a
        // point. Skip placement rather than render at a degenerate position;
        // the arrow itself is also edge-on / invisible there.
        if (len >= 0.5) {
          dx /= len; dy /= len;
          const push = this.gcLabel.w * 0.5 + 6;
          this.gcLabel.mesh.visible = true;
          this.placeAt(
            this.gcLabel.mesh,
            tipX + dx * push,
            tipY + dy * push,
            this.gcLabel.w,
            this.gcLabel.h,
          );
        }
      }
    }

    // Selection reticle — bbox of every cluster member's rendered disc, so
    // a binary/triple reads as a single selectable system whose brackets
    // describe its current screen orientation. Single-member clusters
    // collapse to the previous square-around-one-disc behavior. If a member
    // is behind the camera (projectToBuffer false) we still draw brackets
    // around the visible ones rather than hiding the whole reticle.
    if (this.selectedCluster >= 0) {
      const cluster = STAR_CLUSTERS[this.selectedCluster];
      let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
      for (const memIdx of cluster.members) {
        const s = STARS[memIdx];
        this._world.set(s.x, s.y, s.z);
        if (!this.projectToBuffer(this._world, camera)) continue;
        const r = this.computeRenderedStarSize(memIdx, camera) * 0.5;
        if (this._screen.x - r < xmin) xmin = this._screen.x - r;
        if (this._screen.x + r > xmax) xmax = this._screen.x + r;
        if (this._screen.y - r < ymin) ymin = this._screen.y - r;
        if (this._screen.y + r > ymax) ymax = this._screen.y + r;
      }
      if (xmin === Infinity) {
        this.reticleMesh.visible = false;
      } else {
        // Square reticle, sized to enclose the larger of the two bbox
        // dimensions (so a tilted binary's brackets fully contain both
        // members on either axis), centered on the bbox midpoint. Keeps
        // the visual identity consistent across single-star and multi-
        // star selections — only the size scales with the system.
        const padded = 2 * RETICLE_GAP_PX;
        const span = Math.max(xmax - xmin, ymax - ymin);
        const size = Math.max(RETICLE_MIN_SIZE, Math.ceil(span + padded));
        this.ensureReticleSize(size);
        this.reticleMesh.visible = true;
        const cx = (xmin + xmax) * 0.5;
        const cy = (ymin + ymax) * 0.5;
        this.placeAt(this.reticleMesh, cx, cy, size, size);
      }
    } else {
      this.reticleMesh.visible = false;
    }
  }
}
