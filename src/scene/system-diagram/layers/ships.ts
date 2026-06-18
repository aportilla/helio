// Ships layer — animated "cargo ship" dots (SHIP_SIZE_PX square) over the system
// diagram, the FIRST time-driven element in this otherwise-static view. Each lane the
// EconomyBridge reports (internal / outgoing / incoming / through) becomes a
// steady emitter: dots spawn at the lane's A end, march to B along a quadratic
// Bézier at constant pixel speed, and despawn at B. Emission RATE is proportional
// to the lane's per-turn shipped amount, so a busy lane reads as a denser stream.
//
// Body-to-body (internal) lanes bow into an ARC — the control point is offset
// perpendicular to the chord, signed-random per ordered body-pair and cached so
// every dot on a lane traces the same curve. Endpoints SCATTER: each dot picks a
// random point within the source disc to leave from and within the destination
// disc to arrive at (the off-screen ends of outgoing/incoming/through stay put).
// Off-body lanes leave the control at the chord midpoint, so the Bézier degrades
// to the original straight segment.
//
// Positions are integrated on the CPU and rewritten in place into one
// pre-allocated DynamicDrawUsage pool (the droplines.ts zero-alloc pattern) —
// no per-frame allocation, no GPU clock. A live dot captures its own curve at
// spawn, so a mid-turn setFlows() never re-aims a dot already in flight.

import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Points } from 'three';
import type { Scene, ShaderMaterial } from 'three';
import { indexOfBodyId } from '../../../data/stars';
import { snappedDotsMat, unregisterSnappedMaterial } from '../../materials';
import { disableCulling } from '../geom/cull';
import { snapPx } from '../geom/snap';
import {
  RENDER_ORDER_SHIP, SHIP_ARC_BOW_MAX, SHIP_ARC_BOW_MIN, SHIP_COLOR, SHIP_EASE_FLOOR,
  SHIP_EASE_RAMP, SHIP_MAX_TICK_DT_MS, SHIP_OFFSCREEN_MARGIN, SHIP_POOL_CAP,
  SHIP_RATE_MAX_PER_LANE, SHIP_RATE_MIN_PER_LANE, SHIP_RATE_PER_MILLI, SHIP_SIZE_PX,
  SHIP_SPEED_PX_PER_SEC, SHIP_TRANSIT_FROM_TOP, Z_SHIP,
} from '../layout/constants';
import type { BodyCenter, BodyCenterIndex } from '../types';
import type { ShipLane } from '../../../facilities/economy-bridge';

const TAU = Math.PI * 2;

// A lane resolved to screen geometry + an emission rate, ready to spawn dots.
// (ax,ay)→(bx,by) is the chord; (cx,cy) is the quadratic-Bézier control point
// (chord midpoint for straight lanes, bowed off it for internal arcs). aR/bR are
// the scatter radii of each end (0 for an off-screen end). emitAccum carries the
// fractional dot between frames.
interface ResolvedLane {
  ax: number; ay: number; aR: number;
  bx: number; by: number; bR: number;
  cx: number; cy: number;
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
  // whole Bézier (A control B) + chord length, so it finishes its captured curve
  // even if the schedule changes mid-flight.
  private readonly dAx = new Float32Array(SHIP_POOL_CAP);
  private readonly dAy = new Float32Array(SHIP_POOL_CAP);
  private readonly dCx = new Float32Array(SHIP_POOL_CAP);
  private readonly dCy = new Float32Array(SHIP_POOL_CAP);
  private readonly dBx = new Float32Array(SHIP_POOL_CAP);
  private readonly dBy = new Float32Array(SHIP_POOL_CAP);
  private readonly dLen = new Float32Array(SHIP_POOL_CAP);
  private readonly dT = new Float32Array(SHIP_POOL_CAP);
  private liveCount = 0;

  // Per ordered body-pair arc bow (signed control-offset fraction of the chord),
  // cached so every dot between two bodies follows the same curve. Ephemeral
  // render state — filled lazily with Math.random(), not procedurally stable.
  private readonly arcBow = new Map<string, number>();

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
  // emission accumulators; in-flight dots keep their captured curve and finish.
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
      let ax = 0, ay = 0, aR = 0, bx = 0, by = 0, bR = 0;
      // Internal lanes bow; everything else keeps the control at the midpoint
      // (straight). bowKey is set only when a lane should arc.
      let bowKey: string | null = null;
      switch (lane.kind) {
        case 'internal': {
          const a = this.anchor(lane.srcBodyId);
          const b = this.anchor(lane.dstBodyId);
          if (!a || !b) continue;
          ax = a.cx; ay = a.cy; aR = a.r;
          bx = b.cx; by = b.cy; bR = b.r;
          bowKey = `${lane.srcBodyId}->${lane.dstBodyId}`;
          break;
        }
        case 'outgoing': {
          const a = this.anchor(lane.srcBodyId);
          if (!a) continue;
          ax = a.cx; ay = a.cy; aR = a.r; bx = a.cx; by = offTop;
          break;
        }
        case 'incoming': {
          const b = this.anchor(lane.dstBodyId);
          if (!b) continue;
          ax = b.cx; ay = offTop; bx = b.cx; by = b.cy; bR = b.r;
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
      // Control point: chord midpoint, pushed perpendicular by the cached bow for
      // arced lanes. perp(chord) = (-dy, dx); offsetting by f·perp lands the
      // control at midpoint ± f·length away (the rendered apex is half of that).
      let cx = (ax + bx) / 2, cy = (ay + by) / 2;
      if (bowKey !== null) {
        const f = this.bowFor(bowKey);
        cx += -(by - ay) * f;
        cy += (bx - ax) * f;
      }
      const ratePerSec = clamp(lane.amountMilli * SHIP_RATE_PER_MILLI, SHIP_RATE_MIN_PER_LANE, SHIP_RATE_MAX_PER_LANE);
      this.resolved.push({ ax, ay, aR, bx, by, bR, cx, cy, length, ratePerSec, emitAccum: 0 });
    }
  }

