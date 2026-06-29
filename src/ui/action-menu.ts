// ActionMenuPanel — the anchored, pixel-crisp panel behind the system action menu. It paints
// one level of the menu as a Sea-of-Stars-style plate: a label that FLOATS above a tight box,
// and inside the box a stack of plain-text rows in just two states (active / inactive). The
// "which row is selected" reading is NOT a third row state — it is a separate bouncing pointer
// (MenuPointer) the controller rides on the cursor row, so the rows themselves never need a
// highlighted state. A pure HUD widget (the BodyInfoCard family): it knows nothing about
// actions, ships, or the scene — it renders a generic { title, rows, cursor } model, reports
// which row a pointer is over, and exposes the box rect + the cursor-row anchor so the
// controller can place the pointer and the actor-switch arrows around it.
//
// Mirrors Panel's two-pass measure()/paintInto() + Y-down RowZone → Y-up hit conversion. The
// cursor is deliberately OUTSIDE the paint signature: moving it only re-places the separate
// pointer widget, never repaints the box.

import { drawPixelText, measurePixelText, getFont } from '../data/pixel-font';
import { BasePanel } from './base-panel';
import { paintSurface } from './painter';
import { colors, fonts, sizes } from './theme';
import { Widget } from './widget';

export interface ActionMenuRow {
  readonly label: string;
  readonly enabled: boolean;
}

export interface ActionMenuModel {
  readonly title: string;
  readonly rows: readonly ActionMenuRow[];
  // The single highlighted row (hover OR keyboard cursor — the controller unifies them). The
  // panel does not paint it; it reports its anchor via cursorPointerAnchor() so the controller
  // rides the bouncing pointer there. -1 = nothing highlighted.
  readonly cursor: number;
}

// Y-down row band recorded during paintInto, converted to Y-up at hit time (Panel idiom).
interface RowZone {
  readonly index: number;
  readonly y: number;
  readonly h: number;
}

// A plain buffer-px rect (Y-up). Returned to the controller so it can flank the box with the
// actor-switch arrows without reaching into the widget's internals.
export interface BoxRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// The resting placement of the bouncing pointer for the cursor row: the box-interior left edge
// it points right FROM, and the row's vertical center. The controller adds the per-frame bob.
export interface PointerAnchor {
  readonly left: number;
  readonly centerY: number;
}

const EMPTY_MODEL: ActionMenuModel = { title: '', rows: [], cursor: -1 };

// Gap (px) between the floating label and the box's top border — the "floats above" air.
const TITLE_GAP = 3;
// Vertical padding (px) above/below each row's text inside the box. Tighter than a pill — the
// box is the only border now, so rows pack as a clean stack.
const ROW_PAD_Y = 2;
// Box-interior left gutter (px) reserved for the bouncing pointer: its width plus breathing
// room so the row text never collides with the pointer at the extremes of its bob.
const POINTER_GUTTER = 9;

export class ActionMenuPanel extends BasePanel {
  private model: ActionMenuModel = EMPTY_MODEL;
  private rowZones: RowZone[] = [];
  // Box sub-rect within the canvas (the canvas also holds the floating title band above it).
  // Set by measure(), read by paintInto() + the box/anchor accessors after placeAt().
  private boxW = 0;
  private boxH = 0;
  private titleBandH = 0;
  // Signature of the last PAINTED model — title + rows only, NOT the cursor. A cursor move just
  // re-rides the pointer, so it must not churn a fresh canvas + GPU upload every frame.
  private sig = '';

  // Replace the model and repaint, but only when the painted content actually changed. The new
  // model is always stored (the controller reads model.cursor for the pointer even on a
  // cursor-only change). Returns true if a rebuild happened (the size may have changed → re-anchor).
  setModel(model: ActionMenuModel): boolean {
    this.model = model;
    const sig = paintSignature(model);
    if (sig === this.sig) return false;
    this.sig = sig;
    this.rebuild();
    return true;
  }

  // Hide the panel and clear the rebuild gate, so the NEXT setModel always repaints (and
  // re-shows) even if it carries the same content the panel last painted before closing.
  reset(): void {
    this.sig = '';
    this.model = EMPTY_MODEL;
    this.setVisible(false);
  }

