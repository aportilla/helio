// Debris rings layer — angular-blob polygons distributed along the
// tilted ellipse around each host planet. Two shared chunk pools
// (back / front) span every debris ring in the system; each ring
// gets a contiguous vertex range inside whichever pool its chunks
// belong to. A single ring may have chunks in both pools because
// individual chunks are routed back/front by the sign of their
// untilted y, so the silhouette matches the picker's half-test.

import { BufferAttribute, Scene } from 'three';
import { BELT_CLASS_COLOR, BODIES, WORLD_CLASS_UNKNOWN_COLOR, type Body } from '../../../data/stars';
import {
  DEBRIS_RING_CHUNKS_MAX, DEBRIS_RING_CHUNKS_MIN, DEBRIS_RING_CHUNKS_PER_PX,
  DEBRIS_RING_CHUNK_SIZES, DEBRIS_RING_DIM,
  RENDER_ORDER_BACK_RING, RENDER_ORDER_FRONT_RING,
  RING_MINOR_OVER_MAJOR, Z_BACK_RING, Z_FRONT_RING, Z_STRIDE,
} from '../layout/constants';
import type { RowSlot } from '../layout/row';
import {
  bakeBlob, buildChunkPool, CHUNK_PLACE_ATTEMPTS, overlapsAny, shapesFor,
  type ChunkPool, type ChunkSpec,
} from '../geom/blob';
import { hash32, mulberry32 } from '../geom/prng';
import { hitsRing, ringEllipseParams } from '../geom/ring';
import type { DiagramPick, PlanetCenterIndex } from '../types';

// One ring's footprint inside the back- or front-debris pool — vertex
// range + chunk offsets + the ellipse params needed by the picker.
interface RingSlot {
  bodyIdx: number;
  hostBodyIdx: number;
  startVertex: number;
  endVertex: number;
  chunkOffsets: ReadonlyArray<{ dx: number; dy: number }>;
  outerR: number;
  innerR: number;
  tiltRad: number;
}

export class DebrisRingsLayer {
  private readonly backPool:  ChunkPool<RingSlot> | null;
  private readonly frontPool: ChunkPool<RingSlot> | null;
  // bodyIdx → RingSlot ref, per pool. A ring may live in both pools
  // (chunks routed back/front by un-tilted y sign), so setHovered must
  // check each independently rather than early-returning on first hit.
  private readonly backSlotByBodyIdx:  ReadonlyMap<number, RingSlot>;
  private readonly frontSlotByBodyIdx: ReadonlyMap<number, RingSlot>;

  constructor(scene: Scene, rowSlots: readonly RowSlot[]) {
    const planetItems = rowSlots.filter(r => r.kind === 'planet');
    const specs: Array<{ ring: Body; ringBodyIdx: number; hostBodyIdx: number; hostDiscPx: number }> = [];
    for (const item of planetItems) {
      const planet = BODIES[item.bodyIdx];
      if (planet.ring == null) continue;
      const ring = BODIES[planet.ring];
      if (ring.beltClass === 'ice') continue;
      specs.push({ ring, ringBodyIdx: planet.ring, hostBodyIdx: item.bodyIdx, hostDiscPx: item.widthPx });
    }

    if (specs.length === 0) {
      this.backPool  = null;
      this.frontPool = null;
      this.backSlotByBodyIdx  = new Map();
      this.frontSlotByBodyIdx = new Map();
      return;
    }

    const built = buildDebrisRingPools(specs);
    this.backPool  = built.backSlots.length  > 0
      ? buildChunkPool(built.backSlots,  built.backPositions,  built.backIndices,  built.backColors,  RENDER_ORDER_BACK_RING)
      : null;
    this.frontPool = built.frontSlots.length > 0
      ? buildChunkPool(built.frontSlots, built.frontPositions, built.frontIndices, built.frontColors, RENDER_ORDER_FRONT_RING)
      : null;
    this.backSlotByBodyIdx  = new Map(built.backSlots.map(s  => [s.bodyIdx, s]));
    this.frontSlotByBodyIdx = new Map(built.frontSlots.map(s => [s.bodyIdx, s]));
    if (this.backPool)  scene.add(this.backPool.mesh);
    if (this.frontPool) scene.add(this.frontPool.mesh);
  }

  layout(centers: PlanetCenterIndex): void {
    writePool(this.backPool,  centers, Z_BACK_RING);
    writePool(this.frontPool, centers, Z_FRONT_RING);
  }

  pickFront(x: number, y: number, centers: PlanetCenterIndex): DiagramPick | null {
    return pickFromPool(this.frontPool, centers, x, y, 'front');
  }

