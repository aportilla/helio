// Body / planet render palette — the color-science layer that turns a
// body's physical + compositional data into the colors the system-view
// disc shader and HUD paint. Split out of data/stars.ts (the catalog
// API) so the data layer stays a thin catalog wrapper: biome pigment ×
// stellar shift, the world-class diagrammatic colors, per-gas cloud /
// scattering / haze hues + potencies, the rock-archetype mineralogy
// LUTs, cloud-deck + stratospheric-haze derivation, and the
// resource→color helpers. Consumed by disc-palette/ (the per-body
// palette orchestrator), the belt / ring layers, and the system-view
// HUD cards.
//
// The atmosphere / resource vocabulary types (AtmGas, ResourceKey) live
// in data/stars.ts with the rest of the data model; this module imports
// them.

import { Color } from 'three';
import {
  STARS, BODIES,
  type Body, type SpectralClass,
  type BiosphereArchetype, type AtmGas, type ResourceKey,
} from '../../data/stars';

// Identity colors — the single source for white / black across the render
// palette. They live in this leaf module (not disc-palette/shared.ts, which
// depends on it) so both layers share one instance; disc-palette/shared.ts
// re-exports them for its own consumers. Treated as read-only: callers pass
// them to lerpColor (which allocates a fresh Color) and never mutate in place.
export const WHITE_COLOR = new Color(1, 1, 1);
export const BLACK_COLOR = new Color(0, 0, 0);

// (Disc base color is composed from physics + resources — rock-archetype
// mineralogy, ocean optics, biome paint, atm-column tint, belt icyness — not
// from a per-category LUT. The former WORLD_CLASS_COLOR / _TINT tables were
// near-vestigial fallbacks; the one live use, a gas-giant warm shift, now
// lives in disc-palette/index.ts keyed off the body archetype.)

// =============================================================================
// Biome paint — archetype × stellar class drives a pixel-stipple color
// =============================================================================

// Base pigment hue assuming G-class (Sun-like) starlight. The archetype
// captures the *chemistry* of the biosphere; BIOME_STELLAR_SHIFT below
// then rotates the hue to reflect the host star's actual spectrum.
//
// `null` archetypes don't paint a surface stipple: subsurface_aqueous
// life is under ice (Europa/Enceladus) so it never reaches the visible
// surface; aerial biospheres only appear on banded bodies, which take a
// different render path entirely.
export const BIOME_TINT_COLOR: Record<BiosphereArchetype, Color | null> = {
  carbon_aqueous:     new Color(0x3a8a3a),   // Earth's chlorophyll forest green
  subsurface_aqueous: null,                  // under-ice; no visible surface signal
  aerial:             null,                  // banded mode only
  cryogenic:          new Color(0x8b6f3f),   // hydrocarbon-cycle ochre (Titan-style)
  silicate:           new Color(0x6b8070),   // mineral-metabolism sage-grey
  sulfur:             new Color(0xa07020),   // sulfur-cycle mustard-brown
};

// Stellar-class hue rotation. Photosynthetic pigments evolve to absorb
// the wavelengths the host star delivers most strongly; the *reflected*
// color shifts accordingly (Kiang et al. on alien photosynthesis).
// Earth at G is the calibration anchor (identity); cooler stars push
// reflectance redder, hotter stars push it gold.
//
// Applied uniformly across archetypes for simplicity — sulfur/cryogenic
// biospheres aren't photosynthetic, but their characteristic hues still
// look "alien" when shifted by host class, and the alternative would
// collapse 60% of catalog (M-dwarf systems) to indistinguishable color.
//
// `null` suppresses biome render entirely:
//   - O, B: stellar lifetimes too short for biosphere evolution
//   - WD, BD: insufficient luminosity for a surface biosphere
export const BIOME_STELLAR_SHIFT: Record<SpectralClass, { color: Color; amount: number } | null> = {
  O:  null,
  B:  null,
  A:  { color: new Color(0xd4a050), amount: 0.40 },   // warm gold — reflect red/orange under blue input
  F:  { color: new Color(0xc8a868), amount: 0.25 },   // subtle warm shift from G baseline
  G:  { color: WHITE_COLOR, amount: 0.00 },           // identity — Earth baseline
  K:  { color: new Color(0xa04030), amount: 0.50 },   // rust-red under K-dwarf reddening
  M:  { color: new Color(0x6a3088), amount: 0.70 },   // "Purple Earth" under M-dwarf red/IR
  WD: null,
  BD: null,
};