  // Signed bow fraction for an ordered body-pair, cached so all its dots share
  // one arc. Magnitude in [MIN, MAX], sign a coin flip — opposite-direction
  // lanes (which produce a different key) bow independently.
  private bowFor(key: string): number {
    let v = this.arcBow.get(key);
    if (v === undefined) {
      const mag = SHIP_ARC_BOW_MIN + Math.random() * (SHIP_ARC_BOW_MAX - SHIP_ARC_BOW_MIN);
      v = Math.random() < 0.5 ? -mag : mag;
      this.arcBow.set(key, v);
    }
    return v;
  }

  private anchor(bodyId: string): BodyCenter | undefined {
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
        // Scatter each end across its body disc (uniform-in-area: r = R·√u). An
        // off-screen end has R=0, so it pins to the exact chord endpoint.
        const aRad = lane.aR * Math.sqrt(Math.random());
        const aAng = Math.random() * TAU;
        const adx = aRad * Math.cos(aAng), ady = aRad * Math.sin(aAng);
        const bRad = lane.bR * Math.sqrt(Math.random());
        const bAng = Math.random() * TAU;
        const bdx = bRad * Math.cos(bAng), bdy = bRad * Math.sin(bAng);
        const p0x = lane.ax + adx, p0y = lane.ay + ady;
        const p2x = lane.bx + bdx, p2y = lane.by + bdy;
        this.dAx[s] = p0x; this.dAy[s] = p0y;
        this.dBx[s] = p2x; this.dBy[s] = p2y;
        // Translate the control by the average end-jitter so the whole curve
        // shifts with its endpoints — every dot stays a near-parallel copy of the
        // lane arc instead of fanning back to one shared apex.
        this.dCx[s] = lane.cx + (adx + bdx) * 0.5;
        this.dCy[s] = lane.cy + (ady + bdy) * 0.5;
        // Chord length paces t (floored at 1px so a near-coincident pair can't
        // divide-by-tiny and teleport); the arc is a touch longer, so bowed dots
        // travel marginally faster than SHIP_SPEED — imperceptible.
        this.dLen[s] = Math.max(Math.hypot(p2x - p0x, p2y - p0y), 1); this.dT[s] = 0;
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
          this.dCx[i] = this.dCx[last]!; this.dCy[i] = this.dCy[last]!;
          this.dBx[i] = this.dBx[last]!; this.dBy[i] = this.dBy[last]!;
          this.dLen[i] = this.dLen[last]!; this.dT[i] = this.dT[last]!;
        }
        continue; // reprocess the swapped-in dot at slot i
      }
      // Quadratic Bézier P(t) = u²·A + 2ut·C + t²·B (u = 1−t). C at the chord
      // midpoint collapses this to the straight A→B segment.
      const u = 1 - t;
      const w0 = u * u, w1 = 2 * u * t, w2 = t * t;
      this.pos[i * 3 + 0] = snapPx(w0 * this.dAx[i]! + w1 * this.dCx[i]! + w2 * this.dBx[i]!);
      this.pos[i * 3 + 1] = snapPx(w0 * this.dAy[i]! + w1 * this.dCy[i]! + w2 * this.dBy[i]!);
      this.pos[i * 3 + 2] = Z_SHIP;
      // Scale the per-frame advance by the ease profile so the dot crawls out of
      // the source, cruises the middle at full speed, and settles into the dest.
      this.dT[i] = t + step * easeSpeed(t) / this.dLen[i]!;
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

// Speed multiplier at path-fraction t — the trapezoidal velocity profile (see
// SHIP_EASE_* in constants). FLOOR..1 over the first RAMP (accelerate), flat 1
// through the cruise middle, 1..FLOOR over the last RAMP (decelerate), each ramp
// smoothstep-shaped. Floored above 0 so a dot near the ends keeps inching toward
// the despawn at t≥1 rather than stalling.
function easeSpeed(t: number): number {
  let ramp: number;
  if (t < SHIP_EASE_RAMP) ramp = t / SHIP_EASE_RAMP;
  else if (t > 1 - SHIP_EASE_RAMP) ramp = (1 - t) / SHIP_EASE_RAMP;
  else return 1;
  const s = ramp * ramp * (3 - 2 * ramp); // smoothstep
  return SHIP_EASE_FLOOR + (1 - SHIP_EASE_FLOOR) * s;
}
