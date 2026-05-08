#!/usr/bin/env node
//
// Scrape a Wikipedia "list of stars" table into a clean CSV.
//
// Default invocation pulls the main table from "List of nearest stars" into
// src/data/nearest-stars.csv. The cell-extraction logic is generic over the
// Wikipedia table convention used by that page (rowspan/colspan multi-row
// systems, {{RA|h|m|s}} / {{DEC|d|m|s}} templates, [[link|display]] wikilinks,
// {{br}} / {{wbr}} / {{±}} / {{Asterisk}} formatting templates), so future
// catalogs (brightest stars, naked-eye stars, etc.) can be scraped with
// different --page / --table / --out args without code changes.
//
// Re-run after the upstream Wikipedia table changes to refresh the CSV.
//
// Usage:
//   node scripts/scrape-wiki-stars.mjs
//   node scripts/scrape-wiki-stars.mjs --page=List_of_brightest_stars --table=1 --out=src/data/brightest-stars.csv

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ----- args -----
const argv = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) throw new Error(`bad arg: ${a} (expected --key=value)`);
    return [m[1], m[2]];
  }),
);
const PAGE = argv.page ?? 'List_of_nearest_stars';
const TABLE_INDEX = Number(argv.table ?? '1'); // 0-based; the nearest-stars page has a small intro wikitable at 0 and the data table at 1
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(REPO_ROOT, argv.out ?? 'src/data/nearest-stars.csv');

// Column layout per Wikipedia source page. Both pages follow the same
// "system | name | distance | cons | radec | class | ... | parallax | notes"
// shape, but the 20-25 ly catalog drops Mass and Abs Mag (Wikipedia editors
// chose not to repeat them — most entries are dim BDs without measured mass
// anyway). Add a new schema entry when scraping a future Wikipedia stellar
// list with yet another column order.
const SCHEMAS = {
  nearest: {
    numCols: 11,
    map: { SYSTEM: 0, NAME: 1, DISTANCE: 2, CONS: 3, RADEC: 4, CLASS: 5, MASS: 6, APP_MAG: 7, ABS_MAG: 8, PARALLAX: 9 },
  },
  '20-25': {
    numCols: 9,
    map: { SYSTEM: 0, NAME: 1, DISTANCE: 2, CONS: 3, RADEC: 4, CLASS: 5, APP_MAG: 6, PARALLAX: 7 },
  },
};
const SCHEMA = argv.schema ?? 'nearest';
if (!(SCHEMA in SCHEMAS)) throw new Error(`unknown --schema=${SCHEMA}; expected one of ${Object.keys(SCHEMAS).join(', ')}`);
const { numCols: NUM_COLS, map: COLS } = SCHEMAS[SCHEMA];

// ----- fetch -----
const apiUrl = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(PAGE)}&prop=wikitext&format=json&formatversion=2`;
console.log(`fetching ${apiUrl}`);
const res = await fetch(apiUrl);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const wikitext = (await res.json()).parse?.wikitext;
if (!wikitext) throw new Error('no wikitext in response');

// ----- locate target wikitable -----
// Tables in this corpus don't nest, so a non-greedy match between `\n{|` and
// `\n|}\n` is sufficient.
const tables = [];
const tableRe = /\n\{\|([^\n]*)\n([\s\S]*?)\n\|\}\n/g;
for (let m; (m = tableRe.exec(wikitext)); ) {
  if (m[1].includes('wikitable')) tables.push({ attrs: m[1], body: m[2] });
}
if (TABLE_INDEX >= tables.length) {
  throw new Error(`asked for table #${TABLE_INDEX} but only found ${tables.length} wikitables`);
}
const { attrs: tableAttrs, body: tableBody } = tables[TABLE_INDEX];
console.log(`using table #${TABLE_INDEX}: ${tableAttrs.trim().slice(0, 80)}...`);

// ----- markup helpers -----

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripRefs(s) {
  return s
    .replace(/<ref\b[^>]*\/>/g, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/g, '');
}

