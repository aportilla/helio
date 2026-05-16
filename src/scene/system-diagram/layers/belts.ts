// Belts layer — one shared chunk pool across every belt slot. Chunk
// counts and per-chunk offsets bake at construction so layout only
// translates each cluster around its slot center (no re-roll on resize).

import { BufferAttribute, Scene } from 'three';
import { BELT_CLASS_COLOR, BODIES, WORLD_CLASS_UNKNOWN_COLOR } from '../../../data/stars';
import {
  BELT_CHUNKS_MAX, BELT_CHUNKS_MIN, BELT_CHUNK_SIZES, BELT_HEIGHT_FACTOR,
  BELT_SLOT_WIDTH, PLANET_DISC_MIN, RENDER_ORDER_BELT, Z_BELT, Z_STRIDE,
} from '../layout/constants';
import type { RowSlot } from '../layout/row';
import {
  bakeBlob, buildChunkPool, sampleBeltChunks, shapesFor, type ChunkPool,
} from '../geom/blob';
import { hash32, mulberry32 } from '../geom/prng';
import type { DiagramPick } from '../types';

// One belt's footprint inside the shared chunk pool — vertex range +
// the vertical extent used by the picker's bounding-box test.
interface BeltSlot {
  bodyIdx: number;
  // rowSlots index — threaded into the chunk vertex z so this belt's
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

export class BeltsLayer {
  private readonly pool: ChunkPool<BeltSlot> | null;

  constructor(scene: Scene, rowSlots: readonly RowSlot[]) {
    const beltItems = rowSlots.filter(r => r.kind === 'belt');
    if (beltItems.length === 0) {
      this.pool = null;
      return;
    }
    const planetItems = rowSlots.filter(r => r.kind === 'planet');
    const largestPlanet = planetItems.reduce((m, r) => Math.max(m, r.widthPx), PLANET_DISC_MIN);
    const heightPx = largestPlanet * BELT_HEIGHT_FACTOR;
    this.pool = buildBeltPool(beltItems.map(r => ({ bodyIdx: r.bodyIdx, rowIdx: r.rowIdx })), heightPx);
    scene.add(this.pool.mesh);
  }

  // Translate each belt's pre-baked chunk offsets onto the current slot
  // center. No re-randomization on resize — the chunk pattern is stable.
  layout(rowSlots: readonly RowSlot[]): void {
    if (!this.pool) return;
    const positions = this.pool.geometry.attributes.position.array as Float32Array;
    let bi = 0;
    for (const item of rowSlots) {
      if (item.kind !== 'belt') continue;
      const slot = this.pool.slots[bi];
      const z = slot.rowIdx * Z_STRIDE + Z_BELT;
      for (let v = slot.startVertex; v < slot.endVertex; v++) {
        const off = slot.chunkOffsets[v - slot.startVertex];
        positions[v * 3 + 0] = Math.round(item.cx + off.dx);
        positions[v * 3 + 1] = Math.round(item.cy + off.dy);
        positions[v * 3 + 2] = z;
      }
      bi++;
    }
    this.pool.geometry.attributes.position.needsUpdate = true;
  }

  // Bbox test against each belt slot. Iterate rowSlots to pair each
  // belt slot with its laid-out cx/cy.
  pickAt(x: number, y: number, rowSlots: readonly RowSlot[]): DiagramPick | null {
    if (!this.pool) return null;
    let bi = 0;
    for (const item of rowSlots) {
      if (item.kind !== 'belt') continue;
      const slot = this.pool.slots[bi];
      if (Math.abs(x - item.cx) <= slot.halfW && Math.abs(y - item.cy) <= slot.halfH) {
        return { kind: 'belt', bodyIdx: slot.bodyIdx };
      }
      bi++;
    }
    return null;
  }

  setHovered(pick: DiagramPick, value: 0 | 1): void {
    if (pick.kind !== 'belt' || !this.pool) return;
    const slot = this.pool.slots.find(s => s.bodyIdx === pick.bodyIdx);
    if (!slot) return;
    const attr = this.pool.geometry.attributes.aHovered as BufferAttribute;
    for (let v = slot.startVertex; v < slot.endVertex; v++) attr.setX(v, value);
    attr.needsUpdate = true;
  }

  dispose(): void {
    this.pool?.geometry.dispose();
    this.pool?.material.dispose();
  }
}

// For each belt, sample N center-weighted non-overlapping chunks via
// sampleBeltChunks, bake each chunk's polygon vertices, and concatenate
// into one indexed triangle mesh. Chunk counts scale log-uniformly with
// belt mass; smallest masses bottom out at BELT_CHUNKS_MIN, largest
// approach BELT_CHUNKS_MAX. Asteroid + debris belts pull from POTATO
// shapes; ice belts use CRYSTAL shapes.
function buildBeltPool(
  belts: ReadonlyArray<{ bodyIdx: number; rowIdx: number }>,
  heightPx: number,
): ChunkPool<BeltSlot> {
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
  return buildChunkPool(slots, positions, indices, colors, RENDER_ORDER_BELT);
}
