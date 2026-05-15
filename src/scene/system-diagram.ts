// SystemDiagram — flat 2D screen diagram of one cluster.
//
// Stars hang off the top edge: each star is a Mesh+PlaneGeometry with a
// procedural-disc fragment shader, positioned so the disc center sits
// ABOVE the buffer top — the GPU clips the offscreen portion and the
// visible sliver below the edge reads as "huge body, mostly hidden up
// there". Mesh (not Points) is load-bearing here because GL_POINTS
// discards any sprite whose vertex falls outside the clip volume; the
// triangle path rasterizes fine with vertices outside the viewport.
// Lateral order is biggest in the middle with smaller stars flanking.
//
// The body arc sits below the stars at a FIXED distance from the top
// (not a fraction of bufferH), so the stars + planets form a constant-
// height block hanging from the top; the empty space below (reserved
// for ships) grows or shrinks with the viewport. Planets are in semi-
// major-axis order (innermost left, outermost right); moons straddle
// their parent's rim at procedurally distributed angles, split into
// back/front pools so the upper half is occluded by the parent and the
// lower half overlaps downward.
//
// SystemHud overlays the system name + back button on top of all of this.

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  Scene,
  Vector2,
  type ShaderMaterial,
} from 'three';
import {
  BODIES,
  CLASS_COLOR,
  STARS,
  STAR_CLUSTERS,
  WORLD_CLASS_COLOR,
  WORLD_CLASS_UNKNOWN_COLOR,
  type Body,
} from '../data/stars';
import { sizes } from '../ui/theme';
import { makeFlatStarsMaterial, makeStarMeshMaterial } from './materials';

// Per-star disc-diameter multiplier on top of the galaxy-tuned pxSize.
// Stars render as top-clipped half-discs hanging off the buffer top,
// so most of the disc area is off-screen — scale up generously to
// suggest "substantial body poking through".
const DISC_SCALE = 9;

// Fraction of the disc radius pushed above the viewport top. 0 = center
// on edge (half disc visible). 0.4 = center is 40% of radius above edge,
// 30% of disc visible as a strip below the edge. Higher = stars feel
// bigger because more is "hidden up there"; ≥ 0.5 starts making small
// stars vanish entirely (visible portion < a few px).
const STAR_OFFSCREEN_FRAC = 0.3;

// Edge-to-edge horizontal gap between adjacent stars, expressed as a
// fraction of the largest member's disc diameter. Smaller than the
// previous full-disc-row value because discs are now top-clipped — they
// read smaller, so less breathing room is needed.
const STAR_HORIZ_GAP_FACTOR = 0.3;
// Floor for the star gap when the row is width-constrained; below this
// we start scaling disc sizes down.
const MIN_STAR_GAP = 2;

// Distance from the TOP of the screen to the dome's PEAK (where the
// middle planet sits). Fixed — the top of the arc stays at a constant
// gap below the stars regardless of viewport size; only the dome's
// edges move (see DOME_PEAK_*_PX below).
const PLANET_PEAK_FROM_TOP = 120;

// Dome height — vertical drop from the peak to the edges. Scales with
// viewport area so bigger screens get a more pronounced arc; the edges
// drop lower while the peak stays anchored. Area drives the lerp
// (rather than width or height alone) because the arc reads as
// "proportional to how much real estate you have."
const DOME_PEAK_MIN_PX = 60;
const DOME_PEAK_MAX_PX = 120;
// Anchor points for the lerp (env-px², post-render-scale). 400k ≈ small
// laptop viewport; 2M ≈ full-HD desktop.
const DOME_AREA_MIN = 400_000;
const DOME_AREA_MAX = 2_000_000;

