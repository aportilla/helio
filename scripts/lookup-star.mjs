#!/usr/bin/env node
//
// Look up stellarcatalog.com URLs for stars by name, by distance range, or
// for every CSV row that's missing RA/Dec (our most common workflow when a
// Wikipedia table left coords blank). Reads a local copy of the catalog's
// "all stars" listing, since the source has ~10k entries and we'd rather
// brute-force a string index than hit the live site.
//
// Default --catalog path is ~/Documents/catalog.html — pass --catalog=PATH
// to point elsewhere.
//
// Usage:
//   node scripts/lookup-star.mjs "Barnard's Star"
//   node scripts/lookup-star.mjs --range=30,35
//   node scripts/lookup-star.mjs --csv=src/data/stars-30-35ly.csv --missing=radec
//   node scripts/lookup-star.mjs --csv=src/data/stars-30-35ly.csv  (defaults to --missing=radec)
//
// Output is TSV-ish on stdout: one line per resolved star, with the full
// stellarcatalog.com URL.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { loadCatalog, buildIndex, findStar, parseCsv } from './lib/catalog-index.mjs';

// ---------- args ----------
const positional = [];
const flags = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] ?? '1';
  else positional.push(a);
}
const CATALOG = flags.catalog ?? resolve(homedir(), 'Documents/catalog.html');

// ---------- modes ----------
const stars = loadCatalog(CATALOG);
const index = buildIndex(stars);
console.error(`loaded ${stars.length} catalog stars from ${CATALOG}`);

if (flags.range !== undefined) {
  const [lo, hi] = flags.range.split(',').map(Number);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error(`--range expects "lo,hi" numeric pair (got ${flags.range})`);
  }
  const matches = stars
    .filter(s => s.distLy != null && s.distLy >= lo && s.distLy <= hi)
    .sort((a, b) => a.distLy - b.distLy);
  for (const s of matches) {
    console.log(`${s.distLy}\t${s.primary}\t${s.url}`);
  }
  console.error(`${matches.length} stars in [${lo}, ${hi}] ly`);
} else if (flags.csv) {
  const csv = parseCsv(readFileSync(flags.csv, 'utf8'));
  const header = csv.shift();
  const NAME = header.indexOf('name');
  const DIST = header.indexOf('distance_ly');
  const RA = header.indexOf('ra_deg');
  const DEC = header.indexOf('dec_deg');
  const CLASS = header.indexOf('spectral_class');
  const filter = flags.missing ?? 'radec';
  let total = 0, found = 0, miss = 0;
  for (const row of csv) {
    if (!row[NAME]) continue;
    let needsLookup = false;
    if (filter === 'radec') needsLookup = !row[RA] || !row[DEC];
    else if (filter === 'all') needsLookup = true;
    else if (filter === 'class') needsLookup = !row[CLASS];
    else throw new Error(`unknown --missing=${filter}; expected radec | class | all`);
    if (!needsLookup) continue;
    total++;
    const hit = findStar(index, row[NAME]);
    if (hit) {
      found++;
      console.log(`${row[NAME]}\t${row[DIST]} ly\t${hit.url}\t(catalog: ${hit.distLy} ly)`);
    } else {
      miss++;
      console.log(`${row[NAME]}\t${row[DIST]} ly\tNOT_FOUND`);
    }
  }
  console.error(`${total} CSV rows needed lookup (filter=${filter}), ${found} matched, ${miss} not found`);
} else if (positional.length) {
  for (const q of positional) {
    const hit = findStar(index, q);
    if (hit) {
      console.log(`${q}\t${hit.url}\t(${hit.primary}, ${hit.distLy} ly)`);
    } else {
      console.log(`${q}\tNOT_FOUND`);
    }
  }
} else {
  console.error('Usage:');
  console.error('  node scripts/lookup-star.mjs "Star Name" ["Another Name" ...]');
  console.error('  node scripts/lookup-star.mjs --range=30,35');
  console.error('  node scripts/lookup-star.mjs --csv=src/data/stars-30-35ly.csv [--missing=radec|class|all]');
  console.error('  node scripts/lookup-star.mjs --catalog=PATH ...   (default ~/Documents/catalog.html)');
  process.exit(1);
}
