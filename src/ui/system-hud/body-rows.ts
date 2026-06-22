// Body → display-row projection for the system-view info card. Pure
// data-to-presentation mapping — label tables, formatters, and the per-kind
// row builders — split out of body-info-card.ts so the card stays a thin
// BasePanel while this, the part coupled to the catalog vocabulary and a few
// procgen thresholds, lives in one place that can be unit-tested and kept in
// sync with the data layer.

import { BODIES, STARS, type BiosphereArchetype, type BiosphereComplexity, type BiosphereImpactLevel, type Body, type ResourceKey, type SurfaceLiquidSpecies } from '../../data/stars';
import type { BodyOrStarPick } from '../../diagram-pick';
import { composeWorldLabel } from './body-label';
import { isGaseousBody } from '../../../scripts/lib/body-traits.mjs';

// Pretty labels for enum-valued fields. They're a presentation concern, so
// they live here rather than on the data layer. The world-class display
// string is composed richly in body-label.ts; the biosphere / resource
// labels below stay local since they're only used in the rows.

const BIOSPHERE_ARCHETYPE_LABEL: Record<BiosphereArchetype, string> = {
  carbon_aqueous:     'Aqueous',
  subsurface_aqueous: 'Subsurface',
  aerial:             'Aerial',
  cryogenic:          'Cryogenic',
  silicate:           'Silicate',
  sulfur:             'Sulfur',
};
const BIOSPHERE_COMPLEXITY_LABEL: Record<Exclude<BiosphereComplexity, 'none'>, string> = {
  prebiotic: 'Prebiotic',
  microbial: 'Microbial',
  complex:   'Complex',
};

// Surface impact bucket suffix. Mirrors IMPACT_BUCKET_THRESHOLDS in
// procgen-priors.mjs. The 'none' impact level never paints — it's only
// included for type completeness — because complex life always contributes
// additive surface coupling per LIFE_SURFACE_CONTRIBUTION, so anything that
// clears the complexity 'none' gate carries a non-zero impact.
const BIOSPHERE_IMPACT_LABEL: Record<Exclude<BiosphereImpactLevel, 'none'>, string> = {
  trace:     'trace signature',
  modifying: 'modifying surface',
  dominant:  'dominant biosphere',
};

function impactBucket(impact: number): BiosphereImpactLevel {
  if (impact <  0.05) return 'none';
  if (impact <  0.20) return 'trace';
  if (impact <  0.50) return 'modifying';
  return 'dominant';
}

// Display label per resource. Each surviving top-N resource becomes its
// own row in the info card, keyed by the label and valued by the body's
// abundance — so a player reads "metals 80% / silicates 40%" as "rich
// in iron, modest in rock" rather than scanning a comma-joined name list
// that hides whether the world is barren or saturated.
const RESOURCE_LABEL: Record<ResourceKey, string> = {
  resMetals:       'metals',
  resSilicates:    'silicates',
  resVolatiles:    'volatiles',
  resRareEarths:   'rare earths',
  resRadioactives: 'radio',
  resExotics:      'exotics',
};
const RESOURCE_FIELDS: readonly ResourceKey[] = [
  'resMetals', 'resSilicates', 'resVolatiles',
  'resRareEarths', 'resRadioactives', 'resExotics',
];

// Top `count` resources by raw value, descending, each with the body's
// absolute abundance ∈ [0..1] (value/10). Empty array when the body
// carries no resource signal at all. Mirrors `dominantResources` in
// system-diagram/color-science.ts but uses display labels instead of
// Color objects since the panel only needs names + numbers.
function dominantResourceEntries(b: Body, count = 2): Array<{ label: string; abundance: number }> {
  return RESOURCE_FIELDS
    .map(f => ({ label: RESOURCE_LABEL[f], value: b[f] ?? 0 }))
    .filter(e => e.value > 0)
    .sort((a, c) => c.value - a.value)
    .slice(0, count)
    .map(e => ({ label: e.label, abundance: Math.min(1, e.value / 10) }));
}