  pickBack(x: number, y: number, centers: PlanetCenterIndex): DiagramPick | null {
    return pickFromPool(this.backPool, centers, x, y, 'back');
  }

  // Returns true if this layer owns any chunks for the toggled ring.
  // A ring may live in both pools; flip every owning slot in lockstep.
  setHovered(pick: DiagramPick, value: 0 | 1): boolean {
    if (pick.kind !== 'ring') return false;
    const front = this.frontPool && this.frontSlotByBodyIdx.get(pick.bodyIdx);
    const back  = this.backPool  && this.backSlotByBodyIdx.get(pick.bodyIdx);
    if (this.frontPool && front) writeHoverRange(this.frontPool, front, value);
    if (this.backPool  && back)  writeHoverRange(this.backPool,  back,  value);
    return Boolean(front || back);
  }

  dispose(): void {
    this.backPool?.geometry.dispose();
    this.backPool?.material.dispose();
    this.frontPool?.geometry.dispose();
    this.frontPool?.material.dispose();
  }
}

function writeHoverRange(pool: ChunkPool<RingSlot>, slot: RingSlot, value: 0 | 1): void {
  const attr = pool.geometry.attributes.aHovered as BufferAttribute;
  for (let v = slot.startVertex; v < slot.endVertex; v++) attr.setX(v, value);
  attr.needsUpdate = true;
}

function writePool(pool: ChunkPool<RingSlot> | null, centers: PlanetCenterIndex, layerZ: number): void {
  if (!pool) return;
  const positions = pool.geometry.attributes.position.array as Float32Array;
  for (const slot of pool.slots) {
    const parent = centers.get(slot.hostBodyIdx);
    if (!parent) continue;
    const z = parent.rowIdx * Z_STRIDE + layerZ;
    for (let v = slot.startVertex; v < slot.endVertex; v++) {
      const off = slot.chunkOffsets[v - slot.startVertex];
      positions[v * 3 + 0] = Math.round(parent.cx + off.dx);
      positions[v * 3 + 1] = Math.round(parent.cy + off.dy);
      positions[v * 3 + 2] = z;
    }
  }
  pool.geometry.attributes.position.needsUpdate = true;
}

function pickFromPool(
  pool: ChunkPool<RingSlot> | null,
  centers: PlanetCenterIndex,
  x: number, y: number,
  half: 'back' | 'front',
): DiagramPick | null {
  if (!pool) return null;
  for (const slot of pool.slots) {
    const parent = centers.get(slot.hostBodyIdx);
    if (!parent) continue;
    const hit = hitsRing(x, y, {
      hostCx: parent.cx, hostCy: parent.cy,
      outerR: slot.outerR, innerR: slot.innerR, tiltRad: slot.tiltRad,
    }, half);
    if (hit) return { kind: 'ring', bodyIdx: slot.bodyIdx };
  }
  return null;
}

// Chunk count scales with the ellipse perimeter (Ramanujan's first
// approximation): π × [3(a+b) − √((3a+b)(a+3b))]. Multiply by
// DEBRIS_RING_CHUNKS_PER_PX and clamp. Each chunk's back/front pool
// assignment is determined by the sign of its un-tilted y so the
// silhouette matches the picker's half-test.
function buildDebrisRingPools(
  specs: ReadonlyArray<{ ring: Body; ringBodyIdx: number; hostBodyIdx: number; hostDiscPx: number }>,
): {
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
    const ring = spec.ring;
    const { innerR, outerR, tiltRad } = ringEllipseParams(ring, spec.hostDiscPx);
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
    // Overlap rejection runs per back/front pool — a chunk on the front
    // at y=0+ε shouldn't collide with a back chunk at y=0-ε, but it can
    // collide with another front chunk nearby.
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
        bodyIdx: spec.ringBodyIdx, hostBodyIdx: spec.hostBodyIdx,
        startVertex: backStart, endVertex: backCursor,
        chunkOffsets: backOffs,
        outerR, innerR, tiltRad,
      });
    }
    if (frontOffs.length > 0) {
      frontSlots.push({
        bodyIdx: spec.ringBodyIdx, hostBodyIdx: spec.hostBodyIdx,
        startVertex: frontStart, endVertex: frontCursor,
        chunkOffsets: frontOffs,
        outerR, innerR, tiltRad,
      });
    }
  }
  // hovered arrays travel into the geometry alongside positions /
  // indices / colors; buildChunkPool re-allocates them, so we don't need
  // to return them — the per-vertex hover flag starts at 0 either way.
  void backHovered; void frontHovered;
  return { backSlots, backPositions, backIndices, backColors, frontSlots, frontPositions, frontIndices, frontColors };
}
