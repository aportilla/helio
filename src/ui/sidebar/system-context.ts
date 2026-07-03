// SystemContext — the sidebar's contextual region while the system view is up.
// Shows the system name, then the selected body's name + its placed-facility list
// (each with a remove ✕), its economy rows (stock + signed balance, with a dim
// next-turn forecast cue when inbound cargo is set to relieve a deficit), a ship
// construction control when the body has a shipyard (a Build-ship pill when idle,
// or an in-progress readout + Cancel while a build is in flight), and one "Add
// <type>" pill per buildable facility type, stacked vertically down the narrow
// column. A selected fleet **ship** swaps that whole body block for a read-only ship
// card (name / class / status); the body and ship selections are mutually exclusive.
// SystemScene drives it through setBody() / setShip() (selection changed / facilities
// or builds mutated) and routes the clicked controls back through onAddFacility /
// onRemoveFacility / onBuildShip / onCancelBuild.
//
// The data path is the registry-driven one — `SelectedBodyInfo` + `addableTypes` +
// the add/remove loop, shared with `game-state` / `src/facilities`; this file owns
// only the narrow vertical geometry and its hit-rects.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import type { BodyKind } from '../../data/stars';
import type { BodyEconomyView } from '../../facilities/economy-bridge';
import { facilityHasShipbuilding, facilityLabel, type FacilityType } from '../../facilities';
import type { Facility } from '../../game-state';
import { paintPillButton } from '../painter';
import { colors, fonts, sizes } from '../theme';
import type { Region, SidebarContext } from './context';
import { fmtMilli, inRect, type Rect } from './shared';

// The selected body, plus its facilities, as the context needs to render it.
// SystemScene composes this from the catalog Body + the game-state store.
export interface SelectedBodyInfo {
  readonly bodyId: string;
  readonly name: string;
  readonly kind: BodyKind;
  readonly facilities: readonly Facility[];
  // Types this body can still host (registry-derived: physics predicate AND build
  // cap), in Add-button order. SystemScene computes it — it owns the Body.
  readonly addableTypes: readonly FacilityType[];
  // The body's live economy (per-resource stock, balance, shortfall, and a
  // realized utilization/fill rate), or null when it hosts no facility / carries
  // nothing yet. SystemScene reads it from the EconomyBridge; updated on selection
  // and after each turn.
  readonly economy: BodyEconomyView | null;
  // The body's in-flight ship build (a shipyard holds one build slot), or null when
  // none. SystemScene composes it from the game-state store; turnsLeft is DERIVED
  // (completesOnTurn - turn), never stored, and refreshes on selection / each turn.
  readonly build: { readonly shipId: string; readonly name: string; readonly turnsLeft: number } | null;
}

// A selected ship, as the context renders it. Mutually exclusive with SelectedBodyInfo
// (a click selects a body OR a ship). Read-only in v1 — a ready ship has no actions yet
// (movement/combat land later), so this is a plain readout, no controls.
export interface SelectedShipInfo {
  readonly name: string;
  // Whose ship — the only ownership signal in the card. factionColor ties the line to
  // the fleet sprite's tint (both come from the faction registry).
  readonly factionLabel: string;
  readonly factionColor: string;
  // Mirrors the codec Ship.status union (fed straight from it in system-scene). 'transiting' is carried
  // for type-completeness — a transiting ship is unpickable in v1 (out of the fleet muster), so the card
  // never actually renders that arm; its presence surfaces instead as the sidebar's TRANSITS rows.
  readonly status: 'building' | 'ready' | 'transiting';
}

const SHIP_STATUS_LABEL: Record<SelectedShipInfo['status'], string> = {
  building: 'Building',
  ready: 'Ready',
  transiting: 'In transit',
};

const KIND_LABEL: Record<BodyKind, string> = {
  planet: 'planet', moon: 'moon', belt: 'belt', ring: 'ring',
};
const addLabel = (t: FacilityType): string => `Add ${facilityLabel(t).toLowerCase()}`;

const ROW_GAP = 2;
const REMOVE_LABEL_GAP = 6;
// Vertical gap between the stacked Add buttons (the narrow sidebar stacks them
// top-down, one pill per row).
const ADD_BUTTON_GAP = 4;
// Horizontal gap between the columns of an economy row (name · stock · flow).
const ECON_COL_GAP = 5;
// Indent of a shortfall sub-line under its resource row.
const ECON_SUB_INDENT = 6;

