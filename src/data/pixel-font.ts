import { CanvasTexture, ClampToEdgeWrapping, NearestFilter } from 'three';

// Inline BDF data for Monaco 11px. Each entry: [encoding, advance, bbxW,
// bbxH, bbxX, bbxY, hexRows[]]. Coverage: ASCII 32-126 + ° · — ►.
const FONT_ASCENT = 9;
const FONT_DESCENT = 2;
export const FONT_LINEH = FONT_ASCENT + FONT_DESCENT;

type GlyphTuple = readonly [number, number, number, number, number, number, readonly string[]];

const FONT_GLYPHS: readonly GlyphTuple[] = [
  [32,6,1,1,6,-2,['00']],
  [33,6,1,7,2,0,['80','80','80','80','80','00','80']],
  [34,6,3,2,1,5,['A0','A0']],
  [35,6,5,5,0,2,['50','F8','50','F8','50']],
  [36,6,5,9,0,-1,['20','70','A8','A0','70','28','A8','70','20']],
  [37,6,5,7,0,0,['78','A8','B0','50','68','A8','90']],
  [38,6,5,7,0,0,['60','90','A0','40','A8','90','68']],
  [39,6,1,2,2,5,['80','80']],
  [40,6,3,7,1,0,['20','40','80','80','80','40','20']],
  [41,6,3,7,2,0,['80','40','20','20','20','40','80']],
  [42,6,5,5,0,2,['20','A8','70','A8','20']],
  [43,6,5,5,0,1,['20','20','F8','20','20']],
  [44,6,2,3,1,-2,['40','40','80']],
  [45,6,5,1,0,3,['F8']],
  [46,6,1,1,2,0,['80']],
  [47,6,4,8,1,-1,['10','10','20','20','40','40','80','80']],
  [48,6,5,7,0,0,['70','88','88','88','88','88','70']],
  [49,6,2,7,2,0,['40','C0','40','40','40','40','40']],
  [50,6,5,7,0,0,['70','88','08','10','20','40','F8']],
  [51,6,5,7,0,0,['70','88','08','30','08','88','70']],
  [52,6,5,7,0,0,['10','30','50','90','F8','10','10']],
  [53,6,5,7,0,0,['F8','80','F0','08','08','88','70']],
  [54,6,5,7,0,0,['70','80','F0','88','88','88','70']],
  [55,6,5,7,0,0,['F8','08','08','10','20','20','20']],
  [56,6,5,7,0,0,['70','88','88','70','88','88','70']],
  [57,6,5,7,0,0,['70','88','88','88','78','08','70']],
  [58,6,1,5,2,0,['80','00','00','00','80']],
  [59,6,2,7,1,-2,['40','00','00','00','40','40','80']],
  [60,6,3,5,1,1,['20','40','80','40','20']],
  [61,6,5,3,0,2,['F8','00','F8']],
  [62,6,3,5,1,1,['80','40','20','40','80']],
  [63,6,5,7,0,0,['70','88','08','10','20','00','20']],
  [64,6,5,7,0,0,['70','88','E8','A8','F0','80','70']],
  [65,6,5,7,0,0,['70','88','88','F8','88','88','88']],
  [66,6,5,7,0,0,['F0','88','88','F0','88','88','F0']],
  [67,6,5,7,0,0,['70','88','80','80','80','88','70']],
  [68,6,5,7,0,0,['F0','88','88','88','88','88','F0']],
  [69,6,5,7,0,0,['F8','80','80','F0','80','80','F8']],
  [70,6,5,7,0,0,['F8','80','80','F0','80','80','80']],
  [71,6,5,7,0,0,['70','88','80','98','88','88','70']],
  [72,6,5,7,0,0,['88','88','88','F8','88','88','88']],
  [73,6,1,7,2,0,['80','80','80','80','80','80','80']],
  [74,6,5,7,0,0,['08','08','08','08','88','88','70']],
  [75,6,5,7,0,0,['88','90','A0','C0','A0','90','88']],
  [76,6,5,7,0,0,['80','80','80','80','80','80','F8']],
  [77,6,5,7,0,0,['88','D8','A8','88','88','88','88']],
  [78,6,5,7,0,0,['88','C8','A8','98','88','88','88']],
  [79,6,5,7,0,0,['70','88','88','88','88','88','70']],
  [80,6,5,7,0,0,['F0','88','88','F0','80','80','80']],
  [81,6,5,8,0,-1,['70','88','88','88','88','88','70','08']],
  [82,6,5,7,0,0,['F0','88','88','F0','88','88','88']],
  [83,6,5,7,0,0,['70','88','80','70','08','88','70']],
  [84,6,5,7,0,0,['F8','20','20','20','20','20','20']],
  [85,6,5,7,0,0,['88','88','88','88','88','88','70']],
  [86,6,5,7,0,0,['88','88','88','88','88','50','20']],
  [87,6,5,7,0,0,['88','88','88','88','A8','D8','88']],
  [88,6,5,7,0,0,['88','50','20','20','20','50','88']],
  [89,6,5,7,0,0,['88','88','88','50','20','20','20']],
  [90,6,5,7,0,0,['F8','08','10','20','40','80','F8']],
  [97,6,5,5,0,0,['78','88','88','98','68']],
  [98,6,5,7,0,0,['80','80','F0','88','88','88','F0']],
  [99,6,5,5,0,0,['70','88','80','80','78']],
  [100,6,5,7,0,0,['08','08','78','88','88','88','78']],
  [101,6,5,5,0,0,['70','88','F8','80','78']],
  [102,6,4,7,1,0,['30','40','E0','40','40','40','40']],
  [103,6,5,7,0,-2,['78','88','88','88','78','08','70']],
  [104,6,5,7,0,0,['80','80','F0','88','88','88','88']],
  [105,6,1,7,2,0,['80','00','80','80','80','80','80']],
  [106,6,3,9,0,-2,['20','00','20','20','20','20','20','20','C0']],
  [107,6,5,7,0,0,['80','80','90','A0','E0','90','88']],
  [108,6,1,7,2,0,['80','80','80','80','80','80','80']],
  [109,6,5,5,0,0,['F0','A8','A8','A8','A8']],
  [110,6,5,5,0,0,['B0','C8','88','88','88']],
  [111,6,5,5,0,0,['70','88','88','88','70']],
  [112,6,5,7,0,-2,['F0','88','88','88','F0','80','80']],
  [113,6,5,7,0,-2,['78','88','88','88','78','08','08']],
  [114,6,5,5,0,0,['B0','C8','80','80','80']],
  [115,6,5,5,0,0,['78','80','70','08','F0']],
  [116,6,4,7,1,0,['40','40','E0','40','40','40','30']],
  [117,6,5,5,0,0,['88','88','88','98','68']],
  [118,6,5,5,0,0,['88','88','88','50','20']],
  [119,6,5,5,0,0,['A8','A8','A8','A8','50']],
  [120,6,5,5,0,0,['88','50','20','50','88']],
  [121,6,5,7,0,-2,['88','88','88','88','78','08','70']],
  [122,6,5,5,0,0,['F8','10','20','40','F8']],
  // Symbols mapped to Unicode codepoints (not BDF MacRoman) for JS lookup.
  [0x00B0,6,4,4,1,4,['60','90','90','60']],            // ° degree
  [0x00B7,6,5,5,0,1,['70','F8','F8','F8','70']],       // · middle dot
  [0x2014,6,6,1,0,3,['FC']],                           // — em dash
  [0x25BA,6,5,5,0,1,['80','C0','E0','C0','80']],       // ► right-pointer (custom)
];

