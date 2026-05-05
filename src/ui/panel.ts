// Generic sectioned popover panel. Title + 1+ sections, each with an
// optional header and a list of rows. Two row kinds today:
//
//   toggle: checkbox glyph + label, click flips a boolean
//   action: pill-styled button, click fires an event
//
// Hover-row state lives inside Panel; the orchestrator calls
// setHoveredRow(id) on pointer-move, and Panel rebuilds (only when the
// id actually changed). Click dispatch is the orchestrator's job — Panel
// just exposes hitRow() so the orchestrator can route events.
//
// The panel's close-X is NOT owned by Panel — it's a sibling IconButton
// in the orchestrator. Dismissal policy (close to nothing, close to
// previous screen, etc.) is per-dialog, so we don't bake it in.

import { drawPixelText, getFont, measurePixelText } from '../data/pixel-font';
import { BasePanel } from './base-panel';
import {
  paintCheckbox,
  paintPillButton,
  paintSurface,
} from './painter';
import { colors, fonts, sizes } from './theme';

export type PanelRow =
  | { kind: 'toggle'; id: string; label: string; on: boolean }
  | { kind: 'action'; id: string; label: string };

export interface PanelSection {
  header?: string;
  rows: PanelRow[];
}

export interface PanelSpec {
  title?: string;
  sections: PanelSection[];
}

export interface PanelHit {
  id: string;
  kind: 'toggle' | 'action';
}

interface RowZone {
  id: string;
  kind: 'toggle' | 'action';
  // Y-down coords from the panel's top-left (texture space).
  y: number;
  h: number;
}

// Same X-pad as paintPillButton's internal padding — kept in sync by
// intent (both use 6 px). If you change one, change both.
const ACTION_BTN_PAD_X = 6;

export class Panel extends BasePanel {
  private spec: PanelSpec = { sections: [] };
  private hoveredRowId: string | null = null;

  // Hit zones recorded during the last paintInto() pass. Translated to
  // HUD Y-up at hit-test time using the laid-out panel position.
  private rowZones: RowZone[] = [];

  // Replace the spec and rebuild. Width/height may change → orchestrator
  // must re-anchor after this call.
  setSpec(spec: PanelSpec): void {
    this.spec = spec;
    this.rebuild();
  }

  // Update the hovered-row id and rebuild (label colors flip). No-op when
  // the id is unchanged so a pointermove storm doesn't trigger a rebuild
  // storm.
  setHoveredRow(id: string | null): void {
    if (this.hoveredRowId === id) return;
    this.hoveredRowId = id;
    this.rebuild();
  }

  // Hit-test in HUD buffer coords. Caller ensures bufY is Y-up; this
  // method converts to panel-local Y-down using the panel's current
  // visible bounds.
  hitRow(bufX: number, bufY: number): PanelHit | null {
    if (!this.visible) return null;
    const v = this.visibleBounds;
    if (bufX < v.x || bufX >= v.x + v.w) return null;
    const panelTop = v.y + v.h;
    for (const r of this.rowZones) {
      const rowTopHud    = panelTop - r.y;
      const rowBottomHud = rowTopHud - r.h;
      if (bufY >= rowBottomHud && bufY < rowTopHud) {
        return { id: r.id, kind: r.kind };
      }
    }
    return null;
  }

  // True if the point lies anywhere inside the panel's visible rect.
  // Used to absorb taps so they don't fall through to whatever's behind.
  hitsBackground(bufX: number, bufY: number): boolean {
    return this.visible && this.visibleBounds.contains(bufX, bufY);
  }

  // -- two-pass paint ---------------------------------------------------

