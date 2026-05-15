// BDF (Glyph Bitmap Distribution Format) loader + atlas-based renderer.
// One BdfFont per parsed .bdf file. On first draw/measure we build a single
// canvas atlas containing every glyph as opaque WHITE-on-transparent pixels;
// drawText then issues one drawImage per glyph from the atlas.
//
// Atlas pixels are white because starmap text is overwhelmingly light-on-dark
// — white callers take a fast no-recolor path. Other colors route through a
// per-call temp-canvas + source-in tint (the os-home approach), which keeps
// memory at one atlas per font regardless of how many colors callers use.
//
// The atlas is rebuilt lazily, so addGlyph() (used to inject the custom ►
// pointer onto Monaco) just sets a dirty flag and the next draw rebuilds.
//
// Canvas creation prefers HTMLCanvasElement when document is available and
// falls back to OffscreenCanvas — keeps the renderer worker-safe.

export interface Glyph {
  adv: number;          // advance width (DWIDTH x)
  w: number;            // bbox width
  h: number;            // bbox height
  ox: number;           // bbox x-offset (left bearing)
  oy: number;           // bbox y-offset (descent below baseline)
  bytes: Uint8Array[];  // one row per Uint8Array; bit 7 of byte 0 = leftmost pixel
}

interface AtlasSlot {
  ax: number;     // x in atlas
  w: number;      // bbox width
  h: number;      // bbox height
  drawX: number;  // bbox x-offset for placement (== glyph.ox)
  drawY: number;  // y-offset from cell-top to bbox-top (== ascent - oy - h)
  adv: number;    // advance width
}

// MacRoman codepoints 128–255 don't match Unicode, so we identify those
// glyphs by their BDF STARTCHAR name and remap to the Unicode codepoint
// callers actually use. Keep this set tight — only the glyphs we render.
// Note: bullet → U+00B7 (middle dot), not the canonical U+2022 — matches
// what the existing label code uses ("·").
const NAME_TO_CODEPOINT: Record<string, number> = {
  degree: 0x00B0,
  bullet: 0x00B7,
  emdash: 0x2014,
  endash: 0x2013,
  odieresis: 0x00F6,
  plusminus: 0x00B1,
  greaterequal: 0x2265,
};

