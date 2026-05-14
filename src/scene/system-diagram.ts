// SystemDiagram — flat 2D screen diagram of one cluster's stars. Owns its
// own ortho scene at 1 unit = 1 buffer pixel (same convention as Labels and
// the HUD overlays). Renders crisp pixel discs for every member of the
// cluster and a name label above each.
//
// No camera, no orbit, no depth. SystemScene calls resize() with buffer
// dims and renders the scene each tick.

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  Scene,
  type ShaderMaterial,
} from 'three';
import { BODIES, CLASS_COLOR, STARS, STAR_CLUSTERS, WORLD_CLASS_COLOR, WORLD_CLASS_UNKNOWN_COLOR, type Body } from '../data/stars';
import { makeLabelTexture, type LabelTextureResult } from '../data/pixel-font';
import { HEADER_HEIGHT } from '../ui/system-hud/header-bar';
import { makeFlatStarsMaterial } from './materials';

// Per-star disc-diameter multiplier on top of the galaxy-tuned pxSize. The
// system view has no depth attenuation, so this is the only knob controlling
// rendered disc size. Larger = bigger discs across the board, preserving
// the within-class size ratios that pxSize already encodes.
const DISC_SCALE = 6;

// Buffer-pixel gap between the disc edge and the label texture below it.
const LABEL_GAP = 4;

// Edge-to-edge horizontal gap between adjacent discs as a fraction of the
// largest member's disc diameter. Uniform across the row so a binary with
// a tiny WD next to a big A-class primary spaces consistently with the
// rest of the row.
const HORIZ_GAP_FACTOR = 0.4;

// Vertical gap from the bottom of the header bar to the top of the
// tallest disc. Keeps the star row clearly under the title bar without
// crowding it.
const TOP_GAP = 12;

// Diagrammatic planet row sits below the stars row. Discs are sized from
// radiusEarth with sqrt compression so the row reads at a glance —
// Earth (1.0 R⊕) lands at ~6 px, Jupiter (11.2 R⊕) at ~20 px, Mars (0.5)
// at the floor. Catalog rows whose radius is null fall back to Earth
// size; procgen will fill in real values later.
const PLANET_DISC_MIN = 4;
const PLANET_DISC_MAX = 22;
const PLANET_HORIZ_GAP_FACTOR = 0.6;
// Gap between the bottom of the tallest star disc and the top of the
// tallest planet disc. Loose enough that the rows read as separate things.
const PLANET_ROW_GAP = 32;

function planetDiscPx(b: Body): number {
  const r = b.radiusEarth ?? 1.0;
  const px = Math.sqrt(Math.max(r, 0.0001)) * 6;
  return Math.max(PLANET_DISC_MIN, Math.min(PLANET_DISC_MAX, Math.round(px)));
}

// Moon discs sized smaller than planets so the parent/child relationship
// reads at a glance — caps at 7 px even for Ganymede-class large moons.
// Unknown radius falls back to Luna-ish (0.3 R⊕). Without the smaller cap
// the largest moons would render the same size as the smallest planets
// and the row hierarchy would collapse.
const MOON_DISC_MIN = 3;
const MOON_DISC_MAX = 7;
const MOON_HORIZ_GAP = 2;
// Gap from the bottom of the tallest planet disc to the top of the moon row.
const MOON_ROW_GAP = 6;

function moonDiscPx(b: Body): number {
  const r = b.radiusEarth ?? 0.3;
  const px = Math.sqrt(Math.max(r, 0.0001)) * 6;
  return Math.max(MOON_DISC_MIN, Math.min(MOON_DISC_MAX, Math.round(px)));
}

interface MemberLabel {
  mesh: Mesh;
  w: number;
  h: number;
}

export class SystemDiagram {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  private readonly members: readonly number[];
  // Integer disc diameter (px) per member. Matches the shader's
  // floor(aSize * uDiscScale + 0.5), used CPU-side for ring sizing and
  // label placement.
  private readonly memberDiscPx: readonly number[];
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly points: Points;
  private readonly labels: MemberLabel[] = [];
  private readonly labelTextures: LabelTextureResult[] = [];