  protected measure(): { w: number; h: number } {
    const titleLineH = getFont(fonts.panelTitle).lineHeight;
    const bodyLineH  = getFont(fonts.body).lineHeight;
    const titleW = this.spec.title ? measurePixelText(this.spec.title, fonts.panelTitle) : 0;

    let maxRowContentW = 0;
    for (const section of this.spec.sections) {
      if (section.header) {
        const headerW = measurePixelText(section.header);
        if (headerW > maxRowContentW) maxRowContentW = headerW;
      }
      for (const r of section.rows) {
        const w = r.kind === 'toggle'
          ? sizes.checkbox + sizes.checkboxLabelGap + measurePixelText(r.label)
          : measurePixelText(r.label) + ACTION_BTN_PAD_X * 2;
        if (w > maxRowContentW) maxRowContentW = w;
      }
    }

    // Title line reserves room for a corner close-X (sibling widget that
    // sits flush at the top-right of the panel).
    const titleLineMinW = this.spec.title
      ? sizes.padX + titleW + sizes.nameToCloseGap + sizes.closeBox
      : 0;
    const W = Math.max(titleLineMinW, sizes.padX * 2 + maxRowContentW);

    let H = sizes.padY;
    if (this.spec.title) {
      H += titleLineH + sizes.panelTitleGap + sizes.panelTitleToSection;
    }
    for (let si = 0; si < this.spec.sections.length; si++) {
      if (si > 0) H += sizes.panelSectionGapBefore;
      if (this.spec.sections[si].header) {
        H += bodyLineH + sizes.panelSectionGapAfter;
      }
      for (const r of this.spec.sections[si].rows) {
        H += r.kind === 'toggle'
          ? bodyLineH + sizes.panelRowPadY * 2
          : (bodyLineH + 3 * 2) + sizes.panelRowPadY * 2;  // pill: bodyLineH + 2*padY=6 + 2*rowPad
      }
    }
    H += sizes.padY;

    return { w: W, h: H };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    paintSurface(g, 0, 0, w, h);

    const titleLineH = getFont(fonts.panelTitle).lineHeight;
    const bodyLineH  = getFont(fonts.body).lineHeight;
    const zones: RowZone[] = [];

    let cursorY = sizes.padY;
    if (this.spec.title) {
      drawPixelText(g, this.spec.title, sizes.padX, cursorY, colors.starName, fonts.panelTitle);
      cursorY += titleLineH + sizes.panelTitleGap + sizes.panelTitleToSection;
    }

    for (let si = 0; si < this.spec.sections.length; si++) {
      if (si > 0) cursorY += sizes.panelSectionGapBefore;
      const section = this.spec.sections[si];
      if (section.header) {
        drawPixelText(g, section.header, sizes.padX, cursorY, colors.textKey);
        cursorY += bodyLineH + sizes.panelSectionGapAfter;
      }

      for (const r of section.rows) {
        const isHover = r.id === this.hoveredRowId;
        if (r.kind === 'toggle') {
          const rowTop = cursorY;
          const rowH = bodyLineH + sizes.panelRowPadY * 2;
          const labelY = rowTop + sizes.panelRowPadY;
          const checkboxX = sizes.padX;
          const checkboxY = labelY + Math.floor((bodyLineH - sizes.checkbox) / 2);

          paintCheckbox(g, checkboxX, checkboxY, { on: r.on });

          const labelX = checkboxX + sizes.checkbox + sizes.checkboxLabelGap;
          drawPixelText(
            g, r.label, labelX, labelY,
            isHover ? colors.textBodyHover : colors.textBody,
          );

          zones.push({ id: r.id, kind: 'toggle', y: rowTop, h: rowH });
          cursorY += rowH;
        } else {
          const rowTop = cursorY;
          const btn = paintPillButton(
            g, sizes.padX, rowTop + sizes.panelRowPadY, r.label,
            { hover: isHover },
          );
          const rowH = btn.h + sizes.panelRowPadY * 2;
          zones.push({ id: r.id, kind: 'action', y: rowTop, h: rowH });
          cursorY += rowH;
        }
      }
    }

    this.rowZones = zones;
  }
}