// Iteratively resolve {{tpl|...}} so nested templates collapse cleanly. RA/DEC
// templates are passed through (the cell-value extractors read them directly).
function stripTemplates(s, opts = {}) {
  const { keepRaDec = false } = opts;
  let prev;
  do {
    prev = s;
    s = s.replace(/\{\{([^{}]*)\}\}/g, (whole, body) => {
      const parts = body.split('|');
      const name = parts[0].trim().toLowerCase();
      if (keepRaDec && (name === 'ra' || name === 'dec')) return whole;
      if (name === 'br' || name === 'wbr') return '\n';
      if (name === '±') return ` ±${(parts[1] ?? '').trim()}`;
      if (name === 'tabletba') return parts[1] ?? '';
      if (name === 'abbr' || name === 'nowrap' || name === 'shy') return parts[1] ?? '';
      // {{val|x|σ}} renders as "x ± σ" (with optional unit/format args). For
      // our cell-extraction purposes, we want the central value — feed the
      // first positional arg back through and let extractNumber pick it up.
      if (name === 'val') return parts[1] ?? '';
      if (name.startsWith('cite ')) return '';
      // Drop everything else (asterisk, dollar sign, double-dagger, hash-tag,
      // star-color, &, etc.) — they're decorative.
      return '';
    });
  } while (s !== prev);
  return s;
}

function stripLinks(s) {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1')
    .replace(/\[https?:\/\/[^\]]+\]/g, '');
}

function stripHtml(s) {
  return s.replace(/<\/?[^>]+>/g, '');
}

// Generic "give me the readable text" cleanup. Used for cells where we don't
// need the inner template syntax preserved.
function clean(s) {
  return decodeEntities(stripHtml(stripLinks(stripTemplates(stripRefs(s))))).trim();
}

// First numeric value in a string. Wikipedia uses U+2212 (minus) instead of
// ASCII '-' in negative numbers, so normalize before extracting.
function extractNumber(s) {
  const norm = s.replace(/−/g, '-');
  const m = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(norm);
  return m ? Number(m[0]) : null;
}

// {{RA|HH|MM|SS}} → degrees (hours × 15).
function extractRA(s) {
  const m = /\{\{RA\|([^|}]+)\|([^|}]+)\|([^|}]+)\}\}/i.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]);
  if ([h, mm, ss].some(v => !Number.isFinite(v))) return null;
  return (h + mm / 60 + ss / 3600) * 15;
}

// {{DEC|±DD|MM|SS}} → signed decimal degrees.
function extractDec(s) {
  const m = /\{\{DEC\|([^|}]+)\|([^|}]+)\|([^|}]+)\}\}/i.exec(s);
  if (!m) return null;
  // Wikipedia uses three different "minus" characters interchangeably:
  // ASCII '-', U+2212 (true minus), and U+2013 (en dash). Normalize all to
  // ASCII before parsing so negative declinations don't silently lose
  // their sign (Beta Hydri / LP 944-20 use the en dash).
  const dRaw = m[1].replace(/[−–]/g, '-').trim();
  const sign = dRaw.startsWith('-') ? -1 : 1;
  const d = Math.abs(parseFloat(dRaw));
  const mm = Number(m[2]), ss = Number(m[3]);
  if ([d, mm, ss].some(v => !Number.isFinite(v))) return null;
  return sign * (d + mm / 60 + ss / 3600);
}

// ----- table-row parser -----
//
// Wikitext rows are separated by `\n|-...`. Within a row, cells start with
// `|` at line beginning (or `||` for multiple cells on one line); cells may
// span multiple lines. A leading `attrs |` prefix on a cell carries
// rowspan/colspan/style.

function splitDataRows(body) {
  // Drop preamble (caption + headers). We treat any row-block whose
  // non-`|+` lines all start with `!` as a header block.
  const blocks = body.split(/\n\|-[^\n]*/);
  const out = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('|+'));
    if (!lines.length) continue;
    if (lines.every(l => l.startsWith('!'))) continue;
    out.push(block);
  }
  return out;
}

