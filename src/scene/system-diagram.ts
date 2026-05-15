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
  BELT_CLASS_COLOR,
  BODIES,
  CLASS_COLOR,
  STARS,
  STAR_CLUSTERS,
  WORLD_CLASS_COLOR,
  WORLD_CLASS_UNKNOWN_COLOR,
  type BeltClass,
  type Body,
} from '../data/stars';
import { sizes } from '../ui/theme';
import { makeBlobMaterial, makeFlatStarsMaterial, makeIceRingMaterial, makeStarMeshMaterial } from './materials';

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

// Per-channel lerp of moon color toward white. Same-world-class moon +
// parent would otherwise share an exact color and the moon's inner half
// would disappear into the parent at the rim overlap. Lerp toward white
// (rather than additive bump) preserves hue and won't oversaturate
// channels already near 1.
const MOON_BRIGHTEN = 0.15;

// Belts occupy a row slot like a planet, but render as a vertical
// column of irregular angular blobs (polygon meshes) rather than a
// single disc. Slot width is fixed (not derived from belt mass) so a
// system's row-layout math stays simple.
const BELT_SLOT_WIDTH = 36;
// Vertical extent of a belt column, expressed as a multiple of the
// largest planet disc on the row. ~3× makes the band feel like a
// structural feature spanning a real swath of the system rather than
// a compact cluster — wide enough to read distinctly from a tightly
// packed moon system but not so tall it crashes into the stars or
// the ships area.
const BELT_HEIGHT_FACTOR = 3.0;
// Chunk count range per belt. Smallest masses bottom out at MIN; the
// largest belts approach MAX. Log-based so a 100× mass range only
// doubles chunk count. Calibrated against the taller BELT_HEIGHT_FACTOR
// — at the extended vertical area the band wants more bodies to read
// as a dense belt rather than a sparse trail.
const BELT_CHUNKS_MIN = 20;
const BELT_CHUNKS_MAX = 50;
// Per-chunk polygon half-extent in env-px. A chunk's silhouette is one
// of the BLOB_SHAPES inscribed in a unit circle, scaled by this size
// and rotated by a per-chunk angle, so the visible footprint is roughly
// (2*size) × (2*size) with the polygon filling ~60% of the bbox.
// Values calibrated to give a similar visible mass to the old square-
// sprite sizes [3,5,6,8,10] (mass = halfExtent² × ~2.4).
const BELT_CHUNK_SIZES = [2, 3, 4, 5, 6];

// --- Rings ---
//
// Rings render as a tilted ellipse around the host planet. Ice rings
// are solid triangle-strip annuli (back-half mesh draws before the
// planet, front-half after, so the planet disc occludes one and the
// front mesh overpaints the other); debris rings are angular-blob
// polygons scattered along the same ellipse path with the same
// back/front split. Both share the geometry constants below so a
// planet that rolls "ice" vs "debris" sits in the same physical space.
//
// Perspective compression: how much the ring's vertical extent is
// squished relative to its horizontal extent. 0.20 is a Saturn-like
// "looking down at it from above" angle — flat enough that the ring
// clearly reads as edge-tilted, not so flat that the back/front split
// loses its visual punch.
const RING_MINOR_OVER_MAJOR = 0.20;
// Per-ring tilt range in degrees. Each ring picks its tilt from the
// uniform [-RING_TILT_DEG_MAX, +RING_TILT_DEG_MAX] using a seed off
// the ring's id, so the same ring always tilts the same direction but
// different planets in the same system don't comb-align.
const RING_TILT_DEG_MAX = 14;
// Visual scale applied to the ring's RADIAL WIDTH (outer − inner) at
// render time. The CSV's innerPlanetRadii / outerPlanetRadii stay in
// physical units (Saturn's rings really do extend ~2.3 R_S); this
// multiplier pulls the OUTER edge in toward the inner edge so the band
// reads as stubbier without bringing the inner edge inside the
// planet's silhouette. Inner edge stays at innerPlanetRadii × R_p
// (always outside the planet rim).
const RING_WIDTH_VIZ_SCALE = 0.5;

// --- Per-row-item depth ---
//
// Each row item (planet or belt) gets a slot of z range Z_STRIDE in
// world coordinates. Larger row index → larger world z → smaller
// fragment depth under our OrthographicCamera (near=-1, far=1,
// projection negates z so world_z=+1 maps to depth=0). The default
// depthFunc (LessEqual) lets smaller depth win, so the rightmost
// row item draws on top. With depthWrite enabled across the system-
// diagram materials, each planet's whole stack (back-moon → back-ring
// → disc → front-ring → front-moon) renders as one contiguous z-band
// that fully occludes — or is fully occluded by — neighboring
// planets' stacks. Z_STRIDE × max-row-items must fit inside the
// camera's [-1, 1] z range (Z_STRIDE 0.001 → 1000-item ceiling, far
// past any realistic system size).
const Z_STRIDE = 0.001;
// Sub-offsets within one row item's z band. Listed deepest to most
// forward — back layers have NEGATIVE offsets (smaller world z =
// drawn under the planet disc); front layers have POSITIVE offsets
// (larger world z = drawn over the disc). Sub-offsets are an order
// of magnitude smaller than Z_STRIDE so adjacent row items' stacks
// never z-interleave.
const Z_BACK_MOON  = -0.00040;
const Z_BACK_RING  = -0.00030;
const Z_BELT       =  0.00000;
const Z_PLANET     =  0.00000;
const Z_FRONT_RING = +0.00030;
const Z_FRONT_MOON = +0.00040;
// Segments per half-ellipse for the ice-ring triangle strips. 24 is
// the floor where the silhouette stops reading as a polygon at the
// largest realistic planet sizes; bumping past 32 is wasted geometry.
const ICE_RING_SEGMENTS = 24;
// Debris-ring chunk density (chunks per px of ellipse perimeter) and
// clamp range. The perimeter approximation uses Ramanujan's first
// formula for the outer ellipse; close enough at our aspect ratios.
const DEBRIS_RING_CHUNKS_PER_PX = 0.10;
const DEBRIS_RING_CHUNKS_MIN = 18;
const DEBRIS_RING_CHUNKS_MAX = 80;
// Debris ring chunk polygon half-extents (env-px). Same blob shape +
// rotation model as belt chunks; smaller scale since rings are visual
// texture around an existing object and shouldn't out-mass the host
// planet's disc.
const DEBRIS_RING_CHUNK_SIZES = [2, 3, 3, 3];
// Brightness multiplier for debris ring chunks. Multiplies the
// BELT_CLASS_COLOR.debris value (~0x806848 → already dusty); pulling
// it down further per the brief ("darker thicker chunks") keeps debris
// distinct from the pale-cyan ice rings even at small sizes.
const DEBRIS_RING_DIM = 0.75;

// Two libraries of irregular convex polygon silhouettes — `potato`
// shapes for asteroid + debris chunks (rounded, weathered boulder
// reads), `crystal` shapes for ice chunks (sharp angles, shard reads).
// Each entry is a CCW-ordered vertex list in normalized [-1, 1] space
// inscribed in the unit circle; bakeBlob picks a shape, scales by the
// chunk's size, rotates by a per-chunk angle, then translates onto
// the chunk's center.
//
// Fan-triangulation in bakeBlob requires CCW winding around the
// centroid — keep new shapes that way (or the triangle winding flips
// and the rasterizer may cull them depending on side settings).

