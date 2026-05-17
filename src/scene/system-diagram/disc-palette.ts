// Per-body palette derivation for the planet + moon disc shader.
// Both PlanetsLayer and MoonsLayer call buildDiscPalette(body, discPx) at
// construction time and pack the result into the per-vertex attributes
// consumed by makePlanetMaterial.
//
// Two render modes emerge from the body's world class + atmosphere:
//   - **surface**  — speckle world-class color with the body's 2
//                    dominant resource colors (per-pixel hash pick).
//   - **banded**   — quantize latitude into strips, each picking from
//                    the body's top 3 atmospheric gas colors. Used for
//                    gas/ice giants and Venus-class rocky worlds.
//
// The palette is always 3 RGB entries + 3 weights so the shader has
// fixed-size inputs regardless of how many resources/gases the body
// actually carries. Empty slots get zero weight and the picker skips
// them.

import { Color } from 'three';
import {
  AtmGas, Body, CHROMOPHORE_COLOR, GAS_COLOR,
  WORLD_CLASS_COLOR, WORLD_CLASS_TINT, WORLD_CLASS_UNKNOWN_COLOR,
  dominantResources, isBandedAtmosphere, topGases,
} from '../../data/stars';
import { hash32 } from './geom/prng';
import { PROCEDURAL_TEXTURE_MIN_PX } from './layout/constants';

// Fraction of total surface weight reserved for the world-class base
// color. Remaining (1 - SURFACE_BASE_WEIGHT) is split across the two
// dominant resources by their relative magnitudes. 0.6 keeps the body
// "reading as its class" while letting resources accent with ~40% of
// the pixels — a Mars-class with metals heavy enough to dominate will
// still have ~60% rust-tan but ~25-30% iron-grey speckle.
const SURFACE_BASE_WEIGHT = 0.6;

// Weights when a chromophore is present on a surface-mode body. The
// chromophore takes the second resource slot — Earth's H2O cloud cover
// or Mars's DUST haze is a single distinctive accent rather than a
// fifth color. 0.25 cloud-pixel weight reads as "partly cloudy" rather
// than "fully banded" — surface texture (continents, oceans) still
// dominates.
const SURFACE_WITH_CHROMOPHORE_BASE   = 0.5;
const SURFACE_WITH_CHROMOPHORE_RES1   = 0.25;
const SURFACE_WITH_CHROMOPHORE_CHROMO = 0.25;

export type DiscMode = 0 | 1;  // 0 = surface, 1 = banded

export interface DiscPalette {
  // Three RGB entries packed in row order: [r0,g0,b0, r1,g1,b1, r2,g2,b2].
  readonly palette: readonly [number, number, number,
                              number, number, number,
                              number, number, number];
  readonly weights: readonly [number, number, number];
  readonly mode: DiscMode;
  readonly seed: number;  // [0..1)
}

// Pull the world-class color or unknown-grey fallback. Same precedence
// as the legacy flat-color renderer so a worldClass=null body stays
// recognizable as "TBD" rather than slotting into an arbitrary class.
function worldClassColor(body: Body): Color {
  if (body.worldClass === null) return WORLD_CLASS_UNKNOWN_COLOR;
  return WORLD_CLASS_COLOR[body.worldClass] ?? WORLD_CLASS_UNKNOWN_COLOR;
}

// Resolve a body's chromophore to a render color for the surface-mode
// path. Prefers CHROMOPHORE_COLOR (condensed-product hue: NH4SH brown,
// tholin orange, silicate grey-blue, dust rust) and falls back to
// GAS_COLOR (clear-gas hue: H2O white). Returns null when the body
// has no chromophore set OR the gas name isn't in the bounded vocab.
function chromophoreSurfaceColor(body: Body): Color | null {
  if (body.chromophoreGas === null) return null;
  const gas = body.chromophoreGas as AtmGas;
  return CHROMOPHORE_COLOR[gas] ?? GAS_COLOR[gas] ?? null;
}

// Lerp `c` toward `tint.color` by `tint.amount`. Returns `c` unchanged
// when `tint` is undefined. Used by buildDiscPalette to apply the
// world-class warm/cool tint to every palette entry.
function applyTint(c: Color, tint: { color: Color; amount: number } | undefined): Color {
  if (!tint) return c;
  return new Color(
    c.r + (tint.color.r - c.r) * tint.amount,
    c.g + (tint.color.g - c.g) * tint.amount,
    c.b + (tint.color.b - c.b) * tint.amount,
  );
}

