#!/usr/bin/env node
//
// Expand multi-star systems using the catalog's per-system detail pages as
// the source of truth for cluster structure.
//
// For each row in our CSVs whose `id` is a real catalog slug, fetch the
// primary's detail page. The page has one <h2 class='title'> section per
// component, with name, spectral class, and mass. For each non-primary
// component:
//   - Construct canonical id = primary slug stem + `-<lowercase letter>`
//     (e.g., `fomalhaut-b`, `gliese-1245-ba`).
//   - If a row in our CSVs matches this component (by canonical id, or by
//     name-variants overlap), update its id to canonical and leave its data
//     fields alone (CSV-is-canonical for non-blank cells).
//   - Otherwise, add a new row to the primary's CSV with id + name,
//     primary's distance/RA/Dec/parallax/constellation, sibling's spectral
//     class + mass.
//
// Read existing data fields are NEVER overwritten — the script only touches
// `id` on existing rows. New rows fill the catalog-derived fields and leave
// blank what the page doesn't expose (app_mag, abs_mag).
//
// Usage:
//   node scripts/expand-systems-from-catalog.mjs                 (dry-run)
//   node scripts/expand-systems-from-catalog.mjs --apply         (write)
//   node scripts/expand-systems-from-catalog.mjs --throttle=200

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadCatalog, parseCsv, serializeCsv, variants } from './lib/catalog-index.mjs';

const argv = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) argv[m[1]] = m[2] ?? '1';
}
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(REPO_ROOT, 'src/data');
const CATALOG = argv.catalog ?? resolve(homedir(), 'Documents/catalog.html');
const CACHE_DIR = resolve(REPO_ROOT, '.cache/stellarcatalog');
const THROTTLE_MS = Number(argv.throttle ?? '500');
const APPLY = 'apply' in argv;

mkdirSync(CACHE_DIR, { recursive: true });

// IAU proper names that act as a specific component letter without saying
// so in their display name. The sync skip-list preserves these as display
// names ("Toliman", not "Alpha Centauri B"); this map lets us still bind
// them to the canonical sibling id during expansion. Without it, position-
// match's letter-suffix gate misses them and we'd emit a duplicate row.
const KNOWN_COMPONENT_ALIASES = new Map([
  ['Toliman', { primaryId: 'alpha-centauri-a', letter: 'B' }],
]);

async function fetchCached(url, slug) {
  const cachePath = resolve(CACHE_DIR, `${slug.replace(/\//g, '-')}.html`);
  if (existsSync(cachePath)) {
    return { html: readFileSync(cachePath, 'utf8'), cached: true };
  }
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (helio-mapcatalog-expand)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  writeFileSync(cachePath, html);
  return { html, cached: false };
}

// Each component section on a primary's page:
//   <h2 class='title'>NAME</h2>
//   <div class='noteBig'>...category descriptor...</div>
//   <div class='noteBig'>Spectral class: <span class='value'>K5Vp</span></div>
//   <div>Mass: <span class='value'>72.5 %</span> M<span class='lowerIndex'> Sun</span></div>
// We extract name, spectral class, mass. Other fields the page exposes
// (radius, temperature, age) aren't part of the CSV schema, ignored.
//
// Mass is parsed from the percentage display, NOT from the prose
// ("Mass of the star NAME is N.NN solar masses.") on the same page —
// the catalog's prose narrative is buggy: it copies the previous
// component's mass into each subsequent section's text. The "%" display
// is reliable per-component.
function parseComponents(html) {
  const blocks = [];
  // Walk h2 sentinels manually; the prose-tail before the next h2 is the
  // body. Stop at the page's "Other neighborhood stars" section — that
  // section has its own h2s for unrelated stars.
  const stopIdx = html.search(/Other neighborhood stars|<h1 class='title'/);
  const slice = stopIdx > 0 ? html.slice(0, stopIdx) : html;
  const matches = [...slice.matchAll(/<h2 class='title'>([^<]+)<\/h2>/g)];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : slice.length;
    const body = slice.slice(start, end);
    const clsMatch = /Spectral class:\s*<span[^>]*>([^<]+)<\/span>/.exec(body);
    const massPctMatch = /Mass:\s*<span[^>]*>\s*([\d.]+)\s*%\s*<\/span>/.exec(body);
    const massMsun = massPctMatch ? (Number(massPctMatch[1]) / 100).toString() : '';
    blocks.push({
      name,
      cls: clsMatch ? clsMatch[1].trim() : '',
      mass: massMsun,
    });
  }
  return blocks;
}

