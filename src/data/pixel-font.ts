import { CanvasTexture, ClampToEdgeWrapping, NearestFilter } from 'three';
import { DEFAULT_FONT, getFont, type FontSpec } from './font-provider';

// Re-export so callers don't need to know about the provider for simple uses.
export {
  DEFAULT_FONT,
  FONT_MONACO_11,
  FONT_CHICAGO_15,
  FONTS,
  getFont,
  initFonts,
  type FontSpec,
  type FontFamily,
} from './font-provider';

export function measurePixelText(text: string, font: FontSpec = DEFAULT_FONT): number {
  return getFont(font).measureText(text);
}

// Draw text into an arbitrary canvas at (x, y) — exported so callers (e.g.
// the HUD) can compose text into their own canvases alongside borders, fills,
// and other primitives without going through makeLabelTexture.
export function drawPixelText(
  g2d: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  font: FontSpec = DEFAULT_FONT,
): void {
  getFont(font).drawText(g2d, text, x, y, color);
}

// Fill any transparent pixel adjacent to an opaque one with dark BG. Gives
// labels a 1px halo so they read against any background.
function addDarkHalo(g: CanvasRenderingContext2D, w: number, h: number): void {
  const img = g.getImageData(0, 0, w, h);
  const px = img.data;
  const mask = new Uint8Array(w * h);
  for (let i = 0, k = 0; k < mask.length; i += 4, k++) {
    mask[k] = px[i + 3] > 0 ? 1 : 0;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (mask[k]) continue;
      const has = (y > 0 && mask[k - w]) || (y < h - 1 && mask[k + w]) ||
                  (x > 0 && mask[k - 1]) || (x < w - 1 && mask[k + 1]);
      if (has) {
        const o = k * 4;
        px[o] = 0; px[o + 1] = 0; px[o + 2] = 16; px[o + 3] = 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
}

export interface TextSegment {
  text: string;
  color: string;
}

export interface LabelTextureResult {
  tex: CanvasTexture;
  w: number;
  h: number;
}

export interface LabelTextureOptions {
  box?: boolean;
  // Font to render with (e.g. FONT_MONACO_11, FONTS.Chicago[15]). Defaults
  // to DEFAULT_FONT when omitted.
  font?: FontSpec;
}

export function makeLabelTexture(text: string, color: string, opts?: LabelTextureOptions): LabelTextureResult;
export function makeLabelTexture(segments: TextSegment[], opts?: LabelTextureOptions): LabelTextureResult;
export function makeLabelTexture(lines: TextSegment[][], opts?: LabelTextureOptions): LabelTextureResult;
export function makeLabelTexture(
  arg1: string | TextSegment[] | TextSegment[][],
  arg2?: string | LabelTextureOptions,
  arg3?: LabelTextureOptions,
): LabelTextureResult {
  // Normalize to TextSegment[][] (lines of segments) regardless of overload.
  let lines: TextSegment[][];
  let opts: LabelTextureOptions | undefined;
  if (typeof arg1 === 'string') {
    lines = [[{ text: arg1, color: arg2 as string }]];
    opts = arg3;
  } else if (arg1.length > 0 && Array.isArray(arg1[0])) {
    lines = arg1 as TextSegment[][];
    opts = arg2 as LabelTextureOptions | undefined;
  } else {
    lines = [arg1 as TextSegment[]];
    opts = arg2 as LabelTextureOptions | undefined;
  }

  const font = getFont(opts?.font ?? DEFAULT_FONT);
  const lineH = font.lineHeight;

  const box = !!opts?.box;
  // Boxed labels get an extra px of horizontal breathing room (padX > padY)
  // so glyphs don't crowd the side borders — vertically the cap-height +
  // descender already leaves visible whitespace inside the frame, but
  // horizontally the glyphs sit right against their cells.
  const padX = box ? 5 : 3;
  const padY = box ? 4 : 3;
  let maxTextW = 0;
  for (const line of lines) {
    let lineW = 0;
    for (const seg of line) lineW += font.measureText(seg.text);
    if (lineW > maxTextW) maxTextW = lineW;
  }
  const w = maxTextW + padX * 2;
  const h = lineH * lines.length + padY * 2;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;

  if (box) {
    g.fillStyle = '#000814';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#3a8fe0';
    g.fillRect(0, 0, w, 1); g.fillRect(0, h - 1, w, 1);
    g.fillRect(0, 0, 1, h); g.fillRect(w - 1, 0, 1, h);
  }

  lines.forEach((line, lineIdx) => {
    let cursor = padX;
    const cellY = padY + lineH * lineIdx;
    for (const seg of line) {
      font.drawText(g, seg.text, cursor, cellY, seg.color);
      cursor += font.measureText(seg.text);
    }
  });

  // Halo only for non-boxed labels — the box bg already provides contrast.
  if (!box) addDarkHalo(g, w, h);

  const tex = new CanvasTexture(c);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  // colorSpace intentionally left at default. With ColorManagement disabled
  // and outputColorSpace = LinearSRGBColorSpace (set in scene.ts), the whole
  // pipeline is raw sRGB end-to-end, so we want the sampler to return the
  // canvas pixels untouched.
  return { tex, w, h };
}
