// Motion profile for cargo-ship dots — the SINGLE source of truth for how a ship moves.
// Maps a ship's NORMALIZED JOURNEY TIME (τ ∈ [0,1]) to its ARC POSITION (s ∈ [0,1], the
// Bézier parameter) under the constant-acceleration profile the ships layer renders, and
// reports the journey time + thrust phase. ShipsLayer.update() samples it every frame to
// place and advance a dot; ShipsLayer.prime() multiplies journeyTime() by a lane's
// emission rate to seed the lane at steady-state occupancy.
//
// Storing TIME (τ) rather than POSITION (s) is the whole point: at steady state ships
// enter a lane at a constant rate and each takes the same time, so the in-flight ships'
// τ values are UNIFORM on [0,1] — which makes a uniform random spread the correct
// open-the-view-busy seed (prime()). The spatial bunching at the slow body-ends emerges
// for free because s(τ) is non-linear (a ship spends more time where it moves slowly).
//
// Distances are NORMALIZED to content widths (L = chord / contentW) and speeds to
// widths/sec, matching ships.ts, so the profile is window-size-independent. Per call:
//   L  journey length (widths)
//   vc cruise speed (widths/sec) — already carries the per-ship dSpeed variance
// and internally a = vc / SHIP_ACCEL_SEC (constant accel), vf = vc · SHIP_EASE_FLOOR
// (crawl floor — speed never drops below this, so rest-to-rest ends inch in rather than
// stalling). Velocity-vs-distance by kind (matches the switch in ships.ts):
//   through  : vc                                                — s(τ)=τ, no burn
//   outgoing : max(√(2·a·x), vf)                                 — accelerate the whole way out
//   incoming : max(√(2·a·(L−x)), vf)                             — brake the whole way in
//   internal : max(min(vc, √(2·a·x), √(2·a·(L−x))), vf)          — accel · cruise · decel

import { SHIP_ACCEL_SEC, SHIP_EASE_FLOOR } from '../layout/constants.ts';

// Lane kinds. Plain int consts (not an enum) so the hot loop compares integers and the
// values store straight into an Int8Array. INTERNAL rides between two bodies; OUTGOING /
// INCOMING pair one body end with an off-the-top point; THROUGH_* sweep the transit band
// edge-to-edge. Defined here because the motion formulas key on them; ships.ts imports
// these (its resolve() switch and per-frame loop) so there is one definition.
export const KIND_INTERNAL = 0;
export const KIND_OUTGOING = 1;
export const KIND_INCOMING = 2;
export const KIND_THROUGH_LTR = 3;
export const KIND_THROUGH_RTL = 4;

// Thrust phase = exhaust direction: the burn trails BEHIND while accelerating (−1),
// streams out the FRONT while braking (+1), and is dark at cruise (0). The values ARE the
// `dir` the ships layer feeds the exhaust tangent.
export const PHASE_ACCEL = -1;
export const PHASE_CRUISE = 0;
export const PHASE_BRAKE = 1;

// One sample, mutated in place so the per-frame hot loop stays allocation-free: the ships
// layer owns a single instance and reuses it (see ShipsLayer.profileOut).
export interface ProfileSample {
  s: number; // arc position ∈ [0,1] (Bézier parameter)
  phase: number; // PHASE_* — drives the exhaust burn direction
  t: number; // journey time (sec) for this L/vc/kind — used to advance τ
}

// Time (sec) to traverse [0, L] under accelerate-from-rest with the crawl floor: the slow
// toe where √(2·a·x) < vf is replaced by a constant-vf crawl, so a near-zero journey
// doesn't take infinite time.
function accelTime(L: number, a: number, vf: number): number {
  const xf = (vf * vf) / (2 * a); // distance where √(2·a·x) overtakes the floor
  if (L <= xf) return L / vf; // whole journey crawls at the floor
  return Math.sqrt((2 * L) / a) - vf / (2 * a);
}

