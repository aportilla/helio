// Star info card — shown in the top-right when a star is selected.
// Two-font layout: name in EspySans 15 (display), key/value body lines
// in Monaco 11. Different enough from the generic Panel (no toggle/
// action rows, no sections, two fonts mixed) to be its own subclass.
//
// Close-X is NOT owned by InfoCard — it's a sibling IconButton in the
// orchestrator. Dismissal policy (clear selection) lives there.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { STARS } from '../../data/stars';
import { BasePanel } from '../base-panel';
import { paintSurface } from '../painter';
import { colors, fonts, sizes } from '../theme';

interface BodyRow { key: string; val: string; }

function bodyForStar(starIdx: number): BodyRow[] {
  const s = STARS[starIdx];
  return [
    { key: 'class    ', val: s.cls },
    { key: 'distance ', val: `${s.distLy.toFixed(2)} ly` },
    { key: 'mass     ', val: `${s.mass.toFixed(2)} Msun` },
    { key: 'diameter ', val: `${s.radiusSolar.toFixed(2)} Dsun` },
  ];
}

export class InfoCard extends BasePanel {
  private starIdx = -1;

  // Pass -1 to clear (hides the card). Otherwise rebuilds the texture
  // for the selected star.
  setStar(starIdx: number): void {
    if (this.starIdx === starIdx) return;
    this.starIdx = starIdx;
    if (starIdx < 0) {
      this.setVisible(false);
      return;
    }
    this.rebuild();
  }

  protected measure(): { w: number; h: number } {
    if (this.starIdx < 0) return { w: 0, h: 0 };
    const s = STARS[this.starIdx];
    const body = bodyForStar(this.starIdx);
    const nameLineH = getFont(fonts.cardName).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;

    const nameW = measurePixelText(s.name, fonts.cardName);
    let maxBodyW = 0;
    for (const b of body) {
      const w = measurePixelText(b.key) + measurePixelText(b.val);
      if (w > maxBodyW) maxBodyW = w;
    }
    // Name line reserves room for the corner close-X (sibling widget).
    const W = Math.max(
      sizes.padX + nameW + sizes.nameToCloseGap + sizes.closeBox,
      sizes.padX * 2 + maxBodyW,
    );
    const H = sizes.padY * 2 + nameLineH + sizes.cardNameGap + bodyLineH * body.length;
    return { w: W, h: H };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    const s = STARS[this.starIdx];
    const body = bodyForStar(this.starIdx);
    const nameLineH = getFont(fonts.cardName).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;

    paintSurface(g, 0, 0, w, h);

    drawPixelText(g, s.name, sizes.padX, sizes.padY, colors.starName, fonts.cardName);

    let cursorY = sizes.padY + nameLineH + sizes.cardNameGap;
    for (const b of body) {
      drawPixelText(g, b.key, sizes.padX, cursorY, colors.textKey);
      drawPixelText(g, b.val, sizes.padX + measurePixelText(b.key), cursorY, colors.textBody);
      cursorY += bodyLineH;
    }
  }
}
