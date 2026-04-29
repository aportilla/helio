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
//   FONTS.Geneva[12]      // ok
//   FONTS.Chicago[999]    // ts error — no such size
//   FONTS.NotAFamily      // ts error — no such family
// Mirrors the actual on-disk layout under ./BDF/. The DEV-mode drift check
// at the bottom warns when this declaration and disk fall out of sync.
export const FONTS = {
  Athens:        { 22: spec('Athens', 22) },
  Boston:        { 13: spec('Boston', 13), 15: spec('Boston', 15), 20: spec('Boston', 20), 24: spec('Boston', 24), 26: spec('Boston', 26), 30: spec('Boston', 30) },
  Cairo:         { 24: spec('Cairo', 24) },
  Chicago:       { 15: spec('Chicago', 15) },
  Courier:       { 10: spec('Courier', 10), 11: spec('Courier', 11), 12: spec('Courier', 12), 14: spec('Courier', 14), 17: spec('Courier', 17), 22: spec('Courier', 22) },
  EWorldTight:   { 18: spec('EWorldTight', 18) },
  EspySans:      { 12: spec('EspySans', 12), 13: spec('EspySans', 13), 15: spec('EspySans', 15), 17: spec('EspySans', 17), 20: spec('EspySans', 20) },
  EspySansBold:  { 12: spec('EspySansBold', 12), 13: spec('EspySansBold', 13), 16: spec('EspySansBold', 16), 18: spec('EspySansBold', 18), 20: spec('EspySansBold', 20) },
  EspySerif:     { 13: spec('EspySerif', 13), 16: spec('EspySerif', 16), 17: spec('EspySerif', 17), 20: spec('EspySerif', 20) },
  EspySerifBold: { 13: spec('EspySerifBold', 13), 17: spec('EspySerifBold', 17), 18: spec('EspySerifBold', 18), 20: spec('EspySerifBold', 20) },
  Geneva:        { 12: spec('Geneva', 12), 15: spec('Geneva', 15), 18: spec('Geneva', 18), 22: spec('Geneva', 22), 24: spec('Geneva', 24), 28: spec('Geneva', 28) },
  London:        { 20: spec('London', 20) },
  LosAngeles:    { 14: spec('LosAngeles', 14), 28: spec('LosAngeles', 28) },
  Mobile:        { 28: spec('Mobile', 28) },
  Monaco:        { 11: spec('Monaco', 11), 15: spec('Monaco', 15) },
  NewYork:       { 12: spec('NewYork', 12), 15: spec('NewYork', 15), 17: spec('NewYork', 17), 21: spec('NewYork', 21), 22: spec('NewYork', 22), 26: spec('NewYork', 26) },
  Palatino:      { 12: spec('Palatino', 12), 14: spec('Palatino', 14), 16: spec('Palatino', 16), 20: spec('Palatino', 20), 25: spec('Palatino', 25) },
  SanFrancisco:  { 20: spec('SanFrancisco', 20) },
  SwanSong:      { 15: spec('SwanSong', 15) },
  Symbol:        { 11: spec('Symbol', 11), 13: spec('Symbol', 13), 15: spec('Symbol', 15), 17: spec('Symbol', 17), 24: spec('Symbol', 24), 31: spec('Symbol', 31) },
  System:        { 16: spec('System', 16) },
  Taliesin:      { 28: spec('Taliesin', 28) },
  Times:         { 10: spec('Times', 10), 11: spec('Times', 11), 12: spec('Times', 12), 15: spec('Times', 15), 18: spec('Times', 18), 24: spec('Times', 24) },
  Toronto:       { 12: spec('Toronto', 12), 15: spec('Toronto', 15), 17: spec('Toronto', 17), 23: spec('Toronto', 23), 29: spec('Toronto', 29) },
  Venice:        { 19: spec('Venice', 19) },
} as const;

export type FontFamily = keyof typeof FONTS;

// Convenience aliases — the most-called-by-name fonts in the starmap UI.
export const FONT_MONACO_11: FontSpec = FONTS.Monaco[11];
export const FONT_CHICAGO_15: FontSpec = FONTS.Chicago[15];
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

// Eagerly parses the two UI fonts and injects the custom ► glyph onto Monaco.
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
  getFont(FONT_CHICAGO_15);
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
