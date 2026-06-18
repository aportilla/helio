// Pins the cargo-ship motion profile (ship-profile.ts), the single source of truth that
// maps normalized journey TIME (τ) → arc position (s). The load-bearing guarantee is that
// the closed-form profile reproduces the motion the layer used to integrate frame-by-frame
// (so the on-screen feel is unchanged) AND that τ is the parameter a uniform random spread
// can seed — i.e. s(τ) is a proper time→position curve with the right endpoints, monotonic
// and (for internal lanes) symmetric. A `refIntegrate` mirror of the old velocity scheme is
// the oracle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  journeyTime, sampleProfile,
  KIND_INTERNAL, KIND_OUTGOING, KIND_INCOMING, KIND_THROUGH_LTR,
  PHASE_ACCEL, PHASE_CRUISE, PHASE_BRAKE,
  type ProfileSample,
} from '../system-diagram/layers/ship-profile.ts';
import { SHIP_ACCEL_SEC, SHIP_CROSS_SCREEN_SEC, SHIP_EASE_FLOOR } from '../system-diagram/layout/constants.ts';

const out: ProfileSample = { s: 0, phase: 0, t: 0 };
const arc = (tau: number, L: number, vc: number, kind: number): number => {
  sampleProfile(tau, L, vc, kind, out);
  return out.s;
};

// Reference: integrate the OLD per-frame velocity scheme (the exact formulas ships.ts used
// before the τ refactor) forward at a fine step, recording cumulative time vs arc. Returns
// the total journey time and an arc-at-elapsed-time sampler — the oracle the closed form
// must match.
function refIntegrate(L: number, vc: number, kind: number) {
  const a = vc / SHIP_ACCEL_SEC;
  const vFloor = vc * SHIP_EASE_FLOOR;
  const dt = 0.001;
  const timeAt: number[] = [0];
  const arcAt: number[] = [0];
  let t = 0;
  let time = 0;
  let prevT = 0;
  let prevTime = 0;
  while (t < 1) {
    const dist = t * L;
    const vAccel = Math.sqrt(2 * a * dist);
    const vDecel = Math.sqrt(2 * a * Math.max(L - dist, 0));
    let v: number;
    if (kind === KIND_OUTGOING) v = vAccel;
    else if (kind === KIND_INCOMING) v = vDecel;
    else if (kind === KIND_INTERNAL) v = Math.min(vc, vAccel, vDecel);
    else v = vc; // through
    if (v < vFloor) v = vFloor;
    prevT = t;
    prevTime = time;
    t += (v / L) * dt;
    time += dt;
    timeAt.push(t);
    arcAt.push(time);
  }
  // The last step overshot t=1 — linearly interpolate the crossing for an accurate T.
  const T = prevTime + ((1 - prevT) / (t - prevT)) * dt;
  const sampleArc = (te: number): number => {
    if (te <= 0) return 0;
    if (te >= T) return 1;
    // arcAt[] holds cumulative time; timeAt[] holds arc. Find the bracketing samples.
    let lo = 0;
    let hi = arcAt.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arcAt[mid]! < te) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const t0 = arcAt[i - 1]!;
    const t1 = arcAt[i]!;
    const a0 = timeAt[i - 1]!;
    const a1 = timeAt[i]!;
    return Math.min(1, a0 + ((te - t0) / (t1 - t0)) * (a1 - a0));
  };
  return { T, sampleArc };
}

const KINDS = [KIND_INTERNAL, KIND_OUTGOING, KIND_INCOMING];
const LENGTHS = [0.15, 0.4, 0.9, 1.6]; // widths: triangular short hop → cruising long haul
const SPEEDS = [0.85, 1.0, 1.15].map((m) => m / SHIP_CROSS_SCREEN_SEC); // dSpeed variance band

test('journeyTime matches the integrated reference (within 2%)', () => {
  for (const kind of KINDS) {
    for (const L of LENGTHS) {
      for (const vc of SPEEDS) {
        const ref = refIntegrate(L, vc, kind);
        const got = journeyTime(L, vc, kind);
        const relErr = Math.abs(got - ref.T) / ref.T;
        assert.ok(relErr < 0.02, `kind ${kind} L ${L}: journeyTime ${got} vs ref ${ref.T} (relErr ${relErr})`);
      }
    }
  }
});