function decideCodepoint(name: string, encoding: number): number {
  // Glyphs named uniXXXX (e.g. Chicago's re-encoded mac symbols) carry their
  // Unicode codepoint in the name itself.
  const m = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return parseInt(m[1], 16);
  // Encoding ≥ 256 means the BDF was already authored with Unicode codepoints.
  if (encoding >= 256) return encoding;
  // Printable ASCII: encoding == codepoint.
  if (encoding >= 32 && encoding <= 126) return encoding;
  // MacRoman 128–255: look up by name.
  if (encoding >= 128 && encoding <= 255 && NAME_TO_CODEPOINT[name] != null) {
    return NAME_TO_CODEPOINT[name];
  }
  return -1;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

function isWhite(color: string): boolean {
  return color === '#fff' || color === '#ffffff' || color === '#FFFFFF' || color === 'white';
}

export class BdfFont {
  readonly name: string;
  readonly pixelSize: number;
  readonly ascent: number;
  readonly descent: number;
  private glyphs = new Map<number, Glyph>();
  private slots = new Map<number, AtlasSlot>();
  private atlas: AnyCanvas | null = null;
  private atlasDirty = true;

  constructor(opts: { name: string; pixelSize: number; ascent: number; descent: number }) {
    this.name = opts.name;
    this.pixelSize = opts.pixelSize;
    this.ascent = opts.ascent;
    this.descent = opts.descent;
  }

  get lineHeight(): number { return this.ascent + this.descent; }

  getGlyph(codepoint: number): Glyph | undefined { return this.glyphs.get(codepoint); }

  // Register or override a glyph. Useful for adding symbols not present in
  // the BDF source (e.g. the custom ► used by the starmap UI). Marks the
  // atlas dirty so the next draw rebuilds it.
  addGlyph(codepoint: number, glyph: Glyph): void {
    this.glyphs.set(codepoint, glyph);
    this.atlasDirty = true;
  }

  measureText(text: string): number {
    let w = 0;
    for (let i = 0; i < text.length; i++) {
      const g = this.glyphs.get(text.charCodeAt(i));
      w += g ? g.adv : this.pixelSize;
    }
    return w;
  }

  // Draws text with its top-left at (x, y). The baseline lands at y + ascent.
  // White color (the atlas's native color) takes a fast direct-blit path; any
  // other color routes through a temp-canvas source-in recolor.
  //
  // Leading-bearing rule: callers anchor runs to a column edge (info-card
  // padX, axis-label origin, panel row indent), so the contract is "ink
  // starts at x," not "advance origin starts at x." We shift the whole run
  // left by max(0, ox_first) so positive leading bearings (Monaco 't' = +1,
  // 'l'/'i' = +2 — the font centers narrow stems within the 6-px cell) don't
  // recess the first glyph from its column. Negative leading bearings
  // (EspySans 'A' = -1) are preserved as overhang, since the designer drew
  // the diagonal hanging past the cursor on purpose.
  drawText(g2d: AnyCtx2D, text: string, x: number, y: number, color: string): void {
    if (this.atlasDirty) this.buildAtlas();
    if (!this.atlas) return;

    const firstSlot = this.slots.get(text.charCodeAt(0));
    const trim = firstSlot ? Math.max(0, firstSlot.drawX) : 0;

    if (isWhite(color)) {
      this.blitGlyphs(g2d, text, x - trim, y);
      return;
    }

    const advW = this.measureText(text);
    if (advW <= 0) return;
    // The tint path stages through a temp canvas (so source-in can recolor
    // the glyphs) instead of blitting straight to g2d. Without leading
    // padding, a negative-ox first glyph (EspySans 'A' = -1) would land at
    // temp-x = drawX, get clipped at the canvas edge, and composite back
    // already missing a column. Symmetric trailing pad covers any right
    // overhang on the last glyph (bitmap extending past its advance).
    const lastSlot  = this.slots.get(text.charCodeAt(text.length - 1));
    const leadingPad  = firstSlot ? Math.max(0, -firstSlot.drawX) : 0;
    const trailingPad = lastSlot
      ? Math.max(0, lastSlot.w + lastSlot.drawX - lastSlot.adv)
      : 0;
    const w = advW + leadingPad + trailingPad;
    const h = this.lineHeight;
    const tmp = makeCanvas(w, h);
    const tctx = tmp.getContext('2d') as AnyCtx2D;
    tctx.imageSmoothingEnabled = false;
    this.blitGlyphs(tctx, text, leadingPad, 0);
    // source-in keeps only pixels that overlap existing alpha — fillRect with
    // the target color tints the glyphs while leaving the background empty.
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, w, h);
    // leadingPad compensates the negative-ox overhang stored in the temp
    // canvas; trim applies the leading-bearing rule (see drawText header)
    // so positive ox shifts the whole run left. The two are sign-disjoint
    // — one is 0 when the other is non-zero — so they sum cleanly.
    g2d.drawImage(tmp as CanvasImageSource, x - leadingPad - trim, y);
  }

  private blitGlyphs(g2d: AnyCtx2D, text: string, x: number, y: number): void {
    if (!this.atlas) return;
    let cursor = x;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const slot = this.slots.get(code);
      if (slot && slot.w > 0 && slot.h > 0) {
        g2d.drawImage(
          this.atlas as CanvasImageSource,
          slot.ax, 0, slot.w, slot.h,
          cursor + slot.drawX, y + slot.drawY, slot.w, slot.h,
        );
      }
      cursor += slot ? slot.adv : this.pixelSize;
    }
  }

  private buildAtlas(): void {
    // Single-row layout: every glyph gets a strip in a canvas of height =
    // max bbox height. We track each glyph's drawY (its vertical offset
    // within the cell) on the slot, not in the atlas — that way the atlas
    // stays compact (~7px tall for Monaco 11) regardless of cell height.
    this.slots.clear();
    let total = 0;
    let maxH = 0;
    const layout: Array<{ cp: number; g: Glyph; ax: number; drawY: number }> = [];
    for (const [cp, g] of this.glyphs) {
      const drawY = this.ascent - g.oy - g.h;
      layout.push({ cp, g, ax: total, drawY });
      // 1px gap between slots so the atlas is readable in a debugger.
      // drawImage uses exact sub-rects so the gap isn't required for
      // rendering correctness.
      total += Math.max(1, g.w) + 1;
      if (g.h > maxH) maxH = g.h;
    }
    const W = Math.max(1, total);
    const H = Math.max(1, maxH);
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d') as AnyCtx2D;
    ctx.imageSmoothingEnabled = false;

    // Build the whole atlas as one ImageData then putImageData once — far
    // faster than per-pixel fillRect and gives a clean 1-bit alpha channel.
    const img = ctx.createImageData(W, H);
    const data = img.data;
    for (const { cp, g, ax, drawY } of layout) {
      this.slots.set(cp, { ax, w: g.w, h: g.h, drawX: g.ox, drawY, adv: g.adv });
      if (g.w <= 0 || g.h <= 0) continue;
      for (let r = 0; r < g.h; r++) {
        const row = g.bytes[r];
        for (let c = 0; c < g.w; c++) {
          const byte = row[c >> 3];
          if (!((byte >> (7 - (c & 7))) & 1)) continue;
          const idx = (r * W + (ax + c)) * 4;
          data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255; data[idx + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    this.atlas = canvas;
    this.atlasDirty = false;
  }
}

// Minimal BDF parser — supports just the subset needed by the bundled fonts:
// FONT_ASCENT/DESCENT, PIXEL_SIZE, then per-glyph STARTCHAR/ENCODING/DWIDTH/
// BBX/BITMAP. Rows are hex bytes, ceil(w/8) bytes per row.
export function parseBdf(text: string, fontName: string): BdfFont {
  const lines = text.split(/\r?\n/);
  let ascent = 0, descent = 0, pixelSize = 0;
  let font: BdfFont | null = null;

  let inBitmap = false;
  let curName = '', curEnc = -1, curAdv = 0, curW = 0, curH = 0, curOx = 0, curOy = 0;
  let curRows: Uint8Array[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (inBitmap) {
      if (line === 'ENDCHAR') {
        const cp = decideCodepoint(curName, curEnc);
        if (cp >= 0 && font) {
          font.addGlyph(cp, { adv: curAdv, w: curW, h: curH, ox: curOx, oy: curOy, bytes: curRows });
        }
        inBitmap = false;
        curRows = [];
        continue;
      }
      const bytesPerRow = Math.max(1, Math.ceil(curW / 8));
      const row = new Uint8Array(bytesPerRow);
      for (let b = 0; b < bytesPerRow; b++) {
        row[b] = parseInt(line.substring(b * 2, b * 2 + 2), 16) || 0;
      }
      curRows.push(row);
      continue;
    }

    if (line.startsWith('FONT_ASCENT ')) ascent = parseInt(line.slice(12), 10);
    else if (line.startsWith('FONT_DESCENT ')) descent = parseInt(line.slice(13), 10);
    else if (line.startsWith('PIXEL_SIZE ')) pixelSize = parseInt(line.slice(11), 10);
    else if (line === 'ENDPROPERTIES') {
      font = new BdfFont({ name: fontName, pixelSize, ascent, descent });
    }
    else if (line.startsWith('STARTCHAR ')) curName = line.slice(10).trim();
    else if (line.startsWith('ENCODING ')) curEnc = parseInt(line.slice(9), 10);
    else if (line.startsWith('DWIDTH ')) {
      curAdv = parseInt(line.slice(7).trim().split(/\s+/)[0], 10);
    }
    else if (line.startsWith('BBX ')) {
      const parts = line.slice(4).trim().split(/\s+/);
      curW = parseInt(parts[0], 10);
      curH = parseInt(parts[1], 10);
      curOx = parseInt(parts[2], 10);
      curOy = parseInt(parts[3], 10);
    }
    else if (line === 'BITMAP') {
      inBitmap = true;
    }
  }

  if (!font) throw new Error(`parseBdf: ${fontName}: missing ENDPROPERTIES`);
  return font;
}
