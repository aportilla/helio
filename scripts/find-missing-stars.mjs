#!/usr/bin/env node
//
// Find stars present in the local stellarcatalog listing
// (~/Documents/catalog.html, ~10k entries) but absent from one of our
// per-bracket CSVs. Useful for spotting Wikipedia gaps — the upstream
// star-system tables we scrape are curated by hand and miss faint or
// recently-discovered stars that the broader catalog does carry.
//
// Distance bracket is auto-detected from the CSV filename
// (`stars-NN-MMly.csv` → [NN, MM]; `nearest-stars.csv` → [0, 20])
// or can be overridden with --range=lo,hi.
//
// Usage:
//   node scripts/find-missing-stars.mjs --csv=src/data/stars-25-30ly.csv
//   node scripts/find-missing-stars.mjs --csv=PATH --range=20,30
//   node scripts/find-missing-stars.mjs --csv=PATH --add
//      (appends name + distance rows to the CSV; run
//       fill-from-stellarcatalog.mjs --needs=any after to populate the rest)
//   node scripts/find-missing-stars.mjs --csv=PATH --catalog=PATH
//
// Output is TSV on stdout: distance, primary name, full catalog URL. Missing
// stars are sorted by distance.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, parseCsv, variants, serializeCsv } from './lib/catalog-index.mjs';

// ---------- args ----------
const argv = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) argv[m[1]] = m[2] ?? '1';
}
if (!argv.csv) {
  console.error('Usage: node scripts/find-missing-stars.mjs --csv=PATH [--range=lo,hi] [--add] [--catalog=PATH]');
  process.exit(1);
}
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSV_PATH = resolve(REPO_ROOT, argv.csv);
const CATALOG = argv.catalog ?? resolve(homedir(), 'Documents/catalog.html');
const ADD = 'add' in argv;

// ---------- bracket detection ----------
let lo, hi;
if (argv.range) {
  [lo, hi] = argv.range.split(',').map(Number);
} else {
  const name = basename(CSV_PATH);
  const m = /stars-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)ly/.exec(name);
  if (m) { lo = Number(m[1]); hi = Number(m[2]); }
  else if (name === 'nearest-stars.csv') { lo = 0; hi = 20; }
  else throw new Error(`can't infer distance range from filename ${name}; pass --range=lo,hi`);
}
if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
  throw new Error(`bad range: lo=${lo}, hi=${hi}`);
}
console.error(`comparing catalog [${lo}, ${hi}] ly vs ${argv.csv}`);

// ---------- load catalog + CSV ----------
const stars = loadCatalog(CATALOG);
console.error(`loaded ${stars.length} catalog stars`);

const csvRows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
const header = csvRows.shift();
const NAME_COL = header.indexOf('name');
const DIST_COL = header.indexOf('distance_ly');
if (NAME_COL < 0 || DIST_COL < 0) throw new Error(`${CSV_PATH}: missing name or distance_ly column`);

// Build a set of every name variant present in ANY of our CSVs (not just
// the target). Catalog distances are rounded to 1 decimal, so a star at
// 25.045 ly in our 25-30 CSV shows up as "25" in the catalog's 20-25
// search — without cross-CSV matching, we'd false-positive flag it as
// missing from 20-25. Plus Sol is hardcoded in the loader and won't appear
// in any CSV; treat it as known to silence that one too.
const csvKnown = new Set(['sol']);
const dataDir = dirname(CSV_PATH);
for (const fname of readdirSync(dataDir)) {
  if (!fname.endsWith('.csv')) continue;
  const text = readFileSync(resolve(dataDir, fname), 'utf8');
  const rows = parseCsv(text);
  const hdr = rows.shift();
  const ni = hdr.indexOf('name');
  if (ni < 0) continue;
  for (const row of rows) {
    const name = row[ni];
    if (!name) continue;
    for (const v of variants(name)) csvKnown.add(v);
  }
}

// ---------- find missing ----------
const missing = [];
for (const star of stars) {
  if (star.distLy == null || star.distLy < lo || star.distLy > hi) continue;
  // A catalog star counts as "known" if any of its names (primary + every
  // alias) shares a variant with anything in the CSV.
  let known = false;
  for (const name of [star.primary, ...star.aliases]) {
    for (const v of variants(name)) {
      if (csvKnown.has(v)) { known = true; break; }
    }
    if (known) break;
  }
  if (!known) missing.push(star);
}
missing.sort((a, b) => a.distLy - b.distLy);

console.error(`${missing.length} catalog stars in [${lo}, ${hi}] ly missing from ${argv.csv}`);
for (const s of missing) {
  console.log(`${s.distLy}\t${s.primary}\t${s.url}`);
}

// ---------- optional: append to CSV ----------
if (ADD && missing.length) {
  const newRows = missing.map(s => {
    const row = new Array(header.length).fill('');
    row[NAME_COL] = s.primary;
    row[DIST_COL] = String(s.distLy);
    return row;
  });
  const all = [header, ...csvRows, ...newRows];
  writeFileSync(CSV_PATH, serializeCsv(all));
  console.error(`\nappended ${newRows.length} rows to ${CSV_PATH} (name + distance only — run fill-from-stellarcatalog --needs=any to populate the rest)`);
}