// Format an abundance ∈ (0..1] as 1-5 asterisks for the info card. Reads
// as a quick rating rather than a hard percentage — "***" lands faster
// than "60%" when the player is scanning multiple bodies for what's
// worth mining. `ceil` so every nonzero abundance shows at least one
// star (a present-but-trace resource still earns a tick), and the
// quintile bucketing matches roughly how the surface renderer's grey
// lerp reads: 1★ ≈ barren, 5★ ≈ fully saturated archetype.
function formatAbundance(a: number): string {
  const stars = Math.max(1, Math.min(5, Math.ceil(a * 5)));
  return '*'.repeat(stars);
}

// Round fraction (0..1) to a percent string at a precision that keeps
// trace-level differences readable. ≥10% → integer (98%), 0.1–10% →
// one decimal (3.3%, 0.5%), <0.1% → two decimals (0.03%) — so a
// Jupiter NH3 cloud chemistry renders distinctly from Saturn's
// 0.01% rather than both collapsing to "0%".
function formatGasFrac(frac: number): string {
  const pct = frac * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 0.1) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

// Top `count` atmospheric gases by molar fraction, formatted as
// "name pct" so a player extractor can compare bulk reservoirs across
// worlds — Uranus's 2.3% CH4 vs Jupiter's 0.3% CH4 reads at a glance.
// Reads atm1/atm2/atm3 directly (CSV-authored, already ordered by
// fraction descending). Empty when the body has no atmosphere data.
function dominantGasLabels(b: Body, count = 2): string[] {
  const pairs: Array<[string, number | null]> = [
    [b.atm1 ?? '', b.atm1Frac],
    [b.atm2 ?? '', b.atm2Frac],
    [b.atm3 ?? '', b.atm3Frac],
  ];
  return pairs
    .filter(([name]) => name !== '')
    .slice(0, count)
    .map(([name, frac]) => frac !== null ? `${name} ${formatGasFrac(frac)}` : name);
}

// Friendly display name per surface-liquid solvent. The subtitle names the
// world evocatively ("Ammonia Sea World"); this map drives the plainer card
// row that states what the standing liquid actually is. 'ammonia_water' is
// the aqueous-ammonia eutectic mix, distinct from a near-pure ammonia sea.
const SURFACE_LIQUID_LABEL: Record<SurfaceLiquidSpecies, string> = {
  water:         'water',
  hydrocarbon:   'hydrocarbon',
  ammonia_water: 'ammonia-water',
  ammonia:       'ammonia',
  nitrogen:      'liquid nitrogen',
  sulfur:        'molten sulfur',
};

// Coverage word for a surface-liquid extent — reads how the disc renders the
// sea: scattered pools/lakes at low cover, a sea mid-range, a global ocean
// once it dominates. Mirrors LAKE_COVER_FLOOR (0.05) in body-label.ts as the
// lakes/sea break so the card and the composed label agree on the boundary.
function liquidExtentWord(frac: number): string {
  if (frac >= 0.55) return 'ocean';
  if (frac >= 0.20) return 'sea';
  if (frac >= 0.05) return 'lakes';
  return 'pools';
}

// Surface-radiation dose [0..1] → a qualitative band plus the normalized value.
// Bands track the bimodal distribution (unshielded thin-atmosphere worlds
// saturate near 1); 'severe' is the >=0.85 tail the label would once have
// flagged "Irradiated".
function radiationLabel(dose: number): string {
  const band = dose < 0.15 ? 'low' : dose < 0.5 ? 'moderate' : dose < 0.85 ? 'high' : 'severe';
  return `${band} · ${dose.toFixed(2)}`;
}

export interface BodyRow { key: string; val: string }

// Trailing-space padding pads short keys to align the value column.
// Monaco 11 is monospace so character count == column count. Width is
// the longest key in any kind's row set; over-padding short keys is
// cheaper than measuring + per-row indent math.
const KEY_PAD = 10;
function k(label: string): string {
  return label.length >= KEY_PAD ? label : label + ' '.repeat(KEY_PAD - label.length);
}

