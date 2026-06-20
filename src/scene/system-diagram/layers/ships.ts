// Ships layer — animated "cargo ship" dots (per-ship 1–3px square, see
// SHIP_SIZE_PX_WEIGHTS) over the system diagram, the FIRST time-driven element in this
// otherwise-static view. Each lane the
// EconomyBridge reports (internal / outgoing / incoming / through) becomes a
// steady emitter: dots spawn at the lane's A end, march to B along a quadratic
// Bézier under a constant-acceleration motion profile (ramp up to cruise over a
// standard wall-clock duration, hold, ramp down — short hops peak below cruise; the
// profile lives in ship-profile.ts), and despawn at B. A ramp only anchors at a BODY
// end, so a ship bound off-system accelerates the whole way out and an arriving one
// brakes the whole way in. INTERNAL (body→body) lanes are the intra-system reallocation
// the economy resolves instantly on Next Turn — sourced from the speculative dispatch
// plan's same-cluster moves, not the in-flight transfer ring (which carries only the
// inter-cluster outgoing/incoming/through cargo). Emission RATE scales with the
// lane's shipped volume (the speculative next-turn lanes SystemScene feeds in), so
// a busy lane reads as a denser stream. Each dot also rolls its OWN appearance at
// spawn (see rollAppearance) — a metallic-sheen color (random hue, low saturation,
// high lightness; SHIP_COLOR_* band) and a weighted 1–3px size (smaller hulls more
// common; SHIP_SIZE_PX_WEIGHTS) — so a stream reads as individually-hulled ships of
// mixed size, not one uniform substance.
// Through those two ease ramps a dot also trails a short yellow EXHAUST flame (a
// second in-place snapped-line pool) — behind it while accelerating, out the front
// while braking — dark through the cruise middle; a 1px hull gets a stubby 1px flame.
//
// Body-to-body (internal) lanes bow into an ARC — the control point is offset
// perpendicular to the chord, signed and sized deterministically from the ordered
// body-pair key (seeded hash, so the same pair bows the same way every load) and
// cached so the lane's dots form a coherent bundle. Endpoints SCATTER per dot: each ship
// picks its OWN random point within the source disc to leave from and within the
// destination disc to arrive at, so no two ships trace quite the same arc (the
// off-screen ends of outgoing/incoming/through have no disc and stay put).
//
// Positions are computed on the CPU and rewritten in place into one pre-allocated
// DynamicDrawUsage pool (the droplines.ts zero-alloc pattern) — no per-frame
// allocation, no GPU clock. A live dot stores only its NORMALIZED JOURNEY TIME
// (τ ∈ [0,1]) and its endpoint IDENTITIES (which bodies / which screen edges) plus
// its per-end scatter as a fraction of the disc radius — never absolute coordinates.
// Every frame it maps τ → arc position through the shared motion profile (ship-profile.ts)
// and RE-DERIVES the arc from the live body layout, so a resize moves the bodies and the
// dots follow automatically (each keeping its own scattered endpoints), and a mid-turn
// setFlows() never re-aims a dot already in flight (its τ + endpoints are untouched). The
// motion (τ) only ADVANCES on a fixed SHIP_UPDATE_INTERVAL_MS cadence — slow sub-pixel
// motion snapped every frame shimmers at uneven moments, so dots step on a regular beat.
// Storing TIME (not arc position) is what lets prime() open the view already at steady
// state from a uniform random τ spread (see prime()). Travel is screen-normalized:
// crossing the full content width always takes SHIP_CROSS_SCREEN_SEC, so a dot's
// wall-clock journey time is the same on any window size (px/sec auto-scales with the
// viewport).

