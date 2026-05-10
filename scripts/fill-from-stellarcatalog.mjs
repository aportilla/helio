#!/usr/bin/env node
//
// Fill missing fields on rows in a star CSV by fetching stellarcatalog.com
// detail pages. Wikipedia leaves RA/Dec (and sometimes mass / parallax)
// blank for ~half the rows in the 30-35 ly bracket and similar; this script
// closes the gap by looking up each missing-data row in the local catalog
// HTML, fetching the detail page, and writing whatever the page reports
// back into the CSV. Catalog-fetched HTML is cached under .cache/ so re-runs
// against the same star don't re-hit the server.
//
// Source-of-truth policy: existing non-empty cells are NEVER overwritten.
// We only fill blanks. If you want a different value than what Wikipedia
// has, edit the CSV by hand — that takes precedence over both the scraper
// and this filler.
//
// Usage:
//   node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-30-35ly.csv
//   node scripts/fill-from-stellarcatalog.mjs --csv=PATH --needs=mass     (look up rows missing mass instead of RA/Dec)
//   node scripts/fill-from-stellarcatalog.mjs --csv=PATH --needs=any      (look up rows missing any fillable field)
//   node scripts/fill-from-stellarcatalog.mjs --csv=PATH --dry-run
//   node scripts/fill-from-stellarcatalog.mjs --csv=PATH --throttle=1000
//   node scripts/fill-from-stellarcatalog.mjs --csv=PATH --catalog=PATH
//
// Output is a per-row summary on stdout; pipe to `tee` and review the diff
// with `git diff <csv>` after.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadCatalog, buildIndex, findStar, parseCsv, serializeCsv, parseComponentSections, letterFromId } from './lib/catalog-index.mjs';

// ---------- args ----------
const argv = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) argv[m[1]] = m[2] ?? '1';
}
if (!argv.csv) {
  console.error('Usage: node scripts/fill-from-stellarcatalog.mjs --csv=PATH [--catalog=PATH] [--throttle=MS] [--dry-run]');
  process.exit(1);
}
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSV_PATH = resolve(REPO_ROOT, argv.csv);
const CATALOG = argv.catalog ?? resolve(homedir(), 'Documents/catalog.html');
const CACHE_DIR = resolve(REPO_ROOT, '.cache/stellarcatalog');
const THROTTLE_MS = Number(argv.throttle ?? '500');
const DRY_RUN = 'dry-run' in argv;

// ---------- detail-page parser ----------
//
// Two extraction sources per page:
//   1. Page-wide: JSON-LD (distance, parallax, mass, starType, temp) + the
//      RA/Dec rows on the primary's <h2> section. Both ALWAYS describe the
//      primary, so we only use them for primary rows.
//   2. Per-component: parseComponentSections (in lib/catalog-index.mjs)
//      walks the page's <h2 class='title'> blocks and resolves each to a
//      letter (A, B, C, ...). For sibling rows we look up the section by the
//      letter encoded in the row's `id` and read mass / spectral class /
//      app_mag / abs_mag from that block.
//
// The page format is stable enough for regex; the rigid PHP template hasn't
// drifted across spot-checks.

function parseRA(html) {
  // "Right ascension: <span class='value'>5h 3m 19.833s</span>"
  const m = /Right ascension:\s*<span[^>]*>\s*(\d+)h\s+(\d+)m\s+([\d.]+)s\s*</.exec(html);
  if (!m) return null;
  const h = +m[1], mm = +m[2], ss = +m[3];
  if (![h, mm, ss].every(Number.isFinite)) return null;
  return (h + mm / 60 + ss / 3600) * 15;
}

function parseDec(html) {
  // "Declination: <span class='value'>-17° 22' 31.836''</span>"
  // Wikipedia and stellarcatalog both use ASCII '-' here, but normalize a
  // few related dashes just in case.
  const m = /Declination:\s*<span[^>]*>\s*([+−–-]?)\s*(\d+)°\s+(\d+)'\s+([\d.]+)''/.exec(html);
  if (!m) return null;
  const sign = (m[1] === '-' || m[1] === '−' || m[1] === '–') ? -1 : 1;
  const d = +m[2], mm = +m[3], ss = +m[4];
  if (![d, mm, ss].every(Number.isFinite)) return null;
  return sign * (d + mm / 60 + ss / 3600);
}