// Planet discs sized from radiusEarth with cube-root compression. The
// real radius range across rocky-to-gas-giant is ~30× (Mercury 0.38 R⊕ →
// Jupiter 11.2 R⊕); cbrt(30) ≈ 3.1, so the rendered diameter range
// collapses to ~3× — Mercury / Mars at the floor read clearly while
// Jupiter / Saturn still feel substantial without dwarfing the row.
// Stronger compression than the sqrt curve it replaced; the previous
// formula was producing 4 px specs for rocky worlds next to 20 px gas
// giants, a ratio of ~5× that read as "speck vs. dominant disc".
const PLANET_DISC_MIN = 40;
const PLANET_DISC_MAX = 120;
// Multiplier on cbrt(radiusEarth). 54 was picked so Earth (1.0 R⊕) lands
// near the middle of the range and Jupiter (11.2 R⊕) at ~120 px while
// Mercury (0.38 R⊕) lands near the 40 px floor — preserving the 3×
// Jupiter / Mercury ratio at the clamps.
const PLANET_DISC_BASE = 54;

// Moon discs use the same cbrt curve as planets. The 50 px cap exceeds
// the 40 px planet floor on purpose — moons read against their parent,
// not against the smallest planet in the system, and big moons cluster
// around big planets (Ganymede / Titan orbit gas giants), so a 50 px
// moon always sits next to a 100+ px parent in practice. Floor at 10
// keeps tiny inner moons visible against a 120-px Jupiter.
const MOON_DISC_MIN = 10;
const MOON_DISC_MAX = 50;
// Multiplier on cbrt(radiusEarth). 67 lands Ganymede / Titan (~0.4 R⊕)
// at the 50 px cap and Luna (~0.27 R⊕) at ~43 px.
const MOON_DISC_BASE = 67;

// Moon-center distance from parent center, expressed as an offset
// relative to parent's rim. 0 = moon centered exactly on the parent's
// rim (half the moon disc inside the parent, half outside). Positive
// pushes moons outward; negative pulls them inward.
const MOON_EDGE_BIAS = 0;

function planetDiscPx(b: Body): number {
  const r = b.radiusEarth ?? 1.0;
  const px = Math.cbrt(Math.max(r, 0.0001)) * PLANET_DISC_BASE;
  return Math.max(PLANET_DISC_MIN, Math.min(PLANET_DISC_MAX, Math.round(px)));
}

function moonDiscPx(b: Body): number {
  const r = b.radiusEarth ?? 0.3;
  const px = Math.cbrt(Math.max(r, 0.0001)) * MOON_DISC_BASE;
  return Math.max(MOON_DISC_MIN, Math.min(MOON_DISC_MAX, Math.round(px)));
}