// Surface-impact threshold below which biome stipple doesn't render at
// all — eliminates noise from worlds with trace biotic signature
// (surfaceImpact ≈ 0.01) that would paint a few stray pixels and read
// as a bug. Matches the lower bound of the BIOME_RENDER 'trace'
// impact bucket so card label and rendered stipple flip on together.
const BIOME_RENDER_THRESHOLD = 0.05;

// Coverage scale factor — multiplies the body's surfaceImpact to
// produce the stipple coverage fraction. Earth at surfaceImpact ≈ 0.85
// × scale=0.94 lands at ~0.80 coverage, preserving Earth's visual
// identity. Subsurface-dominant worlds collapse to zero coverage via
// the archetype filter below (no surface pigment defined) regardless
// of their surfaceImpact tail.
const BIOME_COVERAGE_SCALE = 0.94;

// Per-channel color lerp — the shared primitive for this palette module
// (biome paint, tints). The canonical copy now that the palette lives
// here; disc-palette consumers can import this rather than re-implement.
export function lerpColor(base: Color, target: Color, amount: number): Color {
  return new Color(
    base.r + (target.r - base.r) * amount,
    base.g + (target.g - base.g) * amount,
    base.b + (target.b - base.b) * amount,
  );
}

// Resolve a body's biome stipple paint by reading the body's derived
// biosphere fields. The body's dominant archetype + its surfaceImpact
// scalar already encode "what kind of life" and "how much it shows" —
// the renderer just looks up the pigment hue × stellar shift and
// scales coverage by surfaceImpact.
//
// Returns null when no stipple should render — sterile bodies (impact
// below threshold), bodies whose dominant archetype is pigment-null
// (subsurface, aerial), or hosts whose stellar class can't support a
// biosphere.
//
// Resolves through the host chain: planet → its host star; moon → its
// host planet → that planet's host star. Hostless bodies (procgen edge)
// return null rather than guessing.
// Resolve a body to the catalog index of the star it orbits, walking
// moon → host-planet → star. Returns null when the chain is broken (no
// host, or a moon whose host has no star). The single source for that
// walk, shared by ocean stellar-tinting and biome stellar-shift — if the
// host model grows (moons-of-moons, binary-host disambiguation) the change
// lands here once instead of in two hand-synced copies.
export function hostStarIdxOf(body: Body): number | null {
  if (body.kind === 'planet' && body.hostStarIdx !== null) return body.hostStarIdx;
  if (body.kind === 'moon' && body.hostBodyIdx !== null) {
    const host = BODIES[body.hostBodyIdx];
    if (host !== undefined && host.hostStarIdx !== null) return host.hostStarIdx;
  }
  return null;
}

export function biomePaintFor(body: Body): { color: Color; coverage: number } | null {
  const arch = body.biosphereArchetype;
  const impact = body.biosphereSurfaceImpact;
  if (arch === null || impact === null || impact < BIOME_RENDER_THRESHOLD) return null;

  const base = BIOME_TINT_COLOR[arch];
  if (base === null) return null;

  const starIdx = hostStarIdxOf(body);
  if (starIdx === null) return null;
  const star = STARS[starIdx];
  if (!star) return null;
  const shift = BIOME_STELLAR_SHIFT[star.cls];
  if (shift === null) return null;

  const color = shift.amount > 0 ? lerpColor(base, shift.color, shift.amount) : base;
  const coverage = Math.min(1, impact * BIOME_COVERAGE_SCALE);
  return { color, coverage };
}

// Endpoints of the rocky↔icy palette lerp, private to beltRingColor below —
// belts and rings consume the blend through that helper, not the raw colors.
const BELT_RING_COLOR_ICY   = new Color(0xb8d8e8);  // pale cyan (Saturn/KBO ice)
const BELT_RING_COLOR_ROCKY = new Color(0xa89060);  // brown-tan (Main Belt rocky)

// Map a body's resource grid to a 0..1 icyness scalar. Volatiles drive
// the bright icy end; metals + silicates + rare earths drive the rocky
// end. Returns 0.5 when the body carries no resource signal at all
// (defensive fallback — every architect/CSV emit should set the grid).
// Used by both ring and belt rendering to read composition off the same
// data that drives mining yields.
export function bodyIcyness(body: Body): number {
  const v = body.resVolatiles ?? 0;
  const rocky = (body.resMetals ?? 0) + (body.resSilicates ?? 0) + (body.resRareEarths ?? 0);
  const denom = v + rocky;
  if (denom <= 0) return 0.5;
  return v / denom;
}

// Rocky↔icy disc color for a belt or ring at the given icyness scalar.
// Takes the scalar (not the body) because belts also reuse it for chunk
// shape selection, so the caller computes bodyIcyness once and shares it.
// Allocates a fresh Color so the BELT_RING_COLOR_* endpoints stay read-only.
export function beltRingColor(icyness: number): Color {
  return new Color().copy(BELT_RING_COLOR_ROCKY).lerp(BELT_RING_COLOR_ICY, icyness);
}

