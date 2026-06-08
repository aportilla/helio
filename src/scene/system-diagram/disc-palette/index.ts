// Per-body palette derivation for the planet + moon disc shader.
// Both PlanetsLayer and MoonsLayer call buildDiscPalette(body, discPx) at
// construction time and pack the result into the per-vertex attributes
// + per-body data-texture row consumed by makePlanetMaterial.
//
// The shader composes a layered stack per fragment, bottom to top:
//   - **surface**  — a terraced elevation field shaded from the body's
//                    primary resource hue, with the secondary flooding the
//                    low ground (see the surface-palette section below).
//                    World-class color only surfaces as a flat-fill fallback
//                    when a body has no resource signal. Substituted with `atmColumnColor`
//                    when the body has no accessible surface (gas / ice
//                    giants) — the void between cloud cells shows the
//                    deep atm column tint there.
//   - **haze**     — uniform per-fragment lerp toward the haze color by
//                    hazeOpacity. Aerosol species not claimed by a
//                    cloud deck (DUST, SILICATE, SALT, H2SO4, ...)
//                    live here alongside bulk gas absorption and
//                    Rayleigh scattering.
//   - **cloud**    — up to MAX_CLOUD_LAYERS stratified decks composited
//                    back-to-front by altitudeNorm. Each deck is ONE
//                    condensate color (CONDENSATE_COLOR[gas] with
//                    GAS_COLOR fallback) plus small per-cell brightness
//                    jitter. Multi-color character on banded bodies
//                    emerges from coverage rents in upper decks
//                    revealing the next-deeper deck (or the surface /
//                    atm-column beneath the stack), not from in-deck
//                    palette mixing.
//   - **rim**      — outward halo into space, no inward fade. Width
//                    bucketed off pressure (surface) or scale-height
//                    proxy (no-surface). Color = same contributor blend
//                    as haze, with each deck's base color folded in by
//                    coverage.
//
// Each layer's alpha is data-driven; total opacity emerges from
// composition rather than a mode flip. Earth's H2O deck at coverage
// 0.4 covers 40% of the disc in white worley cells; Venus's H2SO4
// deck at 1.0 covers everything; Saturn's three full-coverage decks
// stack such that the upper NH3 hides everything below it, while
// Jupiter's lower NH3 coverage rents zonally to reveal NH4SH bands.
//
// ─── Surface palette: a terraced elevation field in one primary colour ──
//
// `buildDiscPalette` derives ONE primary surface colour per body from its
// dominant resources via `dominantResources(body, 2)`, and the shader paints
// the visible surface as a terraced elevation field:
//
//   - An elevation is built per fragment from multi-octave relief noise plus a
//     resource-topology bias: an abundance-claimed worley patch (Uplands, disc
//     area ≈ a0) trends HIGH and the regolith remainder (Lowlands, 1 − a0)
//     trends LOW, so the resource patch still reads as bright high ground while
//     the relief itself comes from the independent noise.
//   - That elevation is quantized into reliefBands discrete terraces, each a
//     fixed shade off the primary colour (lighter uphill, darker downhill,
//     mirrored about the mid terrace). Per-step contrast is constant; the band
//     COUNT is the relief depth. reliefBands and a granularity feature-size
//     factor are per-body, derived read-side here in `terrainRoughnessFor`.
//
// The primary colour (slot 0): the PRIMARY resource's archetype hue, diluted
// toward regolith by the regolith share (1 − a0) — pure primary-over-regolith,
// so a rich world keeps its resource hue and a poor one washes toward barren
// regolith. The SECONDARY resource (slot 1) enters ONLY through the shader's
// stain pass: it floods the low ground as a dithered partial overlay up to an
// elevation level set by its abundance (vWeights.y = a1), never claiming an
// area of its own. vWeights.x = a0 drives the Uplands/Lowlands elevation bias.
// World-class colour appears only as a flat-fill fallback when a body has no
// resource signal at all.
//
// Gas / ice giants skip the surface entirely and paint `atmColumnColor`
// — a frac × GAS_POTENCY weighted blend of the body's atm slots that
// resolves to whichever absorbing species dominates the column. A
// synthetic "base" cloud deck (prepended at altitudeNorm 0.0 with deck
// color = atmColumnColor lifted slightly toward white) provides the
// foundation banding through the same worley + lat-keyed lj machinery
// the chemistry decks use, so gas giants read as gently banded rather
// than a flat fill. The chemistry decks then composite above.
//
// Temperature shapes that base on hot giants (keyed on the combined
// T_eff, which folds in intrinsic heat — see procgen): the column
// collapses toward a dark absorber as it heats (hotGiantColumnDarkening,
// the <10%-albedo hot-Jupiter look), and above the incandescence floor a
// self-emission glow rides the emissionTempNorm channel into the shader
// as a smooth global ember (giantEmissionNormFor) — reflectance-dark yet
// self-luminous, the deep dull red-orange of a hot dayside, veiled by the
// reflective IRON/SILICATE (or dark TIO) decks above and revealed through
// their rents.
//
// ─── Haze contributor model ────────────────────────────────────────
//
// `hazeBlendFor` returns (color, opacity) from four weighted contributor
// categories, each gated by `log10(P+1)` (column-mass proxy) so a
// thin-atm body can't paint full haze regardless of formation strength:
//
//   bulk gases    — frac × GAS_POTENCY[gas]            × HAZE_BULK_GAS_SCALE
//   Rayleigh      — frac × SCATTERING_POTENCY[gas]     × HAZE_RAYLEIGH_SCALE
//   aerosols      — body.hazeAerosols[gas] × POTENCY   × HAZE_AEROSOL_SCALE
//                   (skipped when species matches a cloud deck on this
//                    body — `deckGasesFor` — so we don't double-count)
//   lifted dust   — body.dustStrength × POTENCY[DUST]  × HAZE_DUST_SCALE
//                   (color from `dominantResources` so dust matches the
//                    body's mineralogy: iron-grey, rust, tan)
//
// No-surface bodies fold `atmColumnColor` in as a stratospheric-haze
// contributor so Saturn picks up a non-zero opacity (cream H2/He tint)
// for the per-deck haze pre-tint. Opacity is soft-capped via
// `1 − exp(−Σ)` so many thin contributions saturate smoothly. CHROMOPHORE
// sits in RENDERER_SKIP_AEROSOLS — its visible signal is too localized
// (Jupiter's GRS, Saturn's polar hexagon) for a uniform haze tint.
//
// The rim halo uses the same weighted-average merger plus each cloud
// deck's base color folded in by deck coverage — this is the loft's
// base (Mie) hue, which the shader lights per-star. `scatteringRimFor`
// additionally derives the per-gas limb Rayleigh scatter color (the
// frac × SCATTERING_POTENCY blend of SCATTERING_COLOR) and a Rayleigh-
// fraction strength; the shader rotates the lit rim toward that hue with
// loft-column depth (hue only — see makePlanetMaterial's Rayleigh block).
//
// ─── Where chemistry lives ─────────────────────────────────────────
//
// Procgen owns the chemistry: `procgen.mjs:hazeFor` emits per-species
// formation strengths (THOLIN / NH4SH / CHROMOPHORE / SALT / H2SO4 /
// SULFUR / SILICATE) and `dustStrength` from peaked T+atm gates;
// `procgen.mjs:cloudDecksFor` emits cloud decks from per-species
// condensation gates in `CONDENSABLES`. The renderer paints exactly
// what procgen emits — no silent substitution. See the chemistry-gate
// comments in `procgen.mjs:hazeContribution` and the `CONDENSABLES`
// table in `procgen-priors.mjs` for per-species rationale.
//
// Color tables (two layers) live in `../color-science`:
//   GAS_COLOR        — visible hue when the species is gas-phase or
//                      photochemistry aerosol (CH4 cyan, H2/He cream,
//                      THOLIN orange, NH4SH brown, H2SO4 sulfate, etc.)
//   CONDENSATE_COLOR — sparse table of ice/frost appearances for
//                      condensable gases (CH4 frost, NH3 ice, N2 frost,
//                      H2O ice). Falls back to GAS_COLOR when the
//                      species isn't a condensable.
//
// `WORLD_CLASS_TINT` applies a small warm/cool shift to surface palette
// entries — `gas_giant` lerps toward amber so Jupiter reads ruddier
// than Saturn. Cloud palette entries skip the tint so cloud colors
// stay aligned with their gas species.

