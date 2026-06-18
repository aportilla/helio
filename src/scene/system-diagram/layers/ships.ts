// Ships layer — animated "cargo ship" dots (SHIP_SIZE_PX square) over the system
// diagram, the FIRST time-driven element in this otherwise-static view. Each lane the
// EconomyBridge reports (internal / outgoing / incoming / through) becomes a
// steady emitter: dots spawn at the lane's A end, march to B along a quadratic
// Bézier on a trapezoidal ease (accelerate out of the source, cruise, settle into
// the destination — see easeSpeed), and despawn at B. Emission RATE scales with the
// lane's live in-flight cargo volume, so a busy lane reads as a denser stream.
//
// Body-to-body (internal) lanes bow into an ARC — the control point is offset
// perpendicular to the chord, signed-random per ordered body-pair and cached so
// the lane's dots form a coherent bundle. Endpoints SCATTER per dot: each ship
// picks its OWN random point within the source disc to leave from and within the
// destination disc to arrive at, so no two ships trace quite the same arc (the
// off-screen ends of outgoing/incoming/through have no disc and stay put).
//
// Positions are integrated on the CPU and rewritten in place into one
// pre-allocated DynamicDrawUsage pool (the droplines.ts zero-alloc pattern) — no
// per-frame allocation, no GPU clock. A live dot stores only its journey PROGRESS
// (t ∈ [0,1]) and its endpoint IDENTITIES (which bodies / which screen edges) plus
// its per-end scatter as a fraction of the disc radius — never absolute
// coordinates. Every frame it RE-DERIVES its arc from the live body layout, so a
// resize moves the bodies and the dots follow automatically (each keeping its own
// scattered endpoints), and a mid-turn setFlows() never re-aims a dot already in
// flight (its t + endpoints are untouched). Travel is screen-normalized: crossing
// the full content width always takes SHIP_CROSS_SCREEN_SEC, so a dot's wall-clock
// journey time is the same on any window size (px/sec auto-scales with the
// viewport).

import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Points } from 'three';
import type { Scene, ShaderMaterial } from 'three';
import { indexOfBodyId } from '../../../data/stars';
import { snappedDotsMat, unregisterSnappedMaterial } from '../../materials';
import { disableCulling } from '../geom/cull';
import { snapPx } from '../geom/snap';
import {
  RENDER_ORDER_SHIP, SHIP_ARC_BOW_MAX, SHIP_ARC_BOW_MIN, SHIP_COLOR, SHIP_CROSS_SCREEN_SEC,
  SHIP_EASE_FLOOR, SHIP_EASE_RAMP, SHIP_MAX_TICK_DT_MS, SHIP_OFFSCREEN_MARGIN, SHIP_POOL_CAP,
  SHIP_RATE_MAX_PER_LANE, SHIP_RATE_MIN_PER_LANE, SHIP_RATE_PER_MILLI, SHIP_SIZE_PX,
  SHIP_SPEED_VARIANCE, SHIP_TRANSIT_FROM_TOP, Z_SHIP,
} from '../layout/constants';
import type { BodyCenterIndex } from '../types';
import type { ShipLane } from '../../../facilities/economy-bridge';

const TAU = Math.PI * 2;

// How a dot sources its two endpoints from the live layout (stored per dot in
// dKind). INTERNAL rides between two bodies; OUTGOING / INCOMING pair one body
// end with an off-the-top point whose X tracks that body; THROUGH_* sweep
// edge-to-edge across the transit band. Plain int consts (not an enum) so the
// hot loop compares integers and the values store straight into an Int8Array.
const KIND_INTERNAL = 0;
const KIND_OUTGOING = 1;
const KIND_INCOMING = 2;
const KIND_THROUGH_LTR = 3;
const KIND_THROUGH_RTL = 4;

// A lane resolved to its endpoint IDENTITIES + emission rate, ready to spawn dots.
// No screen coordinates live here — they're re-derived per frame from the live
// layout (see update), so one ResolvedLane stays correct across a resize. srcIdx /
// dstIdx are catalog body indices (−1 for an off-screen end). bow is the signed
// arc offset shared by the lane's dots (0 for straight lanes). emitAccum carries
// the fractional dot between frames.
interface ResolvedLane {
  kind: number;
  srcIdx: number;
  dstIdx: number;
  bow: number;
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