// Archetypal hue per atmospheric gas. Picked to read at small disc sizes
// as "what's in the air" rather than as photoreal sky color — the
// rendering target is pixel-banded discs at 40-120 px, not a globe.
export const GAS_COLOR: Record<AtmGas, Color> = {
  N2:  new Color(0xb8c4d8),  // pale slate (mostly transparent in reality)
  O2:  new Color(0x8ec0e4),  // cool blue
  CO2: new Color(0xd8a878),  // dusty ochre (Venus)
  H2O: new Color(0xe4ecf0),  // near-white cloud
  CH4: new Color(0x5cb4d0),  // CH4-absorption cyan (Uranus/Neptune). Low R
                              // (methane absorbs strongly in red 619/727/793 nm
                              // bands), high G (less absorbed), high B. Calibrated
                              // for thin CH4 columns (1-3% atm fraction) — Neptune
                              // pale cyan rather than deep saturated azure.
  NH3: new Color(0xc89860),  // warm amber — Jovian NH3 ice cloud
  SO2: new Color(0xc8a448),  // sulfurous yellow
  Ar:  new Color(0xa8b0b8),  // grey neutral
  CO:  new Color(0x988478),  // smoky brown
  H2:  new Color(0xf0e4c8),  // pale Jovian
  He:  new Color(0xf4e8d4),  // Jovian cream
  // Aerosol / reaction-product species — only emitted via cloudGas or
  // the hazeAerosols contributor list, never via atm priors. The color
  // is what the visible condensate / aerosol actually looks like as a
  // layer; procgen runs the chemistry gates that decide whether the
  // species forms (so the renderer paints exactly what procgen says —
  // no chemistry magic).
  H2SO4:       new Color(0xd8c474),  // yellow-cream — Venus sulfuric acid deck
  SILICATE:    new Color(0x788098),  // refractive silicate-cloud grey-blue
  IRON:        new Color(0xbcb0a0),  // reflective metallic warm-grey — iron-droplet deck
  TIO:         new Color(0x2e241c),  // near-black warm — Ti/V-oxide dayside absorber
  DUST:        new Color(0xa86040),  // ferric oxide rust — Mars-class dust
  THOLIN:      new Color(0xc88040),  // orange — Titan tholin (CH4+N2+UV photolysis)
  NH4SH:       new Color(0xc88250),  // warm tan-orange — Jovian belt brown (NH4SH condensate)
  CHROMOPHORE: new Color(0xc04830),  // deep brick-red — Jovian Great Red Spot pigment (PH3 photolysis)
  SALT:        new Color(0xc0d4d8),  // pale blue-white — KCl/ZnS sub-Neptune haze
  SULFUR:      new Color(0xe8d048),  // bright yellow — S8 elemental sulfur (Io-class volcanic)
};

// Condensed-phase ice / frost colors — used when a gas is the body's
// cloud species. Sparse: only species whose ice/frost form reads
// visibly different from GAS_COLOR get an entry. CH4 gas is cyan-blue
// (Uranus absorption) but CH4 ICE is pale frost (Triton, Pluto polar
// caps). NH3 gas is amber but NH3 ICE is pale off-white. Species not
// listed fall back to GAS_COLOR (the species is already an aerosol
// like H2SO4/SILICATE/DUST/THOLIN/NH4SH — its color IS its visible
// form, no separate condensate appearance).
export const CONDENSATE_COLOR: Partial<Record<AtmGas, Color>> = {
  CH4: new Color(0xdce8ec),  // pale methane frost
  NH3: new Color(0xf5f0e4),  // bright cream-white ammonia ice — Jovian zones
  N2:  new Color(0xe4e8eb),  // pale nitrogen frost (Triton)
  H2O: new Color(0xe4ecf0),  // water ice / cloud droplets
  IRON: new Color(0xcabea8),  // brighter metallic deck — molten-iron droplets reflect grey-white
};

// Per-gas "visual potency" — how much each gas contributes to the disc's
// apparent color *per unit molar fraction*. Decoupled from abundance
// because the two correlate poorly: Uranus and Neptune are 95%+ H2/He
// (transparent) and read as blue *because of* 1.5-2.3% CH4, which is a
// strong red-light absorber. Mass-fraction-weighted color would paint
// them as cream-and-trace-blue (wrong); potency-weighted color paints
// them as mostly CH4 with cream accents (right).