test('sampleProfile arc-vs-time matches the integrated reference (within 0.02)', () => {
  for (const kind of KINDS) {
    for (const L of LENGTHS) {
      const vc = 1 / SHIP_CROSS_SCREEN_SEC;
      const ref = refIntegrate(L, vc, kind);
      const T = journeyTime(L, vc, kind);
      for (let tau = 0.05; tau < 1; tau += 0.05) {
        const got = arc(tau, L, vc, kind);
        const want = ref.sampleArc(tau * T);
        assert.ok(
          Math.abs(got - want) < 0.02,
          `kind ${kind} L ${L} τ ${tau.toFixed(2)}: arc ${got.toFixed(4)} vs ref ${want.toFixed(4)}`,
        );
      }
    }
  }
});

test('endpoints: s(0)=0 and s(1)=1 for every kind', () => {
  for (const kind of [...KINDS, KIND_THROUGH_LTR]) {
    for (const L of LENGTHS) {
      const vc = 1 / SHIP_CROSS_SCREEN_SEC;
      assert.ok(Math.abs(arc(0, L, vc, kind)) < 1e-9, `kind ${kind} L ${L}: s(0)`);
      assert.ok(Math.abs(arc(1, L, vc, kind) - 1) < 1e-9, `kind ${kind} L ${L}: s(1)`);
    }
  }
});

test('s(τ) is monotonic non-decreasing in τ', () => {
  for (const kind of [...KINDS, KIND_THROUGH_LTR]) {
    for (const L of LENGTHS) {
      const vc = 1 / SHIP_CROSS_SCREEN_SEC;
      let prev = -1;
      for (let tau = 0; tau <= 1.0001; tau += 0.01) {
        const s = arc(Math.min(tau, 1), L, vc, kind);
        assert.ok(s >= prev - 1e-9, `kind ${kind} L ${L} τ ${tau.toFixed(2)}: ${s} < prev ${prev}`);
        prev = s;
      }
    }
  }
});

test('internal lanes are time-symmetric: s(τ) + s(1−τ) = 1', () => {
  for (const L of LENGTHS) {
    const vc = 1 / SHIP_CROSS_SCREEN_SEC;
    for (let tau = 0.05; tau <= 0.5; tau += 0.05) {
      const a = arc(tau, L, vc, KIND_INTERNAL);
      const b = arc(1 - tau, L, vc, KIND_INTERNAL);
      assert.ok(Math.abs(a + b - 1) < 1e-6, `L ${L} τ ${tau.toFixed(2)}: ${a} + ${b} ≠ 1`);
    }
  }
});

test('through lanes cruise linearly with no burn', () => {
  const vc = 1 / SHIP_CROSS_SCREEN_SEC;
  for (let tau = 0; tau <= 1; tau += 0.1) {
    sampleProfile(tau, 1.2, vc, KIND_THROUGH_LTR, out);
    assert.ok(Math.abs(out.s - tau) < 1e-9, `through s(${tau}) = ${out.s}`);
    assert.equal(out.phase, PHASE_CRUISE);
  }
});

test('thrust phase: outgoing burns aft, incoming burns fore, internal ramps then cruises then brakes', () => {
  const vc = 1 / SHIP_CROSS_SCREEN_SEC;
  sampleProfile(0.5, 0.9, vc, KIND_OUTGOING, out);
  assert.equal(out.phase, PHASE_ACCEL, 'outgoing accelerates the whole way');
  sampleProfile(0.5, 0.9, vc, KIND_INCOMING, out);
  assert.equal(out.phase, PHASE_BRAKE, 'incoming brakes the whole way');

  // A long internal lane reaches cruise: accel early, cruise mid, brake late.
  const L = 1.6;
  sampleProfile(0.02, L, vc, KIND_INTERNAL, out);
  assert.equal(out.phase, PHASE_ACCEL, 'internal accel phase');
  sampleProfile(0.5, L, vc, KIND_INTERNAL, out);
  assert.equal(out.phase, PHASE_CRUISE, 'internal cruise phase');
  sampleProfile(0.98, L, vc, KIND_INTERNAL, out);
  assert.equal(out.phase, PHASE_BRAKE, 'internal brake phase');
});
