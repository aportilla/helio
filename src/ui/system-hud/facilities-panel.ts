// FacilitiesPanel — the full-width bar along the bottom of the system view.
// Shows the currently-selected body's name + its placed-facility list + one
// "Add <type>" button per buildable facility type. One instance lives on
// SystemHud; SystemScene drives it through setSelectedBody (selection changed)
// and the onAddFacility / onRemoveFacility callbacks (button / remove-✕
// clicked), re-pushing fresh state after each mutation.
//
// Like BodyInfoCard it's a single BasePanel surface: everything (header, rows,
// remove glyphs, the Add buttons) is painted into one canvas, and the
// interactive sub-regions are hit-tested by recomputing their rects — no nested
// child widgets to manage as the facility list grows and shrinks. The panel is
// hidden (measure → 0×0) whenever nothing is selected.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import type { BodyKind } from '../../data/stars';
import { facilityLabel, type FacilityType } from '../../facilities';
import type { Facility } from '../../game-state';
import { BasePanel } from '../base-panel';
import { PILL_PAD_X, PILL_PAD_Y, paintPillButton, paintSurface } from '../painter';
import { colors, fonts, sizes } from '../theme';

// The selected body, plus its facilities, as the panel needs to render it.
// SystemScene composes this from the catalog Body + the game-state store.
export interface SelectedBodyInfo {
  readonly bodyId: string;
  readonly name: string;
  readonly kind: BodyKind;
  readonly facilities: readonly Facility[];
  // Types this body can still host (registry-derived: physics predicate AND
  // build cap), in Add-button order. SystemScene computes it — it owns the Body.
  readonly addableTypes: readonly FacilityType[];
}

// What a point on the panel resolves to. 'background' = a solid-but-inert part
// of the bar (absorbs the click so it doesn't fall through to deselect).
export type PanelHit =
  | { readonly kind: 'add'; readonly facilityType: FacilityType }
  | { readonly kind: 'remove'; readonly facilityId: string }
  | { readonly kind: 'background' };

const ROW_GAP = 2;
const REMOVE_LABEL_GAP = 6;
// Horizontal gap between the side-by-side Add buttons.
const ADD_BUTTON_GAP = 6;

const KIND_LABEL: Record<BodyKind, string> = {
  planet: 'planet', moon: 'moon', belt: 'belt', ring: 'ring',
};
// The button reads "Add <label>" using facilityLabel — the registry's single
// source of the name; a placed facility's row reuses facilityLabel directly.
const addLabel = (t: FacilityType): string => `Add ${facilityLabel(t).toLowerCase()}`;

interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
interface AddButton { readonly type: FacilityType; readonly label: string; readonly rect: Rect }
interface PanelLayout {
  readonly h: number;
  readonly addButtons: readonly AddButton[];
  readonly removeRects: ReadonlyArray<{ readonly id: string; readonly rect: Rect }>;
}

function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// 1-px X glyph in a closeGlyph×closeGlyph box — the per-row remove affordance.
// A bare X (no L-strut) reads cleaner mid-list than paintCloseX's panel-corner
// variant.
function paintRemoveX(g: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  const N = sizes.closeGlyph;
  g.fillStyle = color;
  for (let i = 0; i < N; i++) {
    g.fillRect(x + i, y + i, 1, 1);
    g.fillRect(x + i, y + (N - 1 - i), 1, 1);
  }
}

type HoverHit = { kind: 'add'; facilityType: FacilityType } | { kind: 'remove'; facilityId: string } | null;

function hoverEqual(a: HoverHit, b: HoverHit): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'remove' && b.kind === 'remove') return a.facilityId === b.facilityId;
  if (a.kind === 'add' && b.kind === 'add') return a.facilityType === b.facilityType;
  return true;
}

export class FacilitiesPanel extends BasePanel {
  private info: SelectedBodyInfo | null = null;
  // Full-bar width in buffer pixels, set from the viewport on resize.
  private barWidth = 1;
  private hovered: HoverHit = null;
  // Cached layout (canvas coords, top-down), computed in measure() and read by
  // paintInto() + hitTest() so the three stay in lockstep.
  private layoutCache: PanelLayout | null = null;

  // Selection changed (or facilities mutated): re-render or hide.
  setBody(info: SelectedBodyInfo | null): void {
    this.info = info;
    this.hovered = null;
    this.rebuild();
  }

  // Viewport resized: re-render at the new bar width (keeps current body).
  setWidth(w: number): void {
    if (this.barWidth === w) return;
    this.barWidth = w;
    this.rebuild();
  }