// Universal scales for the unified haze blend — Σ (per-species weight
// × GAS_POTENCY) × scale, summed across the four contributor channels,
// then soft-capped via 1 - exp(-Σ) to land in [0, 1).
//
// The bulk-gas, aerosol, and dust weights are each multiplied by
// `atmColumnFactor(body)` in `surfaceHazeContributors` — log10(P/g_norm + 1),
// a compressed Earth-normalized column that suits opacity saturation for
// those terms. Low-gravity bodies (Titan, Pluto) accumulate more atmospheric
// mass per unit surface pressure than Earth, so their haze saturates at lower
// P than the raw surface-pressure model implied. These scales are calibrated
// against thick-column anchors (Titan-class for aerosol, Venus-class for bulk
// gas). The clear-gas Rayleigh term is the exception — it scales with the
// LINEAR column (see CLEAR_GAS_OPACITY). Tune these globals, not per-species
// coefficients, if anchors drift. This is the single source of truth: the
// haze category scales are applied renderer-side (disc-palette/atmosphere.ts),
// not in procgen, which emits raw 0..1 strengths.
export const HAZE_BULK_GAS_SCALE = 0.2;
export const HAZE_AEROSOL_SCALE  = 1.25;
export const HAZE_DUST_SCALE     = 3.0;
// Rim-hue ratio only. Sets the Rayleigh fraction of the limb's clear-air
// color in `scatteringRimFor` (where its absolute value cancels in the
// rs/(rs+bs) ratio); the haze OPACITY contribution from clear gas is driven
// by CLEAR_GAS_OPACITY below, not this.
export const HAZE_RAYLEIGH_SCALE = 0.15;

// Clear-gas (Rayleigh) self-obscuration — how much a body's own clear
// atmosphere veils its surface. This is the visual-tuning knob for "thick
// clear air hides the ground."
//
// Physics: Rayleigh optical depth scales LINEARLY with the gas column (∝ P/g),
// not logarithmically like the aerosol/dust terms. Earth's whole 1-bar air
// column has τ ≈ 0.1 in the visible (which is why the ground stays crisp from
// orbit), so the clear-gas haze weight is (Earth-normalized linear column,
// `rayleighColumn`) × this anchor, fed through the shared 1 - exp(-Στ) soft
// cap — which makes that cap the exact Beer–Lambert obscuration law. At the
// physically faithful value 0.1: Earth reads as a faint blue veil, a ~10-bar
// N₂ world (τ≈1) a strong haze, and 50–200-bar worlds saturate to a fully
// obscured blue scattering ball (correct — 200 bar of clear N₂ has τ≈20, the
// surface is genuinely invisible).
//
// Deliberately a GAMEPLAY lever, not only a physics constant: LOWER it to let
// surface character bleed through thick clear atmospheres more than pure
// optics allow (trading realism for legibility of the surface archetype);
// raise it past 0.1 to over-obscure. Only the clear-gas Rayleigh term reads
// this — absorbing-gas tint, aerosols, and dust keep their log-column scaling.
export const CLEAR_GAS_OPACITY = 0.1;

// Per-gas clear-air scattering color — the visible tint of an
// atmosphere viewed edge-on through a long column with no haze layer
// to obscure it. Used by the disc rim's clear-air branch in
// disc-palette/atmosphere.ts, keyed per gas so each column tints by its
// own dominant species.
//
// Rayleigh-blue is the canonical case (N2/O2/Ar bulk atmospheres),
// but CH4-absorbing columns tint cyan-blue (the Uranus/Neptune signal,
// also relevant for any deep-atm window through a methane-rich
// terrestrial), CO2-thick columns tint warmer, and SO2-tinted air
// goes yellow-orange.
//
// Aerosol-only species (H2SO4, SILICATE, DUST) never appear in the
// clear-air gas list — their entries are placeholders.
export const SCATTERING_COLOR: Record<AtmGas, Color> = {
  N2:  new Color(0x8cb4f0),  // pale sky cyan-blue — Rayleigh anchor (Earth)
  O2:  new Color(0x70a0e8),  // cool sky blue
  CO2: new Color(0x90a8c8),  // slightly warmer cyan
  CH4: new Color(0x6090d8),  // cyan-blue — selective red absorber
  H2O: new Color(0xc0d0e0),  // pale cool — water vapor scatters weakly
  NH3: new Color(0xd8c890),  // pale cream
  SO2: new Color(0xc8b478),  // yellow — sulfur-tinted air
  Ar:  new Color(0xa8b0b8),  // neutral grey
  CO:  new Color(0x9c8c7c),  // brown-grey
  H2:  new Color(0xe8d8b8),  // pale cream — weak scattering
  He:  new Color(0xece0c4),  // pale cream
  // Aerosol / product-only species don't enter the clear-air scattering
  // blend — they're handled exclusively by the haze layer.
  H2SO4:       new Color(0xc0c0c0),
  SILICATE:    new Color(0xa0a0a0),
  IRON:        new Color(0xb0a890),
  TIO:         new Color(0x2e241c),
  DUST:        new Color(0xa86040),
  THOLIN:      new Color(0xc88040),
  NH4SH:       new Color(0xc88250),
  CHROMOPHORE: new Color(0xc04830),
  SALT:        new Color(0xc0d4d8),
  SULFUR:      new Color(0xe8d048),
};