import { Color } from 'three';
import { Body } from '../../../data/stars';
import { MAX_CLOUD_LAYERS } from '../../materials';
import {
  BARREN_ROCK_COLOR,
  biomePaintFor, cloudDeckPalette, dominantResources, lerpColor,
  rockArchetypeFor,
} from '../color-science';
import { isGasGiant } from '../../../../scripts/lib/body-traits.mjs';
import { hash32 } from '../geom/prng';
import { bodyVisualTiltRad } from '../geom/ring';
import { PROCEDURAL_TEXTURE_MIN_PX } from '../layout/constants';
import {
  atmColumnColor, hazeBlendFor, hotGiantColumnDarkening,
  rimWidthForNoSurfaceAtmosphere, rimWidthForSurfaceAtmosphere,
  RIM_PRESENCE_FLOOR_PX, scatteringRimFor, surfaceHazeContributors,
} from './atmosphere';
import { lavaDrivesFor } from './lava';
import { oceanColorFor, OCEAN_FALLBACK_COLOR } from './ocean';
import { BLACK_COLOR, clamp01, smoothstep01, weightedColorBlend, WHITE_COLOR } from './shared';

// Per-body brightness shift — deterministic ±RANGE in [0..1] applied
// uniformly across both archetype palette slots so the body's internal
// contrast is preserved but two bodies sharing an archetype stack
// (e.g. a system full of M+R rusty worlds) read as visibly different
// shades. Positive seed → lerp toward white; negative → lerp toward
// black. Magnitude tuned so adjacent bodies look like siblings rather
// than the same body twice.
const PER_BODY_BRIGHTNESS_RANGE = 0.18;

// Per-body temperature tint — hot bodies lerp toward a warm orange,
// cold bodies toward a cool blue, by `amount × hueShiftMagnitude`. Real
// planetary surfaces lean this way (more iron oxide & sulfur on hot
// dry, more ice & frost on cold), and the shift gives a 5-body system
// orbiting one star a temperature gradient readable at a glance. Tints
// are deliberately soft hues, not saturated — they nudge, they don't
// dominate.
const TEMP_TINT_WARM = new Color(1.0, 0.55, 0.25);
const TEMP_TINT_COOL = new Color(0.55, 0.78, 1.0);
const TEMP_TINT_AMOUNT = 0.12;
const TEMP_NEUTRAL_K = 280;
const TEMP_COLD_K    = 100;
const TEMP_HOT_K     = 700;

// BARREN_ROCK_COLOR (imported from data/stars) backstops the no-resource
// flat-fill fallback (a body whose entire resource grid is empty).

// Surface AREA model — primary abundance (a0) splits the disc into Uplands (the
// resource patch, area a0) and Lowlands (regolith, 1 − a0); that split biases
// the shader's elevation field (Uplands trend high/bright). AREA carries
// abundance: a trace deposit reads as sparse small Uplands patches on a mostly-
// regolith disc, a motherlode fills it. The secondary resource is ignored for
// AREA — it floods the low ground as a separate stain (see buildDiscPalette).

// Regolith base — the barren-rock colour the primary surface colour dilutes
// toward by the regolith share (1 − a0), so a resource-poor world reads as mostly
// regolith and a rich one mostly its resource hue. A neutral, faintly-warm mid
// grey (per-body tinted for sibling variety): it is now the colour the WHOLE
// disc blends toward on poor worlds — the master "barren darkness" lever — so it
// sits at mid lightness rather than the near-black the old stained-substrate
// model used (that model needed the base darker than the patches; there are no
// separate patches now).
const REGOLITH_BASE_COLOR = new Color(0x4a4742);

// Minimum disc fraction each big area (Uplands / Lowlands) always keeps, so
// neither fully vanishes at the abundance extremes — a pure motherlode still
// shows some regolith and a barren world still shows some resource, both
// keeping a shoreline (so the elevation bias has both a high and a low pole).
// Only a0 < FLOOR or a0 > 1 − FLOOR is affected; the mid-range area stays
// exactly abundance.
const ZONE_AREA_FLOOR = 0.15;

// Synthetic base deck params for no-surface bodies. The deck color is
// the atm column lifted slightly toward white so deck cells fire at a
// just-perceptibly-brighter shade than the rented atm column — gentle
// wispy variety where the deck doesn't fully cover. Coverage 0.95
// leaves ~5% rents to pure atm column. BAND_LIGHTNESS_JITTER in the
// shader (±6%) provides the lat-band tone variation on top.
const BASE_DECK_LIGHTNESS_LIFT = 0.05;
const BASE_DECK_COVERAGE = 0.95;
const BASE_DECK_WIND_DEFAULT = 200;

