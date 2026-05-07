// Map-screen title block: accent bar + title (with optional subtitle).
// Static — texture built once at construction, never rebuilt.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { colors, fonts } from '../theme';
import { Widget } from '../widget';

const ACCENT_W   = 2;
const GAP_LEFT   = 4;
const PAD_RIGHT  = 4;
const PAD_TOPBOT = 3;

export class TitleBlock extends Widget {
  constructor(line1 = 'HELIO', line2?: string) {
    super(100);

    const w1 = measurePixelText(line1, fonts.title);
    const lineH1 = getFont(fonts.title).lineHeight;
    const w2 = line2 ? measurePixelText(line2, fonts.subtitle) : 0;
    const lineH2 = line2 ? getFont(fonts.subtitle).lineHeight : 0;
    const W = ACCENT_W + GAP_LEFT + Math.max(w1, w2) + PAD_RIGHT;
    const H = lineH1 + lineH2 + PAD_TOPBOT * 2;

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;

    // Left accent bar in bright cyan, mirroring the original CSS border-left.
    g.fillStyle = colors.borderAccent;
    g.fillRect(0, 0, ACCENT_W, H);

    drawPixelText(g, line1, ACCENT_W + GAP_LEFT, PAD_TOPBOT, colors.titleBright, fonts.title);
    if (line2) {
      drawPixelText(g, line2, ACCENT_W + GAP_LEFT, PAD_TOPBOT + lineH1, colors.titleDim, fonts.subtitle);
    }

    this.setTexture(c, W, H);
  }
}