import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, LineSegments, Points } from 'three';
import type { Scene, ShaderMaterial } from 'three';
import { indexOfBodyId } from '../../../data/stars';
import { snappedDotsMat, snappedLineMat, unregisterSnappedMaterial } from '../../materials';
import { disableCulling } from '../geom/cull';
import { snapPx } from '../geom/snap';
import { hash32, mulberry32 } from '../geom/prng';
import {
  RENDER_ORDER_SHIP, RENDER_ORDER_SHIP_THRUST, SHIP_ARC_BOW_DOWN_SCALE, SHIP_ARC_BOW_MAX, SHIP_ARC_BOW_MIN,
  SHIP_COLOR_HUE_MAX, SHIP_COLOR_HUE_MIN, SHIP_COLOR_LIGHT_MAX, SHIP_COLOR_LIGHT_MIN,
  SHIP_COLOR_SAT_MAX, SHIP_COLOR_SAT_MIN, SHIP_CROSS_SCREEN_SEC, SHIP_OFFSCREEN_MARGIN,
  SHIP_POOL_CAP, SHIP_RATE_MAX_PER_LANE, SHIP_RATE_MIN_PER_LANE, SHIP_RATE_PER_MILLI,
  SHIP_SIZE_PX_WEIGHTS,
  SHIP_SPEED_VARIANCE, SHIP_THRUST_COLOR, SHIP_THRUST_LEN_PX, SHIP_TRANSIT_FROM_TOP, SHIP_UPDATE_INTERVAL_MS, Z_SHIP,
} from '../layout/constants';
import {
  journeyTime, sampleProfile,
  KIND_INTERNAL, KIND_OUTGOING, KIND_INCOMING, KIND_THROUGH_LTR, KIND_THROUGH_RTL,
} from './ship-profile';
import type { ProfileSample } from './ship-profile';
import type { BodyCenterIndex } from '../types';
import type { ShipLane } from '../../../facilities/economy-bridge';

const TAU = Math.PI * 2;

// Sum of the per-ship size weights, precomputed once for the weighted roll (rollSize).
const SHIP_SIZE_WEIGHT_TOTAL = SHIP_SIZE_PX_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

