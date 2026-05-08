// Font registry. Every .bdf under ./BDF/<Family>/<size>.bdf is discovered
// at build time via Vite's import.meta.glob with ?raw + eager — each file
// becomes a string literal in the bundle. To add a font: drop the .bdf in
// the right directory and (optionally) add a typed entry to FONTS for
// autocomplete; nothing else to wire up.
//
// Fonts are parsed lazily on first getFont(spec). initFonts() forces the
// two UI fonts to register at boot so the first frame doesn't pay the
// parse cost (and so the custom ► glyph injection happens before any
// label is rendered).

import { BdfFont, parseBdf } from './bdf-font';

const modules = import.meta.glob(
  './BDF/**/*.bdf',
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

// Map<family, Map<size, raw bdf text>>
const catalog = new Map<string, Map<number, string>>();
for (const [path, text] of Object.entries(modules)) {
  const m = path.match(/\/BDF\/([^/]+)\/(\d+)\.bdf$/);
  if (!m) continue;
  const [, family, sizeStr] = m;
  const size = parseInt(sizeStr, 10);
  let sizes = catalog.get(family);
  if (!sizes) { sizes = new Map(); catalog.set(family, sizes); }
  sizes.set(size, text);
}

export type FontSpec = { readonly family: string; readonly size: number };

const spec = <F extends string, S extends number>(family: F, size: S) =>
  ({ family, size } as const);

// Typed catalog. Autocomplete walks family → size, and unknown pairs are
// type errors:
//   FONTS.Monaco[11]      // ok
//   FONTS.Monaco[999]     // ts error — no such size
//   FONTS.NotAFamily      // ts error — no such family
// Mirrors the actual on-disk layout under ./BDF/. The DEV-mode drift check
// at the bottom warns when this declaration and disk fall out of sync.
export const FONTS = {
  EspySans:      { 12: spec('EspySans', 12), 13: spec('EspySans', 13), 15: spec('EspySans', 15), 17: spec('EspySans', 17), 20: spec('EspySans', 20) },
  EspySansBold:  { 12: spec('EspySansBold', 12), 13: spec('EspySansBold', 13), 16: spec('EspySansBold', 16), 18: spec('EspySansBold', 18), 20: spec('EspySansBold', 20) },
  Monaco:        { 11: spec('Monaco', 11), 15: spec('Monaco', 15) },
} as const;

export type FontFamily = keyof typeof FONTS;

// Convenience aliases — the most-called-by-name fonts in the starmap UI.
export const FONT_MONACO_11: FontSpec = FONTS.Monaco[11];
export const DEFAULT_FONT: FontSpec = FONT_MONACO_11;

const fonts = new Map<string, BdfFont>();
const key = (s: FontSpec) => `${s.family}@${s.size}`;

function register(s: FontSpec): BdfFont {
  const k = key(s);
  const existing = fonts.get(k);
  if (existing) return existing;
  const text = catalog.get(s.family)?.get(s.size);
  if (!text) {
    throw new Error(
      `Font "${k}" not in catalog. Add src/data/BDF/${s.family}/${s.size}.bdf.`,
    );
  }
  const font = parseBdf(text, k);
  fonts.set(k, font);
  return font;
}

// Sync getter — registers (parses, builds atlas lazily) on first request.
// Throws if no BDF for this spec exists in the catalog.
export function getFont(s: FontSpec = DEFAULT_FONT): BdfFont {
  return fonts.get(key(s)) ?? register(s);
}

// Eagerly parses the body UI font and injects the custom ► glyph onto Monaco.
// Called once at app boot so the first frame doesn't pay parse cost and so
// the ► is present before any label sprite is built. Idempotent.
export function initFonts(): void {
  const monaco = getFont(FONT_MONACO_11);
  if (!monaco.getGlyph(0x25BA)) {
    monaco.addGlyph(0x25BA, {
      adv: 6, w: 5, h: 5, ox: 0, oy: 1,
      bytes: [
        new Uint8Array([0x80]),
        new Uint8Array([0xC0]),
        new Uint8Array([0xE0]),
        new Uint8Array([0xC0]),
        new Uint8Array([0x80]),
      ],
    });
  }
}

if (import.meta.env.DEV) {
  // Drift check — complains when FONTS declares a pair the catalog lacks
  // (typo, renamed file) or vice versa (.bdf added on disk without a
  // corresponding typed entry, so callers can't autocomplete to it).
  const declared = new Set<string>();
  for (const [family, sizes] of Object.entries(FONTS)) {
    for (const s of Object.keys(sizes)) declared.add(`${family}@${s}`);
  }
  const onDisk = new Set<string>();
  for (const [family, sizes] of catalog) {
    for (const size of sizes.keys()) onDisk.add(`${family}@${size}`);
  }
  for (const k of declared) {
    if (!onDisk.has(k)) console.warn(`[font-catalog] FONTS declares "${k}" but no BDF on disk`);
  }
  for (const k of onDisk) {
    if (!declared.has(k)) console.warn(`[font-catalog] BDF "${k}.bdf" on disk but not declared in FONTS`);
  }
}