// Split a row body into in-line cells on `||`, but only at template/link
// depth 0. The naive `body.split('||')` rips templates apart whenever the
// editor wrote `|||` (= `|` + `||`) inside a template — e.g.
// `{{sortname|L5.5|||S5.5|nolink=1}}` on the 30-35 ly page split into
// `{{sortname|L5.5` and `|S5.5|nolink=1}}` as two separate cells, shifting
// every later column.
function splitInlineCells(body) {
  const out = [];
  let depth = 0, q = '', start = 0, prev = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) {
      if (c === q) q = '';
      prev = c;
      continue;
    }
    if (c === '"' || (c === "'" && prev === '=')) { q = c; prev = c; continue; }
    if (body.startsWith('{{', i) || body.startsWith('[[', i)) { depth++; i++; prev = c; continue; }
    if (body.startsWith('}}', i) || body.startsWith(']]', i)) { depth--; i++; prev = c; continue; }
    if (depth === 0 && body.startsWith('||', i)) {
      out.push(body.slice(start, i));
      start = i + 2;
      i++; // skip second '|'
      prev = '|';
      continue;
    }
    prev = c;
  }
  out.push(body.slice(start));
  return out;
}

// Net `{{`/`[[` − `}}`/`]]` depth introduced by a string, ignoring
// quote-string contents (CSS values can contain templates). Used by
// parseRowCells to tell apart real cell-openers from template-continuation
// lines like `|title=...` inside a multi-line `{{cite web|...}}`.
//
// Single-quote handling is `=`-anchored: a `'` only enters quote mode if
// the previous char is `=` (i.e. this is an `attr='value'` opener).
// Otherwise `'` is a literal apostrophe — important because wikilinks like
// `[[Scholz's Star]]` would otherwise enter quote mode on the apostrophe,
// swallow the closing `]]`, and leave depth wedged at 1 for the rest of
// the cell's accumulated lines.
function lineDepthDelta(s) {
  let d = 0;
  let q = '';
  let prev = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; prev = c; continue; }
    if (c === '"' || (c === "'" && prev === '=')) { q = c; prev = c; continue; }
    if (s.startsWith('{{', i) || s.startsWith('[[', i)) { d++; i++; prev = c; continue; }
    if (s.startsWith('}}', i) || s.startsWith(']]', i)) { d--; i++; prev = c; continue; }
    prev = c;
  }
  return d;
}

function parseRowCells(block) {
  const lines = block.split('\n');
  const cells = [];
  let current = null;
  // Running template-nesting depth across the lines accumulated into the
  // current cell. Wikipedia editors format multi-line templates as
  // `{{cite web\n |title=...\n |url=...\n}}`, and those `|param=` lines
  // look identical to a new-cell-opener — only the surrounding template
  // depth tells them apart.
  let depth = 0;
  const flush = () => {
    if (current !== null) cells.push(parseCell(current));
    current = null;
    depth = 0;
  };
  for (const line of lines) {
    // MediaWiki ignores leading whitespace before `|` in table cells, and a
    // handful of nearest-stars rows (e.g. Gliese 268's A/B component rows)
    // start with ` | A`. Trim before checking. Also: the 20-25 ly page mixes
    // leading-`|` and leading-`||` cell openers freely (`|| B || M4.5V`),
    // so strip all leading pipes before splitting on in-line `||`.
    const trimmed = line.replace(/^\s+/, '');
    const opensCell = depth === 0
      && trimmed.startsWith('|')
      && trimmed[1] !== '-' && trimmed[1] !== '+' && trimmed[1] !== '}';
    if (opensCell) {
      flush();
      const body = trimmed.replace(/^\|+/, '');
      const segs = splitInlineCells(body);
      for (let i = 0; i < segs.length - 1; i++) cells.push(parseCell(segs[i]));
      current = segs[segs.length - 1];
      depth = lineDepthDelta(current);
    } else if (depth === 0 && trimmed.startsWith('!')) {
      // header line in a data block — skip
      continue;
    } else if (current !== null) {
      current += '\n' + line;
      depth += lineDepthDelta(line);
    }
  }
  flush();
  return cells;
}