  // Pure: resolve a buffer-space point to what's under it. Caller guards with
  // visible + bounds.contains, so anything inside the bar that isn't a control
  // is 'background'.
  hitTest(bufX: number, bufY: number): PanelHit | null {
    if (!this.layoutCache) return null;
    // Buffer coords are Y-up with origin at the bar's bottom-left; the canvas is
    // Y-down. Flip into canvas space, then test the cached rects.
    const cx = bufX - this.visibleBounds.x;
    const cy = (this.visibleBounds.y + this.height) - bufY;
    for (const b of this.layoutCache.addButtons) {
      if (inRect(cx, cy, b.rect)) return { kind: 'add', facilityType: b.type };
    }
    for (const r of this.layoutCache.removeRects) {
      if (inRect(cx, cy, r.rect)) return { kind: 'remove', facilityId: r.id };
    }
    return { kind: 'background' };
  }

  // Update hover state for affordance; repaint only when it changes. Returns
  // whether the point is over an interactive control (drives the cursor swap).
  handlePointerMove(bufX: number, bufY: number): boolean {
    const hit = this.hitTest(bufX, bufY);
    const interactive = hit !== null && hit.kind !== 'background';
    const next: HoverHit = hit && hit.kind === 'add' ? { kind: 'add', facilityType: hit.facilityType }
      : hit && hit.kind === 'remove' ? { kind: 'remove', facilityId: hit.facilityId }
      : null;
    if (!hoverEqual(next, this.hovered)) {
      this.hovered = next;
      this.rebuild(); // same size → no re-place needed
    }
    return interactive;
  }

  protected measure(): { w: number; h: number } {
    if (!this.info) { this.layoutCache = null; return { w: 0, h: 0 }; }
    this.layoutCache = this.computeLayout(this.info);
    return { w: this.barWidth, h: this.layoutCache.h };
  }

  private computeLayout(info: SelectedBodyInfo): PanelLayout {
    const headerH = getFont(fonts.cardName).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;
    const rowH = Math.max(sizes.closeBox, bodyLineH);

    let cy = sizes.padY + headerH + sizes.cardNameGap;
    const removeRects: Array<{ id: string; rect: Rect }> = [];
    for (const f of info.facilities) {
      const ry = cy + Math.floor((rowH - sizes.closeBox) / 2);
      removeRects.push({ id: f.id, rect: { x: sizes.padX, y: ry, w: sizes.closeBox, h: sizes.closeBox } });
      cy += rowH + ROW_GAP;
    }

    // One "Add <label>" pill per type the body can still host. A fully-built
    // body (everything at cap) shows none — just its rows.
    const addButtons: AddButton[] = [];
    if (info.addableTypes.length > 0) {
      cy += sizes.cardActionGap;
      const addH = getFont(fonts.body).lineHeight + PILL_PAD_Y * 2;
      let ax = sizes.padX;
      for (const type of info.addableTypes) {
        const label = addLabel(type);
        const w = measurePixelText(label) + PILL_PAD_X * 2;
        addButtons.push({ type, label, rect: { x: ax, y: cy, w, h: addH } });
        ax += w + ADD_BUTTON_GAP;
      }
      cy += addH;
    }
    cy += sizes.padY;

    return { h: cy, addButtons, removeRects };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.info || !this.layoutCache) return;
    paintSurface(g, 0, 0, w, h);

    const headerH = getFont(fonts.cardName).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;
    const rowH = Math.max(sizes.closeBox, bodyLineH);

    // Header: yellow body name + dim kind suffix, sharing one baseline.
    drawPixelText(g, this.info.name, sizes.padX, sizes.padY, colors.starName, fonts.cardName);
    const nameW = measurePixelText(this.info.name, fonts.cardName);
    drawPixelText(g, ` · ${KIND_LABEL[this.info.kind]}`, sizes.padX + nameW, sizes.padY, colors.titleDim, fonts.cardName);

    // Facility rows: remove-✕ + label.
    let cy = sizes.padY + headerH + sizes.cardNameGap;
    for (const f of this.info.facilities) {
      const hov = this.hovered;
      const removeHover = hov !== null && hov.kind === 'remove' && hov.facilityId === f.id;
      const gx = sizes.padX + Math.floor((sizes.closeBox - sizes.closeGlyph) / 2);
      const gy = cy + Math.floor((rowH - sizes.closeGlyph) / 2);
      paintRemoveX(g, gx, gy, removeHover ? colors.glyphHover : colors.glyphOff);
      const labelX = sizes.padX + sizes.closeBox + REMOVE_LABEL_GAP;
      const labelY = cy + Math.floor((rowH - bodyLineH) / 2);
      drawPixelText(g, facilityLabel(f.type), labelX, labelY, colors.textBody);
      cy += rowH + ROW_GAP;
    }

    // Add buttons — one pill per buildable facility type, side by side.
    const hov = this.hovered;
    for (const b of this.layoutCache.addButtons) {
      const addHover = hov !== null && hov.kind === 'add' && hov.facilityType === b.type;
      paintPillButton(g, b.rect.x, b.rect.y, b.label, { hover: addHover });
    }
  }
}
