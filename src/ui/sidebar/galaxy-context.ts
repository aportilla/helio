// GalaxyContext — the sidebar's contextual region while the galaxy view is up.
// Stacked blocks:
//   - Civilization summary (always): per-type facility tallies from the save.
//   - Selected system (when a cluster is selected): the cluster + its members'
//     key/value rows (class / distance / mass / radius) + View System / Focus pills.
//   - System economy (when the selected system hosts a facility): per-resource net
//     balances, with a dim speculative next-turn forecast cue under a deficit the
//     next turn is set to relieve.
//
// StarmapScene owns one of these, sets it as the sidebar's context on start, feeds
// it the selection via setCluster, and routes View System / Focus back through the
// callbacks. Facility tallies are re-pulled every paint() so they stay fresh when
// the galaxy view resumes after a facility was placed in the system view.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { STARS, STAR_CLUSTERS, clusterDisplayName, systemIdForCluster } from '../../data/stars';
import type { SystemEconomyView } from '../../facilities/economy-bridge';
import { facilityLabel } from '../../facilities';
import { facilityCounts, shipsInSystem } from '../../game-state';
import { CONTROLLED_FACTION_ID } from '../../factions/registry';
import { paintPillButton } from '../painter';
import { colors, fonts, sizes } from '../theme';
import type { Region, SidebarContext } from './context';
import { fmtMilli, inRect, type Rect } from './shared';

// Gap above each member sub-header (after the first), mirroring the old info card.
const MEMBER_BLOCK_GAP = 4;
const SECTION_GAP = 6;   // between the civ block and the selected-system block
const PILL_GAP = 4;      // between the stacked action pills

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
  // The clickable fleet rows for the selected cluster (ready player ships), cached in paint() and read
  // back by the hit methods. Rebuilt every paint from a fresh game-state read, so a warped ship (now
  // 'transiting') drops out on the next repaint — the "disappears once ordered" behaviour is free.
  private shipRects: Array<{ shipId: string; rect: Rect }> = [];
  private hoveredShipId: string | null = null;

  // Fired from the action pills; StarmapScene wires these to its view methods.
  onViewSystem: (clusterIdx: number) => void = () => {};
  onFocus: (clusterIdx: number) => void = () => {};
  // Fired when a fleet row is clicked; StarmapScene wires it to open the warp destination pick for that
  // ship. Only ready player ships are listed, so the id is always a commandable ship.
  onSelectShip: (shipId: string) => void = () => {};

  // -1 clears the selected-system block. The scene drives this on select/deselect.
  setCluster(idx: number): void {
    if (this.clusterIdx === idx) return;
    this.clusterIdx = idx;
    this.hovered = null;
    this.hoveredShipId = null;
  }

  // The selected system's economy summary, pushed alongside setCluster and after
  // each turn so the galaxy info-card's net balances stay current.
  setEconomy(view: SystemEconomyView | null): void {
    this.economy = view;
  }

  paint(g: CanvasRenderingContext2D, region: Region): void {
    this.viewRect = { x: 0, y: 0, w: 0, h: 0 };
    this.focusRect = { x: 0, y: 0, w: 0, h: 0 };
    this.shipRects = [];
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
          up ? colors.signalPositive : colors.signalNegative, fonts.body);
        y += bodyH;

        // Forecast: a system in deficit that the next turn improves (a fix the
        // player just placed taking hold). Dim, right-aligned under the live net,
        // read off the speculative next-turn world — the galaxy-scan cue that an
        // action is working before the turn is committed. Shows the IMPROVEMENT
        // (predicted − live net), which the gate guarantees is positive, so
        // "++ N" reads as "net gains N next turn" rather than gluing the marker to
        // a still-negative absolute.
        const pred = rl.predictedNetMilli;
        if (pred !== null && rl.netMilli < 0 && pred > rl.netMilli) {
          const fStr = `++ ${fmtMilli(pred - rl.netMilli)}`;
          drawPixelText(g, fStr, x0 + region.w - measurePixelText(fStr), y, colors.titleDim, fonts.body);
          y += bodyH;
        }
      }
    }

    // --- Fleet (ready player ships stationed here) ---
    // Read fresh (like the civ tallies) so a ship that just warped out — now 'transiting' — is gone on the
    // next repaint. Clicking a row opens the warp destination pick for that ship (onSelectShip).
    y += sizes.cardActionGap;
    drawPixelText(g, 'SHIPS', x0, y, colors.textKey, fonts.body);
    y += bodyH + sizes.cardNameGap;
    const ships = shipsInSystem(systemIdForCluster(this.clusterIdx))
      .filter((s) => s.status === 'ready' && s.factionId === CONTROLLED_FACTION_ID);
    if (ships.length === 0) {
      drawPixelText(g, 'None stationed', x0, y, colors.titleDim, fonts.body);
      y += bodyH;
    } else {
      for (const s of ships) {
        const hov = this.hoveredShipId === s.id;
        drawPixelText(g, s.name, x0, y, hov ? colors.starName : colors.textBody, fonts.body);
        this.shipRects.push({ shipId: s.id, rect: { x: x0, y, w: region.w, h: bodyH } });
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
    return inRect(cx, cy, this.viewRect) || inRect(cx, cy, this.focusRect)
      || this.shipRects.some((s) => inRect(cx, cy, s.rect));
  }

  handleClick(cx: number, cy: number): void {
    if (this.clusterIdx < 0) return;
    if (inRect(cx, cy, this.viewRect)) { this.onViewSystem(this.clusterIdx); return; }
    if (inRect(cx, cy, this.focusRect)) { this.onFocus(this.clusterIdx); return; }
    const ship = this.shipRects.find((s) => inRect(cx, cy, s.rect));
    if (ship) this.onSelectShip(ship.shipId);
  }

  setHover(cx: number, cy: number): boolean {
    const nextPill: Control = inRect(cx, cy, this.viewRect) ? 'view'
      : inRect(cx, cy, this.focusRect) ? 'focus' : null;
    const nextShip = this.shipRects.find((s) => inRect(cx, cy, s.rect))?.shipId ?? null;
    let changed = false;
    if (nextPill !== this.hovered) { this.hovered = nextPill; changed = true; }
    if (nextShip !== this.hoveredShipId) { this.hoveredShipId = nextShip; changed = true; }
    return changed;
  }
}