function parseCell(raw) {
  // Find the first `|` outside quotes/templates/links — that's the
  // attribute/content boundary. Wikipedia editors use both "..." and '...'
  // for attribute values (e.g. rowspan='2' appears for ~half a dozen rows on
  // the nearest-stars page), so accept either quote style. CSS values can
  // themselves contain templates (e.g. `style="background: {{star-color|M}};"`),
  // so depth-track even inside quotes.
  //
  // Single quotes are `=`-anchored — a `'` only opens an attribute-value
  // quote when preceded by `=`. Otherwise it's a literal apostrophe (e.g.
  // `[[Scholz's Star]]`), which would otherwise hijack quote mode and
  // mask the closing `]]` from depth tracking.
  let split = -1;
  let quote = ''; // '' = not in quote, otherwise the opening quote char
  let depth = 0;
  let prev = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (raw.startsWith('{{', i) || raw.startsWith('[[', i)) { depth++; i++; }
      else if (raw.startsWith('}}', i) || raw.startsWith(']]', i)) { depth--; i++; }
      prev = c;
      continue;
    }
    if (c === '"' || (c === "'" && prev === '=')) { quote = c; prev = c; continue; }
    if (raw.startsWith('{{', i) || raw.startsWith('[[', i)) { depth++; i++; prev = c; continue; }
    if (raw.startsWith('}}', i) || raw.startsWith(']]', i)) { depth--; i++; prev = c; continue; }
    if (c === '|' && depth === 0) { split = i; break; }
    prev = c;
  }
  let attrs = '';
  let content = raw;
  if (split >= 0) {
    const candidate = raw.slice(0, split);
    // Wikipedia editors mix three attribute styles freely on the same page:
    // double-quoted ("2"), single-quoted ('2'), and bare unquoted (2). The
    // unquoted form is per HTML5 spec for values without whitespace; SCR
    // 1845's distance/parallax cells use it (`rowspan=2 | ...`), and
    // without supporting it the rowspan goes unrecognized — the distance
    // cell falls into the next row's first column, the literal `2` from
    // `rowspan=2` ends up parsed as a 2-ly distance, and the row plots on
    // top of Sol.
    // Allow an optional `;` after each value — a couple of nearest-stars
    // rows use `style="background: #F5F5DC"; |` (the trailing semicolon is
    // a Wikipedia editor typo; without tolerance the whole prefix gets
    // misclassified as content and the row's columns shift left).
    if (/^\s*(?:[a-zA-Z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+);?\s*)+$/.test(candidate)) {
      attrs = candidate;
      content = raw.slice(split + 1);
    }
  }
  const rs = /rowspan\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/.exec(attrs);
  const cs = /colspan\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/.exec(attrs);
  return {
    content,
    rowspan: rs ? Number(rs[1] || rs[2] || rs[3]) : 1,
    colspan: cs ? Number(cs[1] || cs[2] || cs[3]) : 1,
  };
}

// Apply rowspan/colspan carry across rows so each row exposes a full
// per-column cell list. Carried cells are shared by reference across the
// rows they cover — repeated reads return the same content.
function expandSpans(rows, numCols) {
  const carry = new Array(numCols).fill(null);
  return rows.map(row => {
    const expanded = new Array(numCols).fill(null);
    let cellIdx = 0;
    for (let c = 0; c < numCols; c++) {
      if (carry[c] && carry[c].remaining > 0) {
        expanded[c] = carry[c].cell;
        carry[c].remaining--;
        if (carry[c].remaining === 0) carry[c] = null;
        continue;
      }
      const cell = row[cellIdx++];
      if (!cell) continue;
      for (let k = 0; k < cell.colspan && c + k < numCols; k++) {
        expanded[c + k] = cell;
        if (cell.rowspan > 1) {
          carry[c + k] = { remaining: cell.rowspan - 1, cell };
        }
      }
      c += cell.colspan - 1;
    }
    return expanded;
  });
}

// ----- pipeline -----

const dataRowBlocks = splitDataRows(tableBody);
const rawRows = dataRowBlocks.map(parseRowCells);
const expandedRows = expandSpans(rawRows, NUM_COLS);