// FNV-1a 32-bit. Deterministic per-string so each planet's moon ring is
// identical across reloads (matches the build-time procgen seeding family).
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 PRNG. One instance per planet so moon-angle draws are
// deterministic and isolated from other random consumers.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// Procedural moon angle distribution: largest-gap-fill with geometric
// per-pair margins. First moon at a random angle; each subsequent moon
// dropped at a random point inside the current widest gap, with margins
// on each side computed from the actual moon radii of the new placement
// and its left/right neighbors.
//
// Two discs of radius r1, r2 on a ring of radius D are tangent at an
// angular separation of `2 * asin((r1 + r2) / (2D))`. We use that as the
// minimum margin so adjacent moons never visually overlap. The asin
// argument clamps to 1 for the degenerate "oversized moon on a tiny
// parent" case — those fall through to the "ring too crowded" branch
// below and accept some visual overlap.
//
// Determinism: seeded per-planet via the parent's id, identical across
// reloads. Returns angles in the original moon order (matches
// BODIES[parent.moons[j]]).
function distributeMoonAngles(
  moonRadii: readonly number[],
  parentR: number,
  seed: string,
): number[] {
  const N = moonRadii.length;
  if (N === 0) return [];
  const rng = mulberry32(hash32(seed));
  const D = parentR + MOON_EDGE_BIAS;

  interface Placed { angle: number; radius: number; sourceIdx: number }
  const placed: Placed[] = [{
    angle: rng() * Math.PI * 2,
    radius: moonRadii[0],
    sourceIdx: 0,
  }];

  for (let i = 1; i < N; i++) {
    // Walk the sorted angle list once and find the widest gap (wrap-around
    // last → first as a circular gap of length 2π + sorted[0] - last).
    const sorted = [...placed].sort((a, b) => a.angle - b.angle);
    let bestStart = sorted[0];
    let bestEnd   = sorted[0];
    let bestGap   = 0;
    for (let j = 0; j < sorted.length; j++) {
      const startMoon = sorted[j];
      const isLast = j + 1 === sorted.length;
      const endMoon = isLast ? sorted[0] : sorted[j + 1];
      const endAngle = isLast ? endMoon.angle + Math.PI * 2 : endMoon.angle;
      const size = endAngle - startMoon.angle;
      if (size > bestGap) {
        bestGap = size;
        bestStart = startMoon;
        bestEnd = endMoon;
      }
    }

    const rNew = moonRadii[i];
    const leftPad  = 2 * Math.asin(Math.min(1, (rNew + bestStart.radius) / (2 * D)));
    const rightPad = 2 * Math.asin(Math.min(1, (rNew + bestEnd.radius)   / (2 * D)));

    let angle: number;
    if (leftPad + rightPad >= bestGap) {
      // Ring too crowded for non-overlapping placement — drop at gap
      // center and accept the visual overlap. Happens when a parent has
      // many large moons relative to its own size.
      angle = bestStart.angle + bestGap * 0.5;
    } else {
      angle = bestStart.angle + leftPad + rng() * (bestGap - leftPad - rightPad);
    }
    placed.push({ angle, radius: rNew, sourceIdx: i });
  }

  const out: number[] = new Array(N);
  for (const p of placed) out[p.sourceIdx] = p.angle;
  return out;
}

// Permutation that walks slots outward from the center. Caller passes a
// disc-size array already sorted descending; out[finalSlot] = source
// index. Biggest item lands at floor(N/2); subsequent items alternate
// right-then-left as we walk outward, falling back to the unfilled side
// when one runs out (handles asymmetric N gracefully).
function bigMiddleOrder(sortedDescCount: number): number[] {
  const N = sortedDescCount;
  const out: number[] = new Array(N).fill(-1);
  if (N === 0) return out;
  const mid = Math.floor(N / 2);
  out[mid] = 0;
  for (let i = 1; i < N; i++) {
    const step = Math.ceil(i / 2);
    let slot = (i % 2 === 1) ? mid + step : mid - step;
    if (slot < 0 || slot >= N || out[slot] !== -1) {
      slot = slot >= N ? mid - step : mid + step;
    }
    out[slot] = i;
  }
  return out;
}

function sumOf(arr: readonly number[]): number {
  let s = 0;
  for (const n of arr) s += n;
  return s;
}

interface MoonSlot {
  // Index into planetIndices (parent's slot in the body arc).
  parentIndex: number;
  // Index into the per-pool moon arrays (positions, colors, sizes).
  poolIndex: number;
  // Per-moon disc diameter (px), and per-moon angle around parent.
  discPx: number;
  angle: number;
}

interface MoonPool {
  slots: MoonSlot[];
  geometry: BufferGeometry;
  material: ShaderMaterial;
  points: Points;
}

// One mesh per star — independent geometry + material so each disc can
// carry its own size and uniforms, and the mesh can be positioned with
// its center above the viewport top (which GL_POINTS can't do).
interface StarDisc {
  mesh: Mesh;
  geometry: PlaneGeometry;
  material: ShaderMaterial;
  // Cached current diameter in px — used to detect when layoutStars
  // needs to rebuild the geometry (size changed under width-fit scaling).
  currentDiam: number;
}

export class SystemDiagram {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  // -- Stars --
  // starMembers[slot] is the source star index after the big-middle
  // sort. starDiscs[slot] is the corresponding mesh.
  private readonly starMembers: readonly number[];
  private readonly starSlotDiscPx: readonly number[];
  private readonly starDiscs: StarDisc[] = [];