  // Which row index is under (bufX, bufY), or null. The X test is the BOX, not the whole canvas
  // (the floating title may overhang it). Disabled rows are skipped so a click on a greyed row
  // falls through to "absorbed but inert" rather than selecting.
  hitRow(bufX: number, bufY: number): number | null {
    if (!this.visible) return null;
    const v = this.visibleBounds;
    if (bufX < v.x || bufX >= v.x + this.boxW) return null;
    const panelTop = v.y + v.h; // Y-up top edge of the canvas
    for (const z of this.rowZones) {
      const topHud = panelTop - z.y;
      const botHud = topHud - z.h;
      if (bufY >= botHud && bufY < topHud) {
        return this.model.rows[z.index]?.enabled ? z.index : null;
      }
    }
    return null;
  }

  // True when the point lies anywhere on the plate — the box AND the floating-label band above
  // it. Absorbs the click so it never falls through to the diagram pick beneath an open menu,
  // and so a click on the menu's own label is inert rather than silently closing the menu.
  hitsBackground(bufX: number, bufY: number): boolean {
    return this.visible && this.visibleBounds.contains(bufX, bufY);
  }

  // The box's height (px) — the bordered plate alone, sans the floating-title band. The controller
  // centers THIS on the anchored sprite on first placement, then pins its TOP edge across a drill (so
  // a differing sub-menu row count grows the box downward, no vertical jump); the title floats above.
  get boxHeight(): number {
    return this.boxH;
  }

  // The box rect (Y-up buffer px) — the bordered plate, excluding the floating-title band above
  // it. The controller flanks this with the actor-switch arrows. Null when not visible.
  boxBounds(): BoxRect | null {
    if (!this.visible) return null;
    const v = this.visibleBounds;
    // The box sits at the BOTTOM of the canvas (the title band is the top strip), so its Y-up
    // bottom is the canvas bottom and its height is boxH.
    return { x: v.x, y: v.y, w: this.boxW, h: this.boxH };
  }

  // Where the bouncing pointer should rest for the current cursor row: its left edge (just
  // inside the box) and the row's vertical center, both Y-up buffer px. The pointer rides ANY
  // valid cursor row — including a disabled one (the SoS idiom: the cursor still marks where you
  // are on a greyed entry), so the menu always shows a focus indicator. Null only when there's
  // no cursor row at all (e.g. an empty level).
  cursorPointerAnchor(): PointerAnchor | null {
    if (!this.visible) return null;
    const i = this.model.cursor;
    if (i < 0 || i >= this.model.rows.length) return null;
    const z = this.rowZones.find((r) => r.index === i);
    if (!z) return null;
    const v = this.visibleBounds;
    const canvasTop = v.y + v.h;
    const centerY = Math.round(canvasTop - z.y - z.h / 2);
    return { left: v.x + sizes.padX, centerY };
  }

  private rowHeight(): number {
    return getFont(fonts.body).lineHeight + ROW_PAD_Y * 2;
  }

  protected measure(): { w: number; h: number } {
    const titleLineH = getFont(fonts.body).lineHeight;
    let maxTextW = 0;
    for (const r of this.model.rows) {
      const w = measurePixelText(r.label, fonts.body);
      if (w > maxTextW) maxTextW = w;
    }

    this.titleBandH = this.model.title ? titleLineH + TITLE_GAP : 0;
    this.boxW = sizes.padX * 2 + POINTER_GUTTER + maxTextW;
    this.boxH = sizes.padY * 2 + this.rowHeight() * this.model.rows.length;

    // The label floats above the box and may be wider than it — the canvas grows to hold it,
    // while the box itself stays a tight wrap of the row stack.
    const titleW = this.model.title ? sizes.padX + measurePixelText(this.model.title, fonts.body) : 0;
    return { w: Math.max(this.boxW, titleW), h: this.titleBandH + this.boxH };
  }