// Distance (widths) covered by elapsed time `te` under accelerate-from-rest with the
// floor: constant vf until the parabola overtakes it, then x = ½·a·t² (in a rest frame
// shifted so the floor crawl is shaved off the slow toe). The exact inverse of accelTime.
function accelArc(te: number, a: number, vf: number): number {
  const tf = vf / (2 * a); // time at the end of the floor crawl (x = vf²/2a)
  if (te <= tf) return vf * te; // floor region: constant crawl
  const tref = te + tf; // rest-frame time
  return 0.5 * a * tref * tref;
}

// Journey time (sec) for a lane of normalized length L at cruise vc. Used standalone by
// prime() (N = ratePerSec · journeyTime) and by sampleProfile to drive the τ→s mapping.
export function journeyTime(L: number, vc: number, kind: number): number {
  if (kind === KIND_THROUGH_LTR || kind === KIND_THROUGH_RTL) return L / vc;
  const a = vc / SHIP_ACCEL_SEC;
  const vf = vc * SHIP_EASE_FLOOR;
  if (kind === KIND_OUTGOING || kind === KIND_INCOMING) return accelTime(L, a, vf);
  // internal: accel · cruise · decel
  const xc = (vc * vc) / (2 * a); // distance to reach cruise
  if (L >= 2 * xc) return L / vc + (vc - vf) / a; // long lane (reaches cruise)
  if (a * L <= vf * vf) return L / vf; // all-floor (vanishingly short hop)
  return 2 * Math.sqrt(L / a) - vf / a; // triangular (peaks below cruise)
}

// Sample the profile at normalized journey time τ: write arc position, thrust phase, and
// journey time into `out` (reused — no allocation). Position is symmetric for internal
// lanes; outgoing/incoming are time-mirrors of one accelerate-from-rest ramp.
export function sampleProfile(tau: number, L: number, vc: number, kind: number, out: ProfileSample): void {
  const T = journeyTime(L, vc, kind);
  out.t = T;
  const u = tau < 0 ? 0 : tau > 1 ? 1 : tau;

  if (kind === KIND_THROUGH_LTR || kind === KIND_THROUGH_RTL) {
    out.s = u;
    out.phase = PHASE_CRUISE;
    return;
  }

  const a = vc / SHIP_ACCEL_SEC;
  const vf = vc * SHIP_EASE_FLOOR;
  const te = u * T;

  if (kind === KIND_OUTGOING) {
    out.s = accelArc(te, a, vf) / L;
    out.phase = PHASE_ACCEL;
    return;
  }
  if (kind === KIND_INCOMING) {
    out.s = 1 - accelArc(T - te, a, vf) / L;
    out.phase = PHASE_BRAKE;
    return;
  }

  // internal
  const xc = (vc * vc) / (2 * a);
  if (L >= 2 * xc) {
    const tAccel = vc / a - vf / (2 * a); // time to reach x_c (matches accelTime's accel leg)
    if (te <= tAccel) {
      out.s = accelArc(te, a, vf) / L;
      out.phase = PHASE_ACCEL;
      return;
    }
    if (te >= T - tAccel) {
      out.s = 1 - accelArc(T - te, a, vf) / L;
      out.phase = PHASE_BRAKE;
      return;
    }
    out.s = (xc + vc * (te - tAccel)) / L; // cruise
    out.phase = PHASE_CRUISE;
    return;
  }
  if (a * L <= vf * vf) {
    out.s = u; // all-floor: position linear in time
    out.phase = u < 0.5 ? PHASE_ACCEL : PHASE_BRAKE;
    return;
  }
  const tHalf = T / 2; // triangular: peak at the midpoint, no cruise
  if (te <= tHalf) {
    out.s = accelArc(te, a, vf) / L;
    out.phase = PHASE_ACCEL;
  } else {
    out.s = 1 - accelArc(T - te, a, vf) / L;
    out.phase = PHASE_BRAKE;
  }
}