// Potato shapes — 6-8 vertices with all radii in [0.7, 1.0] so corners
// stay near the bounding circle and the silhouette reads as a smoothed
// blob rather than a faceted gem.
const POTATO_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // Round-ish hexagon
  [[1.00, 0.05], [0.50, 0.85], [-0.55, 0.82], [-0.95, 0.10], [-0.45, -0.88], [0.60, -0.80]],
  // 7-sided potato
  [[1.00, 0.00], [0.65, 0.78], [-0.15, 0.95], [-0.85, 0.50], [-0.95, -0.30], [-0.30, -0.93], [0.70, -0.75]],
  // Lumpy 8-vert oval (elongated horizontally)
  [[1.00, 0.00], [0.70, 0.55], [0.05, 0.70], [-0.70, 0.45], [-1.00, 0.00], [-0.70, -0.50], [0.05, -0.70], [0.70, -0.55]],
  // Asymmetric 7-vert (top-heavy)
  [[0.95, 0.20], [0.35, 0.95], [-0.55, 0.85], [-0.95, 0.15], [-0.75, -0.60], [0.00, -0.95], [0.80, -0.55]],
  // Squashed potato (7-vert)
  [[1.00, -0.10], [0.55, 0.65], [-0.40, 0.80], [-0.95, 0.30], [-0.85, -0.35], [-0.10, -0.85], [0.75, -0.55]],
  // Round 6-vert
  [[0.95, 0.30], [0.30, 0.95], [-0.65, 0.75], [-0.95, -0.05], [-0.45, -0.85], [0.55, -0.80]],
];

// Crystal shapes — 3-5 vertices, mixed radii (some flats, some sharp
// points) so the silhouette reads as a faceted shard rather than a
// rounded blob. Used by ice belts + (in principle) ice rings if they
// ever switch to chunks.
const CRYSTAL_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // Asymmetric pentagon shard
  [[1.00, 0.00], [0.25, 0.95], [-0.85, 0.25], [-0.40, -0.65], [0.55, -0.70]],
  // Sharp triangle (one tall point)
  [[1.00, -0.40], [0.00, 1.00], [-1.00, -0.30]],
  // Diamond / rhombus
  [[1.00, 0.00], [0.00, 1.00], [-1.00, 0.00], [0.00, -1.00]],
  // Skewed kite (sharp top)
  [[0.85, 0.10], [-0.20, 1.00], [-0.95, -0.15], [-0.10, -0.85]],
  // Quad with one extra-sharp corner
  [[0.95, 0.15], [-0.30, 0.95], [-0.95, -0.10], [-0.15, -0.95]],
  // Narrow shard
  [[1.00, 0.05], [0.45, 0.85], [-0.85, 0.45], [-0.60, -0.55], [0.40, -0.85]],
];

type ShapeLibrary = ReadonlyArray<ReadonlyArray<readonly [number, number]>>;

function shapesFor(beltClass: BeltClass | null): ShapeLibrary {
  return beltClass === 'ice' ? CRYSTAL_SHAPES : POTATO_SHAPES;
}

// Bake one chunk's geometry into the destination arrays. Returns the
// number of vertices written (so the caller can advance its cursor).
// Triangle indices are emitted as a triangle fan rooted at vertex 0 of
// the shape — works correctly for convex polygons, which is all the
// shape libraries contain.
function bakeBlob(
  shapes: ShapeLibrary,
  shapeIdx: number,
  size: number,
  rotation: number,
  cx: number, cy: number,
  posOut: number[], idxOut: number[], colorOut: number[], hoverOut: number[],
  r: number, g: number, b: number,
  vertexBase: number,
): number {
  const shape = shapes[shapeIdx];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  for (let i = 0; i < shape.length; i++) {
    const [vx, vy] = shape[i];
    const rx = (vx * cos - vy * sin) * size;
    const ry = (vx * sin + vy * cos) * size;
    posOut.push(cx + rx, cy + ry, 0);
    colorOut.push(r, g, b);
    hoverOut.push(0);
  }
  for (let i = 1; i < shape.length - 1; i++) {
    idxOut.push(vertexBase, vertexBase + i, vertexBase + i + 1);
  }
  return shape.length;
}

// Box-Muller normal sample, clamped to ±clamp. Returns a single value
// from N(0, sd); the second normal sample (cos vs sin pair) is
// discarded — cheap for our chunk densities.
function sampleGaussian(rng: () => number, sd: number, clamp: number): number {
  const u1 = Math.max(rng(), 1e-6);
  const u2 = rng();
  const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(-clamp, Math.min(clamp, g * sd));
}

// Per-chunk spec produced by the position samplers and consumed by
// bakeBlob. Sizes are polygon half-extents; positions are offsets from
// the slot's anchor (belt slot center, or planet center for rings).
interface ChunkSpec {
  cx: number;
  cy: number;
  size: number;
  shapeIdx: number;
  rotation: number;
}

// Test a candidate (cx, cy, size) against already-placed chunks for
// bounding-circle overlap. Returns true if the candidate collides with
// any prior placement (within minDist = sumOfRadii + RING_GAP_PX).
const CHUNK_GAP_PX = 1;
function overlapsAny(cx: number, cy: number, size: number, placed: ReadonlyArray<ChunkSpec>): boolean {
  for (const p of placed) {
    const dx = cx - p.cx;
    const dy = cy - p.cy;
    const minDist = size + p.size + CHUNK_GAP_PX;
    if (dx * dx + dy * dy < minDist * minDist) return true;
  }
  return false;
}

// Belt chunk sampler — produces N chunks with:
//   - Y biased toward the slot center (Gaussian, SD = halfH/3)
//   - X biased toward the slot center (Gaussian, SD = halfW/2)
//   - Size correlated with proximity to center (bigger near y=0,
//     smaller near ±halfH) — gives the "stretched out, larger toward
//     middle, attenuating with randomness" silhouette in the brief
//   - Non-overlapping: each candidate is retried up to MAX_ATTEMPTS
//     times before being skipped (skipped chunks naturally rarefy the
//     edges where placement is already sparse anyway)
const CHUNK_PLACE_ATTEMPTS = 10;
function sampleBeltChunks(
  rng: () => number,
  N: number,
  halfW: number,
  halfH: number,
  sizes: ReadonlyArray<number>,
  shapes: ShapeLibrary,
): ChunkSpec[] {
  const placed: ChunkSpec[] = [];
  // Sort an index list by intended "center-proximity" so big chunks
  // get placed first — they're hardest to fit and should win the
  // central spots. We don't pre-sample positions; just attempt each
  // chunk with center-biased random Y and retry on overlap.
  for (let i = 0; i < N; i++) {
    let chosen: ChunkSpec | null = null;
    for (let attempt = 0; attempt < CHUNK_PLACE_ATTEMPTS; attempt++) {
      const cy = sampleGaussian(rng, halfH * 0.33, halfH);
      const cx = sampleGaussian(rng, halfW * 0.50, halfW);
      // Size: biased upward when near center. Pick a uniform index,
      // then bias via pow(u, k): k<1 skews toward last (largest), k>1
      // toward first (smallest). centerProx ∈ [0, 1].
      const centerProx = 1 - Math.abs(cy) / Math.max(halfH, 1);
      const k = 2.2 - 1.8 * centerProx;
      const u = rng();
      const sizeIdx = Math.min(sizes.length - 1, Math.floor(Math.pow(u, k) * sizes.length));
      const size = sizes[sizeIdx];
      if (overlapsAny(cx, cy, size, placed)) continue;
      chosen = {
        cx, cy, size,
        shapeIdx: Math.floor(rng() * shapes.length),
        rotation: rng() * Math.PI * 2,
      };
      break;
    }
    if (chosen) placed.push(chosen);
  }
  return placed;
}

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
  // Parent planet's index in rowItems, threaded into the moon's vertex
  // z by layoutMoons so the moon stacks with its host's bundle.
  parentRowIdx: number;
  // Index into the per-pool moon arrays (positions, colors, sizes).
  poolIndex: number;
  // Index into BODIES — used by the picker / hover lookup so a pool can
  // map a slot back to the body it represents without a parallel array.
  bodyIdx: number;
  // Per-moon disc diameter (px), and per-moon angle around parent.
  discPx: number;
  angle: number;
}

