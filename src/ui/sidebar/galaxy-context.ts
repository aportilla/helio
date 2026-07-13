// GalaxyContext — the sidebar's scrolling body while the galaxy view is up. Two states:
//   - No system selected → the GAME-VIEWS menu: the top-level screens of the game
//     (Galaxy is the live one today; Ships / Planets / Research are dim placeholders
//     for the screens that land later).
//   - System selected → the SHIPS list: the ready player ships stationed in that
//     system, each a full-width selectable TILE (its module-hull sprite + name).
//     Clicking a tile opens its warp destination pick (the galaxy-only nav entry).
//     Read fresh each paint, so a ship that just warped out (now 'transiting') drops
//     off the list on the next repaint.
//
// While a warp destination is being picked, the departing ship's tile stays HIGHLIGHTED
// in this list (setSelectedShip) — the pick is a galaxy modality painted in place, not a
// sidebar swap — and the nav footer is suppressed (the on-map DepartureBanner owns
// confirm/cancel; View System / Deselect would break the mode).
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
import { paintSurface } from '../painter';
import { paintShipHull } from '../ship-hull';
import { colors, fonts, sizes } from '../theme';
import type { FooterAction, Region, SidebarContext } from './context';
import { inRect, type Rect } from './shared';

// Ship-tile geometry (env px). Each ready ship is a full-width, selectable TILE — its
// module-hull sprite on the left (the same paintShipHull the field + warp use, so it
// reads identically) + its name — stacked down the scroll body.
const SHIP_TILE_H = 30;
const SHIP_TILE_GAP = 4;
const SHIP_SPRITE_D = 22;      // sprite diameter, drawn centered in the tile's left region
const SHIP_SPRITE_PAD_X = 5;   // left inset of the sprite box
const SHIP_NAME_GAP = 5;       // gap between the sprite box and the name
const SHIP_TILE_PAD_R = 5;     // right inset of the name column

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
  // The ship whose warp destination is currently being picked, or null. Its tile paints in a
  // persistent SELECTED style, and its presence suppresses the nav footer. The scene drives it
  // via setSelectedShip on departure enter / teardown.
  private selectedShipId: string | null = null;

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

  // Mark the ship being warp-picked (null = none). Highlights its tile + suppresses the footer.
  setSelectedShip(shipId: string | null): void {
    this.selectedShipId = shipId;
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
      const nameX = x0 + SHIP_SPRITE_PAD_X + SHIP_SPRITE_D + SHIP_NAME_GAP;
      const nameW = region.w - (nameX - x0) - SHIP_TILE_PAD_R;
      for (const s of ships) {
        // Selected (being warp-picked) is a persistent highlight that outranks transient hover.
        const sel = this.selectedShipId === s.id;
        const lit = sel || this.hoveredShipId === s.id;
        // Full-width selectable tile: solid plate, lit frame + surfaceOn fill when selected/hovered.
        paintSurface(g, x0, y, region.w, SHIP_TILE_H, {
          bg: lit ? colors.surfaceOn : colors.surface,
          border: lit ? colors.borderAccent : colors.borderDim,
        });
        // The ship's module hull as its icon, facing right like the player's field formation.
        paintShipHull(g, x0 + SHIP_SPRITE_PAD_X + SHIP_SPRITE_D / 2, y + SHIP_TILE_H / 2,
          SHIP_SPRITE_D, s.components, s.factionId, 1);
        // Name, vertically centered + clipped to its column so a long name can't spill past the tile.
        g.save();
        g.beginPath();
        g.rect(nameX, y, nameW, SHIP_TILE_H);
        g.clip();
        drawPixelText(g, s.name, nameX, y + Math.floor((SHIP_TILE_H - bodyH) / 2),
          lit ? colors.starName : colors.textBody, fonts.body);
        g.restore();
        this.shipRects.push({ shipId: s.id, rect: { x: x0, y, w: region.w, h: SHIP_TILE_H } });
        y += SHIP_TILE_H + SHIP_TILE_GAP;
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
    // Mid-pick (a ship selected for departure): no footer — the on-map DepartureBanner owns
    // confirm/cancel, and View System / Deselect would orphan the armed pick.
    if (this.selectedShipId !== null) return [];
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
