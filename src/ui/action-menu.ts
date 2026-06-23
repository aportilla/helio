// ActionMenuPanel — the anchored, pixel-crisp panel that paints one level of the system
// action menu: a title line + a stack of labelled rows with a single highlighted row.
// A pure HUD widget (the BodyInfoCard family): it knows nothing about actions, ships, or
// the scene — it renders a generic { title, rows, cursor } model and reports which row a
// pointer is over. The scene-side controller (src/scene/actions/) maps the ActionMenu
// state machine onto this model and routes hits back into it.
//
// Mirrors Panel's two-pass measure()/paintInto() + Y-down RowZone → Y-up hit conversion,
// trimmed to one column of pill rows. Greyed rows (disabled) paint dim and never hit.

import { drawPixelText, measurePixelText, getFont } from '../data/pixel-font';
import { BasePanel } from './base-panel';
import { paintPillButton, paintSurface, PILL_PAD_X, PILL_PAD_Y } from './painter';
import { colors, fonts, sizes } from './theme';
import { Widget } from './widget';

export interface ActionMenuRow {
  readonly label: string;
  readonly enabled: boolean;
}

export interface ActionMenuModel {
  readonly title: string;
  readonly rows: readonly ActionMenuRow[];
  // The single highlighted row (hover OR keyboard cursor — the controller unifies them).
  // -1 = nothing highlighted.
  readonly cursor: number;
}

// Y-down row band recorded during paintInto, converted to Y-up at hit time (Panel idiom).
interface RowZone {
  readonly index: number;
  readonly y: number;
  readonly h: number;
}

const EMPTY_MODEL: ActionMenuModel = { title: '', rows: [], cursor: -1 };

export class ActionMenuPanel extends BasePanel {
  private model: ActionMenuModel = EMPTY_MODEL;
  private rowZones: RowZone[] = [];
  // Signature of the last painted model — gates rebuilds so a pointermove that doesn't
  // change the highlighted row doesn't churn a fresh canvas + GPU upload every frame.
  private sig = '';

  // Replace the model and repaint, but only when something visible actually changed.
  // Returns true if a rebuild happened (the size may have changed → re-anchor).
  setModel(model: ActionMenuModel): boolean {
    const sig = signature(model);
    if (sig === this.sig) return false;
    this.sig = sig;
    this.model = model;
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

  // Which row index is under (bufX, bufY), or null. Disabled rows are skipped so a click
  // on a greyed row falls through to "absorbed but inert" rather than selecting.
  hitRow(bufX: number, bufY: number): number | null {
    if (!this.visible) return null;
    const v = this.visibleBounds;
    if (bufX < v.x || bufX >= v.x + v.w) return null;
    const panelTop = v.y + v.h; // Y-up top edge
    for (const z of this.rowZones) {
      const topHud = panelTop - z.y;
      const botHud = topHud - z.h;
      if (bufY >= botHud && bufY < topHud) {
        return this.model.rows[z.index]?.enabled ? z.index : null;
      }
    }
    return null;
  }

  // True when the point lies anywhere inside the panel — absorbs the click so it never
  // falls through to the diagram pick beneath an open menu.
  hitsBackground(bufX: number, bufY: number): boolean {
    return this.visible && this.visibleBounds.contains(bufX, bufY);
  }

  private rowHeight(): number {
    return getFont(fonts.body).lineHeight + PILL_PAD_Y * 2 + sizes.panelRowPadY * 2;
  }

  protected measure(): { w: number; h: number } {
    const titleLineH = getFont(fonts.body).lineHeight;
    let maxContentW = measurePixelText(this.model.title, fonts.body);
    for (const r of this.model.rows) {
      const w = measurePixelText(r.label, fonts.body) + PILL_PAD_X * 2;
      if (w > maxContentW) maxContentW = w;
    }
    const W = sizes.padX * 2 + maxContentW;

    let H = sizes.padY;
    if (this.model.title) H += titleLineH + sizes.cardNameGap;
    H += this.rowHeight() * this.model.rows.length;
    H += sizes.padY;
    return { w: W, h: H };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    paintSurface(g, 0, 0, w, h);
    const titleLineH = getFont(fonts.body).lineHeight;
    const rowZones: RowZone[] = [];

    let cursorY = sizes.padY;
    if (this.model.title) {
      drawPixelText(g, this.model.title, sizes.padX, cursorY, colors.starName, fonts.body);
      cursorY += titleLineH + sizes.cardNameGap;
    }

    const rowH = this.rowHeight();
    for (let i = 0; i < this.model.rows.length; i++) {
      const row = this.model.rows[i]!;
      paintPillButton(g, sizes.padX, cursorY + sizes.panelRowPadY, row.label, {
        hover: i === this.model.cursor && row.enabled,
        disabled: !row.enabled,
        font: fonts.body,
      });
      rowZones.push({ index: i, y: cursorY, h: rowH });
      cursorY += rowH;
    }

    this.rowZones = rowZones;
  }
}

// Cheap structural signature for the rebuild gate — title + cursor + each row's
// label/enabled. Two models with the same signature paint identically.
function signature(m: ActionMenuModel): string {
  let s = `${m.title}|${m.cursor}|`;
  for (const r of m.rows) s += `${r.label}:${r.enabled ? 1 : 0};`;
  return s;
}

// TargetBracket — the in-field 'select' reticle that rides the locked target ship while the
// player chooses a command (the Sea-of-Stars target marker). Four 1-px corner Ls around the
// sprite, painted once per radius (cached) and re-placed on the target's slot center. A plain
// Widget CanvasTexture quad, so it sidesteps the snapped-material trip-wires like the panel.
const BRACKET_GAP = 2; // px between the sprite edge and the bracket box
const BRACKET_ARM = 4; // px length of each corner arm

export class TargetBracket extends Widget {
  private builtR = -1;

  // Show the bracket centered on (cx, cy) for a sprite of radius r (buffer px).
  showAt(cx: number, cy: number, r: number): void {
    if (r !== this.builtR) {
      this.build(r);
      this.builtR = r;
    }
    const s = this.width;
    this.placeAt(Math.round(cx - s / 2), Math.round(cy - s / 2));
    this.setVisible(true);
  }

  hide(): void {
    this.setVisible(false);
  }

  private build(r: number): void {
    const S = Math.max(8, Math.round(2 * (r + BRACKET_GAP)));
    const arm = Math.min(BRACKET_ARM, Math.floor(S / 2));
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const g = c.getContext('2d')!;
    g.fillStyle = colors.starName; // bright yellow — the locked-target marker, pops on any hull
    // top-left
    g.fillRect(0, 0, arm, 1);
    g.fillRect(0, 0, 1, arm);
    // top-right
    g.fillRect(S - arm, 0, arm, 1);
    g.fillRect(S - 1, 0, 1, arm);
    // bottom-left
    g.fillRect(0, S - 1, arm, 1);
    g.fillRect(0, S - arm, 1, arm);
    // bottom-right
    g.fillRect(S - arm, S - 1, arm, 1);
    g.fillRect(S - 1, S - arm, 1, arm);
    this.setTexture(c, S, S);
  }
}
