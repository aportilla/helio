// GalaxyContext — the sidebar's contextual region while the galaxy view is up.
// Two stacked blocks:
//   - Civilization summary (always): per-type facility tallies from the save. The
//     only honest civ-level data that exists today — no economy is implied.
//   - Selected system (when a cluster is selected): the cluster + its members'
//     key/value rows (class / distance / mass / radius) + View System / Focus pills.
//
// StarmapScene owns one of these, sets it as the sidebar's context on start, feeds
// it the selection via setCluster, and routes View System / Focus back through the
// callbacks. Facility tallies are re-pulled every paint() so they stay fresh when
// the galaxy view resumes after a facility was placed in the system view.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { STARS, STAR_CLUSTERS, clusterDisplayName } from '../../data/stars';
import type { SystemEconomyView } from '../../facilities/economy-bridge';
import { facilityLabel } from '../../facilities';
import { facilityCounts } from '../../game-state';
import { paintPillButton } from '../painter';
import { colors, fonts, sizes } from '../theme';
import type { Region, SidebarContext } from './context';

interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// Gap above each member sub-header (after the first), mirroring the old info card.
const MEMBER_BLOCK_GAP = 4;
const SECTION_GAP = 6;   // between the civ block and the selected-system block
const PILL_GAP = 4;      // between the stacked action pills

// milli-units → a compact unit string for the value column (≤1 decimal, a
// trailing ".0" trimmed). Mirrors the system context's chip formatting.
function fmtMilli(milli: number): string {
  const s = (Math.round(milli / 100) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

interface BodyRow { readonly key: string; readonly val: string }

// Padded keys (monospace Monaco) so the values line up in a column — same shape
// the bottom-right info card used before it moved into the sidebar.
function bodyForStar(starIdx: number): BodyRow[] {
  const s = STARS[starIdx]!;
  return [
    { key: 'class    ', val: s.rawClass },
    { key: 'distance ', val: `${s.distLy.toFixed(2)} ly` },
    { key: 'mass     ', val: `${s.mass.toFixed(2)} Msun` },
    { key: 'radius   ', val: `${s.radiusSolar.toFixed(2)} Rsun` },
  ];
}

type Control = 'view' | 'focus' | null;

export class GalaxyContext implements SidebarContext {
  private clusterIdx = -1;
  // The selected system's aggregated economy, pushed by StarmapScene on select
  // and after each turn. Null when nothing is selected / hosts no facility.
  private economy: SystemEconomyView | null = null;
  private hovered: Control = null;
  private viewRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private focusRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  // Fired from the action pills; StarmapScene wires these to its view methods.
  onViewSystem: (clusterIdx: number) => void = () => {};
  onFocus: (clusterIdx: number) => void = () => {};

  // -1 clears the selected-system block. The scene drives this on select/deselect.
  setCluster(idx: number): void {
    if (this.clusterIdx === idx) return;
    this.clusterIdx = idx;
    this.hovered = null;
  }

  // The selected system's economy summary, pushed alongside setCluster and after
  // each turn so the galaxy info-card's net balances stay current.
  setEconomy(view: SystemEconomyView | null): void {
    this.economy = view;
  }

  paint(g: CanvasRenderingContext2D, region: Region): void {
    this.viewRect = { x: 0, y: 0, w: 0, h: 0 };
    this.focusRect = { x: 0, y: 0, w: 0, h: 0 };
    const x0 = region.x;
    const bodyH = getFont(fonts.body).lineHeight;
    let y = region.y;

    // --- Civilization summary ---
    drawPixelText(g, 'CIVILIZATION', x0, y, colors.textKey, fonts.body);
    y += bodyH + sizes.cardNameGap;
    for (const [type, n] of facilityCounts()) {
      drawPixelText(g, facilityLabel(type), x0, y, colors.textBody, fonts.body);
      const valStr = String(n);
      drawPixelText(g, valStr, x0 + region.w - measurePixelText(valStr), y, colors.starName, fonts.body);
      y += bodyH;
    }
    y += SECTION_GAP;

    // --- Selected system ---
    if (this.clusterIdx < 0) {
      drawPixelText(g, 'No system selected', x0, y, colors.textKey, fonts.body);
      return;
    }
    const cluster = STAR_CLUSTERS[this.clusterIdx]!;
    const isMulti = cluster.members.length > 1;
    drawPixelText(g, clusterDisplayName(this.clusterIdx), x0, y, colors.starName, fonts.cardName);
    y += getFont(fonts.cardName).lineHeight + sizes.cardNameGap;

    for (let i = 0; i < cluster.members.length; i++) {
      const memIdx = cluster.members[i]!;
      if (isMulti) {
        if (i > 0) y += MEMBER_BLOCK_GAP;
        drawPixelText(g, STARS[memIdx]!.name, x0, y, colors.starName, fonts.body);
        y += bodyH;
      }
      for (const row of bodyForStar(memIdx)) {
        drawPixelText(g, row.key, x0, y, colors.textKey, fonts.body);
        drawPixelText(g, row.val, x0 + measurePixelText(row.key), y, colors.textBody, fonts.body);
        y += bodyH;
      }
    }

    // --- System economy ---
    // Net balance per resource across the system's stars (surplus green / deficit
    // red), right-aligned like the civ tallies. Absent until a facility here
    // projects into the economy.
    if (this.economy) {
      y += sizes.cardActionGap;
      drawPixelText(g, 'ECONOMY', x0, y, colors.textKey, fonts.body);
      y += bodyH + sizes.cardNameGap;
      for (const rl of this.economy.resources) {
        drawPixelText(g, rl.name, x0, y, colors.textBody, fonts.body);
        const up = rl.netMilli >= 0;
        const valStr = (up ? '+' : '') + fmtMilli(rl.netMilli);
        drawPixelText(g, valStr, x0 + region.w - measurePixelText(valStr), y,
          up ? colors.econSurplus : colors.econDeficit, fonts.body);
        y += bodyH;
      }
    }

    // --- Actions ---
    y += sizes.cardActionGap;
    const view = paintPillButton(g, x0, y, 'View System', { hover: this.hovered === 'view' });
    this.viewRect = { x: x0, y, w: view.w, h: view.h };
    y += view.h + PILL_GAP;
    const focus = paintPillButton(g, x0, y, 'Focus', { hover: this.hovered === 'focus' });
    this.focusRect = { x: x0, y, w: focus.w, h: focus.h };
  }

  isInteractive(cx: number, cy: number): boolean {
    return inRect(cx, cy, this.viewRect) || inRect(cx, cy, this.focusRect);
  }

  handleClick(cx: number, cy: number): void {
    if (this.clusterIdx < 0) return;
    if (inRect(cx, cy, this.viewRect)) this.onViewSystem(this.clusterIdx);
    else if (inRect(cx, cy, this.focusRect)) this.onFocus(this.clusterIdx);
  }

  setHover(cx: number, cy: number): boolean {
    const next: Control = inRect(cx, cy, this.viewRect) ? 'view'
      : inRect(cx, cy, this.focusRect) ? 'focus' : null;
    if (next === this.hovered) return false;
    this.hovered = next;
    return true;
  }
}