  // Planet row — flat 2D diagrammatic. One disc per planet across every
  // cluster member, single horizontal row below the stars. Null when the
  // cluster has zero known planets (most catalog systems today).
  private readonly planetIndices: readonly number[];
  private readonly planetDiscPx: readonly number[];
  private readonly planetGeometry: BufferGeometry | null = null;
  private readonly planetMaterial: ShaderMaterial | null = null;
  private readonly planetPoints: Points | null = null;

  // Moon row — one disc per moon across every planet in this cluster.
  // Layout is "small horizontal cluster centered under each parent planet"
  // rather than one global row, so the parent/child relationship reads
  // visually. moonsPerPlanet[i] = which slice of moonIndices belongs to
  // planetIndices[i].
  private readonly moonIndices: readonly number[];
  private readonly moonDiscPx: readonly number[];
  private readonly moonsPerPlanet: readonly { offset: number; count: number }[];
  private readonly moonGeometry: BufferGeometry | null = null;
  private readonly moonMaterial: ShaderMaterial | null = null;
  private readonly moonPoints: Points | null = null;

  constructor(clusterIdx: number) {
    const cluster = STAR_CLUSTERS[clusterIdx];
    this.members = cluster.members;

    const positions = new Float32Array(this.members.length * 3);
    const colors    = new Float32Array(this.members.length * 3);
    const sizes     = new Float32Array(this.members.length);
    const discPx: number[] = [];

    this.members.forEach((m, i) => {
      const s = STARS[m];
      // positions[] is overwritten on first resize() — fill is just defensive.
      positions[i * 3 + 0] = 0;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
      const col = CLASS_COLOR[s.cls] ?? CLASS_COLOR.M;
      colors[i * 3 + 0] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
      sizes[i] = s.pxSize;
      discPx.push(Math.floor(s.pxSize * DISC_SCALE + 0.5));
    });
    this.memberDiscPx = discPx;

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.geometry.setAttribute('color',    new BufferAttribute(colors, 3));
    this.geometry.setAttribute('aSize',    new BufferAttribute(sizes, 1));

    this.material = makeFlatStarsMaterial(DISC_SCALE);
    this.points = new Points(this.geometry, this.material);
    this.scene.add(this.points);

    // Collect every planet across the cluster's member stars. Multi-star
    // systems contribute their per-component planets into one row (e.g. the
    // Alpha Cen cluster surfaces Proxima's three planets even though they
    // orbit the C component, not the A primary).
    const planetIndices: number[] = [];
    for (const m of this.members) {
      for (const pIdx of STARS[m].planets) planetIndices.push(pIdx);
    }
    this.planetIndices = planetIndices;
    this.planetDiscPx = planetIndices.map(i => planetDiscPx(BODIES[i]));

    if (planetIndices.length > 0) {
      const pPositions = new Float32Array(planetIndices.length * 3);
      const pColors    = new Float32Array(planetIndices.length * 3);
      const pSizes     = new Float32Array(planetIndices.length);
      planetIndices.forEach((bIdx, i) => {
        const b = BODIES[bIdx];
        const col = b.worldClass !== null
          ? (WORLD_CLASS_COLOR[b.worldClass] ?? WORLD_CLASS_UNKNOWN_COLOR)
          : WORLD_CLASS_UNKNOWN_COLOR;
        pColors[i * 3 + 0] = col.r;
        pColors[i * 3 + 1] = col.g;
        pColors[i * 3 + 2] = col.b;
        // aSize carries the final pixel diameter directly — planet material
        // uses discScale=1 so we skip the indirection through pxSize that
        // the stars material does.
        pSizes[i] = this.planetDiscPx[i];
      });
      this.planetGeometry = new BufferGeometry();
      this.planetGeometry.setAttribute('position', new BufferAttribute(pPositions, 3));
      this.planetGeometry.setAttribute('color',    new BufferAttribute(pColors, 3));
      this.planetGeometry.setAttribute('aSize',    new BufferAttribute(pSizes, 1));
      this.planetMaterial = makeFlatStarsMaterial(1.0);
      this.planetPoints = new Points(this.planetGeometry, this.planetMaterial);
      this.scene.add(this.planetPoints);
    }

    // Moons follow planets — gather the moon index list parallel to the
    // planet list. moonsPerPlanet[i] is the slice belonging to planet i.
    const moonIndices: number[] = [];
    const moonsPerPlanet: { offset: number; count: number }[] = [];
    for (const pIdx of planetIndices) {
      const offset = moonIndices.length;
      for (const mIdx of BODIES[pIdx].moons) moonIndices.push(mIdx);
      moonsPerPlanet.push({ offset, count: moonIndices.length - offset });
    }
    this.moonIndices = moonIndices;
    this.moonsPerPlanet = moonsPerPlanet;
    this.moonDiscPx = moonIndices.map(i => moonDiscPx(BODIES[i]));

    if (moonIndices.length > 0) {
      const mPositions = new Float32Array(moonIndices.length * 3);
      const mColors    = new Float32Array(moonIndices.length * 3);
      const mSizes     = new Float32Array(moonIndices.length);
      moonIndices.forEach((bIdx, i) => {
        const b = BODIES[bIdx];
        const col = b.worldClass !== null
          ? (WORLD_CLASS_COLOR[b.worldClass] ?? WORLD_CLASS_UNKNOWN_COLOR)
          : WORLD_CLASS_UNKNOWN_COLOR;
        mColors[i * 3 + 0] = col.r;
        mColors[i * 3 + 1] = col.g;
        mColors[i * 3 + 2] = col.b;
        mSizes[i] = this.moonDiscPx[i];
      });
      this.moonGeometry = new BufferGeometry();
      this.moonGeometry.setAttribute('position', new BufferAttribute(mPositions, 3));
      this.moonGeometry.setAttribute('color',    new BufferAttribute(mColors, 3));
      this.moonGeometry.setAttribute('aSize',    new BufferAttribute(mSizes, 1));
      this.moonMaterial = makeFlatStarsMaterial(1.0);
      this.moonPoints = new Points(this.moonGeometry, this.moonMaterial);
      this.scene.add(this.moonPoints);
    }

    // One label per member. Eager build avoids any first-frame canvas
    // work; cost is negligible (one small texture per member, at most a
    // handful per system).
    this.members.forEach(m => {
      const s = STARS[m];
      // Warm-white for Sol, cyan otherwise — same per-Sol rule the galaxy
      // view's plain label variant uses (labels.ts).
      const color = s.id === 'sol' ? '#ffffcc' : '#5ec8ff';
      const tex = makeLabelTexture(s.name, color);
      this.labelTextures.push(tex);
      const mat = new MeshBasicMaterial({
        map: tex.tex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new Mesh(new PlaneGeometry(tex.w, tex.h), mat);
      // Hidden until first resize() places them — avoids a one-frame flash
      // at (0,0) during the first render.
      mesh.visible = false;
      // Ensure labels paint on top of the disc points pass regardless of
      // scene insertion order.
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.labels.push({ mesh, w: tex.w, h: tex.h });
    });
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.layout();
  }

  private layout(): void {
    const N = this.members.length;
    if (N === 0) return;

    const positions = this.geometry.attributes.position.array as Float32Array;

    // Horizontal row anchored to the top of the content area (just below
    // the header). All disc centers share one baseline y so the row reads
    // as a horizontal alignment regardless of size variation. The wide
    // empty space below the row is reserved for the planets/ships layer
    // that lives there in a later pass.
    const maxDiscPx = Math.max(...this.memberDiscPx);
    const gap = N > 1 ? maxDiscPx * HORIZ_GAP_FACTOR : 0;
    let totalW = 0;
    for (const d of this.memberDiscPx) totalW += d;
    totalW += (N - 1) * gap;
    const startX = (this.bufferW - totalW) / 2;
    const cy = Math.round(this.bufferH - HEADER_HEIGHT - TOP_GAP - maxDiscPx / 2);

    let cursor = startX;
    for (let i = 0; i < N; i++) {
      const d = this.memberDiscPx[i];
      const cx = cursor + d / 2;
      positions[i * 3 + 0] = cx;
      positions[i * 3 + 1] = cy;
      positions[i * 3 + 2] = 0;
      cursor += d + gap;
    }
    this.geometry.attributes.position.needsUpdate = true;

    // Labels sit BELOW each disc: above-disc would push into the title
    // bar at this top anchor, and below keeps the labels grouped with
    // their stars rather than crowded against the header. Top-left corner
    // snapped to an integer buffer pixel so every texel renders cleanly
    // (same scheme as Labels.placeAt in labels.ts).
    for (let i = 0; i < N; i++) {
      const px = positions[i * 3 + 0];
      const py = positions[i * 3 + 1];
      const discR = this.memberDiscPx[i] / 2;
      const L = this.labels[i];
      const targetCenterX = px;
      const targetCenterY = py - discR - LABEL_GAP - L.h * 0.5;
      const cornerX = Math.round(targetCenterX - L.w * 0.5);
      const cornerY = Math.round(targetCenterY - L.h * 0.5);
      L.mesh.position.set(cornerX + L.w * 0.5, cornerY + L.h * 0.5, 0);
      L.mesh.visible = true;
    }

    // Planet row — centered, sitting below the stars + label band. Vertical
    // anchor is the bottom of the tallest star disc (cy - maxDiscPx/2), then
    // drop PLANET_ROW_GAP plus half the tallest planet diameter to reach
    // the planet centers. Labels for stars don't shift the planet row
    // because the gap is generous; if labels grow we can revisit.
    if (this.planetGeometry && this.planetPoints) {
      const P = this.planetIndices.length;
      const maxPlanetPx = Math.max(...this.planetDiscPx);
      const pGap = maxPlanetPx * PLANET_HORIZ_GAP_FACTOR;
      let pTotalW = 0;
      for (const d of this.planetDiscPx) pTotalW += d;
      pTotalW += (P - 1) * pGap;
      const pStartX = (this.bufferW - pTotalW) / 2;
      const starRowBottom = cy - maxDiscPx / 2;
      const planetCy = Math.round(starRowBottom - PLANET_ROW_GAP - maxPlanetPx / 2);
      const pPositions = this.planetGeometry.attributes.position.array as Float32Array;
      let pCursor = pStartX;
      for (let i = 0; i < P; i++) {
        const d = this.planetDiscPx[i];
        const pcx = pCursor + d / 2;
        pPositions[i * 3 + 0] = pcx;
        pPositions[i * 3 + 1] = planetCy;
        pPositions[i * 3 + 2] = 0;
        pCursor += d + pGap;
      }
      this.planetGeometry.attributes.position.needsUpdate = true;

      // Moon row — one tight horizontal cluster centered under each parent
      // planet. All moons share a single Y so the rows align visually
      // (anchored to the bottom of the tallest planet disc, not per-planet,
      // so a small planet's moons sit at the same height as a gas giant's).
      // Skips planets with no moons; geometry stays unallocated when the
      // cluster has zero moons.
      if (this.moonGeometry && this.moonPoints && this.moonIndices.length > 0) {
        const maxMoonPx = Math.max(...this.moonDiscPx);
        const planetRowBottom = planetCy - maxPlanetPx / 2;
        const moonCy = Math.round(planetRowBottom - MOON_ROW_GAP - maxMoonPx / 2);
        const mPositions = this.moonGeometry.attributes.position.array as Float32Array;
        for (let i = 0; i < P; i++) {
          const { offset, count } = this.moonsPerPlanet[i];
          if (count === 0) continue;
          const planetCx = pPositions[i * 3 + 0];
          let groupW = 0;
          for (let j = 0; j < count; j++) groupW += this.moonDiscPx[offset + j];
          groupW += (count - 1) * MOON_HORIZ_GAP;
          let mCursor = planetCx - groupW / 2;
          for (let j = 0; j < count; j++) {
            const d = this.moonDiscPx[offset + j];
            mPositions[(offset + j) * 3 + 0] = mCursor + d / 2;
            mPositions[(offset + j) * 3 + 1] = moonCy;
            mPositions[(offset + j) * 3 + 2] = 0;
            mCursor += d + MOON_HORIZ_GAP;
          }
        }
        this.moonGeometry.attributes.position.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.planetGeometry?.dispose();
    this.planetMaterial?.dispose();
    this.moonGeometry?.dispose();
    this.moonMaterial?.dispose();
    for (const L of this.labels) {
      L.mesh.geometry.dispose();
      (L.mesh.material as MeshBasicMaterial).dispose();
    }
    for (const T of this.labelTextures) T.tex.dispose();
  }
}