function parseJsonLd(html) {
  // The page emits multiple <script type="application/ld+json"> blocks; the
  // one we want has @type "Thing" with additionalProperty entries. Iterate
  // until we find it.
  const out = { parallax: null, mass: null, starType: null, distLy: null };
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g;
  for (let m; (m = re.exec(html)); ) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const props = data.additionalProperty;
    if (!Array.isArray(props)) continue;
    for (const p of props) {
      if (!p || !p.name) continue;
      if (p.name === 'parallax') out.parallax = Number(p.value);
      else if (p.name === 'mass') out.mass = Number(p.value);
      // starType in JSON-LD is sometimes right-padded with spaces ("M4V        ").
      // Trim before storing — we'd otherwise write the padding into the CSV.
      else if (p.name === 'starType') out.starType = String(p.value).trim();
      else if (p.name === 'distance') out.distLy = Number(p.value);
    }
    if (out.parallax != null || out.mass != null) break;
  }
  return out;
}

function parseAppMagV(html) {
  // "Apparent magnitude (V): <span class='value'>11.7</span>"
  const m = /Apparent magnitude \(V\):\s*<span[^>]*>\s*([-−–\d.]+)\s*</.exec(html);
  if (!m) return null;
  const v = Number(m[1].replace(/[−–]/g, '-'));
  return Number.isFinite(v) ? v : null;
}

function parseAbsMagV(html) {
  const m = /Absolute magnitude \(V\):\s*<span[^>]*>\s*([-−–\d.]+)\s*</.exec(html);
  if (!m) return null;
  const v = Number(m[1].replace(/[−–]/g, '-'));
  return Number.isFinite(v) ? v : null;
}