// Resolve component letters across all blocks on a page. Mutates blocks
// in place to add `letter`. Two passes: first pull explicit letters from
// the section name (suffix relative to the primary name, or trailing
// single/double-letter group). Second pass: any block we couldn't extract
// a letter from gets the next unused single letter — handles the case
// where the catalog uses an IAU proper name in lieu of a component letter
// (Alpha Centauri page lists "Proxima Centauri" instead of "Alpha
// Centauri C", so Proxima becomes letter "C" by exclusion of A and B).
function resolveComponentLetters(blocks, primaryName, primarySlug) {
  // Primary's letter is whatever the slug encodes (alpha-centauri-a → "A",
  // capella-aa → "Aa") so we don't accidentally re-assign it to a sibling.
  const slugLetterMatch = /-([a-z]{1,2})$/.exec(primarySlug);
  const primaryLetter = slugLetterMatch
    ? slugLetterMatch[1].charAt(0).toUpperCase() + slugLetterMatch[1].slice(1)
    : 'A';

  const claimed = new Set();
  for (const b of blocks) {
    let letter = '';
    if (b.name === primaryName) {
      letter = primaryLetter;
    } else if (b.name.startsWith(primaryName + ' ')) {
      letter = b.name.slice(primaryName.length + 1).trim();
    } else {
      const m = /\s+([A-Z][a-z]?)$/.exec(b.name);
      if (m) letter = m[1];
    }
    if (letter) claimed.add(letter);
    b.letter = letter;
  }
  // Subcomponent letters (Ba, Bb, Aa, Ab) implicitly claim their parent
  // letter — "B" can't be a separate slot if "Ba" + "Bb" already split it.
  // Without this, V1054 Ophiuchi's "Gliese 643" sibling (its D component)
  // would be assigned letter "B", clashing with the binary that "Ba"+"Bb"
  // together form.
  for (const c of [...claimed]) {
    if (c.length === 2) claimed.add(c[0]);
  }
  for (const b of blocks) {
    if (b.letter) continue;
    for (const c of 'BCDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (!claimed.has(c)) {
        b.letter = c;
        claimed.add(c);
        break;
      }
    }
  }
}

// Strip the trailing letter group from a slug ("fomalhaut-a" → "fomalhaut",
// "gliese-1245-a" → "gliese-1245"); leave alone if no trailing letter group.
function slugStem(slug) {
  const m = /-([a-z]{1,2})$/.exec(slug);
  return m ? slug.slice(0, m.index) : slug;
}

function canonicalSiblingId(primarySlug, letter) {
  return `${slugStem(primarySlug)}-${letter.toLowerCase()}`;
}

function splitSuffix(name) {
  const m = /^(.*?)\s+([A-Z][a-z]?)$/.exec(name);
  if (m) return { root: m[1], suffix: m[2] };
  return { root: name, suffix: '' };
}

// Match two display names IFF (a) their normalized name-variants overlap
// AND (b) their component-letter suffixes are exactly equal. The suffix
// gate disambiguates within a system: variants() strips trailing letters
// to make "Sirius A" match "Sirius", but that also makes every component
// share a stem-only variant — so without the suffix gate, "41 G. Arae Ba"
// would match catalog components B AND C via the shared "41 g. arae" stem.
function namesMatch(a, b) {
  if (splitSuffix(a).suffix !== splitSuffix(b).suffix) return false;
  const va = variants(a), vb = variants(b);
  for (const v of va) if (vb.has(v)) return true;
  return false;
}