// Gas-giant self-emission window. A hot/ultra-hot giant glows from its own
// heat — the deep dull red-orange of an incandescent atmosphere — keyed on the
// combined effective temperature (avgSurfaceTempK, which folds intrinsic
// Kelvin-Helmholtz heat into irradiation since Phase 1). Maps T → an
// emissionTempNorm the shader feeds to emberRamp. The window floor is the
// visible-glow onset; RAMP_CAP holds even the hottest giant at vivid orange
// rather than the gold-white top of the ramp — the convo's "deep, dull
// red-orange," reflectance-dark but self-luminous, NOT a lava surface.
const GIANT_EMIT_T_MIN = 900;
const GIANT_EMIT_T_MAX = 2500;
const GIANT_EMIT_RAMP_CAP = 0.7;

function giantEmissionNormFor(body: Body): number {
  const T = body.avgSurfaceTempK;
  if (T === null) return 0;
  return clamp01((T - GIANT_EMIT_T_MIN) / (GIANT_EMIT_T_MAX - GIANT_EMIT_T_MIN)) * GIANT_EMIT_RAMP_CAP;
}

// Apply two per-body shifts to an archetype color: a deterministic
// brightness offset (from the body's hash seed) and a temperature-driven
// warm/cool tint (from `avgSurfaceTempK`). Both are soft — they vary the
// body within a recognizable archetype, not across archetypes.
//
// seed ∈ [0, 1) — same hash used elsewhere in disc-palette so both
// palette slots on one body share the same brightness shift.
function applyPerBodyTints(c: Color, body: Body, seed: number): Color {
  // Brightness — map seed [0, 1) to [-RANGE, +RANGE], lerp toward black
  // or white. Uniform across the body's slots so internal contrast
  // is preserved.
  const brightDelta = (seed - 0.5) * 2 * PER_BODY_BRIGHTNESS_RANGE;
  let shifted = brightDelta > 0
    ? lerpColor(c, WHITE_COLOR, brightDelta)
    : brightDelta < 0
      ? lerpColor(c, BLACK_COLOR, -brightDelta)
      : c;
  // Temperature — split-piecewise around TEMP_NEUTRAL_K. Hot → warm
  // tint; cold → cool tint. Amount scales linearly to TEMP_HOT_K /
  // TEMP_COLD_K then clamps at TEMP_TINT_AMOUNT. Null tempK = no shift.
  const tempK = body.avgSurfaceTempK;
  if (tempK !== null) {
    if (tempK > TEMP_NEUTRAL_K) {
      const a = Math.min(1, (tempK - TEMP_NEUTRAL_K) / (TEMP_HOT_K - TEMP_NEUTRAL_K));
      shifted = lerpColor(shifted, TEMP_TINT_WARM, a * TEMP_TINT_AMOUNT);
    } else if (tempK < TEMP_NEUTRAL_K) {
      const a = Math.min(1, (TEMP_NEUTRAL_K - tempK) / (TEMP_NEUTRAL_K - TEMP_COLD_K));
      shifted = lerpColor(shifted, TEMP_TINT_COOL, a * TEMP_TINT_AMOUNT);
    }
  }
  return shifted;
}

// Map iceFraction → iceCoverage ∈ [0,1], a pure function of how much ice
// procgen put on the surface (temperature, cold-trap and the water budget
// were already folded into iceFraction by surfaceIceCover — re-reading
// temperature here would double-count). Coverage drives one continuous
// latitude model in the shader: the snow line sits at asin(1 − iceCoverage),
// so caps grow organically from the poles toward the equator as ice rises.
//
// Shape: a gamma lift (ICE_COVERAGE_GAMMA > 1, mildly convex so small
// fractions stay small caps rather than spreading toward the equator)
// normalized so coverage saturates to full at ICE_COVERAGE_SATURATE.
// Anchors, by body (snow-line latitude = asin(1 − coverage)): Io (0) bare;
// Mars (0.02) tiny caps above ~80°; Earth (0.10) modest caps above ~65°;
// Ganymede (0.60) mostly covered (caps to ~13°); Callisto (0.70) nearly
// full; Europa/Triton (0.85) and Enceladus (0.95) wholly frozen disc with
// no bare equatorial strip.
const ICE_COVERAGE_GAMMA = 1.2;
// Inputs at/above this fraction saturate to full coverage — the ice-shell
// worlds (Europa/Triton ≈ 0.85, Enceladus ≈ 0.95) should read as a wholly
// frozen disc, not a capped one.
const ICE_COVERAGE_SATURATE = 0.75;
function iceCoverageForFraction(iceFraction: number): number {
  const f = clamp01(iceFraction);
  if (f <= 0) return 0;
  const lifted = Math.pow(f, ICE_COVERAGE_GAMMA);
  // Renormalize so iceFraction === ICE_COVERAGE_SATURATE maps to 1.0; clamp
  // pins anything above to full so the top end fills without a bare strip.
  return clamp01(lifted / Math.pow(ICE_COVERAGE_SATURATE, ICE_COVERAGE_GAMMA));
}

// ── Surface terrain roughness — relief depth + feature granularity, derived
// read-side from stored physics (no stored field, the same discipline as
// iceCoverageForFraction / surfaceAge). Two visual axes the disc shader
// consumes:
//
//   reliefBands — how many discrete elevation terraces the surface shades into
//     (RELIEF_BANDS_MIN ≈ flat, RELIEF_BANDS_MAX ≈ rugged). The per-terrace
//     contrast is fixed in the shader; the COUNT is the relief depth. Relief
//     survives on ANCIENT surfaces (low surfaceAge) and is amplified by low
//     surface gravity (g = M⊕/R⊕²); it is erased by resurfacing (high
//     surfaceAge), atmospheric / fluvial erosion, and warm-ice viscous
//     relaxation. A small tectonic-uplift term keeps active worlds off the floor.
//   granularity — feature fineness [0 = coarse provinces, 1 = fine grain]. Old
//     cratered surfaces read fine (many small features); active tectonic + large
//     bodies read coarse (few big provinces). 0.5 ≈ the historical fixed look.
//
// These are the tuning surface — the weights/anchors below are where the
// judgment lives. Rough reliefBands anchors: Moon/Callisto ≈ 6, Mars ≈ 5,
// Earth ≈ 2, Venus ≈ 2, Europa ≈ 2, Enceladus ≈ 1.
const RELIEF_BANDS_MIN = 1;
const RELIEF_BANDS_MAX = 6;
// Fraction of relief a high-gravity world still keeps (low-g worlds reach 1).
const RELIEF_GRAVITY_FLOOR = 0.4;
const RELIEF_TECT_UPLIFT = 0.25;
const RELIEF_EROSION_WEIGHT = 0.30;
// Ice viscous-relaxation window — below T_LO ice is rigid and holds relief;
// above T_HI it flows and slumps. Scales the iceFraction relaxation destroyer.
const ICE_RELAX_T_LO = 120;
const ICE_RELAX_T_HI = 260;

