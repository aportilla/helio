// BodyInfoCard — transient on-hover tooltip for the system view. One
// instance lives on SystemHud; SystemScene calls setTarget() each
// pointer move with the picker's result (star, planet, moon, or null).
//
// Visually mirrors the galaxy-view InfoCard family — paintSurface bg,
// yellow title in EspySans 15, Monaco 11 key/value body rows — but
// drops the multi-member nesting and the close-X. Tooltips are
// ephemeral; dismissal is the cursor leaving the disc.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { BODIES, STARS, type Biosphere, type WorldClass } from '../../data/stars';
import type { BodyPick } from '../../scene/system-diagram';
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

const BIOSPHERE_LABEL: Record<Exclude<Biosphere, 'none'>, string> = {
  microbial: 'Microbial',
  simple:    'Simple Life',
  complex:   'Complex Life',
  civilized: 'Civilized',
};

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
  const rows: BodyRow[] = [];
  if (b.worldClass !== null) rows.push({ key: k('class'),    val: WORLD_CLASS_LABEL[b.worldClass] });
  if (b.massEarth !== null)  rows.push({ key: k('mass'),     val: `${b.massEarth.toFixed(2)} Mearth` });
  if (b.radiusEarth !== null) rows.push({ key: k('radius'),  val: `${b.radiusEarth.toFixed(2)} Rearth` });
  if (b.semiMajorAu !== null) rows.push({ key: k('orbit'),   val: `${b.semiMajorAu.toFixed(3)} AU` });
  if (b.periodDays !== null)  rows.push({ key: k('period'),  val: formatPeriod(b.periodDays) });
  if (b.avgSurfaceTempK !== null) rows.push({ key: k('temp'), val: `${Math.round(b.avgSurfaceTempK)} K` });
  if (b.surfacePressureBar !== null) rows.push({ key: k('pressure'), val: `${b.surfacePressureBar.toFixed(2)} bar` });
  // Biosphere 'none' is the null-equivalent for inhabited-life — skip;
  // a planet with bacteria is what we want to surface, not a barren rock.
  if (b.biosphere !== null && b.biosphere !== 'none') {
    rows.push({ key: k('life'), val: BIOSPHERE_LABEL[b.biosphere] });
  }
  return rows;
}

// Parent line for moons: "Moon of <parent display name>". Skipped for
// planets (host is the system's star, which is already named in the HUD
// title across the top of the screen).
function parentLineForMoon(bodyIdx: number): string | null {
  const b = BODIES[bodyIdx];
  if (b.kind !== 'moon' || b.hostBodyIdx === null) return null;
  return `Moon of ${BODIES[b.hostBodyIdx].name}`;
}

function titleFor(pick: BodyPick): string {
  if (pick.kind === 'star') return STARS[pick.starIdx].name;
  return BODIES[pick.bodyIdx].name;
}

export class BodyInfoCard extends BasePanel {
  // Track current target so successive setTarget() calls with the same
  // pick are a no-op — the cursor moves continuously within a disc, but
  // we only need to rebuild the canvas when the picked body changes.
  private current: BodyPick | null = null;

  setTarget(pick: BodyPick): void {
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

    const parentLine = this.current.kind === 'moon' ? parentLineForMoon(this.current.bodyIdx) : null;
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

    const parentLine = this.current.kind === 'moon' ? parentLineForMoon(this.current.bodyIdx) : null;
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
function picksMatch(a: BodyPick | null, b: BodyPick | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'star' && b.kind === 'star') return a.starIdx === b.starIdx;
  if (a.kind !== 'star' && b.kind !== 'star') return a.bodyIdx === b.bodyIdx;
  return false;
}
