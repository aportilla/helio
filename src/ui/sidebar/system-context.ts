// SystemContext — the sidebar's contextual region while the system view is up.
// Shows the system name, then the selected body's name + its placed-facility list
// (each with a remove ✕) + one "Add <type>" pill per buildable facility type,
// stacked vertically down the narrow column. SystemScene drives it through
// setBody() (selection changed / facilities mutated) and routes the clicked
// controls back through onAddFacility / onRemoveFacility.
//
// The data path is the registry-driven one — `SelectedBodyInfo` + `addableTypes` +
// the add/remove loop, shared with `game-state` / `src/facilities`; this file owns
// only the narrow vertical geometry and its hit-rects.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import type { BodyKind } from '../../data/stars';
import { facilityLabel, type FacilityType } from '../../facilities';
import type { Facility } from '../../game-state';
import { paintPillButton } from '../painter';
import { colors, fonts, sizes } from '../theme';
import type { Region, SidebarContext } from './context';

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
}

interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

const KIND_LABEL: Record<BodyKind, string> = {
  planet: 'planet', moon: 'moon', belt: 'belt', ring: 'ring',
};
const addLabel = (t: FacilityType): string => `Add ${facilityLabel(t).toLowerCase()}`;

const ROW_GAP = 2;
const REMOVE_LABEL_GAP = 6;
// Vertical gap between the stacked Add buttons (the narrow sidebar stacks them
// top-down, one pill per row).
const ADD_BUTTON_GAP = 4;

type HoverHit = { kind: 'add'; type: FacilityType } | { kind: 'remove'; id: string } | null;

function hoverEqual(a: HoverHit, b: HoverHit): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'remove' && b.kind === 'remove') return a.id === b.id;
  if (a.kind === 'add' && b.kind === 'add') return a.type === b.type;
  return false;
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
  private info: SelectedBodyInfo | null = null;
  private hovered: HoverHit = null;
  // Cached hit-rects in absolute canvas coords, rebuilt every paint().
  private addRects: Array<{ type: FacilityType; rect: Rect }> = [];
  private removeRects: Array<{ id: string; rect: Rect }> = [];

  // Fired from the controls; SystemScene routes these to the game-state store,
  // then re-pushes the updated body via setBody so the list stays in sync.
  onAddFacility: (bodyId: string, type: FacilityType) => void = () => {};
  onRemoveFacility: (facilityId: string) => void = () => {};

  // The system name is fixed for the life of the view (the diagram never changes
  // system mid-life), so it's a constructor arg, not part of the per-selection DTO.
  constructor(private readonly systemName: string) {}

  setBody(info: SelectedBodyInfo | null): void {
    this.info = info;
    this.hovered = null;
  }

  paint(g: CanvasRenderingContext2D, region: Region): void {
    this.addRects = [];
    this.removeRects = [];
    const x0 = region.x;
    let y = region.y;

    // System name as the region title.
    drawPixelText(g, this.systemName, x0, y, colors.starName, fonts.cardName);
    y += getFont(fonts.cardName).lineHeight + sizes.cardNameGap;

    if (!this.info) {
      drawPixelText(g, 'Select a body', x0, y, colors.textKey, fonts.body);
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
      || this.removeRects.some((r) => inRect(cx, cy, r.rect));
  }

  handleClick(cx: number, cy: number): void {
    if (this.info) {
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
    if (hoverEqual(next, this.hovered)) return false;
    this.hovered = next;
    return true;
  }
}
