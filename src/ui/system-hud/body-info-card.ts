// BodyInfoCard — transient on-hover tooltip for the system view. One
// instance lives on SystemHud; SystemScene calls setTarget() each
// pointer move with the picker's result (star, planet, moon, or null).
//
// Visually mirrors the galaxy-view InfoCard family — paintSurface bg,
// yellow title in EspySans 15, Monaco 11 key/value body rows — but
// drops the multi-member nesting and the close-X. Tooltips are
// ephemeral; dismissal is the cursor leaving the disc.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { BODIES, STARS, type BeltClass, type BiosphereArchetype, type BiosphereTier, type Body, type WorldClass } from '../../data/stars';
import type { DiagramPick } from '../../scene/system-diagram';
import { BasePanel } from '../base-panel';
import { paintSurface } from '../painter';
import { colors, fonts, sizes } from '../theme';

// Pretty labels for enum-valued fields. Defined here (rather than on the
// data layer) because they're a presentation concern; if the catalog ever
// adds a new world-class, TS will flag the missing entry here.
const WORLD_CLASS_LABEL: Record<WorldClass, string> = {
  rocky:     'Rocky',
  ocean:     'Ocean',
  ice:       'Ice',
  desert:    'Desert',
  lava:      'Lava',
  gas_dwarf: 'Gas Dwarf',
  gas_giant: 'Gas Giant',
  ice_giant: 'Ice Giant',
};

const BIOSPHERE_ARCHETYPE_LABEL: Record<BiosphereArchetype, string> = {
  carbon_aqueous:     'Aqueous',
  subsurface_aqueous: 'Subsurface',
  aerial:             'Aerial',
  cryogenic:          'Cryogenic',
  silicate:           'Silicate',
  sulfur:             'Sulfur',
};
const BIOSPHERE_TIER_LABEL: Record<Exclude<BiosphereTier, 'none'>, string> = {
  prebiotic: 'Prebiotic',
  microbial: 'Microbial',
  complex:   'Complex',
  gaian:     'Gaian',
};

const BELT_CLASS_LABEL: Record<BeltClass, string> = {
  asteroid: 'Asteroid',
  ice:      'Ice',
  debris:   'Debris',
};

// Resource label table for the per-row mineral readouts on belts.
// Listed in display order; entries with value 0 are still shown so the
// reader can compare profiles across belts (a 0 is signal, not noise).
const RES_ROWS: Array<{ key: string; field: 'resMetals' | 'resSilicates' | 'resVolatiles' | 'resRareEarths' | 'resRadioactives' | 'resExotics' }> = [
  { key: 'metals',    field: 'resMetals' },
  { key: 'silicates', field: 'resSilicates' },
  { key: 'volatiles', field: 'resVolatiles' },
  { key: 'rare',      field: 'resRareEarths' },
  { key: 'radio',     field: 'resRadioactives' },
  { key: 'exotics',   field: 'resExotics' },
];

// Periods are stored in days. Sub-year reads in days; multi-year reads
// in years so a 12-year orbit doesn't surface as "4383.0 d".
function formatPeriod(days: number): string {
  if (days < 365) return `${days.toFixed(1)} d`;
  return `${(days / 365.25).toFixed(1)} y`;
}

interface BodyRow { key: string; val: string }

// Trailing-space padding pads short keys to align the value column.
// Monaco 11 is monospace so character count == column count. Width is
// the longest key in any kind's row set; over-padding short keys is
// cheaper than measuring + per-row indent math.
const KEY_PAD = 10;
function k(label: string): string {
  return label.length >= KEY_PAD ? label : label + ' '.repeat(KEY_PAD - label.length);
}

function rowsForStar(starIdx: number): BodyRow[] {
  const s = STARS[starIdx];
  const rows: BodyRow[] = [
    { key: k('class'),  val: s.rawClass },
    { key: k('mass'),   val: `${s.mass.toFixed(2)} Msun` },
    { key: k('radius'), val: `${s.radiusSolar.toFixed(2)} Rsun` },
  ];
  // Sol's distance is 0 ly by definition; skip the row rather than show
  // "0.00 ly" which reads as a placeholder.
  if (s.distLy > 0) rows.push({ key: k('distance'), val: `${s.distLy.toFixed(2)} ly` });
  return rows;
}