function rowsForStar(starIdx: number): BodyRow[] {
  const s = STARS[starIdx]!;
  // Class (rawClass) is the subtitle under the name — see subtitleFor.
  const rows: BodyRow[] = [
    { key: k('mass'),   val: `${s.mass.toFixed(2)} Msun` },
    { key: k('radius'), val: `${s.radiusSolar.toFixed(2)} Rsun` },
  ];
  // Sol's distance is 0 ly by definition; skip the row rather than show
  // "0.00 ly" which reads as a placeholder.
  if (s.distLy > 0) rows.push({ key: k('distance'), val: `${s.distLy.toFixed(2)} ly` });
  return rows;
}

function rowsForBody(bodyIdx: number): BodyRow[] {
  const b = BODIES[bodyIdx]!;
  if (b.kind === 'belt') return rowsForBelt(b);
  if (b.kind === 'ring') return rowsForRing(b);
  // Class is the composed subtitle under the name — see subtitleFor.
  const rows: BodyRow[] = [];
  if (b.avgSurfaceTempK !== null) rows.push({ key: k('temp'), val: `${Math.round(b.avgSurfaceTempK)} K` });
  if (b.surfacePressureBar !== null) rows.push({ key: k('pressure'), val: `${b.surfacePressureBar.toFixed(2)} bar` });
  // Incident surface-radiation dose [0..1] — the magnetosphere's ground face,
  // decoupled from temperature (Venus scorching but shielded; Mars frozen but
  // bombarded). The label deliberately never spends a chip token on it, so the
  // card is where the colonist's dose reads. Null on no-surface bodies.
  if (b.surfaceRadiation !== null) rows.push({ key: k('radiation'), val: radiationLabel(b.surfaceRadiation) });
  // Surface liquid — say there's standing liquid and name the solvent. The
  // subtitle names the world ("Ammonia Sea World"); this row spells out the
  // solvent + extent + coverage as data, matching the sea the disc renders.
  // surfaceLiquidSpecies is null on dry worlds and (ice/gas) giants, so this
  // fires only where a real liquid stands.
  if (b.surfaceLiquidSpecies !== null && b.surfaceLiquidFraction !== null && b.surfaceLiquidFraction > 0) {
    const species = SURFACE_LIQUID_LABEL[b.surfaceLiquidSpecies];
    const extent = liquidExtentWord(b.surfaceLiquidFraction);
    const pct = b.surfaceLiquidFraction * 100;
    const cover = pct < 1 ? '<1%' : `${Math.round(pct)}%`;
    rows.push({ key: k('liquid'), val: `${species} ${extent} · ${cover}` });
  }
  // Subsurface ocean — a buried ice-shell sea (Europa, Enceladus, Titan).
  // Independent of the surface: a world frozen solid up top can still hide a
  // liquid mantle, so this row can stand alone or pair with the surface-liquid
  // row above (Titan: hydrocarbon lakes over a water-ammonia ocean). No
  // coverage — a buried ocean has no surface extent to report.
  if (b.subsurfaceOceanSpecies !== null) {
    rows.push({ key: k('subsurface'), val: `${SURFACE_LIQUID_LABEL[b.subsurfaceOceanSpecies]} ocean` });
  }
  // Complexity 'none' is the null-equivalent — skip; a planet with
  // bacteria is what we want to surface, not a barren rock. When life
  // exists, the row carries archetype + complexity + impact bucket so
  // the player sees what kind, how structured, and how visibly it
  // alters the body ("Complex Subsurface · trace signature" reads as
  // a sealed Europa; "Complex Aqueous · dominant biosphere" reads as
  // Earth). One row to keep card density tight.
  if (
    b.biosphereComplexity !== null && b.biosphereComplexity !== 'none' &&
    b.biosphereArchetype  !== null && b.biosphereSurfaceImpact !== null
  ) {
    const archLabel    = BIOSPHERE_ARCHETYPE_LABEL[b.biosphereArchetype];
    const complexLabel = BIOSPHERE_COMPLEXITY_LABEL[b.biosphereComplexity];
    const bucket       = impactBucket(b.biosphereSurfaceImpact);
    const impactLabel  = bucket === 'none' ? null : BIOSPHERE_IMPACT_LABEL[bucket];
    const val = impactLabel === null
      ? `${complexLabel} ${archLabel}`
      : `${complexLabel} ${archLabel} · ${impactLabel}`;
    rows.push({ key: k('life'), val });
  }
  const gases = dominantGasLabels(b);
  if (gases.length > 0) rows.push({ key: k('gas'), val: gases.join(', ') });
  // Gas/ice giants have no accessible surface — the procgen resource
  // grid still carries numbers (atmospheric trace species etc.) but
  // nothing's mineable in a "land a rig" sense, so suppress the row to
  // keep player-relevant data forward. Moons of giants stay solid and
  // still surface their resources.
  if (!hasInaccessibleSurface(b)) {
    for (const e of dominantResourceEntries(b)) {
      rows.push({ key: k(e.label), val: formatAbundance(e.abundance) });
    }
  }
  return rows;
}