// Ice-shell composition ramp — bulk ice (water + volatile) fraction over which
// a frozen surface ages as an ICE SHELL (dark sublimation dust mantle, craters
// excavating bright ice — Callisto) rather than a ROCKY snowball (bright snow
// veneer over rock, craters exposing dark regolith). A continuous smoothstep,
// never a threshold: a half-ice world reads as a blend of both aging modes.
// LO ≈ rock-wearing-frost; HI ≈ unambiguous ice shell (Europa/Callisto floor).
const ICE_SHELL_LO = 0.05;
const ICE_SHELL_HI = 0.45;

function terrainRoughnessFor(body: Body): { reliefBands: number; granularity: number } {
  const surfaceAge = body.surfaceAge ?? 0.5;
  const tect = body.tectonicActivity ?? 0.3;
  const mE = body.massEarth;
  const rE = body.radiusEarth;
  const g = mE !== null && rE !== null && rE > 0 ? mE / (rE * rE) : 1;
  // Low surface gravity supports taller relief (Mars, Vesta); high gravity damps
  // it toward the floor (super-earths).
  const gravityGen = 1 - smoothstep01(0.2, 2.0, g);
  const gravMult = RELIEF_GRAVITY_FLOOR + (1 - RELIEF_GRAVITY_FLOOR) * gravityGen;

  // Destroyers — relief loses to the strongest of atmospheric erosion (column
  // mass), fluvial erosion (standing liquid), and warm-ice relaxation.
  const P = body.surfacePressureBar ?? 0;
  const atmErode = clamp01(Math.log10(P + 1) / 2); // ≈ 1 by 100 bar (Venus)
  const fluvErode = body.surfaceLiquidFraction ?? 0;
  const T = body.avgSurfaceTempK;
  const iceRelax = (body.iceFraction ?? 0) * (T === null ? 0 : smoothstep01(ICE_RELAX_T_LO, ICE_RELAX_T_HI, T));
  const erosion = Math.max(atmErode, fluvErode, iceRelax);

  const amplitude = clamp01(
    (1 - surfaceAge) * gravMult + RELIEF_TECT_UPLIFT * tect - RELIEF_EROSION_WEIGHT * erosion,
  );
  const reliefBands = RELIEF_BANDS_MIN + Math.round(amplitude * (RELIEF_BANDS_MAX - RELIEF_BANDS_MIN));

  // Granularity — fine on old cratered surfaces, coarse on active / large bodies.
  const sizeCoarse = rE === null ? 0 : smoothstep01(0.5, 3.0, rE);
  const granularity = clamp01(0.5 + 0.4 * (1 - surfaceAge) - 0.4 * tect - 0.3 * sizeCoarse);

  return { reliefBands, granularity };
}

// Ice-shell composition fraction [0..1] — how ice-dominated a body's BULK is, a
// continuous smoothstep over bulkWater+bulkVolatile (ICE_SHELL_LO/HI), never a
// hard flag. The single source for the renderer's icy-surface aging blend (dust
// mantle / crater reveal / linea), exported so the planet-test grid can label
// its sweep by the axis that actually drives the disc rather than the raw input.
export function shellFractionFor(body: Body): number {
  return smoothstep01(
    ICE_SHELL_LO,
    ICE_SHELL_HI,
    (body.bulkWaterFraction ?? 0) + (body.bulkVolatileFraction ?? 0),
  );
}