  // Per-live-dot SoA, parallel to pool slots [0, liveCount). A dot stores its
  // journey progress + the IDENTITY of its endpoints (a kind, plus a body catalog
  // index per body end) + its per-end scatter + its arc bow — NEVER absolute
  // coordinates. update() re-derives the arc from the live layout each frame, so
  // dots track moving bodies across a resize.
  private readonly dKind = new Int8Array(SHIP_POOL_CAP);
  private readonly dSrc = new Int32Array(SHIP_POOL_CAP);
  private readonly dDst = new Int32Array(SHIP_POOL_CAP);
  // Each dot's own scatter offset at each end, as a vector in units of the disc
  // radius (uniform-in-area: magnitude √u). Multiplied by the current disc radius
  // per frame, so the random emit/arrive point both differs per ship AND tracks
  // the disc if it resizes. An off-screen end has radius 0 → no offset.
  private readonly dAux = new Float32Array(SHIP_POOL_CAP);
  private readonly dAuy = new Float32Array(SHIP_POOL_CAP);
  private readonly dBux = new Float32Array(SHIP_POOL_CAP);
  private readonly dBuy = new Float32Array(SHIP_POOL_CAP);
  private readonly dBow = new Float32Array(SHIP_POOL_CAP);
  // Per-ship cruise multiplier, rolled once at spawn (see SHIP_SPEED_VARIANCE), so
  // ships travel at slightly different speeds rather than in lockstep.
  private readonly dSpeed = new Float32Array(SHIP_POOL_CAP);
  private readonly dT = new Float32Array(SHIP_POOL_CAP);
  private liveCount = 0;

  // Per ordered body-pair arc bow (signed control-offset fraction of the chord),
  // cached so every dot between two bodies shares one curvature. Ephemeral render
  // state — filled lazily with Math.random(), not procedurally stable.
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
  // SystemDiagram.layout on construction + every resize. In-flight dots aren't
  // touched — they re-derive their arc from these new centers on the next frame,
  // so they smoothly track the bodies to their new positions.
  setLayout(centers: BodyCenterIndex, contentW: number, bufferH: number): void {
    this.centers = centers;
    this.contentW = contentW;
    this.bufferH = bufferH;
    this.resolve();
  }

  // Replace the per-turn lane schedule (from EconomyBridge.clusterFlows). Resets
  // emission accumulators; in-flight dots keep their progress + endpoints and
  // finish their journey.
  setFlows(lanes: readonly ShipLane[]): void {
    this.rawLanes = lanes;
    this.resolve();
  }

  // Resolve raw lanes to endpoint IDENTITIES + an emission rate against the
  // current layout. A lane whose in-system body has no published center is
  // dropped. emitAccum restarts at 0 — a re-resolve is rare (turn boundary or
  // resize), so the sub-one-dot priming delay is imperceptible. No coordinates are
  // computed here; update() derives them per frame from the live centers.
  private resolve(): void {
    this.resolved = [];
    const centers = this.centers;
    if (!centers || this.contentW <= 0 || this.bufferH <= 0) return;
    for (const lane of this.rawLanes) {
      switch (lane.kind) {
        case 'internal': {
          const s = indexOfBodyId(lane.srcBodyId);
          const d = indexOfBodyId(lane.dstBodyId);
          if (s < 0 || d < 0 || !centers.has(s) || !centers.has(d)) continue;
          this.resolved.push({
            kind: KIND_INTERNAL, srcIdx: s, dstIdx: d,
            bow: this.bowFor(`${lane.srcBodyId}->${lane.dstBodyId}`),
            ratePerSec: rateFor(lane.amountMilli), emitAccum: 0,
          });
          break;
        }
        case 'outgoing': {
          const s = indexOfBodyId(lane.srcBodyId);
          if (s < 0 || !centers.has(s)) continue;
          this.resolved.push({ kind: KIND_OUTGOING, srcIdx: s, dstIdx: -1, bow: 0, ratePerSec: rateFor(lane.amountMilli), emitAccum: 0 });
          break;
        }
        case 'incoming': {
          const d = indexOfBodyId(lane.dstBodyId);
          if (d < 0 || !centers.has(d)) continue;
          this.resolved.push({ kind: KIND_INCOMING, srcIdx: -1, dstIdx: d, bow: 0, ratePerSec: rateFor(lane.amountMilli), emitAccum: 0 });
          break;
        }
        case 'through': {
          // A full-width horizontal sweep at the transit band. v1 keys motion on
          // direction only, so two relay corridors of the same dir draw as
          // superimposed streams (amounts stay separate, so density is additive).
          // Separating them spatially is the deferred bearing upgrade.
          this.resolved.push({
            kind: lane.dir === 'ltr' ? KIND_THROUGH_LTR : KIND_THROUGH_RTL,
            srcIdx: -1, dstIdx: -1, bow: 0, ratePerSec: rateFor(lane.amountMilli), emitAccum: 0,
          });
          break;
        }
      }
    }
  }

