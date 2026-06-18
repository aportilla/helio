// Ships layer — animated "cargo ship" dots (SHIP_SIZE_PX square) over the system
// diagram, the FIRST time-driven element in this otherwise-static view. Each lane the
// EconomyBridge reports (internal / outgoing / incoming / through) becomes a
// steady emitter: dots spawn at the lane's A point, march a straight segment to
// B at constant pixel speed, and despawn at B. Emission RATE is proportional to
// the lane's per-turn shipped amount, so a busy lane reads as a denser stream.
//
// Positions are integrated on the CPU and rewritten in place into one
// pre-allocated DynamicDrawUsage pool (the droplines.ts zero-alloc pattern) —
// no per-frame allocation, no GPU clock. A live dot captures its own A/B at
// spawn, so a mid-turn setFlows() never re-aims a dot already in flight.

import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Points } from 'three';
import type { Scene, ShaderMaterial } from 'three';
import { indexOfBodyId } from '../../../data/stars';
import { snappedDotsMat, unregisterSnappedMaterial } from '../../materials';
import { disableCulling } from '../geom/cull';
import { snapPx } from '../geom/snap';
import {
  RENDER_ORDER_SHIP, SHIP_COLOR, SHIP_MAX_TICK_DT_MS, SHIP_OFFSCREEN_MARGIN,
  SHIP_POOL_CAP, SHIP_RATE_MAX_PER_LANE, SHIP_RATE_MIN_PER_LANE, SHIP_RATE_PER_MILLI,
  SHIP_SIZE_PX, SHIP_SPEED_PX_PER_SEC, SHIP_TRANSIT_FROM_TOP, Z_SHIP,
} from '../layout/constants';
import type { BodyCenterIndex } from '../types';
import type { ShipLane } from '../../../facilities/economy-bridge';

// A lane resolved to screen geometry + an emission rate, ready to spawn dots.
// emitAccum carries the fractional dot between frames.
interface ResolvedLane {
  ax: number; ay: number;
  bx: number; by: number;
  length: number;
  ratePerSec: number;
  emitAccum: number;
}

export class ShipsLayer {
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly points: Points;
  // BufferAttribute (not Float32BufferAttribute) wraps `pos` BY REFERENCE, so
  // the per-frame writes to `pos` below are what gets uploaded. Float32Buffer-
  // Attribute would COPY the array on construction (its ctor does
  // `new Float32Array(array)`), leaving the GPU pinned to a zero-filled copy
  // while the in-place writes silently went nowhere.
  private readonly posAttr: BufferAttribute;
  private readonly pos: Float32Array;

  // Per-live-dot SoA, parallel to pool slots [0, liveCount). Each dot owns its
  // A/B/length so it finishes its captured path even if the schedule changes.
  private readonly dAx = new Float32Array(SHIP_POOL_CAP);
  private readonly dAy = new Float32Array(SHIP_POOL_CAP);
  private readonly dBx = new Float32Array(SHIP_POOL_CAP);
  private readonly dBy = new Float32Array(SHIP_POOL_CAP);
  private readonly dLen = new Float32Array(SHIP_POOL_CAP);
  private readonly dT = new Float32Array(SHIP_POOL_CAP);
  private liveCount = 0;

  // The per-turn schedule (raw lanes) + the current layout it resolves against.
  private rawLanes: readonly ShipLane[] = [];
  private centers: BodyCenterIndex | null = null;
  private contentW = 0;
  private bufferH = 0;
  private resolved: ResolvedLane[] = [];

  private lastNow = -1;

  constructor(scene: Scene) {
    this.pos = new Float32Array(SHIP_POOL_CAP * 3);
    this.posAttr = new BufferAttribute(this.pos, 3);
    this.posAttr.setUsage(DynamicDrawUsage);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setDrawRange(0, 0);
    this.material = snappedDotsMat({ color: SHIP_COLOR, size: SHIP_SIZE_PX });
    // Layer ships over every body. Z_SHIP sits at the front of the bodies' z
    // span but isn't strictly ahead of the deepest row band, so depthTest:false
    // + the high renderOrder (not the z value) are what guarantee ships paint on
    // top — they always pass the depth test and draw last among the overlays.
    this.material.depthTest = false;
    this.points = new Points(this.geometry, this.material);
    this.points.renderOrder = RENDER_ORDER_SHIP;
    // Positions are rewritten every frame, so the cached bounding sphere goes
    // stale — skip frustum culling (per-vertex GPU clipping still applies).
    disableCulling(this.points);
    scene.add(this.points);
  }

  // Publish the current layout (body anchors + content-rect bounds). Called from
  // SystemDiagram.layout on construction + every resize, so lanes re-resolve
  // against moved bodies.
  setLayout(centers: BodyCenterIndex, contentW: number, bufferH: number): void {
    this.centers = centers;
    this.contentW = contentW;
    this.bufferH = bufferH;
    this.resolve();
  }

  // Replace the per-turn lane schedule (from EconomyBridge.clusterFlows). Resets
  // emission accumulators; in-flight dots keep their captured A/B and finish.
  setFlows(lanes: readonly ShipLane[]): void {
    this.rawLanes = lanes;
    this.resolve();
  }

