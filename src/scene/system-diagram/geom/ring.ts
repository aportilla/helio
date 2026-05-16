// Ring ellipse math — shared by both ring render paths (ice annulus
// meshes in layers/ice-rings.ts and debris chunk pools in
// layers/debris-rings.ts) and by the picker's tilted-ellipse hit test.

import type { Body } from '../../../data/stars';
import { RING_MINOR_OVER_MAJOR, RING_TILT_DEG_MAX, RING_WIDTH_VIZ_SCALE } from '../layout/constants';
import { hash32, mulberry32 } from './prng';

// Compute the ring's ellipse parameters: per-planet pixel radii +
// tilt, derived from the ring body's innerPlanetRadii / outerPlanetRadii
// and a seeded tilt off the ring's id.
export function ringEllipseParams(ring: Body, hostDiscPx: number): { innerR: number; outerR: number; tiltRad: number } {
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

// Picker input: ring geometry params + the host planet's current
// screen-space center.
export interface RingProbe {
  hostCx: number;
  hostCy: number;
  outerR: number;
  innerR: number;
  tiltRad: number;
}

// Tilted-ellipse annulus hit-test. Inverse-rotates the cursor delta
// into the ring's untilted frame, then tests whether the normalized
// ellipse parameter ρ² ∈ [innerR²/outerR², 1] — i.e. the cursor lies
// between the inner and outer ellipses.
//
// The back/front half is determined by the sign of the *untilted* y,
// so a click on the upper half hits the back arc and lower-half clicks
// hit the front arc. The caller picks which half to test based on
// render-order priority.
export function hitsRing(x: number, y: number, probe: RingProbe, half: 'back' | 'front'): boolean {
  const dx = x - probe.hostCx;
  const dy = y - probe.hostCy;
  // Inverse tilt (positive tiltRad rotates the ring; rotate the cursor
  // by -tiltRad to drop back into the ring's local frame).
  const cosT = Math.cos(probe.tiltRad);
  const sinT = Math.sin(probe.tiltRad);
  const lx =  dx * cosT + dy * sinT;
  const ly = -dx * sinT + dy * cosT;
  // Half: back is the upper-half ellipse (ly > 0 in scene coords where
  // y grows upward); front is the lower half.
  if (half === 'back'  && ly <= 0) return false;
  if (half === 'front' && ly >= 0) return false;
  // Normalize against the outer ellipse to get ρ². The minor axis is
  // outerR × RING_MINOR_OVER_MAJOR (and innerR scales identically), so
  // the ratio (innerR/outerR)² holds for both axes.
  const ax = lx / probe.outerR;
  const ay = ly / (probe.outerR * RING_MINOR_OVER_MAJOR);
  const rho2 = ax * ax + ay * ay;
  if (rho2 > 1) return false;
  const innerRho2 = (probe.innerR / probe.outerR) * (probe.innerR / probe.outerR);
  return rho2 >= innerRho2;
}