// Per-gas weight in the clear-air scattering blend. Different from
// GAS_POTENCY (which captures cloud-band visibility): scattering is
// driven by Rayleigh efficiency + selective absorption, not condensate
// chemistry. Bulk gases (N2/O2/CO2) dominate via fraction × Rayleigh
// strength; selective absorbers (CH4, SO2) get amplified weights so
// they color the column even at low fractions; H2/He/Ar are weak.
//
// Aerosol species have potency 0 — they never appear in the clear-air
// blend (haze layer takes over before they could).
export const SCATTERING_POTENCY: Record<AtmGas, number> = {
  N2:  1.0,  // Rayleigh anchor
  O2:  1.2,  // slightly stronger Rayleigh than N2
  CO2: 0.8,  // weaker Rayleigh, warmer tint
  Ar:  0.3,  // monatomic, weak scatterer
  CH4: 4.0,  // strong red absorber — cyan signal dominates at low frac
  SO2: 2.0,  // yellow-orange tint
  H2O: 0.5,  // mostly clouds, weak gas-phase scattering
  NH3: 0.5,
  CO:  0.5,
  H2:  0.3,  // nearly transparent
  He:  0.3,
  H2SO4:       0,
  SILICATE:    0,
  IRON:        0,
  TIO:         0,
  DUST:        0,
  THOLIN:      0,
  NH4SH:       0,
  CHROMOPHORE: 0,
  SALT:        0,
  SULFUR:      0,
};

// GAS_POTENCY (per-gas visible-band absorption weight) is shared with procgen's
// cloud-deck visibility gate, so the table lives once in
// scripts/lib/gas-potency.mjs and is re-exported here. Typed
// Record<AtmGas, number> via gas-potency.d.mts.
export { GAS_POTENCY } from '../../../scripts/lib/gas-potency.mjs';

// Canonical resource palette — the SINGLE SOURCE OF TRUTH for the six resource
// hues. Both the gameplay-signal palette (RESOURCE_COLOR — belt chunks,
// info-card ratings, atmospheric dust via dustColorFor) and the disc-surface
// mineralogy palette (ROCK_ARCHETYPE_SINGLE) derive from this, so a palette
// retune lands in exactly one place and the belt/panel signal can't drift out
// of sync with the planet surface.
export const RESOURCE_HEX: Record<ResourceKey, number> = {
  resMetals:       0x626262,  // neutral mid grey (cold metallic / iron)
  resSilicates:    0xb5a841,  // gold-khaki (rocky regolith, dust)
  resVolatiles:    0x888773,  // pale sage grey (ices / frost)
  resRareEarths:   0x773c4d,  // mauve-wine (monazite / REE ore)
  resRadioactives: 0x7a5b19,  // umber-gold (uraninite ore — leans toward the green ember)
  resExotics:      0xbc4c2e,  // burnt orange (exotic anomaly)
};

// Fresh Color per resource from the canonical hex — separate instances so a
// consumer that treats its palette as read-only can't leak a mutation into
// another's.
function resourceColors(): Record<ResourceKey, Color> {
  const out = {} as Record<ResourceKey, Color>;
  for (const k of Object.keys(RESOURCE_HEX) as ResourceKey[]) out[k] = new Color(RESOURCE_HEX[k]);
  return out;
}

// Direct gameplay-signal hue per resource (belt chunks, info-card resource
// ratings, atmospheric dust via dustColorFor). Synced with the disc surface —
// both derive from RESOURCE_HEX above.
export const RESOURCE_COLOR: Record<ResourceKey, Color> = resourceColors();

const RESOURCE_KEYS: readonly ResourceKey[] = [
  'resMetals', 'resSilicates', 'resVolatiles',
  'resRareEarths', 'resRadioactives', 'resExotics',
];