// A single slot in the planet+belt row. Built once at construction
// (sorted by semi-major axis); cx/cy are filled in by layoutRow().
// Planets carry a disc size, belts a fixed slot width (BELT_SLOT_WIDTH).
// `rowIdx` is the 0-based position in the sorted row; the layout pass
// threads it into every element's vertex z via Z_STRIDE so each row
// item's stack (planet disc + its rings + its moons, or a belt's chunks)
// renders as one z-layer above its left-of-here neighbors and below its
// right-of-here neighbors.
interface RowItem {
  kind: 'planet' | 'belt';
  bodyIdx: number;
  widthPx: number;
  cx: number;
  cy: number;
  rowIdx: number;
}

// A belt's footprint inside the unified chunk pool — vertex range + the
// vertical extent used by the picker's bounding-box test.
interface BeltSlot {
  bodyIdx: number;
  // rowItems index — threaded into the chunk vertex z so this belt's
  // chunks z-stack consistently with its row neighbors.
  rowIdx: number;
  startVertex: number;
  endVertex: number;     // exclusive
  // Pre-baked per-chunk offsets from the belt's slot center. Stable
  // across resizes so re-layout just translates the cluster.
  chunkOffsets: ReadonlyArray<{ dx: number; dy: number }>;
  // Bounding box half-extents used by the picker.
  halfW: number;
  halfH: number;
}

// A debris-ring footprint inside one of the back/front chunk pools.
// Chunk offsets are pre-baked relative to the host planet's center,
// already laid out along the tilted ellipse — layout just translates
// the cluster onto the host's current cx/cy.
interface RingSlot {
  bodyIdx: number;
  hostBodyIdx: number;
  // Host planet's rowItems index — threaded into the chunk vertex z so
  // the ring stays in its host planet's z-stack regardless of ordering
  // within the pool.
  hostRowIdx: number;
  startVertex: number;
  endVertex: number;
  chunkOffsets: ReadonlyArray<{ dx: number; dy: number }>;
  // Ellipse parameters cached for the picker — the bbox alone isn't
  // enough because the ring is tilted and the picker needs to test
  // against the actual annulus.
  outerR: number;
  innerR: number;
  tiltRad: number;
}

// Per-planet ice ring — two meshes (back + front) plus the geometry
// parameters cached for the picker. Distinct from RingSlot because ice
// rings render through Mesh + triangle-strip geometry rather than
// gl.POINTS chunks; one mesh per half rather than a shared pool.
interface IceRingMesh {
  bodyIdx: number;
  hostBodyIdx: number;
  // Host planet's rowItems index — sets the mesh.position.z so the
  // ring stacks with its host's z-band.
  hostRowIdx: number;
  backMesh: Mesh;
  frontMesh: Mesh;
  backGeometry: BufferGeometry;
  frontGeometry: BufferGeometry;
  // Both halves share a material (the hover state covers the whole
  // ring; toggling one half without the other would look broken).
  material: ShaderMaterial;
  outerR: number;
  innerR: number;
  tiltRad: number;
}

// Generic blob pool — one indexed triangle Mesh shared by N slots
// (belts share the belt pool; back debris rings share the back-ring
// pool; etc.). Each slot occupies a contiguous vertex range plus its
// own contiguous index range; hover writes `aHovered = 1` across the
// vertex range to flip every polygon in the slot to white at once.
interface BlobPool<S> {
  slots: S[];
  geometry: BufferGeometry;
  material: ShaderMaterial;
  mesh: Mesh;
}

// Picker result. Discriminated by `kind`: star vs. body (planet / moon /
// belt / ring). Returned by SystemDiagram.pickAt and consumed by
// setHovered + the HUD body info card. starIdx indexes STARS; bodyIdx
// indexes BODIES.
export type BodyPick =
  | { readonly kind: 'star'; readonly starIdx: number }
  | { readonly kind: 'planet' | 'moon' | 'belt' | 'ring'; readonly bodyIdx: number };