type HoverHit =
  | { kind: 'add'; type: FacilityType }
  | { kind: 'remove'; id: string }
  | { kind: 'build' }
  | { kind: 'cancel' }
  | { kind: 'devOpponent' }
  | { kind: 'devOpponentColony' }
  | null;

function hoverEqual(a: HoverHit, b: HoverHit): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'remove' && b.kind === 'remove') return a.id === b.id;
  if (a.kind === 'add' && b.kind === 'add') return a.type === b.type;
  // 'build' / 'cancel' / 'devOpponent' / 'devOpponentColony' are singletons — same kind
  // means the same control.
  return true;
}

// 1-px X glyph in a closeGlyph×closeGlyph box — the per-row remove affordance.
function paintRemoveX(g: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  const N = sizes.closeGlyph;
  g.fillStyle = color;
  for (let i = 0; i < N; i++) {
    g.fillRect(x + i, y + i, 1, 1);
    g.fillRect(x + i, y + (N - 1 - i), 1, 1);
  }
}

export class SystemContext implements SidebarContext {
  // At most one selection at a time: a body (with its facility/economy/build controls)
  // or a ship (a read-only card). The setters keep them mutually exclusive.
  private info: SelectedBodyInfo | null = null;
  private ship: SelectedShipInfo | null = null;
  // Pre-formatted TRANSITS lines (outbound "<ship> → <dest> · T-n" at the origin, inbound "◄ <ship> · T-n"
  // at the destination) — a SYSTEM-level readout the scene rebuilds from transitsFor each turn, so it shows
  // in every selection state. Empty ⇒ the block is omitted.
  private transitLines: readonly string[] = [];
  private hovered: HoverHit = null;
  // Cached hit-rects in absolute canvas coords, rebuilt every paint().
  private addRects: Array<{ type: FacilityType; rect: Rect }> = [];
  private removeRects: Array<{ id: string; rect: Rect }> = [];
  // At most one of each per body (a shipyard's single build slot) — a plain Rect,
  // reset to a zero-size rect each paint (inRect on a 0-w rect is always false).
  private buildRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private cancelRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  // DEV-only "add opponent ship" debug pill — system-scoped, so painted at the top
  // regardless of selection. Zero-size (inert) in a production build, where the paint
  // branch is dead-code-eliminated.
  private devOpponentRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  // DEV-only "+ opponent colony" debug pill — body-scoped (painted only when a body is
  // selected). Places an opponent colony on the body (a facility + an ownership flip),
  // claiming it for the opponent, so the M3 body-as-target path (an enemy colony) is
  // exercisable.
  private devOpponentColonyRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  // Fired from the controls; SystemScene routes these to the game-state store,
  // then re-pushes the updated body via setBody so the list stays in sync.
  onAddFacility: (bodyId: string, type: FacilityType) => void = () => {};
  onRemoveFacility: (facilityId: string) => void = () => {};
  onBuildShip: (bodyId: string) => void = () => {};
  onCancelBuild: (shipId: string) => void = () => {};
  // DEV-only: drop a ready opponent ship into this system (no body arg — system-scoped).
  onAddOpponentShip: () => void = () => {};
  // DEV-only: claim the SELECTED body for an opponent by placing an opponent colony on it
  // (a facility + an ownership flip). SystemScene reads the current selection — no body arg.
  onAddOpponentColony: () => void = () => {};

  // The system name is fixed for the life of the view (the diagram never changes
  // system mid-life), so it's a constructor arg, not part of the per-selection DTO.
  constructor(private readonly systemName: string) {}

  setBody(info: SelectedBodyInfo | null): void {
    this.info = info;
    this.ship = null;
    this.hovered = null;
  }

  setShip(ship: SelectedShipInfo | null): void {
    this.ship = ship;
    this.info = null;
    this.hovered = null;
  }

  // The system's in-flight transits, as pre-formatted lines (the scene owns the wording + the T-n
  // countdown, derived from arrivesOnTurn − turn so it's never a stored decrement). System-scoped, so it
  // is independent of the body/ship selection.
  setTransits(lines: readonly string[]): void {
    this.transitLines = lines;
  }