  // Resolve raw lanes to screen geometry against the current layout. A lane
  // whose in-system endpoint has no published center, or that collapses to zero
  // length, is dropped. emitAccum restarts at 0 — a re-resolve is rare (turn
  // boundary or resize), so the sub-one-dot priming delay is imperceptible.
  private resolve(): void {
    this.resolved = [];
    if (this.contentW <= 0 || this.bufferH <= 0) return;
    const offTop = this.bufferH + SHIP_OFFSCREEN_MARGIN;
    const transitY = this.bufferH - SHIP_TRANSIT_FROM_TOP;
    const leftX = -SHIP_OFFSCREEN_MARGIN;
    const rightX = this.contentW + SHIP_OFFSCREEN_MARGIN;
    for (const lane of this.rawLanes) {
      let ax = 0, ay = 0, bx = 0, by = 0;
      switch (lane.kind) {
        case 'internal': {
          const a = this.anchor(lane.srcBodyId);
          const b = this.anchor(lane.dstBodyId);
          if (!a || !b) continue;
          ax = a.cx; ay = a.cy; bx = b.cx; by = b.cy;
          break;
        }
        case 'outgoing': {
          const a = this.anchor(lane.srcBodyId);
          if (!a) continue;
          ax = a.cx; ay = a.cy; bx = a.cx; by = offTop;
          break;
        }
        case 'incoming': {
          const b = this.anchor(lane.dstBodyId);
          if (!b) continue;
          ax = b.cx; ay = offTop; bx = b.cx; by = b.cy;
          break;
        }
        case 'through': {
          // A full-width horizontal sweep at the transit band. v1 keys motion on
          // direction only, so two distinct relay corridors of the same dir draw
          // as superimposed streams (their amounts stay separate, so density is
          // additive). Separating them spatially is the deferred bearing upgrade.
          if (lane.dir === 'ltr') { ax = leftX; bx = rightX; } else { ax = rightX; bx = leftX; }
          ay = transitY; by = transitY;
          break;
        }
      }
      const length = Math.hypot(bx - ax, by - ay);
      if (length < 1) continue;
      const ratePerSec = clamp(lane.amountMilli * SHIP_RATE_PER_MILLI, SHIP_RATE_MIN_PER_LANE, SHIP_RATE_MAX_PER_LANE);
      this.resolved.push({ ax, ay, bx, by, length, ratePerSec, emitAccum: 0 });
    }
  }

  private anchor(bodyId: string): { cx: number; cy: number } | undefined {
    if (!this.centers) return undefined;
    const idx = indexOfBodyId(bodyId);
    if (idx < 0) return undefined;
    return this.centers.get(idx);
  }

  // Per-frame: spawn at each lane's rate, advance every live dot, despawn at B.
  // dt is clamped (SHIP_MAX_TICK_DT_MS) so a resumed background tab doesn't dump
  // a burst of spawns or teleport in-flight dots.
  update(now: number): void {
    const dt = this.lastNow < 0 ? 0 : Math.min(now - this.lastNow, SHIP_MAX_TICK_DT_MS) / 1000;
    this.lastNow = now;
    if (this.liveCount === 0 && this.resolved.length === 0) return;
    // Nothing moves on a zero-dt frame (the first frame, or a duplicate
    // timestamp) and the buffer is already current — skip the work so this
    // formerly-static view pays no idle per-frame GPU re-upload.
    if (dt <= 0) return;

    const startCount = this.liveCount;

    // Spawn at each lane's rate.
    for (const lane of this.resolved) {
      lane.emitAccum += lane.ratePerSec * dt;
      while (lane.emitAccum >= 1) {
        // Pool full: keep ONE dot pending (clamp, don't zero) so a busy lane
        // resumes at full rate the instant a slot frees — zeroing would re-prime
        // it from scratch and bias the busiest traffic's density DOWN.
        if (this.liveCount >= SHIP_POOL_CAP) { lane.emitAccum = Math.min(lane.emitAccum, 1); break; }
        lane.emitAccum -= 1;
        const s = this.liveCount++;
        this.dAx[s] = lane.ax; this.dAy[s] = lane.ay;
        this.dBx[s] = lane.bx; this.dBy[s] = lane.by;
        this.dLen[s] = lane.length; this.dT[s] = 0;
      }
    }

    // Render-then-advance: draw each dot at its CURRENT t, then advance it for
    // the next frame — so a freshly spawned dot (t=0) renders at A before moving.
    // Despawn fires at the top once t has reached B (swap-remove); a dot's last
    // drawn position is thus a fraction short of B, hidden inside the destination
    // disc (internal/incoming) or off-screen past the margin (outgoing/through).
    const step = SHIP_SPEED_PX_PER_SEC * dt;
    let i = 0;
    while (i < this.liveCount) {
      const t = this.dT[i]!;
      if (t >= 1) {
        const last = --this.liveCount;
        if (i !== last) {
          this.dAx[i] = this.dAx[last]!; this.dAy[i] = this.dAy[last]!;
          this.dBx[i] = this.dBx[last]!; this.dBy[i] = this.dBy[last]!;
          this.dLen[i] = this.dLen[last]!; this.dT[i] = this.dT[last]!;
        }
        continue; // reprocess the swapped-in dot at slot i
      }
      this.pos[i * 3 + 0] = snapPx(this.dAx[i]! + (this.dBx[i]! - this.dAx[i]!) * t);
      this.pos[i * 3 + 1] = snapPx(this.dAy[i]! + (this.dBy[i]! - this.dAy[i]!) * t);
      this.pos[i * 3 + 2] = Z_SHIP;
      this.dT[i] = t + step / this.dLen[i]!;
      i++;
    }

    // Re-upload only when something actually changed: live dots advanced, or the
    // draw range shrank because dots despawned. An idle frame (lanes exist but no
    // dots in flight) touches nothing.
    if (this.liveCount > 0 || this.liveCount !== startCount) {
      this.posAttr.needsUpdate = true;
      this.geometry.setDrawRange(0, this.liveCount);
    }
  }

  dispose(): void {
    // Drop the material from the snapped-viewport registry before freeing it, so
    // the next scene's resize doesn't re-touch a dead GPU handle.
    unregisterSnappedMaterial(this.material);
    this.geometry.dispose();
    this.material.dispose();
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
