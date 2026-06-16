// FacilitiesPanel — the full-width bar along the bottom of the system view.
// Shows the currently-selected body's name + its colony list + an "Add colony"
// button. One instance lives on SystemHud; SystemScene drives it through
// setSelectedBody (selection changed) and the onAddFacility / onRemoveFacility
// callbacks (button / remove-✕ clicked), re-pushing fresh state after each
// mutation.
//
// Like BodyInfoCard it's a single BasePanel surface: everything (header, rows,
// remove glyphs, the Add button) is painted into one canvas, and the
// interactive sub-regions are hit-tested by recomputing their rects — no nested
// child widgets to manage as the facility list grows and shrinks. The panel is
// hidden (measure → 0×0) whenever nothing is selected.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import type { BodyKind } from '../../data/stars';
import type { Facility, FacilityType } from '../../game-state';
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
}

// What a point on the panel resolves to. 'background' = a solid-but-inert part
// of the bar (absorbs the click so it doesn't fall through to deselect).
export type PanelHit =
  | { readonly kind: 'add' }
  | { readonly kind: 'remove'; readonly facilityId: string }
  | { readonly kind: 'background' };

const ADD_LABEL = 'Add colony';
const ROW_GAP = 2;
const REMOVE_LABEL_GAP = 6;

const KIND_LABEL: Record<BodyKind, string> = {
  planet: 'planet', moon: 'moon', belt: 'belt', ring: 'ring',
};
const FACILITY_LABEL: Record<FacilityType, string> = {
  colony: 'Colony',
};

interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
interface PanelLayout {
  readonly h: number;
  readonly addRect: Rect;
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

type HoverHit = { kind: 'add' } | { kind: 'remove'; facilityId: string } | null;

function hoverEqual(a: HoverHit, b: HoverHit): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'remove' && b.kind === 'remove') return a.facilityId === b.facilityId;
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
    if (inRect(cx, cy, this.layoutCache.addRect)) return { kind: 'add' };
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
    const next: HoverHit = hit && hit.kind === 'add' ? { kind: 'add' }
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

    cy += sizes.cardActionGap;
    const addW = measurePixelText(ADD_LABEL) + PILL_PAD_X * 2;
    const addH = getFont(fonts.body).lineHeight + PILL_PAD_Y * 2;
    const addRect: Rect = { x: sizes.padX, y: cy, w: addW, h: addH };
    cy += addH + sizes.padY;

    return { h: cy, addRect, removeRects };
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
      drawPixelText(g, FACILITY_LABEL[f.type], labelX, labelY, colors.textBody);
      cy += rowH + ROW_GAP;
    }

    // Add button.
    const addHover = this.hovered?.kind === 'add';
    paintPillButton(g, this.layoutCache.addRect.x, this.layoutCache.addRect.y, ADD_LABEL, { hover: addHover });
  }
}