interface Glyph {
  adv: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
  rows: readonly string[];
}

const FONT_MAP = new Map<number, Glyph>(
  FONT_GLYPHS.map(g => [g[0], { adv: g[1], w: g[2], h: g[3], ox: g[4], oy: g[5], rows: g[6] }]),
);

export function measurePixelText(text: string): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const g = FONT_MAP.get(text.charCodeAt(i));
    w += g ? g.adv : 6;
  }
  return w;
}

// Glyph bitmap position derives from BDF metrics (bbxX as left bearing, bbxY
// as descent). All glyphs are ≤6px wide, so one byte per row suffices.
function drawPixelGlyph(g2d: CanvasRenderingContext2D, ch: string, cellX: number, cellY: number, color: string): void {
  const glyph = FONT_MAP.get(ch.charCodeAt(0));
  if (!glyph || glyph.w <= 0 || glyph.h <= 0) return;
  const px = cellX + glyph.ox;
  const py = cellY + FONT_ASCENT - glyph.oy - glyph.h;
  g2d.fillStyle = color;
  for (let r = 0; r < glyph.h; r++) {
    const byte = parseInt(glyph.rows[r], 16);
    for (let c = 0; c < glyph.w; c++) {
      if ((byte >> (7 - c)) & 1) g2d.fillRect(px + c, py + r, 1, 1);
    }
  }
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
}

export function makeLabelTexture(text: string, color: string, opts?: LabelTextureOptions): LabelTextureResult;
export function makeLabelTexture(segments: TextSegment[], opts?: LabelTextureOptions): LabelTextureResult;
export function makeLabelTexture(
  textOrSegments: string | TextSegment[],
  colorOrOpts?: string | LabelTextureOptions,
  maybeOpts?: LabelTextureOptions,
): LabelTextureResult {
  let segments: TextSegment[];
  let opts: LabelTextureOptions | undefined;
  if (typeof textOrSegments === 'string') {
    segments = [{ text: textOrSegments, color: colorOrOpts as string }];
    opts = maybeOpts;
  } else {
    segments = textOrSegments;
    opts = colorOrOpts as LabelTextureOptions | undefined;
  }

  const box = !!opts?.box;
  const pad = box ? 4 : 3;
  let textW = 0;
  for (const seg of segments) textW += measurePixelText(seg.text);
  const w = textW + pad * 2;
  const h = FONT_LINEH + pad * 2;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;

  if (box) {
    g.fillStyle = 'rgba(0,8,20,0.92)';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#3a8fe0';
    g.fillRect(0, 0, w, 1); g.fillRect(0, h - 1, w, 1);
    g.fillRect(0, 0, 1, h); g.fillRect(w - 1, 0, 1, h);
  }

  let cursor = pad;
  for (const seg of segments) {
    for (let i = 0; i < seg.text.length; i++) {
      drawPixelGlyph(g, seg.text[i], cursor, pad, seg.color);
      const glyph = FONT_MAP.get(seg.text.charCodeAt(i));
      cursor += glyph ? glyph.adv : 6;
    }
  }

  // Halo only for non-boxed labels — the box bg already provides contrast.
  if (!box) addDarkHalo(g, w, h);

  const tex = new CanvasTexture(c);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  return { tex, w, h };
}
