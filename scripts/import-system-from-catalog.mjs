#!/usr/bin/env node
//
// Pull one stellar system's full structure from its catalog detail page and
// rewrite all CSV rows for that system. The catalog is the source of truth
// for everything:
//
//   - Display names come verbatim from each <h2 class='title'> section header
//     (no name parsing, no normalization, no suffix extraction).
//   - Per-component metadata (spectral_class, mass_msun, app_mag, abs_mag)
//     comes from the section body's "X %" / V-magnitude fields.
//   - Position fields (distance_ly, ra_deg, dec_deg, parallax_mas) come from
//     the primary's section — the catalog doesn't publish per-component
//     positions, so all siblings inherit the primary's coords. The renderer's
//     expandCoincidentSets in src/data/stars.ts then rings co-positioned
//     components onto a small visual ring so the system reads as a cluster.
//   - constellation isn't in the catalog page, so we preserve it from any
//     existing row for this system.
//
// IDs are positional and have no semantic content beyond uniqueness:
//   - Primary keeps its catalog slug as id (e.g. "fomalhaut-a").
//   - Siblings get <primary-stem>-<letter> by section position, with letters
//     starting at 'b' and skipping the primary's letter. This isn't an
//     assertion that "section 1 is component B" — it's just a unique label.
//
// All existing rows whose id starts with the primary slug stem are removed
// before new rows are inserted, so re-running this on a system is idempotent.
// New rows go into the bracket CSV that contains the primary's distance.
//
// Usage:
//   node scripts/import-system-from-catalog.mjs --slug=fomalhaut-a            (dry-run)
//   node scripts/import-system-from-catalog.mjs --slug=fomalhaut-a --apply

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadCatalog, parseCsv, serializeCsv, parseComponentSections } from './lib/catalog-index.mjs';

// ---------- args ----------