  // -- Planets --
  // One Points covering every body across every member star, in semi-
  // major-axis order (innermost first per member, members concatenated).
  private readonly planetIndices: readonly number[];
  private readonly planetDiscPx: readonly number[];
  private readonly planetGeometry: BufferGeometry | null = null;
  private readonly planetMaterial: ShaderMaterial | null = null;
  private readonly planetPoints: Points | null = null;

  // -- Moons --
  // Two pools split by angular hemisphere: upper-half (sin θ > 0) →
  // "back" (renderOrder < planet), lower-half → "front" (renderOrder >
  // planet). Each moon's position depends on its parent's placement, so
  // layoutMoons() runs after layoutPlanets().
  private readonly backMoons: MoonPool | null = null;
  private readonly frontMoons: MoonPool | null = null;

  constructor(clusterIdx: number) {
    const cluster = STAR_CLUSTERS[clusterIdx];

    // -- Stars: sort by disc size descending, then permute into big-
    // middle slot order so geometry indices map directly to lateral slots.
    const rawDiscPx = cluster.members.map(m => Math.floor(STARS[m].pxSize * DISC_SCALE + 0.5));
    const sortedIdx = cluster.members.map((_, i) => i).sort((a, b) => rawDiscPx[b] - rawDiscPx[a]);
    const slotPerm = bigMiddleOrder(sortedIdx.length);
    // starMembers[slot] = original star index in STARS
    const starMembers = slotPerm.map(p => cluster.members[sortedIdx[p]]);
    this.starMembers = starMembers;
    this.starSlotDiscPx = slotPerm.map(p => rawDiscPx[sortedIdx[p]]);

    // Build one mesh per star. Geometry is sized to the star's natural
    // diameter (before any width-fit scaling); layoutStars rebuilds it
    // if a different size is needed. Initial position is (0, 0); resize
    // fills it in.
    starMembers.forEach((starIdx, slot) => {
      const s = STARS[starIdx];
      const col = CLASS_COLOR[s.cls] ?? CLASS_COLOR.M;
      const d = this.starSlotDiscPx[slot];
      const material = makeStarMeshMaterial();
      material.uniforms.uColor.value.setRGB(col.r, col.g, col.b);
      material.uniforms.uRadius.value = d / 2;
      const geometry = new PlaneGeometry(d, d);
      const mesh = new Mesh(geometry, material);
      // Hidden until first layoutStars() places it; avoids a one-frame
      // flash at the origin.
      mesh.visible = false;
      this.scene.add(mesh);
      this.starDiscs.push({ mesh, geometry, material, currentDiam: d });
    });

    // -- Planets: gather across every member, preserve build-time
    // semi-major-axis order (STAR.planets[] is sorted by semiMajorAu).
    const planetIndices: number[] = [];
    for (const starIdx of cluster.members) {
      for (const pIdx of STARS[starIdx].planets) planetIndices.push(pIdx);
    }
    this.planetIndices = planetIndices;
    this.planetDiscPx = planetIndices.map(i => planetDiscPx(BODIES[i]));

    if (planetIndices.length > 0) {
      const P = planetIndices.length;
      const pPositions = new Float32Array(P * 3);
      const pColors    = new Float32Array(P * 3);
      const pSizes     = new Float32Array(P);
      planetIndices.forEach((bIdx, i) => {
        const b = BODIES[bIdx];
        const col = b.worldClass !== null
          ? (WORLD_CLASS_COLOR[b.worldClass] ?? WORLD_CLASS_UNKNOWN_COLOR)
          : WORLD_CLASS_UNKNOWN_COLOR;
        pColors[i * 3 + 0] = col.r;
        pColors[i * 3 + 1] = col.g;
        pColors[i * 3 + 2] = col.b;
        // aSize carries the final pixel diameter; uDiscScale = 1.0 so the
        // shader's floor(aSize * 1.0 + 0.5) is a no-op pass-through.
        pSizes[i] = this.planetDiscPx[i];
      });
      this.planetGeometry = new BufferGeometry();
      this.planetGeometry.setAttribute('position', new BufferAttribute(pPositions, 3));
      this.planetGeometry.setAttribute('color',    new BufferAttribute(pColors, 3));
      this.planetGeometry.setAttribute('aSize',    new BufferAttribute(pSizes, 1));
      this.planetMaterial = makeFlatStarsMaterial(1.0);
      this.planetPoints = new Points(this.planetGeometry, this.planetMaterial);
      this.planetPoints.renderOrder = 10;
      // Three.js computes the bounding sphere from the initial all-zero
      // positions and never recomputes it when the position attribute
      // changes on resize. Disabling frustum culling sidesteps the stale
      // sphere; per-vertex GPU clipping still discards anything
      // genuinely off-screen.
      this.planetPoints.frustumCulled = false;
      this.scene.add(this.planetPoints);
    }

    // -- Moons: per-planet evenly-spaced angles with a deterministic
    // per-planet rotational phase. Each moon goes into the back pool if
    // its angle puts it on the upper half of the ring (sin θ > 0) or the
    // front pool otherwise.
    const backSlots: MoonSlot[] = [];
    const frontSlots: MoonSlot[] = [];
    // moonBodyIdxByPool[poolKey][i] = body index in BODIES for the
    // moon at the i'th slot of that pool. Used to write color/size into
    // the pool's attributes after the pool is built.
    const backMoonBodyIdx: number[] = [];
    const frontMoonBodyIdx: number[] = [];
    planetIndices.forEach((pIdx, parentIndex) => {
      const parent = BODIES[pIdx];
      const Nm = parent.moons.length;
      if (Nm === 0) return;
      // Pre-compute moon disc sizes so the angle distribution can use
      // real radii for its geometric margins.
      const moonDiscs = parent.moons.map(idx => moonDiscPx(BODIES[idx]));
      const moonRadii = moonDiscs.map(d => d / 2);
      const parentR = this.planetDiscPx[parentIndex] / 2;
      const moonAngles = distributeMoonAngles(moonRadii, parentR, parent.id);
      parent.moons.forEach((moonBodyIdx, j) => {
        const angle = moonAngles[j];
        const discPx = moonDiscs[j];
        const slot: MoonSlot = { parentIndex, poolIndex: -1, discPx, angle };
        if (Math.sin(angle) > 0) {
          slot.poolIndex = backSlots.length;
          backSlots.push(slot);
          backMoonBodyIdx.push(moonBodyIdx);
        } else {
          slot.poolIndex = frontSlots.length;
          frontSlots.push(slot);
          frontMoonBodyIdx.push(moonBodyIdx);
        }
      });
    });

    if (backSlots.length > 0) {
      this.backMoons = makeMoonPool(backSlots, backMoonBodyIdx, /*renderOrder=*/ 5);
      this.scene.add(this.backMoons.points);
    }
    if (frontSlots.length > 0) {
      this.frontMoons = makeMoonPool(frontSlots, frontMoonBodyIdx, /*renderOrder=*/ 15);
      this.scene.add(this.frontMoons.points);
    }
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
    this.layoutStars();
    this.layoutPlanets();
    this.layoutMoons();
  }