  paint(g: CanvasRenderingContext2D, region: Region): void {
    this.addRects = [];
    this.removeRects = [];
    this.buildRect = { x: 0, y: 0, w: 0, h: 0 };
    this.cancelRect = { x: 0, y: 0, w: 0, h: 0 };
    this.devOpponentRect = { x: 0, y: 0, w: 0, h: 0 };
    this.devOpponentColonyRect = { x: 0, y: 0, w: 0, h: 0 };
    const x0 = region.x;
    let y = region.y;

    // System name as the region title.
    drawPixelText(g, this.systemName, x0, y, colors.starName, fonts.cardName);
    y += getFont(fonts.cardName).lineHeight + sizes.cardNameGap;

    // DEV-only: a system-scoped "+ opponent ship" pill, painted ahead of the selection
    // block so it is reachable in every state (body selected, ship selected, or
    // nothing). It drops a ready opponent ship into this system to populate the fleet
    // for encounter-combat testing. Stripped from production builds (import.meta.env.DEV
    // is statically false there, so this whole branch — and its hit-rect — vanish).
    if (import.meta.env.DEV) {
      const devHover = this.hovered?.kind === 'devOpponent';
      const { w, h } = paintPillButton(g, x0, y, '+ opponent ship', { hover: devHover });
      this.devOpponentRect = { x: x0, y, w, h };
      y += h + sizes.cardActionGap;
      // Painted only when a body is selected: it places an opponent colony on THAT body
      // (claiming it), so the M3 body-as-target path (an enemy colony) is exercisable.
      if (this.info) {
        const colonyHover = this.hovered?.kind === 'devOpponentColony';
        const colony = paintPillButton(g, x0, y, '+ opponent colony', { hover: colonyHover });
        this.devOpponentColonyRect = { x: x0, y, w: colony.w, h: colony.h };
        y += colony.h + sizes.cardActionGap;
      }
    }

    // TRANSITS — ships leaving this system or inbound to it, shown regardless of selection (a system-level
    // readout, like the galaxy's civ summary). Omitted when there are none.
    if (this.transitLines.length > 0) {
      const transitLineH = getFont(fonts.body).lineHeight;
      drawPixelText(g, 'TRANSITS', x0, y, colors.textKey, fonts.body);
      y += transitLineH + sizes.cardNameGap;
      for (const line of this.transitLines) {
        drawPixelText(g, line, x0, y, colors.textBody, fonts.body);
        y += transitLineH + ROW_GAP;
      }
      y += sizes.cardActionGap;
    }

    // A selected ship is a read-only card (no controls in v1), painted in place of the
    // body block. Returns before the body rect-bearing rows below, so the cached
    // hit-rects (reset at the top of paint) stay empty and every hit method is inert.
    if (this.ship) {
      const lineH = getFont(fonts.body).lineHeight;
      drawPixelText(g, this.ship.name, x0, y, colors.textBody, fonts.body);
      y += lineH + ROW_GAP;
      // Whose ship, painted in the faction's own color — the card's tie to the fleet
      // sprite's tint (both resolve from the faction registry).
      drawPixelText(g, this.ship.factionLabel, x0, y, this.ship.factionColor, fonts.body);
      y += lineH + ROW_GAP;
      drawPixelText(g, SHIP_STATUS_LABEL[this.ship.status], x0, y, colors.textKey, fonts.body);
      return;
    }

    if (!this.info) {
      drawPixelText(g, 'Select a body or ship', x0, y, colors.textKey, fonts.body);
      return;
    }

    // Selected body: name + dim kind suffix.
    drawPixelText(g, this.info.name, x0, y, colors.textBody, fonts.body);
    const nameW = measurePixelText(this.info.name);
    drawPixelText(g, ` · ${KIND_LABEL[this.info.kind]}`, x0 + nameW, y, colors.titleDim, fonts.body);
    y += getFont(fonts.body).lineHeight + sizes.cardNameGap;

    // Facility rows: remove-✕ + label.
    const bodyLineH = getFont(fonts.body).lineHeight;
    const rowH = Math.max(sizes.closeBox, bodyLineH);
    for (const f of this.info.facilities) {
      const ry = y + Math.floor((rowH - sizes.closeBox) / 2);
      this.removeRects.push({ id: f.id, rect: { x: x0, y: ry, w: sizes.closeBox, h: sizes.closeBox } });
      const removeHover = this.hovered?.kind === 'remove' && this.hovered.id === f.id;
      const gx = x0 + Math.floor((sizes.closeBox - sizes.closeGlyph) / 2);
      const gy = ry + Math.floor((sizes.closeBox - sizes.closeGlyph) / 2);
      paintRemoveX(g, gx, gy, removeHover ? colors.glyphHover : colors.glyphOff);
      const labelX = x0 + sizes.closeBox + REMOVE_LABEL_GAP;
      const labelY = y + Math.floor((rowH - bodyLineH) / 2);
      drawPixelText(g, facilityLabel(f.type), labelX, labelY, colors.textBody);
      y += rowH + ROW_GAP;
    }

    // Economy: per-resource stock + signed balance, once the body is a sim node
    // (it has a facility projecting into the economy). Each row is
    // "name · stock · ±balance" — trade-aware cover once a turn has run, else the
    // intrinsic flow — tinted by sign (surplus green / deficit red), with a realized
    // utilization/fill rate (shown only when interesting) and a shortfall-reason
    // sub-line when present.
    const econ = this.info.economy;
    if (econ) {
      const econLineH = getFont(fonts.body).lineHeight;
      y += sizes.cardActionGap;
      drawPixelText(g, 'ECONOMY', x0, y, colors.textKey, fonts.body);
      y += econLineH + ROW_GAP;
      for (const rl of econ.resources) {
        let lx = x0;
        drawPixelText(g, rl.name, lx, y, colors.textBody);
        lx += measurePixelText(rl.name) + ECON_COL_GAP;
        const stockTxt = fmtMilli(rl.stockMilli);
        drawPixelText(g, stockTxt, lx, y, colors.textBody);
        lx += measurePixelText(stockTxt) + ECON_COL_GAP;

        // Signed balance: the sim's trade-aware cover once a digest exists, else
        // the intrinsic production−consumption. Tinted by sign.
        const signed = rl.coverMilli ?? rl.netFlowMilli;
        if (signed !== 0) {
          const up = signed > 0;
          const balTxt = (up ? '+' : '') + fmtMilli(signed);
          drawPixelText(g, balTxt, lx, y, up ? colors.signalPositive : colors.signalNegative);
          lx += measurePixelText(balTxt) + ECON_COL_GAP;
        }
        // Realized rate, always shown: a net-producer resource shows its output
        // utilization (made ÷ capacity) as "N% out"; a net-consumer resource its
        // demand fill (ate ÷ demand) as "N% fed". 100% reads as a healthy confirm
        // (faucet maxed / fully fed); anything less is the signal to act.
        if (rl.utilizationPct !== null) {
          drawPixelText(g, `${Math.round(rl.utilizationPct * 100)}% out`, lx, y, colors.titleDim);
        } else if (rl.fillPct !== null) {
          drawPixelText(g, `${Math.round(rl.fillPct * 100)}% fed`, lx, y, colors.titleDim);
        }
        y += econLineH + ROW_GAP;

        // Shortfall: the binding reason for an unmet demand, indented under the
        // row in deficit red — the player's cue to build/route a fix.
        if (rl.shortfall) {
          drawPixelText(g, rl.shortfall.label, x0 + ECON_SUB_INDENT, y, colors.signalNegative);
          y += econLineH + ROW_GAP;
        }

        // Forecast: a deficit the next turn relieves with actual inbound cargo (a
        // provider just built / came in range). Dim cue indented like the shortfall
        // sub-line, sourced from the speculative next-turn read — so the player sees
        // their action working before committing the turn. Gated on real inbound, not
        // just an improving cover, so "inbound" never overstates.
        const inboundQty = rl.inboundNextTurnMilli;
        const improving = rl.predictedCoverMilli !== null && signed < 0 && rl.predictedCoverMilli > signed;
        if (improving && inboundQty !== null && inboundQty > 0) {
          drawPixelText(g, '++ inbound next turn', x0 + ECON_SUB_INDENT, y, colors.titleDim);
          y += econLineH + ROW_GAP;
        }
      }
    }

    // Ship construction: a shipyard-bearing body gets a Build-ship pill when idle,
    // or an in-progress readout + a Cancel pill while a build is in flight. The two
    // states are mutually exclusive (one build slot per yard, cost is time-only).
    if (facilityHasShipbuilding(this.info.facilities)) {
      y += sizes.cardActionGap;
      if (this.info.build === null) {
        const buildHover = this.hovered?.kind === 'build';
        const { w, h } = paintPillButton(g, x0, y, 'Build ship', { hover: buildHover });
        this.buildRect = { x: x0, y, w, h };
        y += h + ADD_BUTTON_GAP;
      } else {
        const b = this.info.build;
        const lineH = getFont(fonts.body).lineHeight;
        drawPixelText(g, `Building ${b.name}`, x0, y, colors.textBody);
        y += lineH + ROW_GAP;
        drawPixelText(g, b.turnsLeft === 1 ? '1 turn left' : `${b.turnsLeft} turns left`, x0, y, colors.titleDim);
        y += lineH + ROW_GAP;
        const cancelHover = this.hovered?.kind === 'cancel';
        const { w, h } = paintPillButton(g, x0, y, 'Cancel', { hover: cancelHover });
        this.cancelRect = { x: x0, y, w, h };
        y += h + ADD_BUTTON_GAP;
      }
    }

    // One "Add <label>" pill per buildable type, stacked.
    if (this.info.addableTypes.length > 0) {
      y += sizes.cardActionGap;
      for (const type of this.info.addableTypes) {
        const addHover = this.hovered?.kind === 'add' && this.hovered.type === type;
        const { w, h } = paintPillButton(g, x0, y, addLabel(type), { hover: addHover });
        this.addRects.push({ type, rect: { x: x0, y, w, h } });
        y += h + ADD_BUTTON_GAP;
      }
    }
  }

