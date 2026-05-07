// System view header bar — full-width strip across the top of the canvas
// with the system name centered and a 1-px accent line along the bottom.
// The back button is a sibling IconButton (owned by SystemHud), placed on
// top of this bar's left edge after layout.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { STARS, STAR_CLUSTERS } from '../../data/stars';
import { BasePanel } from '../base-panel';
import { colors, fonts } from '../theme';

// Tall enough for the EspySans 20 title with comfortable padding above
// and below; also large enough to vertically center the 17 px back-button
// IconButton.
export const HEADER_HEIGHT = 26;

export class HeaderBar extends BasePanel {
  private readonly clusterIdx: number;
  private headerW = 0;

  constructor(clusterIdx: number, renderOrder = 99) {
    super(renderOrder);
    this.clusterIdx = clusterIdx;
  }

  // Bar width tracks the canvas width — the orchestrator calls this in
  // resize() and rebuild() repaints with the new dimensions.
  setWidth(w: number): void {
    if (this.headerW === w) return;
    this.headerW = w;
    this.rebuild();
  }

  protected measure(): { w: number; h: number } {
    return { w: this.headerW, h: HEADER_HEIGHT };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    g.fillStyle = colors.surface;
    g.fillRect(0, 0, w, h);
    // Bottom accent line — visually separates header from content area.
    g.fillStyle = colors.borderAccent;
    g.fillRect(0, h - 1, w, 1);

    const cluster = STAR_CLUSTERS[this.clusterIdx];
    const primary = STARS[cluster.primary];
    const isMulti = cluster.members.length > 1;
    const text = isMulti ? `${primary.name} +${cluster.members.length - 1}` : primary.name;
    const textW = measurePixelText(text, fonts.title);
    const textH = getFont(fonts.title).lineHeight;
    const x = Math.floor((w - textW) / 2);
    const y = Math.floor((h - 1 - textH) / 2);
    drawPixelText(g, text, x, y, colors.titleBright, fonts.title);
  }
}