export interface DiscPalette {
  // 3 RGB entries × 3 floats — the SURFACE resource palette. Worley
  // cells in the surface block pick from this. Always derived from
  // `dominantResources(body)`; empty bodies fall back to a flat
  // world-class color in slot 0.
  readonly palette: readonly [number, number, number,
                              number, number, number,
                              number, number, number];
  readonly weights: readonly [number, number, number];
  // Atmospheric column color — weighted blend across the body's atm
  // gases by `frac × GAS_POTENCY`. Painted as the disc base when
  // `surfaceOpacity == 0` (gas / ice giants) so cloud rents reveal the
  // physically-honest deep-column tint. Black when the body has no
  // atmosphere data.
  readonly atmColumnColor: readonly [number, number, number];
  // Surface opacity [0..1]. 1 = paintable surface visible (terrestrials).
  // 0 = surface contribution is suppressed; the shader paints
  // atmColumnColor as base instead. Composition stays unconditional;
  // this scalar gates contribution rather than branching the codepath.
  readonly surfaceOpacity: number;
  readonly seed: number;  // [0..1)
  // Render tilt in radians — rotates the banded-mode strip axis so
  // bands run parallel to the planet's equator (and, for ringed giants,
  // to the ring plane via the shared bodyVisualTiltRad helper). Used
  // by both the cloud-banded and surface sphere-projection paths.
  readonly tilt: number;
  // Surface-liquid cover (dominant species, any solvent) [0..1]. Surface
  // block splits the disc into coarse continent cells; a per-cell hash <
  // waterFrac flips that cell from resource patch to flat ocean color.
  // Earth at 0.71 reads as ~71% ocean; a Titan-class hydrocarbon world
  // paints its liquid cells from its own cover; Mars at 0 stays all-land.
  // Forced to 0 on no-surface bodies and on tiny discs
  // (PROCEDURAL_TEXTURE_MIN_PX gate).
  readonly waterFrac: number;
  // Per-body ocean color [0..1]^3 — replaces the shader's hard-coded
  // OCEAN_COLOR constant for surface-liquid cells. Derived through five
  // physical pathways (stellar SED × sky reflection + solvent base ×
  // CDOM × pigment × sediment) so close-analog bodies get distinguishable
  // hues — `oceanColorFor` receives the full body, so species/salinity
  // reach it for the actual color; the waterFrac scalar is only the
  // surface-liquid cover (dominant species, any solvent) that gates
  // which cells are liquid. See `oceanColorFor` above for the full stack. Painted only
  // where the shader's existing `liquidOceanHere` predicate fires;
  // fragments above the snow line fall back to ice/resource paths.
  readonly oceanColor: readonly [number, number, number];
  // Surface ice cover [0..1]. Feeds iceCoverage (the latitude model's
  // snow line) and the per-fragment ice/linea gates. Same suppression
  // gates as the surface-liquid cover (dominant species, any solvent)
  // above.
  readonly iceFrac: number;
  // Biome stipple — pigment color (archetype × stellar shift; see
  // biomePaintFor in color-science.ts) packed as [r,g,b], and coverage density
  // [0..1] scaled off biosphereSurfaceImpact. Suppressed on no-surface
  // bodies, tiny discs, and bodies with no surface signature.
  readonly biomeColor: readonly [number, number, number];
  readonly biomeCoverage: number;
  // Cloud layers — up to MAX_CLOUD_LAYERS stratified decks, sorted
  // ascending by altitudeNorm. Each entry carries one condensate color
  // (no in-deck mixing). The shader composites layers above the
  // surface + haze, each pre-tinted by the haze opacity sitting above
  // it. Empty slots have coverage = 0 and get a no-op composite.
  // Banded character emerges from coverage rents revealing the deck
  // below (or the surface / atm-column beneath the stack). No-surface
  // bodies get a synthetic base deck prepended at altitudeNorm 0.0
  // (atm column lifted toward white) so the bulk gas-giant fill reads
  // as gently banded foundation under any chemistry decks above.
  readonly cloudLayers: ReadonlyArray<{
    readonly coverage: number;
    readonly windSpeedMS: number;
    readonly altitudeNorm: number;
    // Condensate RGB — CONDENSATE_COLOR[gas] with GAS_COLOR fallback.
    readonly color: readonly [number, number, number];
  }>;
  // Haze layer uniform opacity [0..1]. The shader runs a per-fragment
  // mix(col, hazeColor, hazeOpacity) over EVERY paint underneath
  // (surface + cloud). Derived from the unified contributor blend
  // (bulk atm gases × pressure × potency, formation-gated aerosol
  // products, lifted dust from body mineralogy, Rayleigh scattering)
  // soft-capped via 1 - exp(-Σ). Titan ≈ 0.92 (puffy-column-anchored —
  // low gravity piles ~10× Earth-equivalent atmospheric mass per unit
  // surface pressure, matching real Titan's orbit-invisible surface),
  // Venus ≈ 0.7, Mars ≈ 0.30 (dust storms now visible from orbit),
  // Earth ≈ 0.15. Zero on bodies with no atmosphere data.
  readonly hazeOpacity: number;
  // Unified haze blend color — weighted average across every
  // atmospheric contributor (bulk gases, Rayleigh, aerosol products,
  // dust). One color per body; the shader's surface haze pass paints
  // it uniformly across the disc face. Same color also feeds the
  // outward rim merger.
  readonly hazeColor: readonly [number, number, number];
  // Merged rim color — weighted-average blend across cloud slot 0 +
  // every haze contributor for surface bodies, or cloud + atm column
  // tint for no-surface bodies. Used by the outward halo. Dominated by
  // whatever signal has the highest weight (tholin on Titan,
  // chromophore-filtered H2/He column on Jupiter, cyan Rayleigh on
  // Earth, mineralogy-rust on Mars).
  readonly rimColor: readonly [number, number, number];
  readonly rimWidthPx: number;
  // Per-body limb Rayleigh scattering (see scatteringRimFor). scatterColor
  // is the gas-specific scatter hue the rim shifts toward (re-illuminated
  // by starlight in the shader); scatterStrength [0..1] scales the maximum
  // depth-graded hue shift so a clear-air body (Earth) shifts strongly
  // while an absorption-dominated one (Venus) barely moves. Black /
  // strength 0 on bodies with no clear-air signal — the shader then leaves
  // the rim at its Mie color.
  readonly scatterColor: readonly [number, number, number];
  readonly scatterStrength: number;
  // Phase 1.4 surface age [0..1]. 1 = perpetually refreshed (Io's lava,
  // Enceladus's plumes); 0 = ancient unmodified (Mercury, Luna,
  // Callisto). Drives crater density and the ice-on-top-vs-buried mix.
  // Forced to 0.5 on no-surface bodies and tiny discs (the surface
  // block is unreachable there) so the attribute schema stays uniform.
  readonly surfaceAge: number;
  // Surface terrain roughness (see terrainRoughnessFor). reliefBands [1..6] =
  // the number of discrete elevation terraces the shader shades the disc into
  // (relief depth, constant per-step contrast); granularity [0..1] = feature
  // fineness (coarse provinces → fine grain), scaling the macro patch + relief
  // noise pitch. Defaulted (reliefBands 1, granularity 0.5) on suppressed
  // surfaces where the surface block is unreachable.
  readonly reliefBands: number;
  readonly granularity: number;
  // Ice-shell fraction [0..1] — how ice-dominated the body's BULK is, a
  // continuous smoothstep over bulkWater+bulkVolatile (ICE_SHELL_LO/HI), never a
  // hard flag. Drives how a frozen surface ages: at 1 it's an ice shell (dark
  // sublimation dust mantle, craters excavating bright ice — Callisto); at 0 a
  // rocky snowball (bright snow over rock, craters exposing dark regolith);
  // between, a continuous blend of the two. 0 on suppressed surfaces.
  readonly shellFraction: number;
  // Ice coverage [0..1] — a pure function of iceFraction (no temperature;
  // procgen already folded thermal state into iceFraction). Drives the
  // shader's single continuous latitude model: the snow line sits at
  // asin(1 − iceCoverage), so caps grow from the poles toward the equator
  // as coverage rises, up to a wholly frozen disc.
  readonly iceCoverage: number;
  // Lava / molten-surface emission. `moltenCoverage` [0..1] = how much of
  // the disc is molten — the max of an insolation-driven global-melt ramp
  // (avgSurfaceTempK across the silicate solidus) and a capped tidal/
  // radiogenic vent drive (sparse calderas on an actively-repaved dry
  // surface, e.g. Io). `emissionTempNorm` [0..1] keys the shader's
  // blackbody emberRamp (0 ≈ Draper-point dull red, 1 ≈ white-hot) — the
  // heat path emits at the surface temperature, the vent path at intrinsic
  // silicate-lava temperature regardless of a cold crust. On gaseous bodies
  // `emissionTempNorm` is repurposed for giant self-emission — keyed on the
  // combined T_eff (see giantEmissionNormFor), it drives a smooth GLOBAL glow
  // under the cloud decks rather than the lava-lake geometry, and
  // `moltenCoverage` stays 0 (unused on that path). Both 0 on suppressed
  // surfaces and non-incandescent bodies, so the shader's molten sub-pass
  // early-outs. See the LAVA_* constants above and the molten sub-pass in
  // makePlanetMaterial.
  readonly moltenCoverage: number;
  readonly emissionTempNorm: number;
  // Composition hue nudge [0..1] — abiotic surface sulfur fraction (SO2 /
  // sulfate / elemental-sulfur species). The shader lifts the ember's
  // green channel by this so sulfurous volcanism (Io) reads yellower than
  // pure silicate lava. 0 leaves the blackbody ember untouched.
  readonly lavaSulfurFrac: number;
  // Per-body cooled-crust RGB (each channel [0..1]) — neutral basalt base
  // leaned toward the body's dominant rock mineralogy (see lavaDrivesFor).
  // The shader's Tier-1 molten crust backdrop tints toward this, so
  // co-orbiting lava worlds keep distinct between-feature crust hues rather
  // than one shared global brown. Neutral base on bodies with no molten
  // surface (the channel is unread there). NOT run through the per-class
  // applyTint/WORLD_CLASS_TINT — this is cooled rock, not surface palette.
  readonly lavaCrustColor: readonly [number, number, number];
  // Per-body ember chromophore filter RGB (each ~[0.55..1]) — the dominant-
  // resource blend of RESOURCE_EMBER_TINT (see lavaDrivesFor). The shader
  // multiplies the molten ember by this so the glow signals composition (a
  // radioactives world reads sickly green, a metals world whiter-orange).
  // Neutral white (1,1,1) on bodies with no molten surface or no resource
  // signal — the channel is a no-op tint there.
  readonly emberTint: readonly [number, number, number];
}