  isInteractive(cx: number, cy: number): boolean {
    return this.addRects.some((a) => inRect(cx, cy, a.rect))
      || this.removeRects.some((r) => inRect(cx, cy, r.rect))
      || inRect(cx, cy, this.buildRect)
      || inRect(cx, cy, this.cancelRect)
      || inRect(cx, cy, this.devOpponentRect)
      || inRect(cx, cy, this.devOpponentColonyRect);
  }

  handleClick(cx: number, cy: number): void {
    // DEV debug pill first — it's system-scoped, reachable in every selection state.
    // The rect is zero-size in production (the paint branch is stripped), so this is
    // inert there even without the env guard.
    if (inRect(cx, cy, this.devOpponentRect)) { this.onAddOpponentShip(); return; }
    if (inRect(cx, cy, this.devOpponentColonyRect)) { this.onAddOpponentColony(); return; }
    if (this.info) {
      if (inRect(cx, cy, this.buildRect)) { this.onBuildShip(this.info.bodyId); return; }
      if (this.info.build && inRect(cx, cy, this.cancelRect)) { this.onCancelBuild(this.info.build.shipId); return; }
      for (const a of this.addRects) {
        if (inRect(cx, cy, a.rect)) { this.onAddFacility(this.info.bodyId, a.type); return; }
      }
    }
    for (const r of this.removeRects) {
      if (inRect(cx, cy, r.rect)) { this.onRemoveFacility(r.id); return; }
    }
  }

  setHover(cx: number, cy: number): boolean {
    let next: HoverHit = null;
    for (const a of this.addRects) {
      if (inRect(cx, cy, a.rect)) { next = { kind: 'add', type: a.type }; break; }
    }
    if (!next) {
      for (const r of this.removeRects) {
        if (inRect(cx, cy, r.rect)) { next = { kind: 'remove', id: r.id }; break; }
      }
    }
    if (!next && inRect(cx, cy, this.buildRect)) next = { kind: 'build' };
    if (!next && inRect(cx, cy, this.cancelRect)) next = { kind: 'cancel' };
    if (!next && inRect(cx, cy, this.devOpponentRect)) next = { kind: 'devOpponent' };
    if (!next && inRect(cx, cy, this.devOpponentColonyRect)) next = { kind: 'devOpponentColony' };
    if (hoverEqual(next, this.hovered)) return false;
    this.hovered = next;
    return true;
  }
}