// ---------- load catalog ----------
const catStars = loadCatalog(CATALOG);
const slugToCatStar = new Map();
for (const s of catStars) {
  slugToCatStar.set(s.slug.replace(/^stars\//, ''), s);
}

// ---------- load all CSVs ----------
const csvFiles = readdirSync(DATA_DIR).filter(f => f.endsWith('.csv')).map(f => resolve(DATA_DIR, f));
const tables = csvFiles.map(path => {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows.shift();
  return { path, header, rows };
});

// Build a global row index { id, name, ra, dec, table, row } for cross-CSV
// lookup. RA/Dec are kept so we can position-match unresolved rows
// (e.g. "Toliman" with RA/Dec ~ Rigil Kentaurus) to a catalog primary's
// sibling component when name-variant matching alone wouldn't catch them.
const allRows = [];
for (const t of tables) {
  const ID = t.header.indexOf('id');
  const NAME = t.header.indexOf('name');
  const RA = t.header.indexOf('ra_deg');
  const DEC = t.header.indexOf('dec_deg');
  for (const row of t.rows) {
    if (!row.length || (row.length === 1 && !row[0])) continue;
    if (!row[NAME]) continue;
    // Number('') === 0, so guard empty cells before parsing — otherwise
    // every row with blank coords ends up at (0, 0) and they all
    // false-match each other on the position fallback.
    const num = (cell) => {
      const trimmed = (cell ?? '').trim();
      return trimmed ? Number(trimmed) : NaN;
    };
    const ra = num(row[RA]), dec = num(row[DEC]);
    allRows.push({
      id: row[ID], name: row[NAME], table: t, row,
      ra: Number.isFinite(ra) ? ra : null,
      dec: Number.isFinite(dec) ? dec : null,
    });
  }
}

const rowsByCanonicalId = new Map();
for (const r of allRows) rowsByCanonicalId.set(r.id, r);

// ---------- iterate primaries ----------
const idUpdates = [];          // { row, oldId, newId }
const newRowsByTable = new Map(); // table → [row, ...]
const fetchErrors = [];
const boundRows = new Set();   // rows already claimed by some sibling, don't reuse
let pagesFetched = 0, pagesCached = 0, primariesProcessed = 0;

for (const r of allRows) {
  const cat = slugToCatStar.get(r.id);
  if (!cat) continue;  // row's id isn't a real catalog primary; skip.
  // Only fetch pages for slugs ending in -a / -aa (multi-star primary
  // marker). Single-star slugs (no trailing letter) wouldn't have sibling
  // sections anyway; saves traffic.
  if (!/-([a-z]{1,2})$/.test(r.id)) continue;

  primariesProcessed++;
  let html, cached;
  try {
    ({ html, cached } = await fetchCached(cat.url, cat.slug));
  } catch (e) {
    fetchErrors.push({ id: r.id, err: e.message });
    continue;
  }
  if (cached) pagesCached++; else { pagesFetched++; await sleep(THROTTLE_MS); }

  const components = parseComponents(html);
  if (components.length <= 1) continue;  // single-star page, nothing to expand.
  resolveComponentLetters(components, cat.primary, r.id);

  for (const comp of components) {
    if (comp.name === cat.primary) continue;  // skip primary's own section.
    const letter = comp.letter;
    if (!letter) continue;  // letter resolution exhausted A-Z (very unlikely).
    const canonId = canonicalSiblingId(r.id, letter);

    // Find existing row for this sibling. Two-pass match against unbound,
    // unclaimed rows:
    //   pass 1 — variants overlap + letter equality (catches "GJ 1245 B" ↔
    //            "Gliese 1245 B", "Alpha Piscis Austrini B" ↔ "Fomalhaut B").
    //   pass 2 — RA/Dec proximity to the primary + letter equality (catches
    //            "Toliman" ↔ "Alpha Centauri B", "Omicron2 Eridani B" ↔
    //            "40 Eridani B" — where the rename was suppressed by the
    //            sync skip-list, so the name carries no shared variant).
    // Position-match is only used when name-match fails so we don't bind by
    // coordinate-collision in normal cases.
    let bound = rowsByCanonicalId.get(canonId);
    if (!bound) {
      for (const cand of allRows) {
        if (boundRows.has(cand)) continue;
        if (cand.id === canonId) { bound = cand; break; }
        if (cand.id === r.id) continue;
        if (slugToCatStar.has(cand.id)) continue;
        if (namesMatch(cand.name, comp.name)) { bound = cand; break; }
      }
    }
    if (!bound) {
      // Pass 3: explicit alias map (IAU proper names like Toliman).
      for (const cand of allRows) {
        if (boundRows.has(cand)) continue;
        const alias = KNOWN_COMPONENT_ALIASES.get(cand.name);
        if (alias && alias.primaryId === r.id && alias.letter === letter) {
          bound = cand;
          break;
        }
      }
    }
    if (!bound && r.ra != null && r.dec != null) {
      const POS_TOL_DEG = 0.1;  // ~6 arcmin; way under inter-system spacing
      for (const cand of allRows) {
        if (boundRows.has(cand)) continue;
        if (cand.id === r.id) continue;
        if (slugToCatStar.has(cand.id)) continue;
        if (cand.ra == null || cand.dec == null) continue;
        if (splitSuffix(cand.name).suffix !== letter) continue;
        if (Math.abs(cand.ra - r.ra) > POS_TOL_DEG) continue;
        if (Math.abs(cand.dec - r.dec) > POS_TOL_DEG) continue;
        bound = cand;
        break;
      }
    }

    if (bound) {
      boundRows.add(bound);
      // Existing row — only touch id if not already canonical.
      if (bound.id !== canonId) {
        idUpdates.push({ row: bound, oldId: bound.id, newId: canonId, compName: comp.name });
      }
    } else {
      // No matching row — synthesize a new one in the primary's CSV using
      // the primary's positional fields and the sibling's spectral/mass.
      const t = r.table;
      const idC = t.header.indexOf('id');
      const nameC = t.header.indexOf('name');
      const distC = t.header.indexOf('distance_ly');
      const conC = t.header.indexOf('constellation');
      const raC = t.header.indexOf('ra_deg');
      const decC = t.header.indexOf('dec_deg');
      const clsC = t.header.indexOf('spectral_class');
      const massC = t.header.indexOf('mass_msun');
      const plxC = t.header.indexOf('parallax_mas');

      const pRow = r.row;
      const newRow = new Array(t.header.length).fill('');
      newRow[idC] = canonId;
      newRow[nameC] = comp.name;
      if (distC >= 0) newRow[distC] = pRow[distC];
      if (conC  >= 0) newRow[conC]  = pRow[conC];
      if (raC   >= 0) newRow[raC]   = pRow[raC];
      if (decC  >= 0) newRow[decC]  = pRow[decC];
      if (clsC  >= 0) newRow[clsC]  = comp.cls;
      if (massC >= 0) newRow[massC] = comp.mass;
      if (plxC  >= 0) newRow[plxC]  = pRow[plxC];

      const list = newRowsByTable.get(t) ?? [];
      list.push({ row: newRow, primary: r.name, comp });
      newRowsByTable.set(t, list);
    }
  }
}

// ---------- report ----------
console.error(`processed ${primariesProcessed} multi-star primaries`);
console.error(`pages: ${pagesCached} cached, ${pagesFetched} fetched, ${fetchErrors.length} failed`);
if (fetchErrors.length) for (const f of fetchErrors) console.error(`  fetch fail: ${f.id} — ${f.err}`);

console.log(`\n=== ID updates (${idUpdates.length}) ===`);
for (const u of idUpdates) {
  console.log(`  ${u.row.name.padEnd(28)} (in ${u.row.table.path.split('/').pop()})  ${u.oldId.padEnd(22)} → ${u.newId}`);
}

let totalNew = 0;
for (const [t, list] of newRowsByTable) totalNew += list.length;
console.log(`\n=== New sibling rows (${totalNew}) ===`);
for (const [t, list] of newRowsByTable) {
  for (const item of list) {
    console.log(`  ${item.comp.name.padEnd(28)} cls=${(item.comp.cls || '?').padEnd(8)} mass=${(item.comp.mass || '?').padEnd(6)}  → ${t.path.split('/').pop()} (sibling of ${item.primary})`);
  }
}

// ---------- apply ----------
if (APPLY) {
  for (const u of idUpdates) {
    const idC = u.row.table.header.indexOf('id');
    u.row.row[idC] = u.newId;
    u.row.id = u.newId;
  }
  for (const [t, list] of newRowsByTable) {
    for (const item of list) t.rows.push(item.row);
  }
  for (const t of tables) {
    writeFileSync(t.path, serializeCsv([t.header, ...t.rows]));
  }
  console.error(`\napplied: ${idUpdates.length} id updates, ${totalNew} new rows`);
} else {
  console.error(`\n(dry run — re-run with --apply to write)`);
}