  private layoutStars(): void {
    const N = this.starMembers.length;
    if (N === 0) return;

    const availW = this.bufferW - 2 * sizes.edgePad;
    const maxDiscPx = Math.max(...this.starSlotDiscPx);
    let gap = N > 1 ? maxDiscPx * STAR_HORIZ_GAP_FACTOR : 0;
    let totalW = sumOf(this.starSlotDiscPx) + (N - 1) * gap;

    // Width-fit: shrink gap first (down to MIN_STAR_GAP), then scale all
    // disc sizes proportionally if even the minimum-gap row would
    // overflow. The proportional scale preserves within-row size ratios.
    let discScale = 1;
    if (totalW > availW && N > 1) {
      const fixed = sumOf(this.starSlotDiscPx);
      const minTotal = fixed + (N - 1) * MIN_STAR_GAP;
      if (minTotal <= availW) {
        gap = (availW - fixed) / (N - 1);
        totalW = availW;
      } else {
        const targetFixed = availW - (N - 1) * MIN_STAR_GAP;
        discScale = targetFixed / Math.max(fixed, 1);
        gap = MIN_STAR_GAP;
        totalW = targetFixed + (N - 1) * MIN_STAR_GAP;
      }
    }

    const startX = (this.bufferW - totalW) / 2;
    let cursor = startX;
    for (let slot = 0; slot < N; slot++) {
      const d = Math.max(1, Math.round(this.starSlotDiscPx[slot] * discScale));
      const r = d / 2;
      const cxTarget = cursor + r;
      // Star center sits above the buffer top by STAR_OFFSCREEN_FRAC × r,
      // so the disc reads as "huge body, mostly hidden". Mesh path makes
      // this safe; GL_POINTS would discard the off-edge vertex.
      const cyTarget = this.bufferH + r * STAR_OFFSCREEN_FRAC;

      // Parity-aware snap for pixel-perfect rasterization: even diameter
      // → center on integer (pixel boundary), odd diameter → center on
      // integer+0.5 (pixel center). Same algorithm as the GL_POINTS
      // shader's vertex snap, just CPU-side now.
      const oddOff = (d & 1) * 0.5;
      const cx = Math.floor(cxTarget - oddOff + 0.5) + oddOff;
      const cy = Math.floor(cyTarget - oddOff + 0.5) + oddOff;

      const disc = this.starDiscs[slot];
      // Rebuild the plane geometry only when diameter actually changed;
      // a resize that doesn't change layout leaves all geometries intact.
      if (disc.currentDiam !== d) {
        disc.geometry.dispose();
        disc.geometry = new PlaneGeometry(d, d);
        disc.mesh.geometry = disc.geometry;
        disc.material.uniforms.uRadius.value = r;
        disc.currentDiam = d;
      }
      disc.mesh.position.set(cx, cy, 0);
      (disc.material.uniforms.uCenter.value as Vector2).set(cx, cy);
      disc.mesh.visible = true;

      cursor += d + gap;
    }
  }