const argv = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) argv[m[1]] = m[2] ?? '1';
}
if (!argv.slug) {
  console.error('Usage: node scripts/import-system-from-catalog.mjs --slug=fomalhaut-a [--apply]');
  process.exit(1);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(REPO_ROOT, 'src/data');
const CATALOG = argv.catalog ?? resolve(homedir(), 'Documents/catalog.html');
const CACHE_DIR = resolve(REPO_ROOT, '.cache/stellarcatalog');
const THROTTLE_MS = Number(argv.throttle ?? '500');
const APPLY = 'apply' in argv;
const FORCE_CATALOG_NAMES = 'force-catalog-names' in argv;
const SLUG = argv.slug.replace(/^stars\//, '');

mkdirSync(CACHE_DIR, { recursive: true });

// ---------- detail-page parsers ----------

async function fetchCached(url, slug) {
  const cachePath = resolve(CACHE_DIR, `${slug.replace(/\//g, '-')}.html`);
  if (existsSync(cachePath)) {
    return { html: readFileSync(cachePath, 'utf8'), cached: true };
  }
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (helio-mapcatalog-import)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  writeFileSync(cachePath, html);
  return { html, cached: false };
}

function parseRA(html) {
  const m = /Right ascension:\s*<span[^>]*>\s*(\d+)h\s+(\d+)m\s+([\d.]+)s\s*</.exec(html);
  if (!m) return null;
  return (+m[1] + +m[2] / 60 + +m[3] / 3600) * 15;
}

function parseDec(html) {
  const m = /Declination:\s*<span[^>]*>\s*([+−–-]?)\s*(\d+)°\s+(\d+)'\s+([\d.]+)''/.exec(html);
  if (!m) return null;
  const sign = (m[1] === '-' || m[1] === '−' || m[1] === '–') ? -1 : 1;
  return sign * (+m[2] + +m[3] / 60 + +m[4] / 3600);
}

// JSON-LD always describes the primary; pull distance + parallax from it.
function parsePrimaryMeta(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g;
  for (let m; (m = re.exec(html)); ) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    if (!Array.isArray(data.additionalProperty)) continue;
    const out = { parallax: null, distLy: null };
    for (const p of data.additionalProperty) {
      if (!p?.name) continue;
      if (p.name === 'parallax') out.parallax = Number(p.value);
      else if (p.name === 'distance') out.distLy = Number(p.value);
    }
    if (out.parallax != null || out.distLy != null) return out;
  }
  return { parallax: null, distLy: null };
}

// ---------- bracket selection ----------

// Map a distance (light years) to the per-bracket CSV that holds it.
// All components of a system go into the same bracket — the primary's bracket.
function bracketCsvFor(distLy) {
  if (distLy < 20) return 'nearest-stars.csv';
  if (distLy < 25) return 'stars-20-25ly.csv';
  if (distLy < 30) return 'stars-25-30ly.csv';
  if (distLy < 35) return 'stars-30-35ly.csv';
  if (distLy < 40) return 'stars-35-40ly.csv';
  if (distLy < 45) return 'stars-40-45ly.csv';
  return 'stars-45-50ly.csv';
}

// ---------- main ----------

const stars = loadCatalog(CATALOG);
const primary = stars.find(s => s.slug === `stars/${SLUG}` || s.slug === SLUG);
if (!primary) {
  console.error(`No catalog entry with slug=${SLUG}`);
  process.exit(1);
}
console.error(`primary: ${primary.primary} (${primary.slug})`);

const { html, cached } = await fetchCached(primary.url, primary.slug);
console.error(`page: ${cached ? 'cache' : 'network'}`);
if (!cached) await sleep(THROTTLE_MS);

const sections = parseComponentSections(html, primary.primary, primary.slug);
if (!sections.length) {
  console.error(`No <h2 class='title'> sections found on ${primary.slug} — page may have changed schema`);
  process.exit(1);
}

const meta = parsePrimaryMeta(html);
const raDeg = parseRA(html);
const decDeg = parseDec(html);
const distLy = meta.distLy ?? primary.distLy;
if (distLy == null) {
  console.error(`No distance available for ${SLUG} (catalog page lacks JSON-LD distance and the catalog index entry has no distLy)`);
  process.exit(1);
}

// ---------- assign positional ids ----------

// Strip trailing -letter (1-2 chars) from the primary slug to get the stem.
// Anything from "fomalhaut-a" → "fomalhaut", "v1054-ophiuchi-aa" → "v1054-ophiuchi".
// Single-star slugs without a letter suffix are passed through unchanged.
const slugSuffixMatch = /-([a-z]{1,2})$/.exec(SLUG);
const slugStem = slugSuffixMatch ? SLUG.slice(0, -(slugSuffixMatch[1].length + 1)) : SLUG;
const primarySlugLetter = slugSuffixMatch
  ? slugSuffixMatch[1].charAt(0).toUpperCase() + slugSuffixMatch[1].slice(1)
  : 'A';

// Id assignment: primary keeps its slug. Siblings reuse the existing CSV's
// sibling ids in lexical order if available — keeps things like
// `epsilon-indi-ba`/`-bb` stable across re-imports so name-preservation
// (keyed by id) survives. Sibling sections beyond what we already have get
// freshly-generated ids `<stem>-b`, `-c`, ... skipping any letter the
// primary occupies. Mid-fill case (catalog has fewer siblings than our CSV)
// drops the extra existing ids — catalog is source of truth for component
// count. Generated lazily inside the loop so we don't compute existing
// siblings before they're loaded below.

// ---------- locate existing rows for this system + preserve constellation ----------

// Match existing rows by id-stem. e.g. for slugStem="fomalhaut": matches
// fomalhaut-a, fomalhaut-b, fomalhaut-c. Single-star case (no stem) just
// matches the slug exactly.
const stemMatcher = (id) =>
  slugStem ? (id === slugStem || id.startsWith(slugStem + '-')) : id === SLUG;

const csvFiles = readdirSync(DATA_DIR).filter(f => f.endsWith('.csv'));
const tables = csvFiles.map(f => {
  const path = resolve(DATA_DIR, f);
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows.shift();
  return { f, path, header, rows };
});

const existingRows = [];
for (const t of tables) {
  const idC = t.header.indexOf('id');
  for (const row of t.rows) {
    if (!row.length || !row[idC]) continue;
    if (stemMatcher(row[idC])) existingRows.push({ table: t, row });
  }
}

// Pull constellation from the existing primary row if any (catalog page
// doesn't carry constellation as a clean field).
let constellation = '';
for (const e of existingRows) {
  const idC = e.table.header.indexOf('id');
  const conC = e.table.header.indexOf('constellation');
  if (e.row[idC] === SLUG && e.row[conC]) { constellation = e.row[conC]; break; }
}
if (!constellation) {
  for (const e of existingRows) {
    const conC = e.table.header.indexOf('constellation');
    if (e.row[conC]) { constellation = e.row[conC]; break; }
  }
}

// ---------- id assignment by resolved letter ----------
//
// Identify the primary section by letter equality with the slug's letter
// (or 'A' for bare slugs). Then order: primary first, siblings sorted
// alphabetically by resolved letter. Catalog HTML doesn't always list
// sections A-first (Gliese 250 lists B before A), so we MUST reorder
// rather than assume section[0] is the primary.
//
// New ids are derived directly from the resolved letter:
//   primary  → SLUG (keeps the original slug, e.g. "fomalhaut-a")
//   sibling  → <stem>-<letter.toLowerCase()>
// This means subcomponent letters (Ba/Bb) round-trip cleanly: parseComponentSections
// resolves them, and we mirror them in the id ("epsilon-indi-ba"/"-bb"). Any
// existing CSV rows with these ids get their names preserved by id-match.
let primaryIdx = sections.findIndex(s => s.letter === primarySlugLetter);
if (primaryIdx < 0) primaryIdx = 0;
const primarySection = sections[primaryIdx];
const siblingSections = sections
  .filter((_, i) => i !== primaryIdx)
  .sort((a, b) => (a.letter || 'Z').localeCompare(b.letter || 'Z'));
const ordered = [primarySection, ...siblingSections];

const newIds = ordered.map((s, i) => {
  if (i === 0) return SLUG;
  const letter = (s.letter || '?').toLowerCase();
  return slugStem ? `${slugStem}-${letter}` : `${SLUG}-${letter}`;
});
const idSet = new Set(newIds);
if (idSet.size !== newIds.length) {
  console.error(`ERROR: duplicate ids generated for ${SLUG}: ${newIds.join(', ')}`);
  process.exit(1);
}

// Preserve hand-curated display names. Default: use catalog section name.
// Override: if an existing row with the same id has a name that differs
// from the catalog's, keep the existing name — covers IAU proper-name
// overrides (Toliman, Guniibuu, Rigil Kentaurus) and catalog typos
// ("Epsion" → Epsilon). --force-catalog-names disables this.
const existingNameById = new Map();
for (const e of existingRows) {
  const idC = e.table.header.indexOf('id');
  const nameC = e.table.header.indexOf('name');
  if (e.row[idC] && e.row[nameC]) existingNameById.set(e.row[idC], e.row[nameC]);
}
const preservedNames = [];
const finalNames = ordered.map((s, i) => {
  const id = newIds[i];
  const existing = existingNameById.get(id);
  if (!FORCE_CATALOG_NAMES && existing && existing !== s.name) {
    preservedNames.push({ id, catalogName: s.name, preserved: existing });
    return existing;
  }
  return s.name;
});

// ---------- build new rows ----------

const csvName = bracketCsvFor(distLy);
const target = tables.find(t => t.f === csvName);
if (!target) {
  console.error(`Target CSV ${csvName} not found in ${DATA_DIR}`);
  process.exit(1);
}

const col = {};
for (const k of ['id','name','distance_ly','constellation','ra_deg','dec_deg','spectral_class','mass_msun','app_mag','abs_mag','parallax_mas']) {
  col[k] = target.header.indexOf(k);
}

// For each existing row, build a quick { fieldName: value } lookup so we
// can fall back when the catalog is silent on a per-component field. This
// preserves long-known values (e.g. Alpha Centauri A's app_mag of 0.01,
// which the catalog page doesn't expose for that section) without
// reintroducing wholesale "merging." When the same id appears in multiple
// rows (a known data bug we may be cleaning up here), we union the cells:
// any non-empty value across the duplicates is kept, so we don't lose data
// to the last-seen empty row.
const existingByCellById = new Map();
for (const e of existingRows) {
  const idC = e.table.header.indexOf('id');
  const id = e.row[idC];
  if (!id) continue;
  const cells = existingByCellById.get(id) ?? {};
  for (const k of Object.keys(col)) {
    const ci = e.table.header.indexOf(k);
    const v = ci >= 0 ? (e.row[ci] ?? '') : '';
    if (!cells[k] && v) cells[k] = v;
  }
  existingByCellById.set(id, cells);
}

// Catalog mass-percent → solar masses sometimes lands on values like
// 0.011399999999999999 (1.14% in binary FP). Round to 4 decimals, strip
// trailing zeros.
function fmtMass(m) {
  if (m == null) return '';
  return String(Number(m.toFixed(4)));
}

const preservedFields = [];
function fieldOrPreserve(id, field, fromCatalog) {
  if (fromCatalog !== '' && fromCatalog != null) return String(fromCatalog);
  const ex = existingByCellById.get(id);
  const prior = ex && ex[field];
  if (prior) {
    preservedFields.push({ id, field, value: prior });
    return prior;
  }
  return '';
}

const newRows = ordered.map((s, i) => {
  const id = newIds[i];
  const r = new Array(target.header.length).fill('');
  r[col.id] = id;
  r[col.name] = finalNames[i];
  r[col.distance_ly] = String(distLy);
  r[col.constellation] = constellation;
  r[col.ra_deg] = raDeg != null ? String(raDeg) : '';
  r[col.dec_deg] = decDeg != null ? String(decDeg) : '';
  r[col.parallax_mas] = meta.parallax != null ? String(meta.parallax) : '';
  r[col.spectral_class] = fieldOrPreserve(id, 'spectral_class', s.spectralClass);
  r[col.mass_msun]      = fieldOrPreserve(id, 'mass_msun',      fmtMass(s.mass));
  r[col.app_mag]        = fieldOrPreserve(id, 'app_mag',        s.appMagV);
  r[col.abs_mag]        = fieldOrPreserve(id, 'abs_mag',        s.absMagV);
  return r;
});

// ---------- report ----------

console.log(`\n=== ${primary.primary} system: ${ordered.length} components ===`);
console.log(`primary distance ${distLy} ly → target CSV: ${csvName}`);
console.log(`primary RA ${raDeg?.toFixed(4)}, Dec ${decDeg?.toFixed(4)}, parallax ${meta.parallax} mas, constellation '${constellation || '(none)'}'`);

console.log(`\nNew rows (${newRows.length}):`);
for (let i = 0; i < ordered.length; i++) {
  const s = ordered[i];
  console.log(`  ${newIds[i].padEnd(28)} "${finalNames[i]}"`);
  console.log(`      spectral=${s.spectralClass ?? '?'}  mass=${s.mass ?? '?'}  appV=${s.appMagV ?? '?'}  absV=${s.absMagV ?? '?'}`);
}
if (preservedNames.length) {
  console.log(`\nPreserved hand-curated names (catalog said otherwise):`);
  for (const p of preservedNames) {
    console.log(`  ${p.id.padEnd(28)} kept "${p.preserved}" (catalog: "${p.catalogName}")`);
  }
}
if (preservedFields.length) {
  console.log(`\nPreserved existing values where catalog was silent:`);
  for (const p of preservedFields) {
    console.log(`  ${p.id.padEnd(28)} ${p.field.padEnd(16)} = ${p.value}`);
  }
}

console.log(`\nExisting rows to remove (${existingRows.length}):`);
for (const e of existingRows) {
  const idC = e.table.header.indexOf('id');
  const nameC = e.table.header.indexOf('name');
  console.log(`  ${e.table.f.padEnd(22)} ${e.row[idC].padEnd(28)} "${e.row[nameC]}"`);
}

// ---------- apply ----------

if (APPLY) {
  for (const t of tables) {
    const idC = t.header.indexOf('id');
    t.rows = t.rows.filter(r => !(r.length && r[idC] && stemMatcher(r[idC])));
  }
  for (const r of newRows) target.rows.push(r);

  const changed = new Set([target, ...existingRows.map(e => e.table)]);
  for (const t of changed) {
    writeFileSync(t.path, serializeCsv([t.header, ...t.rows]));
    console.error(`wrote ${t.path}`);
  }
} else {
  console.error(`\n(dry-run — re-run with --apply to write)`);
}