// Per-resource TARGET emission hue the molten ember rotates toward (NOT a
// multiplicative filter — the shader renormalizes this to the ember's own
// luminance then lerps, so a green/rose/violet cast reads at full brightness;
// a multiply could only darken channels, never lift one, so it can't turn an
// orange ember (~(1.0, 0.5, 0.15)) green). Bulk resources (metals/silicates)
// sit near the blackbody ember so they barely shift; the strategic/exotic
// resources carry the vivid casts that read as a gameplay tell. Applied as a
// soft mix AFTER the sulfur green-lift, so the two compose. Hues echo each
// resource's RESOURCE_COLOR identity so the surface palette and the glow agree.
export const RESOURCE_EMBER_TINT: Record<ResourceKey, Color> = {
  resMetals:       new Color(1.0, 0.80, 0.42),  // molten iron — gold-white (≈ blackbody, near no-op)
  resSilicates:    new Color(1.0, 0.88, 0.40),  // silicate melt — yellow (reinforces sulfur)
  resVolatiles:    new Color(0.75, 0.92, 1.0),  // rarely molten — cool steam-blue
  resRareEarths:   new Color(1.0, 0.42, 0.66),  // rare-earth phosphor — rose
  resRadioactives: new Color(0.45, 1.0, 0.32),  // radioluminescence — vivid green tell
  resExotics:      new Color(0.70, 0.40, 1.0),  // exotic-matter anomaly — violet
};

// Ember-cast characterfulness — how strongly a resource pulls the ember hue
// in the per-body blend. Bulk bread-and-butter resources are low so they don't
// wash out a dramatic resource's cast; the scarce/strategic/exotic tiers
// dominate, so a metals+radioactives world glows green (the radioactives
// signature) rather than averaging to a muddy half-green. Mirrors the label
// philosophy: a notable condition replaces the signature rather than blending.
export const RESOURCE_EMBER_POTENCY: Record<ResourceKey, number> = {
  resMetals:       0.4,
  resSilicates:    0.4,
  resVolatiles:    0.5,
  resRareEarths:   1.0,
  resRadioactives: 1.0,
  resExotics:      1.0,
};

// Single-resource colors for the rocky-surface palette path — what a region
// paints when only one resource dominates it. Derived from the same canonical
// RESOURCE_HEX as RESOURCE_COLOR, so the planet surface and the belt/panel
// gameplay signal stay in lockstep. Pair/blend behaviour lives elsewhere: the
// curated LUT below (for belts / lava via rockArchetypeFor) and the disc-
// palette's primary-over-regolith dilution + Lowlands secondary stain (for the
// planet disc surface).
const ROCK_ARCHETYPE_SINGLE: Record<ResourceKey, Color> = resourceColors();

// Rock-archetype pair LUT — when a region's resource subset contains two
// resources both above threshold, look up the named mineralogy here
// instead of RGB-blending the two single colors. Keyed by a
// "resA|resB" string in RESOURCE_KEYS canonical order (metals →
// silicates → volatiles → rare-earths → radioactives → exotics);
// `rockArchetypeFor` normalizes its two inputs to that same order so the
// lookup is direction-independent. All 15 resource pairs are covered, so
// the RGB-blend branch in `rockArchetypeFor` is now a defensive fallback
// rather than a routine path.
//
// Each color is a real-world mineral analog so a player can learn to
// read the disc: basalt = mafic crust, hematite = iron oxide rust,
// permafrost = cold rocky, sulfur deposits = Io-class warm, obsidian =
// volcanic glass, etc.
const ROCK_ARCHETYPE_PAIR: Record<string, Color> = {
  'resMetals|resSilicates':       new Color(0x988668),  // basalt (mafic crust: Earth ocean, lunar maria, Mars plains)
  'resMetals|resVolatiles':       new Color(0xb0b8bc),  // cryo-rock (Callisto, dark icy moons)
  'resMetals|resRareEarths':      new Color(0xa87868),  // iron oxide / hematite (weathered dusty rust — saturated lava reds reserved for future molten-surface effect)
  'resMetals|resRadioactives':    new Color(0x9c947c),  // uranium-iron metallic (light olive)
  'resMetals|resExotics':         new Color(0x706878),  // lifted obsidian glass
  'resSilicates|resVolatiles':    new Color(0xc8c8c0),  // permafrost (tundra, Mars high lat.)
  'resSilicates|resRareEarths':   new Color(0xd8945a),  // ferric sandstone / ochre desert (Mars rust)
  'resSilicates|resRadioactives': new Color(0xd8c084),  // sulfur deposits (Io-class warm yellow)
  'resSilicates|resExotics':      new Color(0x988494),  // mineralized vein-rock (light purple-brown)
  'resVolatiles|resRareEarths':   new Color(0xdcc4bc),  // reddish ice (tholin-stained outer moons)
  'resVolatiles|resRadioactives': new Color(0xc8ccb8),  // brine ice (pale sage)
  'resVolatiles|resExotics':      new Color(0x9c9cac),  // dark ice (slate)
  'resRareEarths|resRadioactives':  new Color(0xb89868),  // monazite ore (rare-earth phosphate, mildly radioactive — warm yellow-tan)
  'resRareEarths|resExotics':       new Color(0xb488ac),  // exotic pegmatite vein (rose-lavender crystal)
  'resRadioactives|resExotics':     new Color(0x9c8ca4),  // irradiated anomaly (muted violet-grey)
};

