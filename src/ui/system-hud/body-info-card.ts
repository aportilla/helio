// BodyInfoCard — transient on-hover tooltip for the system view. One
// instance lives on SystemHud, fed the picker's catalog-backed result
// (star / planet / moon / belt / ring, or null) each pointer move. A ship
// pick is filtered out upstream by SystemHud — a ship has no catalog row to
// describe, so it shows in the sidebar's ship card instead.
//
// Visually mirrors the rest of the HUD panel family — paintSurface bg,
// yellow title in EspySans 15, Monaco 11 key/value body rows — but
// drops the multi-member nesting and the close-X. Tooltips are
// ephemeral; dismissal is the cursor leaving the disc.
//
// The body → title / subtitle / row projection (the part coupled to the
// catalog vocabulary and procgen thresholds) lives in body-rows.ts; this
// file is just the BasePanel that measures and lays those rows out.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { picksEqual, type BodyOrStarPick } from '../../diagram-pick';
import { BasePanel } from '../base-panel';
import { paintSurface } from '../painter';
import { colors, fonts, sizes } from '../theme';
import { rowsFor, subtitleFor, titleFor } from './body-rows';

export class BodyInfoCard extends BasePanel {
  // Track current target so successive setTarget() calls with the same
  // pick are a no-op — the cursor moves continuously within a disc, but
  // we only need to rebuild the canvas when the picked body changes.
  private current: BodyOrStarPick | null = null;

  setTarget(pick: BodyOrStarPick): void {
    if (picksEqual(pick, this.current)) return;
    this.current = pick;
    this.rebuild();
  }

  // Reset without hiding the mesh — caller toggles visibility. After a
  // clear, the next setTarget always triggers a rebuild.
  clearTarget(): void {
    this.current = null;
  }

  protected measure(): { w: number; h: number } {
    if (!this.current) return { w: 0, h: 0 };
    const title = titleFor(this.current);
    const subtitle = subtitleFor(this.current);
    const titleLineH = getFont(fonts.cardName).lineHeight;
    const subtitleLineH = getFont(fonts.subtitle).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;
    const titleW = measurePixelText(title, fonts.cardName);
    const subtitleW = subtitle ? measurePixelText(subtitle, fonts.subtitle) : 0;

    let maxBodyW = 0;
    const rows = rowsFor(this.current);
    for (const r of rows) {
      const w = measurePixelText(r.key) + measurePixelText(r.val);
      if (w > maxBodyW) maxBodyW = w;
    }

    const w = Math.max(
      sizes.padX * 2 + titleW,
      sizes.padX * 2 + subtitleW,
      sizes.padX * 2 + maxBodyW,
    );
    const h = sizes.padY * 2 + titleLineH
      + (subtitle ? subtitleLineH : 0)
      + sizes.cardNameGap + bodyLineH * rows.length;
    return { w, h };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.current) return;
    paintSurface(g, 0, 0, w, h);

    const titleLineH = getFont(fonts.cardName).lineHeight;
    const subtitleLineH = getFont(fonts.subtitle).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;

    drawPixelText(g, titleFor(this.current), sizes.padX, sizes.padY, colors.starName, fonts.cardName);

    let cursorY = sizes.padY + titleLineH;

    // Subtitle — the composed world descriptor (or star class), dim accent
    // beneath the yellow name, forming the title/subtitle pair above the
    // key/value list.
    const subtitle = subtitleFor(this.current);
    if (subtitle) {
      drawPixelText(g, subtitle, sizes.padX, cursorY, colors.titleDim, fonts.subtitle);
      cursorY += subtitleLineH;
    }
    cursorY += sizes.cardNameGap;

    for (const r of rowsFor(this.current)) {
      drawPixelText(g, r.key, sizes.padX, cursorY, colors.textKey);
      drawPixelText(g, r.val, sizes.padX + measurePixelText(r.key), cursorY, colors.textBody);
      cursorY += bodyLineH;
    }
  }
}
