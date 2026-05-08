#!/usr/bin/env node
//
// Sync our per-bracket CSVs with stellarcatalog.com's primary names + slug IDs.
//
// Two outcomes per row:
//   - `id`: stable identifier (catalog slug, e.g. `fomalhaut-a`). For rows the
//     catalog doesn't recognize, we slug-ify the row's name as a fallback so
//     every row still gets an id.
//   - `name`: the catalog's primary display name, with component-letter
//     preservation. The catalog usually has only the A component as a discrete
//     entry (slug ending in `-a`), so B/C/D rows in our CSVs match the same
//     catalog entry via name aliases. We keep their distinctness by carrying
//     our suffix forward over the catalog primary's root.
//
// Suffix preservation rules:
//   ourSuffix = trailing ` <Letter>` on our name (e.g. "A", "B", "")
//   pSuffix   = trailing ` <Letter>` on catalog primary
//   slugEndsA = catalog slug ends in `-a` (the catalog's "this is the A
//               component" convention even when the primary lacks a suffix —
//               see Fomalhaut, slug `fomalhaut-a`, primary "Fomalhaut")
//
//   ourSuffix       pSuffix    slugEndsA    →  newName                            newId
//   ─────────────   ────────   ─────────    ────────────────────────────────────────────────────────
//   "" or "A"       ""         no           →  P                                  slug
//   "A"             ""         yes          →  P            (catalog implies A)   slug
//   "B" / "C" /…    ""         yes          →  `${P} ${ourSuffix}`                slug w/ -a → -b/c/…
//   "B" / "C" /…    ""         no           →  `${P} ${ourSuffix}`                `${slug}-${suf}`
//   any             "A" / "B"  -            →  `${stripSuffix(P)} ${ourSuffix||pSuffix}`
//                                              id = slug w/ trailing letter → ourSuffix (if any)
//
// Rows that don't resolve to a catalog entry get id = slug-ify(name) and a
// flag in the dry-run report so we can investigate (most often: brand-new
// rows that haven't been filled yet, or designations the catalog spells in
// some way our `variants()` matcher can't reach).
//
// A default SKIP_RENAMES list freezes display names where the catalog's
// primary is a regression: apostrophe/case losses ("Barnard's Star" →
// "Barnard star"), IAU proper names the catalog lacks ("Keid", "Achird",
// "Alsafi", "Guniibuu"), and a couple other specific calls (Rigil Kentaurus
// — kept because the project's WAYPOINT list uses it). These rows still get
// their id assigned from the catalog slug; only the name field is preserved.
//
// Usage:
//   node scripts/sync-with-catalog.mjs                  (dry-run, all CSVs)
//   node scripts/sync-with-catalog.mjs --apply          (write changes)
//   node scripts/sync-with-catalog.mjs --csv=PATH       (one CSV only)
//   node scripts/sync-with-catalog.mjs --catalog=PATH

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, buildIndex, findStar, parseCsv, serializeCsv } from './lib/catalog-index.mjs';

// ---------- args ----------
const argv = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) argv[m[1]] = m[2] ?? '1';
}
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(REPO_ROOT, 'src/data');
const CATALOG = argv.catalog ?? resolve(homedir(), 'Documents/catalog.html');
const APPLY = 'apply' in argv;

// Names to assign an id to but NOT rename. Matched against the CSV's current
// `name` cell before any transform. See header comment for rationale.
const SKIP_RENAMES = new Set([
  "Barnard's Star",
  "Luyten's Star",
  "Teegarden's Star",
  "Kapteyn's Star",
  "Van Maanen's Star",
  "Scholz's Star A",
  "Scholz's Star B",
  'Keid',
  'Achird',
  'Alsafi',
  'Guniibuu',
  'Rigil Kentaurus',
]);