const records = [];
for (const row of expandedRows) {
  const sysCell = row[COLS.SYSTEM];
  const nameCell = row[COLS.NAME];
  if (!sysCell) continue;
  // Skip banner/separator rows — a single colspan that covers every column.
  // The 30-35 ly page uses one to mark the 10 pc boundary
  // (`| colspan='9' | '''''10 parsecs''''' (about 32.616 ly)`); without
  // this filter the literal "10" gets extracted as a distance and a fake
  // 10 ly star lands in the catalog.
  if (row.every(c => c === sysCell)) continue;

  // Strip footnote glyphs Wikipedia editors append directly to names
  // (§ marks brown dwarfs, † / ‡ mark white dwarfs / nearby unconfirmed, etc.).
  // These are LITERAL characters in the wikitext (not templates), so they
  // survive template-stripping and need a dedicated pass.
  const stripGlyphs = s => s.replace(/[§†‡*]+\s*$/, '').trim();
  const sysClean = stripGlyphs(clean(sysCell.content).split('(')[0].trim());
  // colspan=2 on the System column means single-star system; sysCell ===
  // nameCell (same reference) and we use sysClean as the star name.
  let starName;
  if (!nameCell || nameCell === sysCell) {
    starName = sysClean;
  } else {
    let nm = stripGlyphs(clean(nameCell.content).split('(')[0].trim());
    // Component labels ("A", "B", "C", "Aa", "Bb", "Ba", "Ab", ...) get
    // prefixed with the system name so the catalog reads "Sirius A" rather
    // than just "A". Allow one trailing lowercase letter for sub-component
    // designations (Epsilon Indi Ba/Bb, Gliese 229 Ba/Bb, etc.).
    if (/^[A-Z][a-z]?$/.test(nm)) nm = `${sysClean} ${nm}`;
    starName = nm || sysClean;
  }
  if (!starName) continue;
  // Skip Sol — the runtime loader hardcodes it (Wikipedia gives Sol a
  // nonsense distance of 0.0000158 ly and no RA/Dec).
  if (/^Sun$/i.test(starName) || /^Solar System$/i.test(starName)) continue;

  const distance = extractNumber(clean(row[COLS.DISTANCE]?.content ?? ''));
  const cons = clean(row[COLS.CONS]?.content ?? '');
  // RA/Dec extractors read the raw {{RA|...}} / {{DEC|...}} templates, so
  // strip refs but pass templates through.
  const radecRaw = stripRefs(row[COLS.RADEC]?.content ?? '');
  const raDeg = extractRA(radecRaw);
  const decDeg = extractDec(radecRaw);
  const cls = clean(row[COLS.CLASS]?.content ?? '');
  const mass = extractNumber(clean(row[COLS.MASS]?.content ?? ''));
  // Magnitudes can be V-band or J-band; preserve the raw token (e.g. "10.7 J")
  // so the loader can tell them apart if it ever needs to.
  const appMag = clean(row[COLS.APP_MAG]?.content ?? '');
  const absMag = clean(row[COLS.ABS_MAG]?.content ?? '');
  const parallax = extractNumber(clean(row[COLS.PARALLAX]?.content ?? ''));

  records.push({
    name: starName,
    distance,
    cons,
    raDeg,
    decDeg,
    cls,
    mass,
    appMag,
    absMag,
    parallax,
  });
}

// ----- write CSV -----

function csvEscape(v) {
  if (v == null || v === '') return '';
  const s = typeof v === 'number' ? String(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const header = [
  'name',
  'distance_ly',
  'constellation',
  'ra_deg',
  'dec_deg',
  'spectral_class',
  'mass_msun',
  'app_mag',
  'abs_mag',
  'parallax_mas',
];
const lines = [header.join(',')];
for (const r of records) {
  lines.push(
    [r.name, r.distance, r.cons, r.raDeg, r.decDeg, r.cls, r.mass, r.appMag, r.absMag, r.parallax]
      .map(csvEscape)
      .join(','),
  );
}

// Source-of-truth policy: the CSVs in src/data/ are canonical and may be
// hand-tuned to fix scraper artifacts or correct upstream Wikipedia errors.
// Re-running the scraper would overwrite those edits, so refuse to clobber
// an existing file unless --force is passed. Initial seeding (file doesn't
// exist yet) writes freely.
mkdirSync(dirname(OUT), { recursive: true });
if (existsSync(OUT) && !('force' in argv)) {
  throw new Error(
    `${OUT} already exists. CSVs are the source of truth and may carry hand-edits — ` +
    `refusing to overwrite. Pass --force=1 to scrape over it (only do this if you ` +
    `want to discard local edits and resync from upstream).`,
  );
}
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`wrote ${records.length} rows to ${OUT}`);