function picksEqual(a: BodyPick | null, b: BodyPick | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'star' && b.kind === 'star') return a.starIdx === b.starIdx;
  if (a.kind !== 'star' && b.kind !== 'star') return a.bodyIdx === b.bodyIdx;
  return false;
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

  // -- Row (planets + belts share one dome row, sorted by semi-major
  // axis). rowItems carries every slot in order; planetIndices /
  // planetDiscPx are the planet-only subset, preserved for moon-layout
  // and pick code that already keys off the planet's row position.
  private readonly rowItems: RowItem[];
  private readonly planetIndices: readonly number[];
  private readonly planetDiscPx: readonly number[];
  // -- Planets --
  // One Points covering every planet across every member star.
  private readonly planetGeometry: BufferGeometry | null = null;
  private readonly planetMaterial: ShaderMaterial | null = null;
  private readonly planetPoints: Points | null = null;

  // -- Belts --
  // One shared blob pool — all belts in the system render as polygon
  // chunks (BLOB_SHAPES, per-chunk rotation + scale) in a single
  // indexed triangle Mesh. Hover writes aHovered across the slot's
  // [startVertex, endVertex) vertex range so every polygon in the
  // hovered belt flips to white at once.
  private readonly belts: BlobPool<BeltSlot> | null = null;

  // -- Moons --
  // Two pools split by angular hemisphere: upper-half (sin θ > 0) →
  // "back" (renderOrder < planet), lower-half → "front" (renderOrder >
  // planet). Each moon's position depends on its parent's placement, so
  // layoutMoons() runs after layoutPlanets().
  private readonly backMoons: MoonPool | null = null;
  private readonly frontMoons: MoonPool | null = null;

  // -- Rings --
  // Ice rings render as solid triangle-strip annulus halves (one per
  // back / front pair per planet). Debris rings render as chunky
  // sprites distributed along the same tilted-ellipse path, sharing
  // back- and front-pool chunk geometries with all other debris rings
  // in the system. Both render paths use the same back-then-planet-then-
  // front draw order so the planet disc is sandwiched inside the ring.
  private readonly iceRings: IceRingMesh[] = [];
  private readonly backDebrisRings: BlobPool<RingSlot> | null = null;
  private readonly frontDebrisRings: BlobPool<RingSlot> | null = null;

  // -- Hover --
  // Currently-outlined body. setHovered() diffs against this to skip
  // no-op repaints (cursor moving within the same disc) and to clear the
  // previous outline before stamping the new one.
  private hoveredPick: BodyPick | null = null;

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

    // -- Row (planets + belts): gather both kinds across every member,
    // tag each with its slot width, then sort by semi-major axis so
    // they share a single dome row. A belt sitting between two planets
    // in semi-major order interleaves naturally — no separate "belt row."
    const rowItems: RowItem[] = [];
    for (const starIdx of cluster.members) {
      for (const pIdx of STARS[starIdx].planets) {
        rowItems.push({
          kind: 'planet', bodyIdx: pIdx,
          widthPx: planetDiscPx(BODIES[pIdx]),
          cx: 0, cy: 0, rowIdx: 0,
        });
      }
      for (const bIdx of STARS[starIdx].belts) {
        rowItems.push({
          kind: 'belt', bodyIdx: bIdx,
          widthPx: BELT_SLOT_WIDTH,
          cx: 0, cy: 0, rowIdx: 0,
        });
      }
    }
    rowItems.sort((a, b) => {
      const aa = BODIES[a.bodyIdx].semiMajorAu ?? Infinity;
      const bb = BODIES[b.bodyIdx].semiMajorAu ?? Infinity;
      return aa - bb;
    });
    rowItems.forEach((r, i) => { r.rowIdx = i; });
    this.rowItems = rowItems;

    // planetIndices / planetDiscPx are the planet-only projection of
    // rowItems, in the same row order. Moon-layout code keys off
    // planetIndices[parentIndex] for its parent's bodyIdx; preserving
    // this array lets the moon path stay untouched.
    const planetItems = rowItems.filter(r => r.kind === 'planet');
    this.planetIndices = planetItems.map(r => r.bodyIdx);
    this.planetDiscPx = planetItems.map(r => r.widthPx);

    if (this.planetIndices.length > 0) {
      const P = this.planetIndices.length;
      const pPositions = new Float32Array(P * 3);
      const pColors    = new Float32Array(P * 3);
      const pSizes     = new Float32Array(P);
      // aHovered carries the per-vertex hover flag (0 or 1) consumed by
      // the fragment shader's outline branch. Starts all-zero; setHovered
      // flips one entry at a time.
      const pHovered   = new Float32Array(P);
      this.planetIndices.forEach((bIdx, i) => {
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
      this.planetGeometry.setAttribute('aHovered', new BufferAttribute(pHovered, 1));
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
    this.planetIndices.forEach((pIdx, parentIndex) => {
      const parent = BODIES[pIdx];
      const Nm = parent.moons.length;
      if (Nm === 0) return;
      // Pre-compute moon disc sizes so the angle distribution can use
      // real radii for its geometric margins.
      const moonDiscs = parent.moons.map(idx => moonDiscPx(BODIES[idx]));
      const moonRadii = moonDiscs.map(d => d / 2);
      const parentR = this.planetDiscPx[parentIndex] / 2;
      const moonAngles = distributeMoonAngles(moonRadii, parentR, parent.id);
      const parentRowIdx = planetItems[parentIndex].rowIdx;
      parent.moons.forEach((moonBodyIdx, j) => {
        const angle = moonAngles[j];
        const discPx = moonDiscs[j];
        const slot: MoonSlot = { parentIndex, parentRowIdx, poolIndex: -1, bodyIdx: moonBodyIdx, discPx, angle };
        if (Math.sin(angle) > 0) {
          slot.poolIndex = backSlots.length;
          backSlots.push(slot);
        } else {
          slot.poolIndex = frontSlots.length;
          frontSlots.push(slot);
        }
      });
    });

    if (backSlots.length > 0) {
      this.backMoons = makeMoonPool(backSlots, /*renderOrder=*/ 5);
      this.scene.add(this.backMoons.points);
    }
    if (frontSlots.length > 0) {
      this.frontMoons = makeMoonPool(frontSlots, /*renderOrder=*/ 15);
      this.scene.add(this.frontMoons.points);
    }

    // -- Belts: one shared chunk pool across every belt slot. Chunk
    // counts and per-chunk offsets bake at construction so layout only
    // translates the cluster around its slot center (no re-roll on
    // resize).
    const beltItems = rowItems.filter(r => r.kind === 'belt');
    if (beltItems.length > 0) {
      const largestPlanet = planetItems.reduce((m, r) => Math.max(m, r.widthPx), PLANET_DISC_MIN);
      const heightPx = largestPlanet * BELT_HEIGHT_FACTOR;
      this.belts = buildBeltPool(beltItems.map(r => ({ bodyIdx: r.bodyIdx, rowIdx: r.rowIdx })), heightPx);
      this.scene.add(this.belts.mesh);
    }

    // -- Rings: per-planet ring systems split by beltClass. Ice rings
    // get solid mesh annulus halves; debris rings get chunky sprites
    // distributed along the same tilted-ellipse geometry. Both kinds
    // sit in the same per-planet z-stack: their depth threads the host
    // planet's rowIdx so they render above/below neighboring planets'
    // elements as a unit.
    type RingSpec = { bodyIdx: number; hostBodyIdx: number; hostDiscPx: number; hostRowIdx: number };
    const iceSpecs: RingSpec[] = [];
    const debrisSpecs: RingSpec[] = [];
    planetItems.forEach((p, i) => {
      const planet = BODIES[p.bodyIdx];
      if (planet.ring == null) return;
      const ring = BODIES[planet.ring];
      const spec: RingSpec = { bodyIdx: planet.ring, hostBodyIdx: p.bodyIdx, hostDiscPx: this.planetDiscPx[i], hostRowIdx: p.rowIdx };
      if (ring.beltClass === 'ice') iceSpecs.push(spec);
      else debrisSpecs.push(spec);
    });
    for (const spec of iceSpecs) {
      const mesh = buildIceRing(spec);
      if (mesh) {
        this.iceRings.push(mesh);
        this.scene.add(mesh.backMesh);
        this.scene.add(mesh.frontMesh);
      }
    }
    if (debrisSpecs.length > 0) {
      const built = buildDebrisRingPools(debrisSpecs);
      if (built.backSlots.length > 0) {
        this.backDebrisRings = buildBlobPool(built.backSlots, built.backPositions, built.backIndices, built.backColors, /*renderOrder=*/ 7);
        this.scene.add(this.backDebrisRings.mesh);
      }
      if (built.frontSlots.length > 0) {
        this.frontDebrisRings = buildBlobPool(built.frontSlots, built.frontPositions, built.frontIndices, built.frontColors, /*renderOrder=*/ 13);
        this.scene.add(this.frontDebrisRings.mesh);
      }
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
    this.layoutRow();
    this.layoutPlanets();
    this.layoutBelts();
    this.layoutMoons();
    this.layoutRings();
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

  // Compute cx/cy for every rowItem (planets + belts share the row).
  // Slot widths come from rowItem.widthPx; even-edge-to-edge gap math
  // is identical to the prior planet-only layout — belts just sum into
  // the totalW like any other slot.
  private layoutRow(): void {
    const N = this.rowItems.length;
    if (N === 0) return;

    const availW = this.bufferW - 2 * sizes.edgePad;
    const xLeft = sizes.edgePad;

    // Edge-to-edge spacing: free space split into N+1 equal gaps — one
    // between each adjacent pair plus one as a margin on each end — so a
    // gas giant next to a rocky world (or a belt next to either) preserves
    // the same edge-to-edge gap. Goes negative when sum(width) > availW;
    // slots then overlap evenly (deck-of-cards). Not shrinking widths in
    // that case because the cbrt size curve is what keeps Mercury legible
    // next to Jupiter — uniform shrinkage would flatten the ratio.
    const sumD = this.rowItems.reduce((s, r) => s + r.widthPx, 0);
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
      const item = this.rowItems[i];
      const r = item.widthPx / 2;
      const cx = cursor + r;
      // Dome Y keyed to actual x (not ordinal index), so the peak stays
      // at availW/2 regardless of size variation across the row — the
      // arc is a geometric shape every slot rides on, not a function of
      // slot index. sin(π·t) peaks at t = 0.5 and is 0 at t = 0 / t = 1.
      const t = (cx - xLeft) / availW;
      const yOffset = peakHeight * Math.sin(Math.PI * t);
      item.cx = Math.round(cx);
      item.cy = Math.round(baselineY + yOffset);
      cursor += item.widthPx + gap;
    }
  }

  // Write planet Points positions from the rowItems' (already-laid-out)
  // cx/cy. Iterates the planet-only subset of rowItems in row order, so
  // index i lines up with planetIndices[i].
  private layoutPlanets(): void {
    if (!this.planetGeometry || !this.planetPoints) return;
    const positions = this.planetGeometry.attributes.position.array as Float32Array;
    let pi = 0;
    for (const item of this.rowItems) {
      if (item.kind !== 'planet') continue;
      positions[pi * 3 + 0] = item.cx;
      positions[pi * 3 + 1] = item.cy;
      positions[pi * 3 + 2] = item.rowIdx * Z_STRIDE + Z_PLANET;
      pi++;
    }
    this.planetGeometry.attributes.position.needsUpdate = true;
  }

  // Belt chunks: translate each belt's pre-baked chunk offsets onto the
  // current slot center. No re-randomization on resize — the chunk
  // pattern is stable.
  private layoutBelts(): void {
    if (!this.belts) return;
    const positions = this.belts.geometry.attributes.position.array as Float32Array;
    let bi = 0;
    for (const item of this.rowItems) {
      if (item.kind !== 'belt') continue;
      const slot = this.belts.slots[bi];
      const z = slot.rowIdx * Z_STRIDE + Z_BELT;
      for (let v = slot.startVertex; v < slot.endVertex; v++) {
        const off = slot.chunkOffsets[v - slot.startVertex];
        positions[v * 3 + 0] = Math.round(item.cx + off.dx);
        positions[v * 3 + 1] = Math.round(item.cy + off.dy);
        positions[v * 3 + 2] = z;
      }
      bi++;
    }
    this.belts.geometry.attributes.position.needsUpdate = true;
  }

  // Rings: translate ice-ring meshes and debris-ring chunks onto each
  // host planet's current cx/cy. Both render paths thread the host's
  // rowIdx into z — back layers sit slightly behind the host planet's
  // disc and front layers slightly ahead, so the depth test
  // sandwiches the disc inside the ring. Ice rings position via
  // mesh.position; debris chunks write per-vertex z.
  private layoutRings(): void {
    const planetCenters = new Map<number, { cx: number; cy: number }>();
    for (const item of this.rowItems) {
      if (item.kind === 'planet') planetCenters.set(item.bodyIdx, { cx: item.cx, cy: item.cy });
    }
    for (const ring of this.iceRings) {
      const c = planetCenters.get(ring.hostBodyIdx);
      if (!c) continue;
      const baseZ = ring.hostRowIdx * Z_STRIDE;
      ring.backMesh.position.set(c.cx, c.cy, baseZ + Z_BACK_RING);
      ring.frontMesh.position.set(c.cx, c.cy, baseZ + Z_FRONT_RING);
    }
    const writePool = (pool: BlobPool<RingSlot> | null, layerZ: number) => {
      if (!pool) return;
      const positions = pool.geometry.attributes.position.array as Float32Array;
      for (const slot of pool.slots) {
        const c = planetCenters.get(slot.hostBodyIdx);
        if (!c) continue;
        const z = slot.hostRowIdx * Z_STRIDE + layerZ;
        for (let v = slot.startVertex; v < slot.endVertex; v++) {
          const off = slot.chunkOffsets[v - slot.startVertex];
          positions[v * 3 + 0] = Math.round(c.cx + off.dx);
          positions[v * 3 + 1] = Math.round(c.cy + off.dy);
          positions[v * 3 + 2] = z;
        }
      }
      pool.geometry.attributes.position.needsUpdate = true;
    };
    writePool(this.backDebrisRings,  Z_BACK_RING);
    writePool(this.frontDebrisRings, Z_FRONT_RING);
  }

  private layoutMoons(): void {
    if (!this.planetGeometry) return;
    const pPositions = this.planetGeometry.attributes.position.array as Float32Array;

    const writePool = (pool: MoonPool | null, layerZ: number) => {
      if (!pool) return;
      const out = pool.geometry.attributes.position.array as Float32Array;
      pool.slots.forEach((slot, i) => {
        const parentR = this.planetDiscPx[slot.parentIndex] / 2;
        const D = parentR + MOON_EDGE_BIAS;
        const px = pPositions[slot.parentIndex * 3 + 0];
        const py = pPositions[slot.parentIndex * 3 + 1];
        out[i * 3 + 0] = Math.round(px + Math.cos(slot.angle) * D);
        out[i * 3 + 1] = Math.round(py + Math.sin(slot.angle) * D);
        out[i * 3 + 2] = slot.parentRowIdx * Z_STRIDE + layerZ;
      });
      pool.geometry.attributes.position.needsUpdate = true;
    };

    writePool(this.backMoons,  Z_BACK_MOON);
    writePool(this.frontMoons, Z_FRONT_MOON);
  }

  // Hit-test the rendered discs at (x, y) in buffer-pixel coords. Layer
  // priority follows render order (later-rendered wins, so the eye and
  // the cursor agree): front moons → front ring chunks → planets →
  // back ring chunks → belts → back moons → stars. The first matching
  // slot wins, with no smaller-radius tiebreaker (so a moon overlapping
  // its parent's rim always wins because the moon pool draws after the
  // planet pool).
  pickAt(x: number, y: number): BodyPick | null {
    const inDisc = (cx: number, cy: number, r: number): boolean => {
      const dx = x - cx;
      const dy = y - cy;
      return dx * dx + dy * dy <= r * r;
    };

    const pickFromMoonPool = (pool: MoonPool | null): BodyPick | null => {
      if (!pool) return null;
      const pos = pool.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < pool.slots.length; i++) {
        const slot = pool.slots[i];
        const cx = pos[i * 3 + 0];
        const cy = pos[i * 3 + 1];
        if (inDisc(cx, cy, slot.discPx / 2)) {
          return { kind: 'moon', bodyIdx: slot.bodyIdx };
        }
      }
      return null;
    };

    // Tilted-ellipse annulus hit-test against any ring (ice or debris)
    // whose host planet is at `host.cx/cy`. Inverse-rotates the cursor
    // delta into the ring's untilted frame, then tests whether the
    // normalized ellipse parameter ρ² ∈ [innerR²/outerR², 1] — i.e.
    // the cursor lies between the inner and outer ellipses. The
    // back/front half of the ring is determined by the sign of the
    // *untilted* y, so a click on the upper half hits the back arc
    // and lower-half clicks hit the front arc; the caller picks which
    // half to test based on render order.
    type RingProbe = { bodyIdx: number; hostBodyIdx: number; outerR: number; innerR: number; tiltRad: number };
    const hitsRing = (probe: RingProbe, half: 'back' | 'front'): boolean => {
      const host = this.findPlanetRowItem(probe.hostBodyIdx);
      if (!host) return false;
      const dx = x - host.cx;
      const dy = y - host.cy;
      // Inverse tilt (positive tiltRad rotates the ring; rotate the
      // cursor by -tiltRad to drop back into the ring's local frame).
      const cosT = Math.cos(probe.tiltRad);
      const sinT = Math.sin(probe.tiltRad);
      const lx =  dx * cosT + dy * sinT;
      const ly = -dx * sinT + dy * cosT;
      // Half: back is the upper-half ellipse (ly > 0 in scene coords
      // where y grows upward); front is the lower half.
      if (half === 'back'  && ly <= 0) return false;
      if (half === 'front' && ly >= 0) return false;
      // Normalize against the outer ellipse to get ρ². The minor axis
      // is outerR × RING_MINOR_OVER_MAJOR (and innerR scales identically),
      // so the ratio (innerR/outerR)² holds for both axes.
      const ax = lx / probe.outerR;
      const ay = ly / (probe.outerR * RING_MINOR_OVER_MAJOR);
      const rho2 = ax * ax + ay * ay;
      if (rho2 > 1) return false;
      const innerRho2 = (probe.innerR / probe.outerR) * (probe.innerR / probe.outerR);
      return rho2 >= innerRho2;
    };

    const pickIceRing = (half: 'back' | 'front'): BodyPick | null => {
      for (const ring of this.iceRings) {
        if (hitsRing(ring, half)) return { kind: 'ring', bodyIdx: ring.bodyIdx };
      }
      return null;
    };
    const pickDebrisRing = (pool: BlobPool<RingSlot> | null, half: 'back' | 'front'): BodyPick | null => {
      if (!pool) return null;
      for (const slot of pool.slots) {
        if (hitsRing(slot, half)) return { kind: 'ring', bodyIdx: slot.bodyIdx };
      }
      return null;
    };

    const frontHit = pickFromMoonPool(this.frontMoons);
    if (frontHit) return frontHit;

    const frontIceHit = pickIceRing('front');
    if (frontIceHit) return frontIceHit;
    const frontDebrisHit = pickDebrisRing(this.frontDebrisRings, 'front');
    if (frontDebrisHit) return frontDebrisHit;

    if (this.planetGeometry) {
      const pos = this.planetGeometry.attributes.position.array as Float32Array;
      for (let i = 0; i < this.planetIndices.length; i++) {
        const cx = pos[i * 3 + 0];
        const cy = pos[i * 3 + 1];
        if (inDisc(cx, cy, this.planetDiscPx[i] / 2)) {
          return { kind: 'planet', bodyIdx: this.planetIndices[i] };
        }
      }
    }

    const backIceHit = pickIceRing('back');
    if (backIceHit) return backIceHit;
    const backDebrisHit = pickDebrisRing(this.backDebrisRings, 'back');
    if (backDebrisHit) return backDebrisHit;

    // Belt picks: bbox test against each belt slot. Iterate rowItems to
    // pair each belt slot with its laid-out cx/cy.
    if (this.belts) {
      let bi = 0;
      for (const item of this.rowItems) {
        if (item.kind !== 'belt') continue;
        const slot = this.belts.slots[bi];
        if (Math.abs(x - item.cx) <= slot.halfW && Math.abs(y - item.cy) <= slot.halfH) {
          return { kind: 'belt', bodyIdx: slot.bodyIdx };
        }
        bi++;
      }
    }

    const backHit = pickFromMoonPool(this.backMoons);
    if (backHit) return backHit;

    for (let slot = 0; slot < this.starDiscs.length; slot++) {
      const disc = this.starDiscs[slot];
      const cx = disc.mesh.position.x;
      const cy = disc.mesh.position.y;
      if (inDisc(cx, cy, disc.currentDiam / 2)) {
        return { kind: 'star', starIdx: this.starMembers[slot] };
      }
    }

    return null;
  }

  // Helper for the ring picker: rowItems is unordered with respect to
  // ring slots, so a Map would speed this up if it were called more
  // than O(rings) per pick. As-is it stays O(rowItems × rings) per
  // pick, which is trivial for any realistic system.
  private findPlanetRowItem(bodyIdx: number): RowItem | null {
    for (const item of this.rowItems) {
      if (item.kind === 'planet' && item.bodyIdx === bodyIdx) return item;
    }
    return null;
  }

  // Stamp the 1-px outline onto the picked disc, clearing the previous
  // one if any. No-op when the pick is unchanged so continuous pointer
  // movement within the same disc doesn't churn the GPU upload.
  setHovered(pick: BodyPick | null): void {
    if (picksEqual(pick, this.hoveredPick)) return;
    this.writeHover(this.hoveredPick, 0);
    this.writeHover(pick, 1);
    this.hoveredPick = pick;
  }

  // Flip the per-vertex aHovered (planets/moons/belts/rings) or
  // per-mesh uHovered (stars) to `value` for the disc identified by
  // `pick`. Belts and rings span multiple vertices per slot — the loop
  // writes `value` across [startVertex, endVertex).
  private writeHover(pick: BodyPick | null, value: 0 | 1): void {
    if (!pick) return;
    if (pick.kind === 'star') {
      const slot = this.starMembers.indexOf(pick.starIdx);
      if (slot < 0) return;
      this.starDiscs[slot].material.uniforms.uHovered.value = value;
      return;
    }
    if (pick.kind === 'planet') {
      if (!this.planetGeometry) return;
      const slot = this.planetIndices.indexOf(pick.bodyIdx);
      if (slot < 0) return;
      const attr = this.planetGeometry.attributes.aHovered as BufferAttribute;
      attr.setX(slot, value);
      attr.needsUpdate = true;
      return;
    }
    if (pick.kind === 'belt') {
      if (!this.belts) return;
      const slot = this.belts.slots.find(s => s.bodyIdx === pick.bodyIdx);
      if (!slot) return;
      const attr = this.belts.geometry.attributes.aHovered as BufferAttribute;
      for (let v = slot.startVertex; v < slot.endVertex; v++) attr.setX(v, value);
      attr.needsUpdate = true;
      return;
    }
    if (pick.kind === 'ring') {
      // Ice ring? Flip the shared material uniform — both halves carry
      // the same ShaderMaterial reference, so one write covers both.
      const ice = this.iceRings.find(r => r.bodyIdx === pick.bodyIdx);
      if (ice) {
        ice.material.uniforms.uHovered.value = value;
        return;
      }
      // Otherwise it's a debris ring split across the back / front
      // chunk pools — both pools may carry slots for the same ring.
      const pools: ReadonlyArray<BlobPool<RingSlot> | null> = [this.frontDebrisRings, this.backDebrisRings];
      for (const pool of pools) {
        if (!pool) continue;
        const slot = pool.slots.find(s => s.bodyIdx === pick.bodyIdx);
        if (!slot) continue;
        const attr = pool.geometry.attributes.aHovered as BufferAttribute;
        for (let v = slot.startVertex; v < slot.endVertex; v++) attr.setX(v, value);
        attr.needsUpdate = true;
      }
      return;
    }
    // moon — scan both pools (each moon belongs to exactly one).
    const pools: ReadonlyArray<MoonPool | null> = [this.frontMoons, this.backMoons];
    for (const pool of pools) {
      if (!pool) continue;
      const slotIdx = pool.slots.findIndex(s => s.bodyIdx === pick.bodyIdx);
      if (slotIdx < 0) continue;
      const attr = pool.geometry.attributes.aHovered as BufferAttribute;
      attr.setX(slotIdx, value);
      attr.needsUpdate = true;
      return;
    }
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
    this.belts?.geometry.dispose();
    this.belts?.material.dispose();
    this.backDebrisRings?.geometry.dispose();
    this.backDebrisRings?.material.dispose();
    this.frontDebrisRings?.geometry.dispose();
    this.frontDebrisRings?.material.dispose();
    for (const ring of this.iceRings) {
      ring.backGeometry.dispose();
      ring.frontGeometry.dispose();
      ring.material.dispose();
    }
  }
}

// Belt blob pool — for each belt, sample N center-weighted non-
// overlapping chunks via sampleBeltChunks, bake each chunk's polygon
// vertices, and concatenate into one indexed triangle mesh. Chunk
// counts scale log-uniformly with belt mass; smallest masses bottom
// out at BELT_CHUNKS_MIN, largest approach BELT_CHUNKS_MAX. Asteroid
// and debris belts pull from POTATO_SHAPES (rounded); ice belts use
// CRYSTAL_SHAPES (sharp shards).
function buildBeltPool(belts: ReadonlyArray<{ bodyIdx: number; rowIdx: number }>, heightPx: number): BlobPool<BeltSlot> {
  const slots: BeltSlot[] = [];
  const positions: number[] = [];
  const indices:   number[] = [];
  const colors:    number[] = [];
  const hovered:   number[] = [];
  let cursor = 0;
  for (const { bodyIdx, rowIdx } of belts) {
    const belt = BODIES[bodyIdx];
    const rng = mulberry32(hash32(`belt:${belt.id}`));
    const mass = belt.massEarth ?? 0.001;
    const logMass = Math.log10(Math.max(mass, 1e-5));
    const t = Math.max(0, Math.min(1, (logMass + 4) / 3.5));
    const N = Math.round(BELT_CHUNKS_MIN + t * (BELT_CHUNKS_MAX - BELT_CHUNKS_MIN));

    const col = belt.beltClass ? BELT_CLASS_COLOR[belt.beltClass] : WORLD_CLASS_UNKNOWN_COLOR;
    const halfW = BELT_SLOT_WIDTH / 2;
    const halfH = heightPx / 2;
    const shapes = shapesFor(belt.beltClass);
    const chunks = sampleBeltChunks(rng, N, halfW, halfH, BELT_CHUNK_SIZES, shapes);

    const slotStart = cursor;
    const offsets: { dx: number; dy: number }[] = [];
    for (const chunk of chunks) {
      const scratchPos: number[] = [];
      const written = bakeBlob(
        shapes, chunk.shapeIdx, chunk.size, chunk.rotation,
        chunk.cx, chunk.cy,
        scratchPos, indices, colors, hovered,
        col.r, col.g, col.b,
        cursor,
      );
      for (let v = 0; v < written; v++) {
        offsets.push({ dx: scratchPos[v * 3 + 0], dy: scratchPos[v * 3 + 1] });
        positions.push(0, 0, 0);
      }
      cursor += written;
    }
    slots.push({
      bodyIdx, rowIdx,
      startVertex: slotStart,
      endVertex: cursor,
      chunkOffsets: offsets,
      halfW, halfH,
    });
  }
  return buildBlobPool(slots, positions, indices, colors, /*renderOrder=*/ 6);
}

// Compute the ring's ellipse parameters: per-planet pixel radii +
// tilt, derived from the ring body's innerPlanetRadii / outerPlanetRadii
// and a seeded tilt off the ring's id. Shared between ice + debris
// builders so both paths read the same geometry from the same source.
function ringEllipseParams(ring: Body, hostDiscPx: number): { innerR: number; outerR: number; tiltRad: number } {
  const innerFrac = ring.innerPlanetRadii ?? 1.1;
  const outerFrac = ring.outerPlanetRadii ?? 2.0;
  const planetRadius = hostDiscPx / 2;
  const innerR = innerFrac * planetRadius;
  // Scale only the band's WIDTH — inner edge stays at innerR (outside
  // the planet rim); the outer edge moves toward the inner by
  // (1 - RING_WIDTH_VIZ_SCALE) of the CSV band width.
  const outerR = innerR + (outerFrac - innerFrac) * planetRadius * RING_WIDTH_VIZ_SCALE;
  // Tilt: uniform over ±RING_TILT_DEG_MAX, seeded so the same ring
  // tilts the same way every reload. Per-ring (not per-system) so two
  // ringed planets in the same star system don't comb-align.
  const tiltRng = mulberry32(hash32(`ring-tilt:${ring.id}`));
  const tiltRad = (tiltRng() - 0.5) * 2 * RING_TILT_DEG_MAX * Math.PI / 180;
  return { innerR, outerR, tiltRad };
}

// Ice ring builder — two triangle-strip annulus halves (back + front)
// per planet. Each strip walks the half-ellipse, emitting an inner +
// outer vertex per segment and indexing them into triangles. The result
// is a solid Saturn-style band filled in BELT_CLASS_COLOR.ice.
function buildIceRing(spec: { bodyIdx: number; hostBodyIdx: number; hostDiscPx: number; hostRowIdx: number }): IceRingMesh | null {
  const ring = BODIES[spec.bodyIdx];
  if (ring.beltClass !== 'ice') return null;
  const { innerR, outerR, tiltRad } = ringEllipseParams(ring, spec.hostDiscPx);
  const color = BELT_CLASS_COLOR.ice;
  const material = makeIceRingMaterial(color);
  const backGeometry  = buildHalfAnnulusGeometry(innerR, outerR, tiltRad, /*upperHalf=*/ true);
  const frontGeometry = buildHalfAnnulusGeometry(innerR, outerR, tiltRad, /*upperHalf=*/ false);
  const backMesh  = new Mesh(backGeometry,  material);
  const frontMesh = new Mesh(frontGeometry, material);
  // renderOrder matches the corresponding debris-ring pools — depth z
  // does the heavy lifting for cross-element ordering, but mirroring
  // the back-then-planet-then-front sequence keeps tied-z scenarios
  // (e.g. equal-z moon next to a ring chunk) settling the right way.
  backMesh.renderOrder  = 7;
  frontMesh.renderOrder = 13;
  // Geometry vertices live in planet-local coords; layoutRings writes
  // the per-row z into mesh.position.z so the host planet's disc paints
  // over the back mesh and the front mesh paints over the disc.
  backMesh.frustumCulled  = false;
  frontMesh.frustumCulled = false;
  return { bodyIdx: spec.bodyIdx, hostBodyIdx: spec.hostBodyIdx, hostRowIdx: spec.hostRowIdx, backMesh, frontMesh, backGeometry, frontGeometry, material, outerR, innerR, tiltRad };
}

// Build one half of the ring's annulus as a triangle strip. The arc
// runs from angle 0 to π (upperHalf=true) or π to 2π (upperHalf=false)
// in the ring's local frame, then rotates by tiltRad so the visible
// silhouette matches the picker's hit-test math.
function buildHalfAnnulusGeometry(innerR: number, outerR: number, tiltRad: number, upperHalf: boolean): BufferGeometry {
  const N = ICE_RING_SEGMENTS;
  const start = upperHalf ? 0 : Math.PI;
  const end   = start + Math.PI;
  const positions = new Float32Array((N + 1) * 2 * 3);
  const indices: number[] = [];
  const cosT = Math.cos(tiltRad);
  const sinT = Math.sin(tiltRad);
  for (let i = 0; i <= N; i++) {
    const t = start + (i / N) * (end - start);
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    // Inner + outer points on the un-tilted ellipse.
    const ix = innerR * cos;
    const iy = innerR * sin * RING_MINOR_OVER_MAJOR;
    const ox = outerR * cos;
    const oy = outerR * sin * RING_MINOR_OVER_MAJOR;
    // Apply tilt rotation (positive tiltRad = counter-clockwise in
    // scene coords where y grows upward).
    const ixR = ix * cosT - iy * sinT;
    const iyR = ix * sinT + iy * cosT;
    const oxR = ox * cosT - oy * sinT;
    const oyR = ox * sinT + oy * cosT;
    positions[i * 6 + 0] = ixR; positions[i * 6 + 1] = iyR; positions[i * 6 + 2] = 0;
    positions[i * 6 + 3] = oxR; positions[i * 6 + 4] = oyR; positions[i * 6 + 5] = 0;
    if (i < N) {
      const v0 = i * 2, v1 = i * 2 + 1, v2 = (i + 1) * 2, v3 = (i + 1) * 2 + 1;
      indices.push(v0, v1, v2);
      indices.push(v1, v3, v2);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

// Debris ring pools — angular-blob polygons distributed along the
// tilted ellipse (stratified-uniform in angle, uniform radial jitter
// between innerR and outerR). Each chunk's back/front assignment is
// determined by the sign of its un-tilted y so the silhouette matches
// the picker's half-test. Color comes from BELT_CLASS_COLOR.debris (or
// whatever belt class the ring carries) dimmed by DEBRIS_RING_DIM.
function buildDebrisRingPools(specs: ReadonlyArray<{ bodyIdx: number; hostBodyIdx: number; hostDiscPx: number; hostRowIdx: number }>): {
  backSlots: RingSlot[]; backPositions: number[]; backIndices: number[]; backColors: number[];
  frontSlots: RingSlot[]; frontPositions: number[]; frontIndices: number[]; frontColors: number[];
} {
  const backSlots: RingSlot[]   = [], frontSlots: RingSlot[]   = [];
  const backPositions: number[] = [], frontPositions: number[] = [];
  const backIndices:   number[] = [], frontIndices:   number[] = [];
  const backColors:    number[] = [], frontColors:    number[] = [];
  const backHovered:   number[] = [], frontHovered:   number[] = [];
  let backCursor = 0, frontCursor = 0;
  for (const spec of specs) {
    const ring = BODIES[spec.bodyIdx];
    const { innerR, outerR, tiltRad } = ringEllipseParams(ring, spec.hostDiscPx);
    // Chunk count scales with the ellipse perimeter (Ramanujan's first
    // approximation): π × [3(a+b) − √((3a+b)(a+3b))]. Multiply by
    // DEBRIS_RING_CHUNKS_PER_PX and clamp.
    const a = outerR;
    const b = outerR * RING_MINOR_OVER_MAJOR;
    const perim = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    const N = Math.round(Math.max(DEBRIS_RING_CHUNKS_MIN, Math.min(DEBRIS_RING_CHUNKS_MAX, perim * DEBRIS_RING_CHUNKS_PER_PX)));
    const baseCol = ring.beltClass ? BELT_CLASS_COLOR[ring.beltClass] : WORLD_CLASS_UNKNOWN_COLOR;
    const r = baseCol.r * DEBRIS_RING_DIM;
    const g = baseCol.g * DEBRIS_RING_DIM;
    const bcol = baseCol.b * DEBRIS_RING_DIM;
    const rng = mulberry32(hash32(`ring:${ring.id}`));
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);

    const backOffs:  { dx: number; dy: number }[] = [];
    const frontOffs: { dx: number; dy: number }[] = [];
    const backStart = backCursor;
    const frontStart = frontCursor;
    const shapes = shapesFor(ring.beltClass);
    // Collect placed chunk centers across both pools so overlap
    // rejection considers neighbors on either side of the back/front
    // split (a chunk on the front pool at y=0+ε shouldn't collide with
    // a back pool chunk at y=0-ε, but it can collide with another
    // front chunk nearby).
    const placedBack: ChunkSpec[] = [];
    const placedFront: ChunkSpec[] = [];
    for (let i = 0; i < N; i++) {
      // Stratified-uniform angle: each chunk gets its own slice of
      // [0, 2π) plus a sub-slice jitter, so the ring reads evenly
      // populated even at low counts.
      const baseAngle = (i / N) * Math.PI * 2;
      let chosen: ChunkSpec | null = null;
      let goesBack = false;
      for (let attempt = 0; attempt < CHUNK_PLACE_ATTEMPTS; attempt++) {
        const t = baseAngle + rng() * (Math.PI * 2 / N);
        const r0 = innerR + rng() * (outerR - innerR);
        const lx = r0 * Math.cos(t);
        const ly = r0 * Math.sin(t) * RING_MINOR_OVER_MAJOR;
        const cx = lx * cosT - ly * sinT;
        const cy = lx * sinT + ly * cosT;
        const size = DEBRIS_RING_CHUNK_SIZES[Math.floor(rng() * DEBRIS_RING_CHUNK_SIZES.length)];
        const candidatePool = ly > 0 ? placedBack : placedFront;
        if (overlapsAny(cx, cy, size, candidatePool)) continue;
        chosen = {
          cx, cy, size,
          shapeIdx: Math.floor(rng() * shapes.length),
          rotation: rng() * Math.PI * 2,
        };
        goesBack = ly > 0;
        break;
      }
      if (!chosen) continue;
      if (goesBack) placedBack.push(chosen); else placedFront.push(chosen);
      const offs        = goesBack ? backOffs        : frontOffs;
      const positions   = goesBack ? backPositions   : frontPositions;
      const indices     = goesBack ? backIndices     : frontIndices;
      const colors      = goesBack ? backColors      : frontColors;
      const hovered     = goesBack ? backHovered     : frontHovered;
      const base = goesBack ? backCursor : frontCursor;
      const scratchPos: number[] = [];
      const written = bakeBlob(
        shapes, chosen.shapeIdx, chosen.size, chosen.rotation,
        chosen.cx, chosen.cy,
        scratchPos, indices, colors, hovered,
        r, g, bcol,
        base,
      );
      for (let v = 0; v < written; v++) {
        offs.push({ dx: scratchPos[v * 3 + 0], dy: scratchPos[v * 3 + 1] });
        positions.push(0, 0, 0);
      }
      if (goesBack) backCursor += written; else frontCursor += written;
    }

    if (backOffs.length > 0) {
      backSlots.push({
        bodyIdx: spec.bodyIdx, hostBodyIdx: spec.hostBodyIdx, hostRowIdx: spec.hostRowIdx,
        startVertex: backStart, endVertex: backCursor,
        chunkOffsets: backOffs,
        outerR, innerR, tiltRad,
      });
    }
    if (frontOffs.length > 0) {
      frontSlots.push({
        bodyIdx: spec.bodyIdx, hostBodyIdx: spec.hostBodyIdx, hostRowIdx: spec.hostRowIdx,
        startVertex: frontStart, endVertex: frontCursor,
        chunkOffsets: frontOffs,
        outerR, innerR, tiltRad,
      });
    }
  }
  // hovered arrays travel into the geometry alongside positions /
  // indices / colors; buildBlobPool re-allocates them so we don't need
  // to return them — the per-vertex hover flag starts at 0 either way.
  void backHovered; void frontHovered;
  return { backSlots, backPositions, backIndices, backColors, frontSlots, frontPositions, frontIndices, frontColors };
}

// Blob pool builder — wraps the accumulated per-vertex (positions,
// colors) and per-triangle (indices) arrays into an indexed Mesh with
// makeBlobMaterial. aHovered is allocated zero; SystemDiagram.writeHover
// flips it per-slot.
function buildBlobPool<S>(
  slots: S[],
  positions: number[],
  indices: number[],
  colors: number[],
  renderOrder: number,
): BlobPool<S> {
  const V = positions.length / 3;
  const posArr = new Float32Array(positions);
  const colorArr = new Float32Array(colors);
  const hoverArr = new Float32Array(V);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(posArr, 3));
  geometry.setAttribute('color',    new BufferAttribute(colorArr, 3));
  geometry.setAttribute('aHovered', new BufferAttribute(hoverArr, 1));
  // Index width: 16-bit if total vertex count fits, else 32. A system
  // with hundreds of chunks each contributing 4-6 verts can creep past
  // 65 K in pathological cases.
  if (V > 65535) geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  else           geometry.setIndex(new BufferAttribute(new Uint16Array(indices), 1));
  const material = makeBlobMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = renderOrder;
  // Same stale-bounding-sphere workaround as planet / moon pools.
  mesh.frustumCulled = false;
  return { slots, geometry, material, mesh };
}

// Build a Points geometry for one moon pool. Colors/sizes pulled from
// each moon's body record via slot.bodyIdx; positions left zeroed and
// rewritten in layoutMoons() once parent positions exist.
function makeMoonPool(slots: MoonSlot[], renderOrder: number): MoonPool {
  const N = slots.length;
  const positions = new Float32Array(N * 3);
  const colors    = new Float32Array(N * 3);
  const sizesAttr = new Float32Array(N);
  // Hover flag per moon; flipped to 1 by SystemDiagram.setHovered.
  const hoveredAttr = new Float32Array(N);
  slots.forEach((slot, i) => {
    const b = BODIES[slot.bodyIdx];
    const col = b.worldClass !== null
      ? (WORLD_CLASS_COLOR[b.worldClass] ?? WORLD_CLASS_UNKNOWN_COLOR)
      : WORLD_CLASS_UNKNOWN_COLOR;
    colors[i * 3 + 0] = col.r + (1 - col.r) * MOON_BRIGHTEN;
    colors[i * 3 + 1] = col.g + (1 - col.g) * MOON_BRIGHTEN;
    colors[i * 3 + 2] = col.b + (1 - col.b) * MOON_BRIGHTEN;
    sizesAttr[i] = slot.discPx;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color',    new BufferAttribute(colors, 3));
  geometry.setAttribute('aSize',    new BufferAttribute(sizesAttr, 1));
  geometry.setAttribute('aHovered', new BufferAttribute(hoveredAttr, 1));
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