// Build the per-body palette + mode + seed for one disc. discPx is the
// final rendered diameter — sub-PROCEDURAL_TEXTURE_MIN_PX bodies force
// flat fill (weights = [1, 0, 0]) so tiny moons don't render as noise.
//
// transformColor lets the caller post-process every palette entry
// before packing (moons brighten toward white so their rims don't merge
// into a same-class parent — see MOON_BRIGHTEN).
export function buildDiscPalette(
  body: Body,
  discPx: number,
  transformColor: (c: Color) => Color = c => c,
): DiscPalette {
  const seed = hash32(`disc:${body.id}`) / 0x100000000;
  const banded = isBandedAtmosphere(body);

  // Slot 0 is always the world-class base color in surface mode, or
  // (in banded mode) the dominant gas — the shader's defensive fallback
  // (weights summing to 0) renders palette[0] solid, so it has to be
  // a reasonable single-color representation of the body.
  let c0: Color;
  let c1: Color;
  let c2: Color;
  let w0: number;
  let w1: number;
  let w2: number;

  if (banded) {
    const gases = topGases(body);
    const base = worldClassColor(body);
    if (gases.length === 0) {
      // No atmosphere data on a gas/ice giant — render flat world-class
      // color. Shouldn't happen after procgen but handle defensively.
      c0 = base; c1 = base; c2 = base;
      w0 = 1; w1 = 0; w2 = 0;
    } else {
      c0 = gases[0].color;
      c1 = gases[1]?.color ?? gases[0].color;
      c2 = gases[2]?.color ?? gases[0].color;
      w0 = gases[0].weight;
      w1 = gases[1]?.weight ?? 0;
      w2 = gases[2]?.weight ?? 0;
    }
  } else {
    const base = worldClassColor(body);
    const res = dominantResources(body, 2);
    // Chromophore overlay for surface-mode bodies — Earth's H2O cloud
    // decks, Mars's DUST haze. Replaces the second resource accent with
    // the chromophore signature so the cloud/dust character paints
    // visibly without overwhelming the resource speckle pattern.
    const chromoColor = chromophoreSurfaceColor(body);
    if (res.length === 0) {
      c0 = base; c1 = base; c2 = base;
      w0 = 1; w1 = 0; w2 = 0;
    } else if (chromoColor !== null) {
      c0 = base;
      c1 = res[0].color;
      c2 = chromoColor;
      w0 = SURFACE_WITH_CHROMOPHORE_BASE;
      w1 = SURFACE_WITH_CHROMOPHORE_RES1;
      w2 = SURFACE_WITH_CHROMOPHORE_CHROMO;
    } else {
      const accentTotal = 1 - SURFACE_BASE_WEIGHT;
      c0 = base;
      c1 = res[0].color;
      c2 = res[1]?.color ?? res[0].color;
      w0 = SURFACE_BASE_WEIGHT;
      w1 = accentTotal * res[0].weight;
      w2 = accentTotal * (res[1]?.weight ?? 0);
    }
  }

  // Force flat fill on very small discs — the per-pixel hash texture
  // and the band strips both degrade to noise below ~16 px.
  if (discPx < PROCEDURAL_TEXTURE_MIN_PX) {
    w0 = 1; w1 = 0; w2 = 0;
  }

  // Per-class hue tint (gas-giant warm shift, etc.) runs first so the
  // caller-supplied transform (moon brighten) lerps from the tinted
  // color toward white rather than starting from the untinted base.
  const tint = body.worldClass !== null ? WORLD_CLASS_TINT[body.worldClass] : undefined;
  const t0 = transformColor(applyTint(c0, tint));
  const t1 = transformColor(applyTint(c1, tint));
  const t2 = transformColor(applyTint(c2, tint));

  return {
    palette: [
      t0.r, t0.g, t0.b,
      t1.r, t1.g, t1.b,
      t2.r, t2.g, t2.b,
    ] as const,
    weights: [w0, w1, w2] as const,
    mode: banded ? 1 : 0,
    seed,
  };
}

// Per-channel lerp toward white. Used by MoonsLayer with MOON_BRIGHTEN
// so all palette entries lift uniformly, not just the world-class base
// — keeping resource accents recognizable while preventing the moon's
// rim from merging into a same-class parent.
export function lerpTowardWhite(c: Color, amount: number): Color {
  return new Color(
    c.r + (1 - c.r) * amount,
    c.g + (1 - c.g) * amount,
    c.b + (1 - c.b) * amount,
  );
}