// ---------- helpers ----------
function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Pull trailing ` <Letter>` (single uppercase letter, optionally lowercase
// follow-letter for "Aa" / "Bb" subcomponents). Returns { root, suffix }.
function splitSuffix(name) {
  const m = /^(.*?)\s+([A-Z][a-z]?)$/.exec(name);
  if (m) return { root: m[1], suffix: m[2] };
  return { root: name, suffix: '' };
}

// Apply suffix preservation. Returns { newName, newId }.
// `rawSlug` is the catalog's URL-path slug ("stars/fomalhaut-a"); the id we
// store in the CSV is just the trailing path segment ("fomalhaut-a").
function syncRow(ourName, primary, rawSlug) {
  const slug = rawSlug.replace(/^stars\//, '');
  const { suffix: ourSuffix } = splitSuffix(ourName);
  const { root: pRoot, suffix: pSuffix } = splitSuffix(primary);
  const slugSuffixMatch = /-([a-z]{1,2})$/.exec(slug);
  const slugSuffix = slugSuffixMatch ? slugSuffixMatch[1].toUpperCase() : '';
  const slugStem = slugSuffixMatch ? slug.slice(0, slugSuffixMatch.index) : slug;

  // Effective component the catalog row represents: explicit suffix on the
  // primary wins, else the slug-encoded suffix, else "".
  const catalogComponent = pSuffix || slugSuffix;

  if (!ourSuffix || ourSuffix === catalogComponent) {
    // Our row IS the catalog entry — adopt name + slug verbatim.
    return { newName: primary, newId: slug };
  }

  // Our row is a different component (B/C/Aa/...) of the same system. Carry
  // our suffix over the catalog root, and synthesize an id by swapping the
  // slug's component letter for ours (or appending if the slug had none).
  const newName = `${pRoot} ${ourSuffix}`;
  const newId = catalogComponent
    ? `${slugStem}-${ourSuffix.toLowerCase()}`
    : `${slug}-${ourSuffix.toLowerCase()}`;
  return { newName, newId };
}

// ---------- load catalog ----------
const stars = loadCatalog(CATALOG);
const index = buildIndex(stars);
console.error(`loaded ${stars.length} catalog stars from ${CATALOG}`);

// ---------- pick CSVs ----------
const csvFiles = argv.csv
  ? [resolve(REPO_ROOT, argv.csv)]
  : readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.csv'))
      .map(f => resolve(DATA_DIR, f));

// ---------- per-CSV sync ----------
let totalRenamed = 0, totalIdAdded = 0, totalUnresolved = 0;
const allUnresolved = [];

for (const csvPath of csvFiles) {
  const label = basename(csvPath);
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  const header = rows.shift();
  if (!header) continue;

  const NAME = header.indexOf('name');
  if (NAME < 0) throw new Error(`${label}: missing name column`);

  // Add `id` column at position 0 if not already present.
  let ID = header.indexOf('id');
  let addedIdCol = false;
  if (ID < 0) {
    header.unshift('id');
    for (const row of rows) row.unshift('');
    ID = 0;
    addedIdCol = true;
    // Re-find name index since we shifted.
  }
  const NAME_NEW = header.indexOf('name');

  let renamed = 0, idAdded = 0, unresolved = 0;
  const unresolvedRows = [];
  const renames = [];

  for (const row of rows) {
    if (!row.length || (row.length === 1 && !row[0])) continue;
    const ourName = row[NAME_NEW];
    if (!ourName) continue;

    const star = findStar(index, ourName);
    if (!star) {
      // No catalog match — assign a deterministic fallback id from our name
      // so the row still has a stable identifier, but flag for review.
      const fallbackId = slugify(ourName);
      if (!row[ID]) {
        row[ID] = fallbackId;
        idAdded++;
      }
      unresolved++;
      unresolvedRows.push(`    ${ourName.padEnd(35)} → id=${fallbackId} (no catalog match)`);
      continue;
    }

    const { newName: catalogName, newId } = syncRow(ourName, star.primary, star.slug);
    const skipRename = SKIP_RENAMES.has(ourName);
    const newName = skipRename ? ourName : catalogName;

    const nameChanged = newName !== ourName;
    const idChanged = !row[ID] || row[ID] !== newId;

    if (nameChanged) {
      renames.push(`    ${ourName.padEnd(35)} → ${newName.padEnd(28)} (id=${newId})`);
      row[NAME_NEW] = newName;
      renamed++;
    } else if (skipRename && catalogName !== ourName) {
      renames.push(`    ${ourName.padEnd(35)} (kept; catalog says "${catalogName}", id=${newId})`);
    }
    if (idChanged) {
      if (!row[ID]) idAdded++;
      row[ID] = newId;
    }
  }

  console.error(`\n=== ${label} ===`);
  if (addedIdCol) console.error(`  added id column`);
  console.error(`  ${rows.length} rows | ${renamed} renamed | ${idAdded} ids added | ${unresolved} unresolved`);
  if (renames.length) {
    console.error(`\n  Renames:`);
    for (const line of renames) console.error(line);
  }
  if (unresolvedRows.length) {
    console.error(`\n  Unresolved (left as-is, fallback id assigned):`);
    for (const line of unresolvedRows) console.error(line);
  }

  if (APPLY) {
    writeFileSync(csvPath, serializeCsv([header, ...rows]));
  }

  totalRenamed += renamed;
  totalIdAdded += idAdded;
  totalUnresolved += unresolved;
  allUnresolved.push(...unresolvedRows.map(l => `  ${label}${l}`));
}

console.error(`\n=========================================================`);
console.error(`Total: ${totalRenamed} renamed, ${totalIdAdded} ids added, ${totalUnresolved} unresolved`);
if (APPLY) {
  console.error(`(applied — CSVs written)`);
} else {
  console.error(`(dry run — re-run with --apply to write)`);
}