  protected paintInto(g: CanvasRenderingContext2D, _w: number, _h: number): void {
    // Floating label: drawn in the transparent band at the top of the canvas, above the box.
    if (this.model.title) {
      drawPixelText(g, this.model.title, sizes.padX, 0, colors.starName, fonts.body);
    }

    // The tight box — one border around the whole row stack (no per-row pills).
    paintSurface(g, 0, this.titleBandH, this.boxW, this.boxH);

    const rowH = this.rowHeight();
    const textX = sizes.padX + POINTER_GUTTER;
    const rowZones: RowZone[] = [];
    let cursorY = this.titleBandH + sizes.padY;
    for (let i = 0; i < this.model.rows.length; i++) {
      const row = this.model.rows[i]!;
      // Two states only — the bouncing pointer carries the selection, so rows never highlight.
      const color = row.enabled ? colors.titleBright : colors.titleDim;
      drawPixelText(g, row.label, textX, cursorY + ROW_PAD_Y, color, fonts.body);
      rowZones.push({ index: i, y: cursorY, h: rowH });
      cursorY += rowH;
    }
    this.rowZones = rowZones;
  }
}

// Cheap structural signature for the rebuild gate — title + each row's label/enabled. The
// CURSOR is intentionally excluded: it only moves the separate pointer widget, never the paint.
function paintSignature(m: ActionMenuModel): string {
  let s = `${m.title}|`;
  for (const r of m.rows) s += `${r.label}:${r.enabled ? 1 : 0};`;
  return s;
}

// -- field + adornment widgets ------------------------------------------

// A right-pointing triangle (apex on the right edge) baked into a transparent canvas. Shared by
// the bouncing pointer and the actor arrows; `dir` mirrors it. Height should be odd so the apex
// lands on a single center row (crisp point, no 2-px nub).
function paintTriangle(dir: 'left' | 'right', w: number, h: number, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  const center = (h - 1) / 2;
  for (let r = 0; r < h; r++) {
    const dist = Math.abs(r - center);
    const len = w - dist;
    // right: rows start at column 0, narrowing from the right → apex points right.
    // left:  rows start at column `dist`, narrowing from the left → apex points left.
    g.fillRect(dir === 'right' ? 0 : dist, r, len, 1);
  }
  return c;
}

// MenuPointer — the bouncing 'you are here' focus indicator (the Sea-of-Stars hand, as a plain
// triangle). A right-pointing arrow that bobs horizontally toward whatever is focused: a menu row
// at the category/command levels, and — once the menu hides for target selection — the locked
// TARGET ship out in the field. The controller decides where it points; this is one widget that
// follows the focus everywhere. Built once and re-placed every frame, so it sets the mesh position
// DIRECTLY (no placeAt → no per-frame Bounds allocation; it is never hit-tested).
const POINTER_W = 5;
const POINTER_H = 7;

export class MenuPointer extends Widget {
  constructor(renderOrder = 130) {
    super(renderOrder);
    this.setTexture(paintTriangle('right', POINTER_W, POINTER_H, colors.textBodyHover), POINTER_W, POINTER_H);
    this.setVisible(false);
  }

  // Place the pointer's left edge at `left`, vertically centered on `centerY` (Y-up buffer px).
  // Sets the mesh position directly to stay allocation-free in the per-frame bob. The Y center is
  // re-derived from an integer bottom (placeAt's convention) so this odd-height quad keeps
  // INTEGER top/bottom edges — a raw integer center would land them on half-pixels and smear the
  // apex under NearestFilter. `left` is already integer (the bob is Math.round'd).
  moveTo(left: number, centerY: number): void {
    const cy = Math.round(centerY - this.h / 2) + this.h / 2;
    this.mesh.position.set(left + this.w / 2, cy, 0);
  }
}

// ActorArrow — a static ◄ / ► affordance flanking the box, telling the player there are other
// commandable actors to switch between (the Sea-of-Stars side arrows). Clickable: the controller
// hit-tests its bounds and cycles the actor. Built once at its declared facing.
const ARROW_W = 5;
const ARROW_H = 9;
const ARROW_HIT_PAD = 4; // the triangle is tiny — inflate the click target around it

export class ActorArrow extends Widget {
  constructor(dir: 'left' | 'right', renderOrder = 125) {
    super(renderOrder);
    this.setTexture(paintTriangle(dir, ARROW_W, ARROW_H, colors.textBodyHover), ARROW_W, ARROW_H);
    this.setHitPad(ARROW_HIT_PAD);
    this.setVisible(false);
  }
}