  // Signed bow fraction for an ordered body-pair, cached so all its dots share
  // one curvature. Magnitude in [MIN, MAX], sign a coin flip — opposite-direction
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

  // Per-frame: spawn at each lane's rate, then re-derive + advance every live dot.
  // dt is clamped (SHIP_MAX_TICK_DT_MS) so a resumed background tab doesn't dump a
  // burst of spawns or teleport in-flight dots.
  update(now: number): void {
    const dt = this.lastNow < 0 ? 0 : Math.min(now - this.lastNow, SHIP_MAX_TICK_DT_MS) / 1000;
    this.lastNow = now;
    if (this.liveCount === 0 && this.resolved.length === 0) return;
    // Nothing moves on a zero-dt frame (the first frame, or a duplicate
    // timestamp) and the buffer is already current — skip the work so this
    // formerly-static view pays no idle per-frame GPU re-upload.
    if (dt <= 0) return;

    const startCount = this.liveCount;

    // Spawn at each lane's rate. A dot captures only its lane's identity + a
    // random per-end scatter; its screen position is derived below, never stored.
    for (const lane of this.resolved) {
      lane.emitAccum += lane.ratePerSec * dt;
      while (lane.emitAccum >= 1) {
        // Pool full: keep ONE dot pending (clamp, don't zero) so a busy lane
        // resumes at full rate the instant a slot frees — zeroing would re-prime
        // it from scratch and bias the busiest traffic's density DOWN.
        if (this.liveCount >= SHIP_POOL_CAP) { lane.emitAccum = Math.min(lane.emitAccum, 1); break; }
        lane.emitAccum -= 1;
        const s = this.liveCount++;
        this.dKind[s] = lane.kind;
        this.dSrc[s] = lane.srcIdx;
        this.dDst[s] = lane.dstIdx;
        this.dBow[s] = lane.bow;
        // This ship's own emit/arrive points: uniform-in-area scatter (r = R·√u),
        // stored as a fraction-of-radius vector so each ship's arc differs AND the
        // points track the disc if it resizes.
        const aFrac = Math.sqrt(Math.random()), aAng = Math.random() * TAU;
        this.dAux[s] = aFrac * Math.cos(aAng); this.dAuy[s] = aFrac * Math.sin(aAng);
        const bFrac = Math.sqrt(Math.random()), bAng = Math.random() * TAU;
        this.dBux[s] = bFrac * Math.cos(bAng); this.dBuy[s] = bFrac * Math.sin(bAng);
        // Fixed random cruise multiplier in [1 − V/2, 1 + V/2], centered on 1.
        this.dSpeed[s] = 1 + (Math.random() - 0.5) * SHIP_SPEED_VARIANCE;
        this.dT[s] = 0;
      }
    }

    // Live screen bounds for the off-body endpoints (re-read every frame so a
    // resize moves them with the viewport).
    const centers = this.centers;
    const offTop = this.bufferH + SHIP_OFFSCREEN_MARGIN;
    const transitY = this.bufferH - SHIP_TRANSIT_FROM_TOP;
    const leftX = -SHIP_OFFSCREEN_MARGIN;
    const rightX = this.contentW + SHIP_OFFSCREEN_MARGIN;

    // Render-then-advance: draw each dot at its CURRENT t (re-derived from the live
    // layout), then advance it for the next frame — so a freshly spawned dot (t=0)
    // renders at A before moving. Despawn fires once t reaches B (swap-remove), so
    // a dot's last drawn position is a fraction short of B, hidden inside the
    // destination disc (internal/incoming) or off-screen past the margin.
    let i = 0;
    while (i < this.liveCount) {
      const t = this.dT[i]!;
      if (t >= 1) { this.swapRemove(i); continue; }

      // Re-derive this frame's endpoints from the live layout. A body end whose
      // center has vanished (shouldn't happen for an in-cluster body) drops the
      // dot rather than rendering it at a stale spot.
      const kind = this.dKind[i]!;
      let ax = 0, ay = 0, aR = 0, bx = 0, by = 0, bR = 0;
      if (kind === KIND_INTERNAL || kind === KIND_OUTGOING) {
        const A = centers?.get(this.dSrc[i]!);
        if (!A) { this.swapRemove(i); continue; }
        ax = A.cx; ay = A.cy; aR = A.r;
      }
      if (kind === KIND_INTERNAL || kind === KIND_INCOMING) {
        const B = centers?.get(this.dDst[i]!);
        if (!B) { this.swapRemove(i); continue; }
        bx = B.cx; by = B.cy; bR = B.r;
      }
      if (kind === KIND_OUTGOING) { bx = ax; by = offTop; }            // up off the top from the source
      else if (kind === KIND_INCOMING) { ax = bx; ay = offTop; }       // down from the top into the dest
      else if (kind === KIND_THROUGH_LTR) { ax = leftX; ay = transitY; bx = rightX; by = transitY; }
      else if (kind === KIND_THROUGH_RTL) { ax = rightX; ay = transitY; bx = leftX; by = transitY; }

      // Per-end scatter (this ship's fraction-of-radius vector × current disc
      // radius; 0 at an off-screen end).
      const adx = aR * this.dAux[i]!, ady = aR * this.dAuy[i]!;
      const bdx = bR * this.dBux[i]!, bdy = bR * this.dBuy[i]!;
      const p0x = ax + adx, p0y = ay + ady;
      const p2x = bx + bdx, p2y = by + bdy;
      // Control: chord midpoint, pushed perpendicular by the cached bow, then
      // shifted by the average end-jitter so the whole arc tracks its scattered
      // endpoints. perp(chord) = (−dy, dx); bow 0 collapses the Bézier to the
      // straight chord.
      let cx = (ax + bx) / 2, cy = (ay + by) / 2;
      const bow = this.dBow[i]!;
      if (bow !== 0) { cx += -(by - ay) * bow; cy += (bx - ax) * bow; }
      cx += (adx + bdx) * 0.5; cy += (ady + bdy) * 0.5;

      // Quadratic Bézier P(t) = u²·A + 2ut·C + t²·B (u = 1−t).
      const u = 1 - t;
      const w0 = u * u, w1 = 2 * u * t, w2 = t * t;
      this.pos[i * 3 + 0] = snapPx(w0 * p0x + w1 * cx + w2 * p2x);
      this.pos[i * 3 + 1] = snapPx(w0 * p0y + w1 * cy + w2 * p2y);
      this.pos[i * 3 + 2] = Z_SHIP;

      // Advance t at a SCREEN-NORMALIZED pace: a chord spanning the full content
      // width crosses in SHIP_CROSS_SCREEN_SEC, shorter chords in proportion, so
      // the wall-clock journey is window-size-independent (px/sec scales with the
      // viewport). The ease shapes the velocity within that. Chord floored at 1px
      // so a near-coincident pair can't divide-by-tiny and teleport.
      const chord = Math.max(Math.hypot(p2x - p0x, p2y - p0y), 1);
      this.dT[i] = t + (this.contentW / (SHIP_CROSS_SCREEN_SEC * chord)) * easeSpeed(t) * this.dSpeed[i]! * dt;
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

  // Despawn the dot at slot i: move the last live dot into i and shrink. The
  // caller re-processes slot i (it now holds a different, not-yet-seen dot).
  private swapRemove(i: number): void {
    const last = --this.liveCount;
    if (i === last) return;
    this.dKind[i] = this.dKind[last]!;
    this.dSrc[i] = this.dSrc[last]!;
    this.dDst[i] = this.dDst[last]!;
    this.dAux[i] = this.dAux[last]!; this.dAuy[i] = this.dAuy[last]!;
    this.dBux[i] = this.dBux[last]!; this.dBuy[i] = this.dBuy[last]!;
    this.dBow[i] = this.dBow[last]!;
    this.dSpeed[i] = this.dSpeed[last]!;
    this.dT[i] = this.dT[last]!;
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

// A lane's emission rate (dots/sec) from its live shipped volume, clamped so a
// small flow still reads as a steady trickle and a glut can't swamp the pool.
function rateFor(amountMilli: number): number {
  return clamp(amountMilli * SHIP_RATE_PER_MILLI, SHIP_RATE_MIN_PER_LANE, SHIP_RATE_MAX_PER_LANE);
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