  private layoutPlanets(): void {
    if (!this.planetGeometry || !this.planetPoints) return;
    const N = this.planetIndices.length;
    const positions = this.planetGeometry.attributes.position.array as Float32Array;

    const availW = this.bufferW - 2 * sizes.edgePad;
    const xLeft = sizes.edgePad;

    // Edge-to-edge spacing: free space split into N+1 equal gaps — one
    // between each adjacent pair plus one as a margin on each end — so a
    // gas giant next to a rocky world preserves the same edge-to-edge gap
    // as two same-sized neighbors. Goes negative when sum(d) > availW;
    // planets then overlap evenly (deck-of-cards). Not shrinking discs in
    // that case because the cbrt size curve is what keeps Mercury legible
    // next to Jupiter — uniform shrinkage would flatten the ratio.
    const sumD = sumOf(this.planetDiscPx);
    const gap = (availW - sumD) / (N + 1);

    // Lerp the dome's height over viewport area, then derive the baseline
    // from the (fixed) peak position. Peak anchored = top of the arc
    // stays the same distance from the stars; edges drop as the screen
    // grows.
    const area = this.bufferW * this.bufferH;
    const areaT = Math.max(0, Math.min(1,
      (area - DOME_AREA_MIN) / (DOME_AREA_MAX - DOME_AREA_MIN)));
    const peakHeight = DOME_PEAK_MIN_PX + areaT * (DOME_PEAK_MAX_PX - DOME_PEAK_MIN_PX);
    const peakY = this.bufferH - PLANET_PEAK_FROM_TOP;
    const baselineY = peakY - peakHeight;

    let cursor = xLeft + gap;
    for (let i = 0; i < N; i++) {
      const d = this.planetDiscPx[i];
      const r = d / 2;
      const cx = cursor + r;
      // Dome Y keyed to actual x (not ordinal index), so the peak stays
      // at availW/2 regardless of size variation across the row — the
      // arc is a geometric shape the planets ride on, not a function of
      // slot index. sin(π·t) peaks at t = 0.5 and is 0 at t = 0 / t = 1.
      const t = (cx - xLeft) / availW;
      const yOffset = peakHeight * Math.sin(Math.PI * t);
      positions[i * 3 + 0] = Math.round(cx);
      positions[i * 3 + 1] = Math.round(baselineY + yOffset);
      positions[i * 3 + 2] = 0;
      cursor += d + gap;
    }
    this.planetGeometry.attributes.position.needsUpdate = true;
  }