function rowsForBody(bodyIdx: number): BodyRow[] {
  const b = BODIES[bodyIdx];
  if (b.kind === 'belt') return rowsForBelt(b);
  if (b.kind === 'ring') return rowsForRing(b);
  const rows: BodyRow[] = [];
  if (b.worldClass !== null) rows.push({ key: k('class'),    val: WORLD_CLASS_LABEL[b.worldClass] });
  if (b.massEarth !== null)  rows.push({ key: k('mass'),     val: `${b.massEarth.toFixed(2)} Mearth` });
  if (b.radiusEarth !== null) rows.push({ key: k('radius'),  val: `${b.radiusEarth.toFixed(2)} Rearth` });
  if (b.semiMajorAu !== null) rows.push({ key: k('orbit'),   val: `${b.semiMajorAu.toFixed(3)} AU` });
  if (b.periodDays !== null)  rows.push({ key: k('period'),  val: formatPeriod(b.periodDays) });
  if (b.avgSurfaceTempK !== null) rows.push({ key: k('temp'), val: `${Math.round(b.avgSurfaceTempK)} K` });
  if (b.surfacePressureBar !== null) rows.push({ key: k('pressure'), val: `${b.surfacePressureBar.toFixed(2)} bar` });
  // Biosphere 'none' is the null-equivalent — skip; a planet with bacteria
  // is what we want to surface, not a barren rock. When life exists, show
  // both axes so the player sees what kind ("Aerial Microbial", etc.).
  if (b.biosphereTier !== null && b.biosphereTier !== 'none' && b.biosphereArchetype !== null) {
    const archLabel = BIOSPHERE_ARCHETYPE_LABEL[b.biosphereArchetype];
    const tierLabel = BIOSPHERE_TIER_LABEL[b.biosphereTier];
    rows.push({ key: k('life'), val: `${archLabel} ${tierLabel}` });
  }
  return rows;
}

// Belt rows surface the band's extent and its full resource profile.
// Resources are the gameplay payoff (asteroid mining, ice harvesting),
// so listing all six lets players compare candidate belts at a glance.
function rowsForBelt(b: Body): BodyRow[] {
  const rows: BodyRow[] = [];
  if (b.beltClass) rows.push({ key: k('class'), val: BELT_CLASS_LABEL[b.beltClass] });
  if (b.innerAu !== null && b.outerAu !== null) {
    rows.push({ key: k('extent'), val: `${b.innerAu.toFixed(2)}–${b.outerAu.toFixed(2)} AU` });
  }
  if (b.massEarth !== null) rows.push({ key: k('mass'), val: `${b.massEarth.toFixed(4)} Mearth` });
  for (const r of RES_ROWS) {
    const v = b[r.field];
    if (v !== null) rows.push({ key: k(r.key), val: `${v}/10` });
  }
  return rows;
}

// Ring rows: extent in planetary radii (so "1.1–2.3 R_p" reads against
// the host planet's size), ring class, and iceFraction as a one-line
// composition cue. No resource grid — ring volumes are too small for
// the mining-profile lens that makes sense for belts.
function rowsForRing(b: Body): BodyRow[] {
  const rows: BodyRow[] = [];
  if (b.beltClass) rows.push({ key: k('class'), val: BELT_CLASS_LABEL[b.beltClass] });
  if (b.innerPlanetRadii !== null && b.outerPlanetRadii !== null) {
    rows.push({ key: k('extent'), val: `${b.innerPlanetRadii.toFixed(2)}–${b.outerPlanetRadii.toFixed(2)} R_p` });
  }
  if (b.iceFraction !== null) rows.push({ key: k('ice'), val: `${(b.iceFraction * 100).toFixed(0)}%` });
  return rows;
}