// A lane resolved to its endpoint IDENTITIES + emission rate, ready to spawn dots.
// No screen coordinates live here — they're re-derived per frame from the live
// layout (see renderFrame), so one ResolvedLane stays correct across a resize. srcIdx /
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

  // Per-dot APPEARANCE, parallel to `pos`: packed RGB color (3 floats/slot) + point
  // size (1 float/slot). Each ship rolls both once at spawn (rollAppearance) and holds
  // them for its whole journey — so unlike `pos` (recomputed every frame from τ) these
  // buffers are written only when the live set changes (spawn / swap-remove).
  // `attrsDirty` gates the re-upload: an in-flight frame that just advances τ leaves
  // them untouched and skips the GPU write. Same by-reference BufferAttribute pattern as
  // `pos`. `aSize` drives gl_PointSize per dot (snappedDotsMat vertexSizes path).
  private readonly colorAttr: BufferAttribute;
  private readonly colors: Float32Array;
  private readonly sizeAttr: BufferAttribute;
  private readonly sizes: Float32Array;
  private attrsDirty = false;
  // Scratch Color reused by rollAppearance so the per-spawn HSL→RGB conversion allocates
  // nothing. ColorManagement is OFF project-wide, so setHSL's RGB lands verbatim in
  // the buffer and renders at exactly that sRGB value.
  private readonly scratchColor = new Color();

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
  // normalized journey TIME + the IDENTITY of its endpoints (a kind, plus a body
  // catalog index per body end) + its per-end scatter + its arc bow — NEVER absolute
  // coordinates. renderFrame() re-derives the arc from the live layout each frame, so
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
  // Per-ship NORMALIZED JOURNEY TIME (τ ∈ [0,1]); the arc position is derived from it
  // each frame via the shared motion profile (ship-profile.ts).
  private readonly dTau = new Float32Array(SHIP_POOL_CAP);
  private liveCount = 0;

  // Reused profile sample, so the per-frame loop allocates nothing (the scratch-on-this
  // discipline; sampleProfile mutates it in place).
  private readonly profileOut: ProfileSample = { s: 0, phase: 0, t: 0 };
  // One-shot guard for prime(): the steady-state seed runs exactly once per view, never
  // re-applied on a resize or turn boundary (which re-resolve lanes but keep live dots).
  private primed = false;

  // Per ordered body-pair arc bow (signed control-offset fraction of the chord),
  // cached so every dot between two bodies shares one curvature. Filled lazily but
  // PROCEDURALLY STABLE — the value is seeded from the pair key (see bowFor), so a
  // given pair bows the same way every load; the Map is just a per-session memo.
  private readonly arcBow = new Map<string, number>();

  // The per-turn schedule (raw lanes) + the current layout it resolves against.
  private rawLanes: readonly ShipLane[] = [];
  private centers: BodyCenterIndex | null = null;
  private contentW = 0;
  private bufferH = 0;
  private resolved: ResolvedLane[] = [];

  // Previous frame's timestamp, and wall-clock time accumulated toward the next motion
  // step. update() runs + redraws every frame, but only ADVANCES the dots once
  // tickAccum crosses SHIP_UPDATE_INTERVAL_MS — see update().
  private lastNow = -1;
  private tickAccum = 0;

  constructor(scene: Scene) {
    this.pos = new Float32Array(SHIP_POOL_CAP * 3);
    this.posAttr = new BufferAttribute(this.pos, 3);
    this.posAttr.setUsage(DynamicDrawUsage);
    this.colors = new Float32Array(SHIP_POOL_CAP * 3);
    this.colorAttr = new BufferAttribute(this.colors, 3);
    this.colorAttr.setUsage(DynamicDrawUsage);
    this.sizes = new Float32Array(SHIP_POOL_CAP);
    this.sizeAttr = new BufferAttribute(this.sizes, 1);
    this.sizeAttr.setUsage(DynamicDrawUsage);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colorAttr);
    this.geometry.setAttribute('aSize', this.sizeAttr);
    this.geometry.setDrawRange(0, 0);
    // vertexColors + vertexSizes: each dot draws its own per-ship tint (from `color`)
    // and per-ship point size (from `aSize`), both rolled at spawn, instead of one
    // shared uniform color + fixed size.
    this.material = snappedDotsMat({ vertexColors: true, vertexSizes: true });
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

  // Replace the per-turn lane schedule (from EconomyBridge.predictedClusterFlows). Resets
  // emission accumulators; in-flight dots keep their τ + endpoints and finish their
  // journey.
  setFlows(lanes: readonly ShipLane[]): void {
    this.rawLanes = lanes;
    this.resolve();
  }

  // Resolve raw lanes to endpoint IDENTITIES + an emission rate against the
  // current layout. A lane whose in-system body has no published center is
  // dropped. emitAccum restarts at 0 — a re-resolve is rare (turn boundary or
  // resize), so the sub-one-dot priming delay is imperceptible. No coordinates are
  // computed here; renderFrame() derives them per frame from the live centers.
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
  // lanes (which produce a different key) bow independently. Seeded from the pair
  // key via the diagram's hash32+mulberry32 pair (same deterministic seeding as
  // moon angles / ring tilts), so the arc is stable across reloads, not re-rolled
  // per view load.
  private bowFor(key: string): number {
    let v = this.arcBow.get(key);
    if (v === undefined) {
      const rng = mulberry32(hash32(`ship-bow:${key}`));
      const mag = SHIP_ARC_BOW_MIN + rng() * (SHIP_ARC_BOW_MAX - SHIP_ARC_BOW_MIN);
      v = rng() < 0.5 ? -mag : mag;
      this.arcBow.set(key, v);
    }
    return v;
  }

  // Per-frame: re-derive + redraw every live dot (so they always track the live layout
  // and the buffer stays current), but only ADVANCE their motion on a fixed CADENCE
  // (SHIP_UPDATE_INTERVAL_MS). Wall-clock time accumulates in tickAccum; once it crosses
  // the cadence it's released as one motion step (`stepDt`) and the dots move, otherwise
  // stepDt is 0 and they're re-derived in place at the same τ. Holding τ between beats
  // makes the slow dots step on a regular cadence instead of creeping sub-pixel and
  // snapping at uneven moments — an even, deliberate retro step rather than a shimmer.
  update(now: number): void {
    // Per-frame dt, clamped so a resumed background tab advances at most one beat
    // (2× the cadence) rather than teleporting in-flight dots through their journey.
    const rawDt = this.lastNow < 0 ? 0 : Math.min(now - this.lastNow, 2 * SHIP_UPDATE_INTERVAL_MS) / 1000;
    this.lastNow = now;
    if (this.liveCount === 0 && this.resolved.length === 0) return;

    // Release accumulated time as a single motion step only once it crosses the cadence;
    // between beats stepDt is 0 (dots re-derived in place — still tracking a resize — but
    // not moved). Resetting to 0 (not subtracting) keeps total advance == wall time, so a
    // dot's journey still takes its full SHIP_CROSS_SCREEN_SEC.
    this.tickAccum += rawDt;
    let stepDt = 0;
    if (this.tickAccum * 1000 >= SHIP_UPDATE_INTERVAL_MS) {
      stepDt = this.tickAccum;
      this.tickAccum = 0;
    }

    // Spawn at each lane's rate for this step's worth of time (0 between beats).
    for (const lane of this.resolved) {
      lane.emitAccum += lane.ratePerSec * stepDt;
      while (lane.emitAccum >= 1) {
        // Pool full: keep ONE dot pending (clamp, don't zero) so a busy lane
        // resumes at full rate the instant a slot frees — zeroing would re-prime
        // it from scratch and bias the busiest traffic's density DOWN.
        if (this.liveCount >= SHIP_POOL_CAP) { lane.emitAccum = Math.min(lane.emitAccum, 1); break; }
        lane.emitAccum -= 1;
        this.spawn(lane.kind, lane.srcIdx, lane.dstIdx, lane.bow, 0); // live emitter enters at τ=0
      }
    }

    this.renderFrame(stepDt);
  }

  // Open the view already at STEADY STATE: seed every lane with the in-flight traffic it
  // would carry once running, instead of filling from empty over a full transit time. A
  // lane that emits at `ratePerSec` and takes `T` seconds to cross carries N = ratePerSec·T
  // dots at once; at steady state their journey-time fractions are uniform, so each seeded
  // dot gets τ = random(). Counts scale down proportionally if the steady-state fleet
  // would overflow the pool (vs. spawn-order starvation). One-shot (guarded) — called once
  // from SystemScene.start after the layout + lanes resolve and BEFORE the first frame; it
  // flushes the buffer itself because update()'s first frame (dt=0) early-returns before
  // drawing.
  prime(): void {
    if (this.primed) return;
    this.primed = true;
    const centers = this.centers;
    if (!centers || this.contentW <= 0 || this.bufferH <= 0 || this.resolved.length === 0) return;

    const offTop = this.bufferH + SHIP_OFFSCREEN_MARGIN;
    const leftX = -SHIP_OFFSCREEN_MARGIN;
    const rightX = this.contentW + SHIP_OFFSCREEN_MARGIN;
    const vcMean = 1 / SHIP_CROSS_SCREEN_SEC; // cruise at the mean (dSpeed = 1)

    // Steady-state occupancy per lane (N = rate · journeyTime), using the lane's CENTER
    // chord and mean cruise. Each dot still derives its own scattered chord + speed per
    // frame; only the integer count uses the lane mean.
    const ns: number[] = [];
    let total = 0;
    for (const lane of this.resolved) {
      const chord = this.centerChord(lane, centers, offTop, leftX, rightX);
      const n = chord > 0 ? lane.ratePerSec * journeyTime(chord / this.contentW, vcMean, lane.kind) : 0;
      ns.push(n);
      total += n;
    }
    // Cap: if the steady-state fleet would overflow the pool, scale every lane down in
    // proportion so the densest lanes keep their share.
    const scale = total > SHIP_POOL_CAP ? SHIP_POOL_CAP / total : 1;

    for (let li = 0; li < this.resolved.length; li++) {
      const lane = this.resolved[li]!;
      const n = ns[li]! * scale;
      let count = Math.floor(n);
      if (Math.random() < n - count) count++; // stochastic remainder — the fractional ship
      for (let k = 0; k < count; k++) {
        if (this.liveCount >= SHIP_POOL_CAP) break;
        this.spawn(lane.kind, lane.srcIdx, lane.dstIdx, lane.bow, Math.random()); // uniform τ
      }
    }

    // Draw the seeded pool now: the first real frame (dt=0) early-returns before rendering.
    this.renderFrame(0);
  }

  // Center-to-center chord (px) for a lane's two endpoints, off-screen ends pinned to the
  // same anchors renderFrame() uses. Returns 0 if an in-system body's center is missing
  // (so prime() skips it). Used only for the steady-state COUNT — per-dot motion uses the
  // scattered chord.
  private centerChord(lane: ResolvedLane, centers: BodyCenterIndex, offTop: number, leftX: number, rightX: number): number {
    switch (lane.kind) {
      case KIND_INTERNAL: {
        const A = centers.get(lane.srcIdx);
        const B = centers.get(lane.dstIdx);
        if (!A || !B) return 0;
        return Math.hypot(B.cx - A.cx, B.cy - A.cy);
      }
      case KIND_OUTGOING: {
        const A = centers.get(lane.srcIdx);
        return A ? Math.abs(offTop - A.cy) : 0;
      }
      case KIND_INCOMING: {
        const B = centers.get(lane.dstIdx);
        return B ? Math.abs(offTop - B.cy) : 0;
      }
      default: // through (LTR / RTL): full-width transit
        return rightX - leftX;
    }
  }

  // Allocate a pool slot for a new dot on a lane, entering at normalized journey time
  // `tau` (0 for the live emitter; a uniform random value for prime()'s steady-state
  // seed). Rolls the dot's own per-end scatter (uniform-in-area, r = R·√u), cruise
  // variance, and metallic-sheen color + point size. Caller MUST ensure liveCount < SHIP_POOL_CAP.
  private spawn(kind: number, srcIdx: number, dstIdx: number, bow: number, tau: number): void {
    const s = this.liveCount++;
    this.dKind[s] = kind;
    this.dSrc[s] = srcIdx;
    this.dDst[s] = dstIdx;
    this.dBow[s] = bow;
    this.rollAppearance(s);
    // This ship's own emit/arrive points: uniform-in-area scatter (r = R·√u), stored as a
    // fraction-of-radius vector so each ship's arc differs AND the points track the disc
    // if it resizes.
    const aFrac = Math.sqrt(Math.random()), aAng = Math.random() * TAU;
    this.dAux[s] = aFrac * Math.cos(aAng); this.dAuy[s] = aFrac * Math.sin(aAng);
    const bFrac = Math.sqrt(Math.random()), bAng = Math.random() * TAU;
    this.dBux[s] = bFrac * Math.cos(bAng); this.dBuy[s] = bFrac * Math.sin(bAng);
    // Fixed random cruise multiplier in [1 − V/2, 1 + V/2], centered on 1.
    this.dSpeed[s] = 1 + (Math.random() - 0.5) * SHIP_SPEED_VARIANCE;
    this.dTau[s] = tau;
  }

  // Roll this dot's fixed-for-life appearance into the per-vertex buffers at `slot`:
  // a metallic-sheen color (random hue across the configured band, held to low
  // saturation + high lightness so it reads as brushed metal rather than a candy dot;
  // see the SHIP_COLOR_* band) and a weighted point size (see rollSize / the
  // SHIP_SIZE_PX_WEIGHTS table). Ephemeral render state, so plain Math.random() like the
  // scatter/speed rolls — not the deterministic sim PRNG. Marks attrsDirty so renderFrame
  // re-uploads both buffers this frame.
  private rollAppearance(slot: number): void {
    const h = SHIP_COLOR_HUE_MIN + Math.random() * (SHIP_COLOR_HUE_MAX - SHIP_COLOR_HUE_MIN);
    const sat = SHIP_COLOR_SAT_MIN + Math.random() * (SHIP_COLOR_SAT_MAX - SHIP_COLOR_SAT_MIN);
    const light = SHIP_COLOR_LIGHT_MIN + Math.random() * (SHIP_COLOR_LIGHT_MAX - SHIP_COLOR_LIGHT_MIN);
    this.scratchColor.setHSL(h, sat, light);
    const b = slot * 3;
    this.colors[b + 0] = this.scratchColor.r;
    this.colors[b + 1] = this.scratchColor.g;
    this.colors[b + 2] = this.scratchColor.b;
    this.sizes[slot] = rollSize();
    this.attrsDirty = true;
  }

  // Render-then-advance every live dot for a `dt`-second step (dt = 0 just redraws — used
  // by prime() to flush the seeded pool into the buffer before the first real frame). Each
  // dot re-derives its endpoints from the live layout, maps its τ → arc position through
  // the shared motion profile, places + lights it, then advances τ. Despawn fires once τ
  // reaches 1 (swap-remove), so a dot's last drawn position is a fraction short of B,
  // hidden inside the destination disc (internal/incoming) or off-screen past the margin.
  private renderFrame(dt: number): void {
    const startCount = this.liveCount;

    // Live screen bounds for the off-body endpoints (re-read every frame so a
    // resize moves them with the viewport).
    const centers = this.centers;
    const offTop = this.bufferH + SHIP_OFFSCREEN_MARGIN;
    const transitY = this.bufferH - SHIP_TRANSIT_FROM_TOP;
    const leftX = -SHIP_OFFSCREEN_MARGIN;
    const rightX = this.contentW + SHIP_OFFSCREEN_MARGIN;

    let i = 0;
    let thrustSegs = 0; // burn segments written this frame (2 vertices each)
    while (i < this.liveCount) {
      const tau = this.dTau[i]!;
      if (tau >= 1) { this.swapRemove(i); continue; }

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
      // straight chord. The control point's vertical push is (bx−ax)·bow (+y is up);
      // when that's negative the arc dips DOWN into the empty lower field, so damp it
      // — down-arcs stay shallow against the bodies' upward sweep, up-arcs untouched.
      let cx = (ax + bx) / 2, cy = (ay + by) / 2;
      let bow = this.dBow[i]!;
      if (bow !== 0 && (bx - ax) * bow < 0) bow *= SHIP_ARC_BOW_DOWN_SCALE;
      if (bow !== 0) { cx += -(by - ay) * bow; cy += (bx - ax) * bow; }
      cx += (adx + bdx) * 0.5; cy += (ady + bdy) * 0.5;

      // Map normalized journey TIME τ → arc position f via the shared motion profile, then
      // place the dot on the quadratic Bézier P(f) = u²·A + 2uf·C + f²·B (u = 1−f). The
      // profile also reports the journey time (to advance τ) and the thrust phase. Distances
      // are normalized by content width so the pace stays window-size-independent; dSpeed
      // carries the per-ship ±variance. Chord floored at 1px so a near-coincident pair
      // can't divide-by-tiny.
      const chord = Math.max(Math.hypot(p2x - p0x, p2y - p0y), 1);
      const dn = chord / this.contentW;
      const vc = this.dSpeed[i]! / SHIP_CROSS_SCREEN_SEC;
      sampleProfile(tau, dn, vc, kind, this.profileOut);
      const f = this.profileOut.s;

      const u = 1 - f;
      const w0 = u * u, w1 = 2 * u * f, w2 = f * f;
      const sx = snapPx(w0 * p0x + w1 * cx + w2 * p2x);
      const sy = snapPx(w0 * p0y + w1 * cy + w2 * p2y);
      this.pos[i * 3 + 0] = sx;
      this.pos[i * 3 + 1] = sy;
      this.pos[i * 3 + 2] = Z_SHIP;

      // Exhaust burn: a short line off the dot along ±the unit Bézier tangent
      // P'(f) = 2(1−f)(C−A) + 2f(B−C), signed by the profile phase — trailing behind while
      // accelerating, out the front while braking, dark at cruise.
      const dir = this.profileOut.phase;
      if (dir !== 0) {
        const gx = 2 * (1 - f) * (cx - p0x) + 2 * f * (p2x - cx);
        const gy = 2 * (1 - f) * (cy - p0y) + 2 * f * (p2y - cy);
        const gl = Math.hypot(gx, gy);
        if (gl > 1e-4) {
          // A 1px hull gets a stubby 1px flame; bigger hulls keep the full length.
          const thrustLen = this.sizes[i]! === 1 ? 1 : SHIP_THRUST_LEN_PX;
          const k = (dir * thrustLen) / gl; // scale tangent to the burn length
          const b = thrustSegs * 6;
          this.thrustPos[b + 0] = sx; this.thrustPos[b + 1] = sy; this.thrustPos[b + 2] = Z_SHIP;
          this.thrustPos[b + 3] = sx + gx * k; this.thrustPos[b + 4] = sy + gy * k; this.thrustPos[b + 5] = Z_SHIP;
          thrustSegs++;
        }
      }

      // Advance the normalized journey time: τ goes 0→1 over the journey time the profile
      // reported. A dt = 0 flush leaves τ untouched (just redraws).
      this.dTau[i] = tau + dt / this.profileOut.t;
      i++;
    }

    // Re-upload only when something actually changed: live dots advanced, or the
    // draw range shrank because dots despawned. An idle frame (lanes exist but no
    // dots in flight) touches nothing.
    if (this.liveCount > 0 || this.liveCount !== startCount) {
      this.posAttr.needsUpdate = true;
      this.geometry.setDrawRange(0, this.liveCount);
    }
    // Color + size only change when the live set does (spawn / despawn), so re-upload
    // those buffers only then — an in-flight frame that just advanced τ leaves them
    // alone. The draw range is shared with `pos` above, set whenever this fires.
    if (this.attrsDirty) {
      this.colorAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
      this.attrsDirty = false;
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
    this.dTau[i] = this.dTau[last]!;
    // Color + size live in the GPU-facing buffers (not SoA arrays), so compact them the
    // same way and flag a re-upload — slot i now wears the moved dot's tint + size.
    const ib = i * 3, lb = last * 3;
    this.colors[ib + 0] = this.colors[lb + 0]!;
    this.colors[ib + 1] = this.colors[lb + 1]!;
    this.colors[ib + 2] = this.colors[lb + 2]!;
    this.sizes[i] = this.sizes[last]!;
    this.attrsDirty = true;
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

// A lane's emission rate (dots/sec) from its shipped volume, clamped so a
// small flow still reads as a steady trickle and a glut can't swamp the pool.
function rateFor(amountMilli: number): number {
  return clamp(amountMilli * SHIP_RATE_PER_MILLI, SHIP_RATE_MIN_PER_LANE, SHIP_RATE_MAX_PER_LANE);
}

// Weighted pick of a per-ship point size from SHIP_SIZE_PX_WEIGHTS — smaller hulls
// dominate the stream (see the table's ratios). Walk the cumulative weight; the final
// return is an FP-rounding guard the loop never actually reaches (r < total always).
function rollSize(): number {
  let r = Math.random() * SHIP_SIZE_WEIGHT_TOTAL;
  for (const [size, weight] of SHIP_SIZE_PX_WEIGHTS) {
    r -= weight;
    if (r < 0) return size;
  }
  return SHIP_SIZE_PX_WEIGHTS[SHIP_SIZE_PX_WEIGHTS.length - 1]![0];
}