// Shade-by-balance magnitude. Inside a pair archetype, the base color is
// lerped toward each contributing resource's single-presence color by
// `(ratioA − 0.5) × SHADE_AMOUNT` so a 70/30 basalt reads visibly more
// iron-grey than a 50/50, and a 30/70 reads tan. Kept small so the
// archetype's identity dominates the visual.
const ROCK_ARCHETYPE_SHADE_AMOUNT = 0.3;

// Neutral barren rock — the muted warm grey regolith the no-resource flat-fill
// backstop falls back to (disc-palette/index.ts), readable as "weathered surface"
// without leaning toward any of the six resource archetypes. Exported so the
// disc-palette shares one source of truth.
export const BARREN_ROCK_COLOR = new Color(0x6c6864);

// Look up the rock archetype for one or two resources, applying shade-
// by-balance for pair entries.
//   - `keyA` alone (keyB = null) → the single-presence color.
//   - `keyA + keyB` with a pair entry → the LUT color, lerped toward
//     keyA's single color by `(ratioA − 0.5) × SHADE_AMOUNT`.
//   - `keyA + keyB` with NO pair entry → straight RGB blend of the two
//     single-presence colors weighted by ratioA / (1 − ratioA). Catches
//     rare/radioactive/exotic combinations that don't have a curated
//     mineralogy.
export function rockArchetypeFor(
  keyA: ResourceKey,
  keyB: ResourceKey | null,
  ratioA: number,
): Color {
  const singleA = ROCK_ARCHETYPE_SINGLE[keyA];
  if (keyB === null) return singleA;
  const singleB = ROCK_ARCHETYPE_SINGLE[keyB];
  // Normalize to RESOURCE_KEYS order — the order the PAIR table is keyed
  // in — so the lookup is direction-independent (a string compare would
  // disagree with the table's order for pairs like silicates+rare-earths).
  const lutKey = RESOURCE_KEYS.indexOf(keyA) <= RESOURCE_KEYS.indexOf(keyB)
    ? `${keyA}|${keyB}`
    : `${keyB}|${keyA}`;
  const pair = ROCK_ARCHETYPE_PAIR[lutKey];
  if (!pair) {
    return new Color(
      singleA.r * ratioA + singleB.r * (1 - ratioA),
      singleA.g * ratioA + singleB.g * (1 - ratioA),
      singleA.b * ratioA + singleB.b * (1 - ratioA),
    );
  }
  const shade = (ratioA - 0.5) * ROCK_ARCHETYPE_SHADE_AMOUNT;
  const towardKey = shade >= 0 ? keyA : keyB;
  const toward = ROCK_ARCHETYPE_SINGLE[towardKey];
  const amount = Math.abs(shade);
  return new Color(
    pair.r + (toward.r - pair.r) * amount,
    pair.g + (toward.g - pair.g) * amount,
    pair.b + (toward.b - pair.b) * amount,
  );
}

// Muted single-resource mineralogy color — the desaturated, lightness-
// lifted hue a region paints when one resource dominates it (the same
// ROCK_ARCHETYPE_SINGLE palette the disc-surface path uses for single-
// resource patches). Returns the shared instance; treat as read-only.
// Exposed for the belt layer, which tints each chunk by one of the
// belt's deposits so a belt reads as a mix of its mineralogy rather
// than one flat icyness lerp.
export function resourceMineralColor(key: ResourceKey): Color {
  return ROCK_ARCHETYPE_SINGLE[key];
}

// Per-deck cloud palette derivation. Each cloud deck is one condensate
// species (NH3 ice, H2O ice, H2SO4 droplets, CH4 frost, ...) suspended
// at one altitude. Its visible color is THAT condensate, plus whatever
// chromophore aerosols physically associate with it — nothing else.
//
// No atm-gas folding here. Transparent atm species (N2, O2, H2, He)
// don't form clouds and don't tint cloud cells. Atm-column absorption
// is a separate concept that paints the void between cloud cells on
// no-surface bodies (see `atmColumnColor` in disc-palette/atmosphere.ts), not the
// cloud itself.
//
// Multi-deck bodies (Jupiter) get one palette per deck: NH3 deck reads
// white + brown + red because procgen emits NH4SH + CHROMOPHORE that
// stain NH3; the H2O deck below stays plain white because no chromophore
// stains H2O. Renderer paints exactly what procgen + this mapping emit.

