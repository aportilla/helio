// Ships layer — animated "cargo ship" dots (SHIP_SIZE_PX square) over the system
// diagram, the FIRST time-driven element in this otherwise-static view. Each lane the
// EconomyBridge reports (internal / outgoing / incoming / through) becomes a
// steady emitter: dots spawn at the lane's A end, march to B along a quadratic
// Bézier under a constant-acceleration motion profile (ramp up to cruise over a
// standard wall-clock duration, hold, ramp down — short hops peak below cruise; see
// update()), and despawn at B. A ramp only anchors at a BODY end, so a ship bound
// off-system accelerates the whole way out and an arriving one brakes the whole way
// in. Emission RATE scales with the lane's live in-flight cargo volume, so a busy
// lane reads as a denser stream.
// Through those two ease ramps a dot also trails a short yellow EXHAUST flame (a
// second in-place snapped-line pool) — behind it while accelerating, out the front
// while braking — dark through the cruise middle.
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

import { BufferAttribute, BufferGeometry, DynamicDrawUsage, LineSegments, Points } from 'three';
import type { Scene, ShaderMaterial } from 'three';
import { indexOfBodyId } from '../../../data/stars';
import { snappedDotsMat, snappedLineMat, unregisterSnappedMaterial } from '../../materials';
import { disableCulling } from '../geom/cull';
import { snapPx } from '../geom/snap';
import {
  RENDER_ORDER_SHIP, RENDER_ORDER_SHIP_THRUST, SHIP_ACCEL_SEC, SHIP_ARC_BOW_MAX, SHIP_ARC_BOW_MIN,
  SHIP_COLOR, SHIP_CROSS_SCREEN_SEC, SHIP_EASE_FLOOR, SHIP_MAX_TICK_DT_MS, SHIP_OFFSCREEN_MARGIN,
  SHIP_POOL_CAP, SHIP_RATE_MAX_PER_LANE, SHIP_RATE_MIN_PER_LANE, SHIP_RATE_PER_MILLI, SHIP_SIZE_PX,
  SHIP_SPEED_VARIANCE, SHIP_THRUST_COLOR, SHIP_THRUST_LEN_PX, SHIP_TRANSIT_FROM_TOP, Z_SHIP,
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

  // Thrust burns — a second, in-place-rewritten pool (same by-reference
  // BufferAttribute pattern as `pos`). One 2-vertex segment per ship that is in an
  // ease ramp this frame (accelerating out of the source / braking into the dest);
  // cruising ships contribute none. Capacity is the whole dot pool (every dot
  // could be ramping at once). Lit yellow, snapped, layered just under the dots.
  private readonly thrustGeometry: BufferGeometry;
  private readonly thrustMaterial: ShaderMaterial;
  private readonly thrustLines: LineSegments;
  private readonly thrustPosAttr: BufferAttribute;
  private readonly thrustPos: Float32Array;
  private lastThrustSegs = 0;

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

    // Thrust burns: 2 vertices per segment, capacity = the whole dot pool. Match
    // the DOTS' compositing exactly — TRANSPARENT + depthTest:false — so the burn
    // lands in the same render pass as the (transparent) body discs and the dots,
    // where renderOrder actually orders it: a notch UNDER the dots (so the dot
    // covers the burn's tip pixel) but OVER the discs. An OPAQUE line would render
    // in the opaque pass, BEFORE every transparent disc, and so vanish behind each
    // body it crosses — exactly where the accel/brake flames live.
    this.thrustPos = new Float32Array(SHIP_POOL_CAP * 2 * 3);
    this.thrustPosAttr = new BufferAttribute(this.thrustPos, 3);
    this.thrustPosAttr.setUsage(DynamicDrawUsage);
    this.thrustGeometry = new BufferGeometry();
    this.thrustGeometry.setAttribute('position', this.thrustPosAttr);
    this.thrustGeometry.setDrawRange(0, 0);
    this.thrustMaterial = snappedLineMat({ color: SHIP_THRUST_COLOR });
    this.thrustMaterial.depthTest = false;
    this.thrustLines = new LineSegments(this.thrustGeometry, this.thrustMaterial);
    this.thrustLines.renderOrder = RENDER_ORDER_SHIP_THRUST;
    disableCulling(this.thrustLines);
    scene.add(this.thrustLines);
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
    let thrustSegs = 0; // burn segments written this frame (2 vertices each)
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
      const sx = snapPx(w0 * p0x + w1 * cx + w2 * p2x);
      const sy = snapPx(w0 * p0y + w1 * cy + w2 * p2y);
      this.pos[i * 3 + 0] = sx;
      this.pos[i * 3 + 1] = sy;
      this.pos[i * 3 + 2] = Z_SHIP;

      // Motion profile: constant-acceleration ramps of a STANDARD DURATION (time,
      // not a path fraction), so reaching cruise always takes SHIP_ACCEL_SEC and a
      // short hop just peaks at its midpoint rather than snapping to full speed. A
      // ramp anchored at a BODY end pulls the speed to ~rest there; an OFF-SCREEN
      // end imposes none — so a ship LEAVING the system accelerates the whole way
      // out and one ARRIVING decelerates the whole way in (no brake/launch against
      // a virtual point at the screen edge). Distances normalized by content width
      // keep the pace window-size-independent; dSpeed carries the per-ship
      // ±variance. Chord floored at 1px so a near-coincident pair can't divide-by-tiny.
      const chord = Math.max(Math.hypot(p2x - p0x, p2y - p0y), 1);
      const dn = chord / this.contentW;                   // journey length, screen widths
      const vc = this.dSpeed[i]! / SHIP_CROSS_SCREEN_SEC;  // cruise speed, widths/sec
      const accel = vc / SHIP_ACCEL_SEC;                   // a = cruise / T_accel
      const dist = t * dn;                                 // distance covered so far
      const vAccel = Math.sqrt(2 * accel * dist);                    // ramp up from the source body
      const vDecel = Math.sqrt(2 * accel * Math.max(dn - dist, 0));  // ramp down into the dest body
      // Pick the speed + exhaust direction by lane kind. dir is the burn: −1 trails
      // behind (accelerating), +1 streams out the front (braking), 0 = dark (cruise).
      let v: number;
      let dir: number;
      switch (kind) {
        case KIND_OUTGOING:                  // body → deep space: accelerate the whole way out
          v = vAccel; dir = -1; break;
        case KIND_INCOMING:                  // deep space → body: decelerate the whole way in
          v = vDecel; dir = 1; break;
        case KIND_THROUGH_LTR:
        case KIND_THROUGH_RTL:               // relay traffic: cruise straight across, no burn
          v = vc; dir = 0; break;
        default: {                           // internal body → body: accel · cruise · decel
          v = Math.min(vc, vAccel, vDecel);
          const accelDist = Math.min(vc * SHIP_ACCEL_SEC * 0.5, dn * 0.5);
          dir = dist < accelDist ? -1 : dist > dn - accelDist ? 1 : 0;
        }
      }
      const vFloor = vc * SHIP_EASE_FLOOR;                 // crawl floor — never a dead stop
      if (v < vFloor) v = vFloor;

      // Exhaust burn: a short line off the dot along ±the unit Bézier tangent
      // P'(t) = 2(1−t)(C−A) + 2t(B−C), signed by dir above — trailing behind while
      // accelerating, out the front while braking, dark at cruise.
      if (dir !== 0) {
        const gx = 2 * (1 - t) * (cx - p0x) + 2 * t * (p2x - cx);
        const gy = 2 * (1 - t) * (cy - p0y) + 2 * t * (p2y - cy);
        const gl = Math.hypot(gx, gy);
        if (gl > 1e-4) {
          const k = (dir * SHIP_THRUST_LEN_PX) / gl; // scale tangent to the burn length
          const b = thrustSegs * 6;
          this.thrustPos[b + 0] = sx; this.thrustPos[b + 1] = sy; this.thrustPos[b + 2] = Z_SHIP;
          this.thrustPos[b + 3] = sx + gx * k; this.thrustPos[b + 4] = sy + gy * k; this.thrustPos[b + 5] = Z_SHIP;
          thrustSegs++;
        }
      }

      // Advance the path fraction by the profiled speed: the normalized distance
      // step v·dt equals dn·Δt, so Δt = v·dt / dn.
      this.dT[i] = t + (v / dn) * dt;
      i++;
    }

    // Re-upload only when something actually changed: live dots advanced, or the
    // draw range shrank because dots despawned. An idle frame (lanes exist but no
    // dots in flight) touches nothing.
    if (this.liveCount > 0 || this.liveCount !== startCount) {
      this.posAttr.needsUpdate = true;
      this.geometry.setDrawRange(0, this.liveCount);
    }

    // Burns: re-upload when any are lit, or when the count dropped to 0 so the
    // draw range shrinks and last frame's flares clear.
    if (thrustSegs > 0 || thrustSegs !== this.lastThrustSegs) {
      this.thrustPosAttr.needsUpdate = true;
      this.thrustGeometry.setDrawRange(0, thrustSegs * 2);
    }
    this.lastThrustSegs = thrustSegs;
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
    // Drop the materials from the snapped-viewport registry before freeing them,
    // so the next scene's resize doesn't re-touch a dead GPU handle.
    unregisterSnappedMaterial(this.material);
    unregisterSnappedMaterial(this.thrustMaterial);
    this.geometry.dispose();
    this.material.dispose();
    this.thrustGeometry.dispose();
    this.thrustMaterial.dispose();
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