// Neutral fill for the degenerate no-surface body that also has no atm
// gases to color its column — `atmColumnColor` returns null only then,
// which no real gas/ice giant hits. Grey reads as "TBD" rather than
// slotting into an arbitrary palette.
const NO_ATM_FALLBACK_COLOR = new Color(0x808080);

// Neutral cooled-basalt crust for bodies with no molten surface (the
// shader never reads the crust channel there, but the field is always
// present so the texel pack stays uniform). Matches lava.ts's LAVA_CRUST_BASE.
const LAVA_CRUST_FALLBACK: readonly [number, number, number] = [0.34, 0.20, 0.21];

// Neutral (no-op) ember chromophore filter for bodies with no molten surface.
// A multiplicative white leaves the shader's blackbody ember untouched.
const EMBER_TINT_NEUTRAL: readonly [number, number, number] = [1, 1, 1];

// Warm amber shift folded into a gas giant's cloud-column palette so it
// reads ruddy-Jovian rather than pale-Saturnian — compensates for the
// gas-mix model not representing condensed-phase chemistry (NH4SH, etc.).
// Gated on the Jupiter-class gaseous predicate (isGasGiant).
const GAS_GIANT_TINT = { color: new Color(0xc88848), amount: 0.25 };

// Lerp `c` toward `tint.color` by `tint.amount`. Returns `c` unchanged
// when `tint` is undefined. Applied to surface palette entries to fold
// in the per-class hue tint (gas-giant warm shift, etc.).
function applyTint(c: Color, tint: { color: Color; amount: number } | undefined): Color {
  if (!tint) return c;
  return lerpColor(c, tint.color, tint.amount);
}