// Aerosol species the renderer should not paint into the haze blanket
// even if procgen emits a non-zero strength. CHROMOPHORE (PH3 photolysis
// red) is parked here: its visible signal lives in narrow lat-bands and
// can't be honestly represented by a body-wide haze tint, so a future
// pass will reintroduce it as a thin sparse-coverage top deck. Until
// then, ignore renderer-side.
export const RENDERER_SKIP_AEROSOLS: ReadonlySet<AtmGas> = new Set<AtmGas>(['CHROMOPHORE']);

// Gas species present as cloud decks on this body. The haze blanket
// walk should skip aerosols whose species matches one of these — they
// already paint as a deck and shouldn't also blanket the disc.
export function deckGasesFor(body: Body): ReadonlySet<AtmGas> {
  if (body.cloudLayers.length === 0) return new Set<AtmGas>();
  return new Set<AtmGas>(body.cloudLayers.map(l => l.gas));
}

export interface CloudDeckPalette {
  // One color per deck — the condensate (CONDENSATE_COLOR with GAS_COLOR
  // fallback). Multi-color character on banded bodies emerges from
  // coverage rents in upper decks revealing the next-deeper deck, not
  // from in-deck palette mixing.
  readonly color: Color;
}

// Stratospheric haze strength for no-surface bodies (gas / ice giants
// / veiled-ice / helium). Photochemical haze accumulates above the cloud
// decks; colder bodies hold thicker stratospheric haze under their
// slower atmospheric dynamics. Consumed by `hazeBlendFor`
// (disc-palette/atmosphere.ts) to weight the atm column color as a haze
// contributor, so the haze blanket pre-tint inside the per-deck loop
// has a non-zero signal on gas giants. Anchors are temperature, value
// pairs. Piecewise linear; clamped at extremes. Null temperature →
// 0.30 (mild default).
const STRATOSPHERIC_HAZE_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [60, 0.85],
  [134, 0.55],
  [165, 0.15],
  [800, 0.10],
];

export function stratosphericHazeStrengthFor(tempK: number | null): number {
  if (tempK == null) return 0.30;
  const first = STRATOSPHERIC_HAZE_ANCHORS[0]!;
  const last = STRATOSPHERIC_HAZE_ANCHORS[STRATOSPHERIC_HAZE_ANCHORS.length - 1]!;
  if (tempK <= first[0]) return first[1];
  if (tempK >= last[0]) return last[1];
  for (let i = 0; i < STRATOSPHERIC_HAZE_ANCHORS.length - 1; i++) {
    const [t0, s0] = STRATOSPHERIC_HAZE_ANCHORS[i]!;
    const [t1, s1] = STRATOSPHERIC_HAZE_ANCHORS[i + 1]!;
    if (tempK >= t0 && tempK <= t1) {
      const a = (tempK - t0) / (t1 - t0);
      return s0 + (s1 - s0) * a;
    }
  }
  return 0.30;
}

// Per-deck color. One condensate per deck — multi-color character on a
// gas giant emerges from coverage rents revealing the deeper deck, not
// from in-deck palette mixing. Species without a CONDENSATE_COLOR
// entry (H2SO4 droplets, SILICATE particles, etc.) fall back to
// GAS_COLOR — their visible aerosol form is the condensate.
export function cloudDeckPalette(_body: Body, gas: AtmGas): CloudDeckPalette {
  return {
    color: CONDENSATE_COLOR[gas] ?? GAS_COLOR[gas] ?? BLACK_COLOR,
  };
}

// Top `count` resources (default 2) by value, with `abundance` = value/10
// (absolute 0..1 scale, NOT renormalized across the picks). Two callers
// rely on this: the disc-palette lerps each archetype slot toward a
// neutral barren grey by (1 − abundance) so resource-poor worlds read
// as muted regolith, and dustColorFor renormalizes internally to blend
// dust mineralogy. Empty when every res scalar is null/zero — caller
// falls back to a solid world-class color. `key` is exposed so callers
// can look the resource up in any of the parallel tables (RESOURCE_COLOR
// for the saturated gameplay signal, ROCK_ARCHETYPE_SINGLE / _PAIR for
// the realistic surface mineralogy).
export function dominantResources(
  body: Body,
  count = 2,
): Array<{ key: ResourceKey; color: Color; abundance: number }> {
  return RESOURCE_KEYS
    .map(k => ({ key: k, value: body[k] ?? 0 }))
    .filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, count)
    .map(e => ({
      key: e.key,
      color: RESOURCE_COLOR[e.key],
      abundance: Math.min(1, e.value / 10),
    }));
}
