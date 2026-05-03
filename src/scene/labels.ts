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
  mesh: Mesh;
  primaryStarIdx: number;
  w: number;
  h: number;
}

interface AnchoredLabel {
  mesh: Mesh;
  worldPos: Vector3;
  w: number;
  h: number;
}

// Buffer-pixel gap between a star's projected position and its label/tooltip.
const LABEL_OFFSET_PX = 6;
const TIP_OFFSET_PX = 18;

// Yellow corner-bracket reticle around the selected star. Fixed screen size
// so it reads consistently whether the star's disc is huge (focused class-O
// up close) or tiny (distant white dwarf). Color matches the hover-tooltip
// star-name color so "selected" feels visually related to "highlighted".
const RETICLE_SIZE_PX = 25;
const RETICLE_ARM_PX = 5;
const RETICLE_COLOR  = '#ffe98a';

function buildReticleTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = RETICLE_SIZE_PX; c.height = RETICLE_SIZE_PX;
  const g = c.getContext('2d')!;
  g.fillStyle = RETICLE_COLOR;
  const S = RETICLE_SIZE_PX;
  const A = RETICLE_ARM_PX;
  // Each corner = two 1px arms forming an L pointing outward into that
  // corner. Canvas Y is top-down here; the texture maps onto a quad whose
  // own coords are flipped, so visually all four corners are symmetric.
  // Top-left
  g.fillRect(0, 0, A, 1);
  g.fillRect(0, 0, 1, A);
  // Top-right
  g.fillRect(S - A, 0, A, 1);
  g.fillRect(S - 1, 0, 1, A);
  // Bottom-left
  g.fillRect(0, S - 1, A, 1);
  g.fillRect(0, S - A, 1, A);
  // Bottom-right
  g.fillRect(S - A, S - 1, A, 1);
  g.fillRect(S - 1, S - A, 1, A);
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

  private readonly clusterLabels: ClusterLabel[] = [];
  private readonly axisLabels: AnchoredLabel[] = [];
  private readonly gcLabel: AnchoredLabel;
  private readonly tipMesh: Mesh;
  private readonly tipMat: MeshBasicMaterial;
  private tipW = 0;
  private tipH = 0;

  private showLabels = true;
  private hoveredCluster = -1;
  private lastHoveredCluster = -1;
  private selectedStar = -1;

  private readonly reticleMesh: Mesh;

  // Reusable per-frame scratch.
  private readonly _proj = new Vector3();
  private readonly _world = new Vector3();
  private readonly _screen = { x: 0, y: 0 };

  // Set per-frame from scene.ts so projectToBuffer can short-circuit the
  // focused star to exact buffer-center coords (see projectToBuffer).
  private viewTarget: Vector3 | null = null;

  constructor() {
    // One label per cluster, displayed at the primary's projected position.
    // Sun's label is warm-white rather than yellow so it stays readable when
    // its quad overlaps the equally-yellow Sun dot. Multi-star clusters get
    // a " +N" suffix in dim cyan to indicate hidden members.
    STAR_CLUSTERS.forEach(cluster => {
      const primary = STARS[cluster.primary];
      const isSun = primary.name === 'Sun';
      const nameColor = isSun ? '#ffffcc' : '#5ec8ff';
      const extras = cluster.members.length - 1;
      const segments = extras > 0
        ? [{ text: primary.name, color: nameColor }, { text: ` +${extras}`, color: '#2d7ab8' }]
        : [{ text: primary.name, color: nameColor }];
      const { tex, w, h } = makeLabelTexture(segments);
      const mesh = new Mesh(new PlaneGeometry(w, h), labelMat(tex));
      mesh.renderOrder = 1;
      mesh.visible = false;
      this.scene.add(mesh);
      this.clusterLabels.push({ mesh, primaryStarIdx: cluster.primary, w, h });
    });

    // Galactic-centre pointer label.
    // noHalo so the label color matches the literal grid-arrow hex, not a
    // subtly darkened halo'd version.
    const gc = makeLabelTexture('GALACTIC CENTRE', '#1e6fc4', { noHalo: true });
    const gcMesh = new Mesh(new PlaneGeometry(gc.w, gc.h), labelMat(gc.tex));
    gcMesh.renderOrder = 1;
    this.scene.add(gcMesh);
    this.gcLabel = { mesh: gcMesh, worldPos: new Vector3(27, 0, 0), w: gc.w, h: gc.h };

    // Axis tick labels at the four cardinal directions on the galactic plane.
    const axes: ReadonlyArray<readonly [string, number, number, number]> = [
      ['0°',    21,  0, 0],
      ['90°',    0, 21, 0],
      ['180°', -21,  0, 0],
      ['270°',   0,-21, 0],
    ];
    for (const [text, x, y, z] of axes) {
      const t = makeLabelTexture(text, '#2d7ab8');
      const mesh = new Mesh(new PlaneGeometry(t.w, t.h), labelMat(t.tex));
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.axisLabels.push({ mesh, worldPos: new Vector3(x, y, z), w: t.w, h: t.h });
    }

    // Hover tooltip — texture rebuilt only on hover transitions.
    this.tipMat = new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    this.tipMesh = new Mesh(new PlaneGeometry(1, 1), this.tipMat);
    this.tipMesh.renderOrder = 2;
    this.tipMesh.visible = false;
    this.scene.add(this.tipMesh);

    // Selection reticle — single static texture, repositioned each frame.
    const reticleMat = new MeshBasicMaterial({
      map: buildReticleTexture(), transparent: true, depthTest: false, depthWrite: false,
    });
    this.reticleMesh = new Mesh(new PlaneGeometry(RETICLE_SIZE_PX, RETICLE_SIZE_PX), reticleMat);
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

  setShowLabels(show: boolean): void {
    this.showLabels = show;
    // Cluster labels and tooltip are gated per-frame; only the static
    // ancillary labels need direct visibility toggles here.
    this.gcLabel.mesh.visible = show;
    for (const a of this.axisLabels) a.mesh.visible = show;
  }

  setHovered(starIdx: number): void {
    this.hoveredCluster = starIdx >= 0 ? clusterIndexFor(starIdx) : -1;
  }

  setSelected(starIdx: number): void {
    this.selectedStar = starIdx;
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
    // Refresh the tooltip texture on hover transitions only — texture build
    // is heavy (multi-line bitmap composition) and we don't want it per-frame.
    if (this.hoveredCluster >= 0 && this.lastHoveredCluster !== this.hoveredCluster) {
      const cluster = STAR_CLUSTERS[this.hoveredCluster];
      if (this.tipMat.map) this.tipMat.map.dispose();
      const lines = cluster.members.map(memIdx => {
        const s = STARS[memIdx];
        return [
          { text: s.name,                       color: '#ffe98a' },
          { text: '  ' + s.cls + '  ',          color: '#2d7ab8' },
          { text: s.distLy.toFixed(2) + ' ly',  color: '#aee4ff' },
        ];
      });
      const { tex, w, h } = makeLabelTexture(lines, { box: true });
      this.tipMat.map = tex;
      this.tipMat.needsUpdate = true;
      this.tipW = w; this.tipH = h;
      this.tipMesh.geometry.dispose();
      this.tipMesh.geometry = new PlaneGeometry(w, h);
      this.lastHoveredCluster = this.hoveredCluster;
    }
    if (this.hoveredCluster < 0) this.lastHoveredCluster = -1;

    // Cluster labels — each anchored above its primary star.
    for (const L of this.clusterLabels) {
      if (!this.showLabels) { L.mesh.visible = false; continue; }
      const s = STARS[L.primaryStarIdx];
      this._world.set(s.x, s.y, s.z);
      if (!this.projectToBuffer(this._world, camera)) { L.mesh.visible = false; continue; }
      L.mesh.visible = true;
      const cy = this._screen.y + LABEL_OFFSET_PX + L.h * 0.5;
      this.placeAt(L.mesh, this._screen.x, cy, L.w, L.h);
    }

    // Galactic-centre label — anchored to the right of the +X arrow tip.
    if (this.showLabels && this.projectToBuffer(this.gcLabel.worldPos, camera)) {
      this.gcLabel.mesh.visible = true;
      const cx = this._screen.x + this.gcLabel.w * 0.5 + 6;
      this.placeAt(this.gcLabel.mesh, cx, this._screen.y, this.gcLabel.w, this.gcLabel.h);
    } else {
      this.gcLabel.mesh.visible = false;
    }

    // Axis tick labels.
    for (const a of this.axisLabels) {
      if (!this.showLabels || !this.projectToBuffer(a.worldPos, camera)) { a.mesh.visible = false; continue; }
      a.mesh.visible = true;
      this.placeAt(a.mesh, this._screen.x, this._screen.y, a.w, a.h);
    }

    // Selection reticle — anchored at the actual selected star (not the
    // cluster primary), since the user can click any cluster member and
    // expect the reticle to land on the dot they hit. projectToBuffer's
    // focus-target short-circuit kicks in automatically when the selection
    // also happens to be the camera's orbit target.
    if (this.selectedStar >= 0) {
      const s = STARS[this.selectedStar];
      this._world.set(s.x, s.y, s.z);
      if (this.projectToBuffer(this._world, camera)) {
        this.reticleMesh.visible = true;
        this.placeAt(this.reticleMesh, this._screen.x, this._screen.y, RETICLE_SIZE_PX, RETICLE_SIZE_PX);
      } else {
        this.reticleMesh.visible = false;
      }
    } else {
      this.reticleMesh.visible = false;
    }

    // Tooltip anchored at the cluster's primary so it doesn't shift between
    // coincident binary members as the cursor moves.
    if (this.hoveredCluster >= 0) {
      const primary = STARS[STAR_CLUSTERS[this.hoveredCluster].primary];
      this._world.set(primary.x, primary.y, primary.z);
      if (this.projectToBuffer(this._world, camera)) {
        this.tipMesh.visible = true;
        const cy = this._screen.y + TIP_OFFSET_PX + this.tipH * 0.5;
        this.placeAt(this.tipMesh, this._screen.x, cy, this.tipW, this.tipH);
      } else {
        this.tipMesh.visible = false;
      }
    } else {
      this.tipMesh.visible = false;
    }
  }
}