  private layoutMoons(): void {
    if (!this.planetGeometry) return;
    const pPositions = this.planetGeometry.attributes.position.array as Float32Array;

    const writePool = (pool: MoonPool | null) => {
      if (!pool) return;
      const out = pool.geometry.attributes.position.array as Float32Array;
      pool.slots.forEach((slot, i) => {
        const parentR = this.planetDiscPx[slot.parentIndex] / 2;
        const D = parentR + MOON_EDGE_BIAS;
        const px = pPositions[slot.parentIndex * 3 + 0];
        const py = pPositions[slot.parentIndex * 3 + 1];
        out[i * 3 + 0] = Math.round(px + Math.cos(slot.angle) * D);
        out[i * 3 + 1] = Math.round(py + Math.sin(slot.angle) * D);
        out[i * 3 + 2] = 0;
      });
      pool.geometry.attributes.position.needsUpdate = true;
    };

    writePool(this.backMoons);
    writePool(this.frontMoons);
  }

  dispose(): void {
    for (const disc of this.starDiscs) {
      disc.geometry.dispose();
      disc.material.dispose();
    }
    this.planetGeometry?.dispose();
    this.planetMaterial?.dispose();
    this.backMoons?.geometry.dispose();
    this.backMoons?.material.dispose();
    this.frontMoons?.geometry.dispose();
    this.frontMoons?.material.dispose();
  }
}

// Build a Points geometry for one moon pool. Colors/sizes pulled from
// each moon's body record at the parallel-array index; positions left
// zeroed and rewritten in layoutMoons() once parent positions exist.
function makeMoonPool(slots: MoonSlot[], moonBodyIdx: readonly number[], renderOrder: number): MoonPool {
  const N = slots.length;
  const positions = new Float32Array(N * 3);
  const colors    = new Float32Array(N * 3);
  const sizesAttr = new Float32Array(N);
  slots.forEach((slot, i) => {
    const b = BODIES[moonBodyIdx[i]];
    const col = b.worldClass !== null
      ? (WORLD_CLASS_COLOR[b.worldClass] ?? WORLD_CLASS_UNKNOWN_COLOR)
      : WORLD_CLASS_UNKNOWN_COLOR;
    colors[i * 3 + 0] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
    sizesAttr[i] = slot.discPx;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color',    new BufferAttribute(colors, 3));
  geometry.setAttribute('aSize',    new BufferAttribute(sizesAttr, 1));
  const material = makeFlatStarsMaterial(1.0);
  const points = new Points(geometry, material);
  points.renderOrder = renderOrder;
  // Stale-bounding-sphere workaround — same as planetPoints. Moon
  // positions move per resize; the cached sphere doesn't, so Three.js
  // would eventually cull the whole pool after the points shift outside
  // their original bounds. GPU per-vertex clipping handles anything
  // actually off-screen.
  points.frustumCulled = false;
  return { slots, geometry, material, points };
}