// Parent line for moons and rings: "Moon of <p>" or "Ring of <p>".
// Skipped for planets and belts (whose host is the system's star,
// already named in the HUD title across the top of the screen).
function parentLineFor(bodyIdx: number): string | null {
  const b = BODIES[bodyIdx];
  if (b.hostBodyIdx === null) return null;
  if (b.kind === 'moon') return `Moon of ${BODIES[b.hostBodyIdx].name}`;
  if (b.kind === 'ring') return `Ring of ${BODIES[b.hostBodyIdx].name}`;
  return null;
}

function titleFor(pick: DiagramPick): string {
  if (pick.kind === 'star') return STARS[pick.starIdx].name;
  return BODIES[pick.bodyIdx].name;
}

export class BodyInfoCard extends BasePanel {
  // Track current target so successive setTarget() calls with the same
  // pick are a no-op — the cursor moves continuously within a disc, but
  // we only need to rebuild the canvas when the picked body changes.
  private current: DiagramPick | null = null;

  setTarget(pick: DiagramPick): void {
    if (picksMatch(pick, this.current)) return;
    this.current = pick;
    this.rebuild();
  }

  // Reset without hiding the mesh — caller toggles visibility. After a
  // clear, the next setTarget always triggers a rebuild.
  clearTarget(): void {
    this.current = null;
  }

  protected measure(): { w: number; h: number } {
    if (!this.current) return { w: 0, h: 0 };
    const title = titleFor(this.current);
    const titleLineH = getFont(fonts.cardName).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;
    const titleW = measurePixelText(title, fonts.cardName);

    let maxBodyW = 0;
    let bodyLines = 0;

    const parentLine = this.current.kind !== 'star' ? parentLineFor(this.current.bodyIdx) : null;
    if (parentLine) {
      const w = measurePixelText(parentLine);
      if (w > maxBodyW) maxBodyW = w;
      bodyLines++;
    }

    const rows = this.current.kind === 'star'
      ? rowsForStar(this.current.starIdx)
      : rowsForBody(this.current.bodyIdx);
    for (const r of rows) {
      const w = measurePixelText(r.key) + measurePixelText(r.val);
      if (w > maxBodyW) maxBodyW = w;
    }
    bodyLines += rows.length;

    const w = Math.max(
      sizes.padX * 2 + titleW,
      sizes.padX * 2 + maxBodyW,
    );
    const h = sizes.padY * 2 + titleLineH + sizes.cardNameGap + bodyLineH * bodyLines;
    return { w, h };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.current) return;
    paintSurface(g, 0, 0, w, h);

    const titleLineH = getFont(fonts.cardName).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;

    drawPixelText(g, titleFor(this.current), sizes.padX, sizes.padY, colors.starName, fonts.cardName);

    let cursorY = sizes.padY + titleLineH + sizes.cardNameGap;

    const parentLine = this.current.kind !== 'star' ? parentLineFor(this.current.bodyIdx) : null;
    if (parentLine) {
      drawPixelText(g, parentLine, sizes.padX, cursorY, colors.textKey);
      cursorY += bodyLineH;
    }

    const rows = this.current.kind === 'star'
      ? rowsForStar(this.current.starIdx)
      : rowsForBody(this.current.bodyIdx);
    for (const r of rows) {
      drawPixelText(g, r.key, sizes.padX, cursorY, colors.textKey);
      drawPixelText(g, r.val, sizes.padX + measurePixelText(r.key), cursorY, colors.textBody);
      cursorY += bodyLineH;
    }
  }
}

// Local equivalent of system-diagram.ts's picksEqual — duplicated here
// to avoid a circular dependency on a runtime export from the scene
// module just for one tiny pure helper.
function picksMatch(a: DiagramPick | null, b: DiagramPick | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'star' && b.kind === 'star') return a.starIdx === b.starIdx;
  if (a.kind !== 'star' && b.kind !== 'star') return a.bodyIdx === b.bodyIdx;
  return false;
}