// Build the per-body palette + scalars for one disc. discPx is the
// final rendered diameter — sub-PROCEDURAL_TEXTURE_MIN_PX bodies force
// flat fill (palette weights = [1, 0, 0]) so tiny moons don't render
// as noise.
export function buildDiscPalette(
  body: Body,
  discPx: number,
): DiscPalette {
  const seed = hash32(`disc:${body.id}`) / 0x100000000;
  const surfaceOpacity = body.surfaceOpacity;
  const hasSurface = surfaceOpacity > 0;
  const tinyDisc = discPx < PROCEDURAL_TEXTURE_MIN_PX;

  // ── SURFACE PALETTE — one primary colour (terraced into elevation shades by
  // the shader) for terrestrials, bulk-atm column tint for gas/ice giants.
  // World-class colour re-enters as a flat-fill fallback when a body carries no
  // resource signal at all.
  //
  // Slot mapping (terrestrials with N>=1 nonzero resources):
  //   slot 0 = the primary surface colour — the PRIMARY resource hue diluted
  //            toward regolith by (1 − a0). Pure primary-over-regolith; the
  //            secondary is NOT tinted in here. The shader terraces it.
  //   slot 1 = the raw SECONDARY resource hue, which the shader floods into the
  //            low ground (up to an elevation level set by vWeights.y = a1).
  //   slot 2 = schema filler (equal to slot 0; the shader reads slot 0).
  //
  // vWeights.x = a0 splits the disc into Uplands (resource patch, area a0) and
  // Lowlands (regolith, 1 − a0), biasing the shader's elevation field.
  // vWeights.y = a1 is NOT an area — it sets the secondary stain's flood level.
  // So the secondary still claims no patch; it only colours.
  let sC0: Color, sC1: Color, sC2: Color;
  let sW0: number, sW1: number, sW2: number;
  if (!hasSurface) {
    const colColor = atmColumnColor(body) ?? NO_ATM_FALLBACK_COLOR;
    sC0 = colColor; sC1 = colColor; sC2 = colColor;
    sW0 = 1; sW1 = 0; sW2 = 0;
  } else {
    const res = dominantResources(body, 2);
    if (res.length === 0) {
      // No resource signal at all — fall back to neutral barren regolith.
      // (Procgen virtually always populates at least one res scalar for
      // terrestrials, so this branch is defensive against curated rows
      // with the entire grid empty.)
      const base = BARREN_ROCK_COLOR;
      sC0 = base; sC1 = base; sC2 = base;
      sW0 = 1; sW1 = 0; sW2 = 0;
    } else {
      const k0 = res[0].key;
      const k1 = res[1]?.key ?? null;
      const a0 = res[0].abundance;
      const a1 = res[1]?.abundance ?? 0;
      // Slot 0 — the PRIMARY surface colour the shader shades into the four
      // zones: the primary resource's hue diluted toward regolith by the
      // REGOLITH SHARE (1 − a0), so a rich world keeps its resource hue and a
      // poor one washes toward barren grey. PURE primary-over-regolith — the
      // secondary is deliberately NOT tinted in here.
      // Slot 1 — the raw SECONDARY hue. The secondary enters ONLY through the
      // shader's Lowlands blend (weight.y carries a1 as the blend amount): it
      // stains the low ground and leaves the Uplands pure primary. It still
      // claims no AREA. Slot 2 is schema filler (the shader reads slot 0).
      const resHue = applyPerBodyTints(rockArchetypeFor(k0, null, 1), body, seed);
      const secHue = k1 !== null
        ? applyPerBodyTints(rockArchetypeFor(k1, null, 1), body, seed)
        : resHue;
      const regolith = applyPerBodyTints(REGOLITH_BASE_COLOR, body, seed);
      const primary = lerpColor(resHue, regolith, clamp01(1 - a0));
      sC0 = primary; sC1 = secHue; sC2 = primary;
      // AREA — the resource (Uplands) covers the primary abundance, regolith
      // (Lowlands) the rest. vWeights.x = a0 drives the shader's elevation bias.
      // Clamped away from 0/1 by ZONE_AREA_FLOOR: a pure motherlode (a0 = 1)
      // would otherwise leave no Lowlands — no shoreline, so the elevation bias
      // would have no low pole. Only the extreme tails move; the "area =
      // abundance" mapping is exact through the middle of the range.
      const upArea = Math.min(1 - ZONE_AREA_FLOOR, Math.max(ZONE_AREA_FLOOR, clamp01(a0)));
      sW0 = upArea;
      sW1 = clamp01(a1);  // → vWeights.y: the secondary's stain flood level, NOT an area
      sW2 = 1 - upArea;
    }
  }

  // ── ATM COLUMN COLOR — what fills the void on a no-surface body.
  // Pure atm blend; no cloud / haze contribution. Black on bodies
  // with no atmosphere data (always overwritten by surface where
  // surface paints).
  const atmColC = atmColumnColor(body);
  const atmColumnRgb: readonly [number, number, number] = atmColC
    ? [atmColC.r, atmColC.g, atmColC.b]
    : [0, 0, 0];

  // Force flat fill on very small discs — the per-pixel hash texture and
  // the band strips degrade to noise below PROCEDURAL_TEXTURE_MIN_PX. That
  // floor now sits under the moon disc range, so in practice no body trips
  // this; it stays as a guard for anything that renders tinier later.
  if (tinyDisc) {
    sW0 = 1; sW1 = 0; sW2 = 0;
  }

  // Surface scalars — suppressed on no-surface bodies (the surface
  // block is unreachable there) and on tiny discs.
  const surfaceSuppressed = !hasSurface || tinyDisc;
  const liquidFrac = surfaceSuppressed ? 0   : (body.surfaceLiquidFraction ?? 0);
  const iceFrac    = surfaceSuppressed ? 0   : (body.iceFraction   ?? 0);
  const surfaceAge = surfaceSuppressed ? 0.5 : (body.surfaceAge ?? 0.5);
  // Coverage is a pure function of iceFraction. No (1 − liquidFrac) factor:
  // procgen's surfaceIceCover already split the surface into separate liquid
  // and ice budgets per the solvent's actual freeze point, so suppressing
  // coverage by liquid extent here would double-count what iceFraction
  // already excludes.
  const iceCoverage = surfaceSuppressed ? 0 : iceCoverageForFraction(iceFrac);

  // Terrain roughness — relief terrace count + feature granularity, derived
  // from stored physics. Defaulted on suppressed surfaces (the surface block is
  // unreachable there) so the texel pack stays uniform.
  const { reliefBands, granularity } = surfaceSuppressed
    ? { reliefBands: 1, granularity: 0.5 }
    : terrainRoughnessFor(body);

  // Ice-shell composition fraction — how ice-dominated the BULK is, a continuous
  // smoothstep (no hard threshold) over bulkWater+bulkVolatile. Drives whether
  // the shader's frozen surface ages as a dust-mantled ice shell (Callisto, → 1)
  // or a bright rocky snowball (→ 0), blending continuously across the middle.
  // 0 on suppressed surfaces.
  const shellFraction = surfaceSuppressed ? 0 : shellFractionFor(body);

  // Unified haze blend — one color + one opacity per body, derived
  // from the atmospheric contributor list (bulk gases × pressure ×
  // potency, Rayleigh scattering, formation-gated aerosol products,
  // lifted dust). Runs for every body now that the surface gate is
  // gone; gas giants typically land at low hazeOpacity from bulk
  // atm contributions alone (no surfacePressureBar → 0 for those
  // contributors, only aerosol formation gates fire). Computed once
  // here and threaded into oceanColorFor (its Fresnel sky-reflect
  // pathway needs the same blend) so the contributor walk runs once.
  const hazeRaw = tinyDisc
    ? { color: new Color(0, 0, 0), opacity: 0 }
    : hazeBlendFor(body);
  const oceanColor = surfaceSuppressed ? OCEAN_FALLBACK_COLOR : oceanColorFor(body, hazeRaw);

  // ── LAVA / MOLTEN-SURFACE EMISSION — three continuous melt drives folded
  // to (coverage, emission temp, sulfur hue). See lavaDrivesFor in ./lava.
  // Suppressed surfaces (no-surface / tiny disc) emit nothing, so the
  // shader's molten sub-pass early-outs.
  let { moltenCoverage, emissionTempNorm, lavaSulfurFrac, lavaCrustColor, emberTint } = surfaceSuppressed
    ? { moltenCoverage: 0, emissionTempNorm: 0, lavaSulfurFrac: 0, lavaCrustColor: LAVA_CRUST_FALLBACK, emberTint: EMBER_TINT_NEUTRAL }
    : lavaDrivesFor(body, surfaceAge);
  // Gaseous self-emission — hot/ultra-hot giants glow from their own heat.
  // Reuses the emissionTempNorm channel + the shader's emberRamp, but the
  // shader paints it as a smooth GLOBAL glow under the cloud decks (no
  // lava-lake geometry). moltenCoverage stays 0 — unused on the no-surface
  // path. tinyDisc still suppresses (the glow needs disc area to read).
  if (!hasSurface && !tinyDisc) {
    emissionTempNorm = giantEmissionNormFor(body);
  }

  // Biome stipple — same suppression as terrain scalars.
  const biomePaint = surfaceSuppressed ? null : biomePaintFor(body);
  const biomeColor: readonly [number, number, number] = biomePaint
    ? [biomePaint.color.r, biomePaint.color.g, biomePaint.color.b]
    : [0, 0, 0];
  const biomeCoverage = biomePaint ? biomePaint.coverage : 0;

  // Cloud layer scalars + per-deck color. One condensate per deck;
  // banded character emerges from coverage rents revealing the deck
  // below, not from in-deck mixing. tinyDisc suppresses all decks
  // since per-fragment worley would resolve as noise on a small disc.
  //
  // No-surface bodies get a synthetic "base" deck prepended at altitude
  // 0.0 — the bulk atm column rendered through the same worley + lat-
  // keyed brightness-jitter machinery as real cloud decks, with the
  // deck color lerped slightly toward white so it reads as "the body's
  // bulk color, gently banded" rather than a flat fill. Coverage 0.95
  // leaves occasional rents that reveal the pure atm column beneath
  // for subtle wispy variety. Wind matches the topmost real deck so
  // the base deck's bands share geometry with the chemistry decks
  // above it (no-deck bodies fall back to BASE_DECK_WIND_DEFAULT).
  const cloudLayers = tinyDisc
    ? []
    : (() => {
        const decks: Array<{
          coverage: number;
          windSpeedMS: number;
          altitudeNorm: number;
          color: readonly [number, number, number];
        }> = body.cloudLayers.map((l) => {
          const dp = cloudDeckPalette(body, l.gas);
          return {
            coverage: l.coverage,
            windSpeedMS: l.windSpeedMS,
            altitudeNorm: l.altitudeNorm,
            color: [dp.color.r, dp.color.g, dp.color.b] as const,
          };
        });
        if (!hasSurface && atmColC !== null) {
          const topWind = decks.reduce(
            (max, d) => (d.windSpeedMS > max ? d.windSpeedMS : max),
            BASE_DECK_WIND_DEFAULT,
          );
          // The base deck claims slot 0, so the real decks must fit in the
          // remaining MAX_CLOUD_LAYERS-1 slots — the geometry packer
          // (body-disc.ts) and shader both hard-cap at MAX_CLOUD_LAYERS and
          // would otherwise silently drop the tail. Trim from the BOTTOM:
          // decks are altitude-ascending, the base already supplies the
          // banded foundation, and the highest deck carries the identity
          // color (e.g. the CH4 cyan that reads an ice giant as Uranus/
          // Neptune-class). Keeping the trim here also keeps the rim merger
          // below consistent with what the disc actually renders.
          const maxRealDecks = MAX_CLOUD_LAYERS - 1;
          if (decks.length > maxRealDecks) decks.splice(0, decks.length - maxRealDecks);
          const baseColor = lerpColor(atmColC, WHITE_COLOR, BASE_DECK_LIGHTNESS_LIFT);
          decks.unshift({
            coverage: BASE_DECK_COVERAGE,
            windSpeedMS: topWind,
            altitudeNorm: 0.0,
            color: [baseColor.r, baseColor.g, baseColor.b] as const,
          });
        }
        return decks;
      })();

  const hazeOpacity = hazeRaw.opacity;
  const hazeColorRgb: readonly [number, number, number] = [hazeRaw.color.r, hazeRaw.color.g, hazeRaw.color.b];

  // Rim color — every visible channel folded into one weighted blend.
  // Per-deck cloud bases enter weighted by their own coverage; haze
  // contributors enter at their physics-derived weights. No-surface
  // bodies add the atm column tint as the deep-column signal that
  // dominates at the limb when clouds don't fully occlude.
  let rimColorRgb: readonly [number, number, number] = [0, 0, 0];
  let rimWidthPx = 0;

  if (!tinyDisc) {
    const entries: Array<{ color: { r: number; g: number; b: number }; weight: number }> = [];

    // Per-deck cloud bases weighted by that deck's coverage. Higher
    // decks aren't preferred over lower decks at the limb — the rim
    // sees the sum of cloud chemistry.
    for (const dl of cloudLayers) {
      const cr = dl.color[0], cg = dl.color[1], cb = dl.color[2];
      // Channel-sum > 0 is a proxy for "real condensate" — it drops the
      // BLACK_COLOR fallback cloudDeckPalette emits for a gas with no
      // CONDENSATE_COLOR/GAS_COLOR entry. Safe only because every curated
      // condensate/gas color is non-black; a legitimately near-black deck
      // would be silently skipped here.
      if ((cr + cg + cb) > 0) entries.push({ color: { r: cr, g: cg, b: cb }, weight: dl.coverage });
    }
    if (hasSurface) {
      for (const c of surfaceHazeContributors(body)) entries.push(c);
    } else if (atmColC !== null) {
      entries.push({ color: atmColC, weight: 1 });
    }

    const { r, g, b, totalWeight } = weightedColorBlend(entries);
    if (totalWeight > 0) {
      rimColorRgb = [r, g, b];
      rimWidthPx = hasSurface
        ? rimWidthForSurfaceAtmosphere(body)
        : rimWidthForNoSurfaceAtmosphere(body);
      // Presence floor — Mars-class thin-air bodies that fall through
      // the pressure tiers still get a visible rim if the merger
      // produced any signal, distinguishing "has air" from "airless".
      if (hasSurface && rimWidthPx === 0) {
        rimWidthPx = RIM_PRESENCE_FLOOR_PX;
      }
    }
  }

  // Per-body limb Rayleigh scatter color + strength for the rim hue shift.
  // Suppressed on tiny discs alongside the rest of the atmosphere paint.
  const scatter = tinyDisc
    ? { color: [0, 0, 0] as readonly [number, number, number], strength: 0 }
    : scatteringRimFor(body);

  // Per-class hue tint applies to surface palette entries only. Cloud
  // palettes already derive from physically-anchored gas species and
  // skip the tint so cloud colors stay aligned with their condensates.
  // The warm amber is faded out by the hot-giant column collapse so it
  // never re-brightens a column that atmColumnColor has already darkened —
  // amber survives only on cold/warm Jupiters, gone by the hot-Jupiter band.
  const tint = isGasGiant(body)
    ? { color: GAS_GIANT_TINT.color, amount: GAS_GIANT_TINT.amount * (1 - hotGiantColumnDarkening(body)) }
    : undefined;
  const t0 = applyTint(sC0, tint);
  const t1 = applyTint(sC1, tint);
  const t2 = applyTint(sC2, tint);

  return {
    palette: [
      t0.r, t0.g, t0.b,
      t1.r, t1.g, t1.b,
      t2.r, t2.g, t2.b,
    ] as const,
    weights: [sW0, sW1, sW2] as const,
    atmColumnColor: atmColumnRgb,
    surfaceOpacity,
    seed,
    tilt: bodyVisualTiltRad(body),
    waterFrac: liquidFrac,
    oceanColor,
    iceFrac,
    biomeColor,
    biomeCoverage,
    cloudLayers,
    hazeOpacity,
    hazeColor: hazeColorRgb,
    rimColor: rimColorRgb,
    rimWidthPx,
    scatterColor: scatter.color,
    scatterStrength: scatter.strength,
    surfaceAge,
    reliefBands,
    granularity,
    shellFraction,
    iceCoverage,
    moltenCoverage,
    emissionTempNorm,
    lavaSulfurFrac,
    lavaCrustColor,
    emberTint,
  };
}