// rowId is the CSV row's `id` (e.g. "fomalhaut-a", "fomalhaut-b"). primarySlug
// is `star.slug` from the catalog index (e.g. "stars/fomalhaut-a"). When the
// row's id-letter matches the primary slug's letter, we treat it as the
// primary row and use page-wide fields. Otherwise we resolve the row's
// id-letter to a per-component section and read mass / spectral class /
// V mags from that section.
function parseDetailPage(html, rowId, primarySlug) {
  const sections = parseComponentSections(html, '', primarySlug);
  const rowLetter = letterFromId(rowId);
  const primaryLetter = letterFromId((primarySlug ?? '').replace(/^stars\//, ''));
  const isPrimary = !rowLetter || rowLetter === (primaryLetter ?? 'A');
  const matched = sections.find(s => s.letter === rowLetter);
  const ld = isPrimary ? parseJsonLd(html) : { parallax: null, mass: null, starType: null, distLy: null };
  return {
    // RA/Dec and parallax/distance only published for the primary.
    raDeg: isPrimary ? parseRA(html) : null,
    decDeg: isPrimary ? parseDec(html) : null,
    parallax: ld.parallax,
    distLy: ld.distLy,
    // Per-component when we matched a section; fall back to JSON-LD (= primary)
    // when no section matched and this is the primary row.
    appMagV: matched ? matched.appMagV : (isPrimary ? parseAppMagV(html) : null),
    absMagV: matched ? matched.absMagV : (isPrimary ? parseAbsMagV(html) : null),
    mass: matched ? matched.mass : (isPrimary ? ld.mass : null),
    starType: matched ? matched.spectralClass : (isPrimary ? ld.starType : null),
  };
}

// ---------- fetch with on-disk cache ----------

async function fetchCached(url, slug) {
  const cachePath = resolve(CACHE_DIR, `${slug.replace(/\//g, '-')}.html`);
  if (existsSync(cachePath)) {
    return { html: readFileSync(cachePath, 'utf8'), cached: true };
  }
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (helio-mapcatalog-filler)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  writeFileSync(cachePath, html);
  return { html, cached: false };
}

// ---------- pipeline ----------

mkdirSync(CACHE_DIR, { recursive: true });

const csvRows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
const header = csvRows.shift();
if (!header) throw new Error(`${CSV_PATH}: empty CSV`);
const idx = (col) => {
  const i = header.indexOf(col);
  if (i < 0) throw new Error(`${CSV_PATH}: missing column ${col}`);
  return i;
};
const ID = idx('id');
const NAME = idx('name');
const RA = idx('ra_deg');
const DEC = idx('dec_deg');
const PAR = idx('parallax_mas');
const MASS = idx('mass_msun');
const CLASS = idx('spectral_class');
const APP = idx('app_mag');
const ABS = idx('abs_mag');

const stars = loadCatalog(CATALOG);
const index = buildIndex(stars);
console.error(`loaded ${stars.length} catalog stars from ${CATALOG}`);

// Find rows that need a catalog lookup. The --needs flag picks which empty
// field triggers the fetch:
//   radec (default)  — rows missing RA or Dec.
//   mass             — rows missing mass.
//   class            — rows missing spectral_class.
//   app_mag          — rows missing app_mag (filling these activates the
//                      M-L mass chain in the loader for those rows).
//   parallax         — rows missing parallax_mas.
//   any              — rows missing ANY of the above (broadest sweep).
// In every mode we fill ALL empty fillable cells once we've fetched a page,
// not just the field that triggered the lookup — so a --needs=mass run also
// fills any incidentally-missing RA/Dec, app_mag, etc. on the same row.
const need = argv.needs ?? 'radec';
const KNOWN_NEEDS = ['radec', 'mass', 'class', 'app_mag', 'parallax', 'any'];
if (!KNOWN_NEEDS.includes(need)) {
  throw new Error(`unknown --needs=${need}; expected one of ${KNOWN_NEEDS.join(', ')}`);
}
const targets = [];
for (const row of csvRows) {
  if (!row[NAME]) continue;
  const m = {
    radec:   !row[RA] || !row[DEC],
    mass:    !row[MASS],
    class:   !row[CLASS],
    app_mag: !row[APP],
    parallax:!row[PAR],
  };
  const want = need === 'any' ? Object.values(m).some(Boolean) : m[need];
  if (want) targets.push(row);
}
console.error(`${targets.length} rows in ${argv.csv} need lookup (--needs=${need})`);

let filled = 0, notFound = 0, fetchFails = 0, alreadyHad = 0;
for (const row of targets) {
  const star = findStar(index, row[NAME]);
  if (!star) {
    notFound++;
    console.log(`  ${row[NAME].padEnd(28)} NOT_FOUND in catalog`);
    continue;
  }
  let html, cached;
  try {
    ({ html, cached } = await fetchCached(star.url, star.slug));
  } catch (e) {
    fetchFails++;
    console.log(`  ${row[NAME].padEnd(28)} FETCH_FAILED ${e.message} (${star.url})`);
    continue;
  }
  // Throttle real network traffic, not cache hits.
  if (!cached) await sleep(THROTTLE_MS);

  const data = parseDetailPage(html, row[ID], star.slug);
  const fills = [];
  if (!row[RA] && data.raDeg != null) { row[RA] = String(data.raDeg); fills.push(`ra=${data.raDeg.toFixed(4)}`); }
  if (!row[DEC] && data.decDeg != null) { row[DEC] = String(data.decDeg); fills.push(`dec=${data.decDeg.toFixed(4)}`); }
  if (!row[PAR] && data.parallax != null) { row[PAR] = String(data.parallax); fills.push(`plx=${data.parallax}`); }
  if (!row[MASS] && data.mass != null) { row[MASS] = String(data.mass); fills.push(`mass=${data.mass}`); }
  if (!row[CLASS] && data.starType != null) { row[CLASS] = data.starType; fills.push(`cls=${data.starType}`); }
  if (!row[APP] && data.appMagV != null) { row[APP] = String(data.appMagV); fills.push(`appV=${data.appMagV}`); }
  if (!row[ABS] && data.absMagV != null) { row[ABS] = String(data.absMagV); fills.push(`absV=${data.absMagV}`); }

  if (fills.length === 0) {
    alreadyHad++;
    console.log(`  ${row[NAME].padEnd(28)} no new fields (catalog page lacked extractable data)`);
  } else {
    filled++;
    const tag = cached ? '[cache]' : '[fetch]';
    console.log(`  ${row[NAME].padEnd(28)} ${tag} filled: ${fills.join(', ')}`);
  }
}

console.error('');
console.error(`Summary: ${filled} filled, ${alreadyHad} fetched-but-empty, ${notFound} not-in-catalog, ${fetchFails} fetch failures`);

if (DRY_RUN) {
  console.error('(dry run — CSV not written)');
} else {
  writeFileSync(CSV_PATH, serializeCsv([header, ...csvRows]));
  console.error(`wrote ${CSV_PATH}`);
}