function hasInaccessibleSurface(b: Body): boolean {
  // Gaseous-bracket bodies have no accessible surface.
  return isGaseousBody(b);
}

// Belt rows surface the band's extent, anchoring metadata, and the top
// two mineable resources with their abundances — one row per resource
// so a Kuiper-style "high volatiles, trace metals" reads as a pair of
// percentages rather than a flat name list.
function rowsForBelt(b: Body): BodyRow[] {
  const rows: BodyRow[] = [];
  if (b.innerAu !== null && b.outerAu !== null) {
    rows.push({ key: k('extent'), val: `${b.innerAu.toFixed(2)}–${b.outerAu.toFixed(2)} AU` });
  }
  // Largest body in km — surfaces the parent-body anchor that gives
  // 'discrete' populations their gameplay handle (sortie to Ceres-class
  // rather than sweep-harvest).
  if (b.largestBodyKm !== null) rows.push({ key: k('largest'), val: `${b.largestBodyKm.toFixed(0)} km` });
  // Dynamical shepherd: the gas/ice giant whose resonances stabilize
  // this belt. Only set on asteroid + ice belts in giant-bearing
  // systems; debris fields and giantless belts have no shepherd.
  if (b.shepherdBodyIdx !== null) {
    const shepherd = BODIES[b.shepherdBodyIdx];
    if (shepherd) rows.push({ key: k('shepherd'), val: shepherd.name });
  }
  for (const e of dominantResourceEntries(b)) {
    rows.push({ key: k(e.label), val: formatAbundance(e.abundance) });
  }
  return rows;
}

// Ring rows: extent in planetary radii (so "1.1–2.3 R_p" reads against
// the host planet's size) plus the top two dominant resources with
// their abundances. The underlying six-resource grid still drives the
// renderer's icy/dusty lerp — the panel just doesn't surface the long
// form.
function rowsForRing(b: Body): BodyRow[] {
  const rows: BodyRow[] = [];
  if (b.innerPlanetRadii !== null && b.outerPlanetRadii !== null) {
    rows.push({ key: k('extent'), val: `${b.innerPlanetRadii.toFixed(2)}–${b.outerPlanetRadii.toFixed(2)} R_p` });
  }
  for (const e of dominantResourceEntries(b)) {
    rows.push({ key: k(e.label), val: formatAbundance(e.abundance) });
  }
  return rows;
}

// Dispatch a pick to its key/value row set — star vs. body (planet / moon /
// belt / ring). The single entry point the card calls for its body rows. Ships never
// reach here — the card only describes catalog bodies, so its pick type excludes them.
export function rowsFor(pick: BodyOrStarPick): BodyRow[] {
  return pick.kind === 'star' ? rowsForStar(pick.starIdx) : rowsForBody(pick.bodyIdx);
}

export function titleFor(pick: BodyOrStarPick): string {
  if (pick.kind === 'star') return STARS[pick.starIdx]!.name;
  return BODIES[pick.bodyIdx]!.name;
}

// Subtitle line under the name — the "what is this" descriptor. Stars show
// their raw spectral class; planets/moons show the richly-composed world
// label (see body-label.ts). Belts/rings have no class, so no subtitle.
export function subtitleFor(pick: BodyOrStarPick): string | null {
  if (pick.kind === 'star') return STARS[pick.starIdx]!.rawClass;
  const b = BODIES[pick.bodyIdx]!;
  if (b.kind === 'belt' || b.kind === 'ring') return null;
  return composeWorldLabel(b);
}
