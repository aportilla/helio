// GalaxyContext — the sidebar's scrolling body while the galaxy view is up. Two states:
//   - No system selected → the GAME-VIEWS menu: the top-level screens of the game
//     (Galaxy is the live one today; Ships / Planets / Research are dim placeholders
//     for the screens that land later).
//   - System selected → the SHIPS list: the ready player ships stationed in that
//     system. Clicking a row opens its warp destination pick (the galaxy-only nav
//     entry). Read fresh each paint, so a ship that just warped out (now 'transiting')
//     drops off the list on the next repaint.
//
// The footer (owned + drawn by the Sidebar) carries the contextual nav actions this
// context declares via footerActions(): pan/zoom when nothing is selected, View System
// / Deselect when a system is selected. StarmapScene owns one of these, drives it via
// setCluster, and wires the callbacks.
//
// Civilization tallies, per-body detail, and the economy readout were removed from the
// sidebar in the scroll-frame rework — the economy data still lives in the bridge; it
// just surfaces on a dedicated screen later, not here.

import { drawPixelText, getFont } from '../../data/pixel-font';
import { clusterDisplayName, systemIdForCluster } from '../../data/stars';
import { shipsInSystem } from '../../game-state';
import { CONTROLLED_FACTION_ID } from '../../factions/registry';
import { colors, fonts, sizes } from '../theme';
import type { FooterAction, Region, SidebarContext } from './context';
import { inRect, type Rect } from './shared';

// The top-level game screens listed in the idle menu. Only 'galaxy' is live today; the
// rest are placeholders (dim, non-interactive) marking where future screens will hang.
const GAME_VIEWS: ReadonlyArray<{ readonly label: string; readonly live: boolean }> = [
  { label: 'Galaxy', live: true },
  { label: 'Ships', live: false },
  { label: 'Planets', live: false },
  { label: 'Research', live: false },
];

export class GalaxyContext implements SidebarContext {
  private clusterIdx = -1;
  // The clickable fleet rows for the selected cluster, cached in paint() and read back
  // by the hit methods (content coords — the Sidebar's ScrollView maps pointer hits
  // into this space).
  private shipRects: Array<{ shipId: string; rect: Rect }> = [];
  private hoveredShipId: string | null = null;

  // Fired when a fleet row is clicked → open the warp destination pick for that ship.
  onSelectShip: (shipId: string) => void = () => {};
  // Footer actions. onViewSystem / onDeselect fire for a selected system; onZoomIn /
  // onZoomOut are the galaxy footer's camera buttons.
  onViewSystem: (clusterIdx: number) => void = () => {};
  onDeselect: () => void = () => {};
  onZoomIn: () => void = () => {};
  onZoomOut: () => void = () => {};

  // -1 clears the selection (→ the game-views menu). The scene drives this on select/deselect.
  setCluster(idx: number): void {
    if (this.clusterIdx === idx) return;
    this.clusterIdx = idx;
    this.hoveredShipId = null;
  }

  paint(g: CanvasRenderingContext2D, region: Region): number {
    this.shipRects = [];
    const x0 = region.x;
    const bodyH = getFont(fonts.body).lineHeight;
    let y = region.y;

    // Nothing selected → the game-views menu (display-only placeholders today).
    if (this.clusterIdx < 0) {
      drawPixelText(g, 'VIEWS', x0, y, colors.textKey, fonts.body);
      y += bodyH + sizes.cardNameGap;
      for (const v of GAME_VIEWS) {
        drawPixelText(g, v.label, x0, y, v.live ? colors.starName : colors.titleDim, fonts.body);
        y += bodyH;
      }
      return y - region.y;
    }

    // System selected → its ready player ships (click a row → warp pick).
    drawPixelText(g, clusterDisplayName(this.clusterIdx), x0, y, colors.starName, fonts.cardName);
    y += getFont(fonts.cardName).lineHeight + sizes.cardNameGap;

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
    return y - region.y;
  }

  isInteractive(cx: number, cy: number): boolean {
    return this.shipRects.some((s) => inRect(cx, cy, s.rect));
  }

  handleClick(cx: number, cy: number): void {
    const ship = this.shipRects.find((s) => inRect(cx, cy, s.rect));
    if (ship) this.onSelectShip(ship.shipId);
  }

  setHover(cx: number, cy: number): boolean {
    const nextShip = this.shipRects.find((s) => inRect(cx, cy, s.rect))?.shipId ?? null;
    if (nextShip === this.hoveredShipId) return false;
    this.hoveredShipId = nextShip;
    return true;
  }

  footerActions(): FooterAction[] {
    // Idle → camera pan/zoom (pan buttons pending real icons; zoom ships now). A
    // selected system → its nav actions.
    if (this.clusterIdx < 0) {
      return [
        { id: 'zoom-out', label: '−', enabled: true, onClick: () => this.onZoomOut() },
        { id: 'zoom-in', label: '+', enabled: true, onClick: () => this.onZoomIn() },
      ];
    }
    const idx = this.clusterIdx;
    return [
      { id: 'view', label: 'View System', enabled: true, onClick: () => this.onViewSystem(idx) },
      { id: 'deselect', label: 'Deselect', enabled: true, onClick: () => this.onDeselect() },
    ];
  }

  // Body identity: the game-views menu vs a specific system's ship list. Changing the
  // selected system (or select↔deselect) resets the scroll to the top.
  contentKey(): string {
    return this.clusterIdx < 0 ? 'g:views' : `g:ships:${this.clusterIdx}`;
  }
}
