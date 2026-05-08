#!/usr/bin/env node
//
// Audit rows whose `id` is a slug-ified-name fallback (i.e. the row's name
// didn't match any catalog entry via `variants()`). For each, find the
// nearest catalog-matched row across all CSVs and report:
//   - "OVERLAP"   — within `OVERLAP_LY` of an existing catalog row (probably
//                   a distinct binary component the catalog conflates into
//                   one entry; deleting loses no positional info)
//   - "NEAR"      — within `NEAR_LY` of a catalog row (likely co-system
//                   member, e.g. Proxima ~0.19 ly from Alpha Cen AB)
//   - "DISTINCT"  — far from any catalog row (catalog genuinely lacks this
//                   star; deleting forfeits the row entirely)
//
// Read-only; prints a TSV report on stdout.

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, buildIndex, findStar, parseCsv } from './lib/catalog-index.mjs';

const argv = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) argv[m[1]] = m[2] ?? '1';
}
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(REPO_ROOT, 'src/data');
const CATALOG = argv.catalog ?? resolve(homedir(), 'Documents/catalog.html');
const OVERLAP_LY = 0.05;  // sub-AU at our scale; effectively "same point"
const NEAR_LY = 0.5;      // co-system / very close pair

// ICRS → galactic, copied from src/data/stars.ts so this script can run
// independently without compiling TypeScript.
const M = [
  [-0.054875539726, -0.873437108010, -0.483834985808],
  [+0.494109453312, -0.444829589425, +0.746982251810],
  [-0.867666135858, -0.198076386122, +0.455983795705],
];
function eqToGal(raDeg, decDeg, distLy) {
  const ra = raDeg * Math.PI / 180, dec = decDeg * Math.PI / 180;
  const c = Math.cos(dec);
  const xe = c * Math.cos(ra), ye = c * Math.sin(ra), ze = Math.sin(dec);
  return [
    distLy * (M[0][0] * xe + M[0][1] * ye + M[0][2] * ze),
    distLy * (M[1][0] * xe + M[1][1] * ye + M[1][2] * ze),
    distLy * (M[2][0] * xe + M[2][1] * ye + M[2][2] * ze),
  ];
}

// Build catalog slug set so we can tell "real catalog slug" from
// "slug-ified fallback" by looking at each row's id.
const catStars = loadCatalog(CATALOG);
const catSlugs = new Set(catStars.map(s => s.slug.replace(/^stars\//, '')));

// Load every CSV. For each row, classify and capture position if RA/Dec/dist
// are present.
const allRows = [];
for (const fname of readdirSync(DATA_DIR)) {
  if (!fname.endsWith('.csv')) continue;
  const rows = parseCsv(readFileSync(resolve(DATA_DIR, fname), 'utf8'));
  const header = rows.shift();
  const ID = header.indexOf('id');
  const NAME = header.indexOf('name');
  const DIST = header.indexOf('distance_ly');
  const RA = header.indexOf('ra_deg');
  const DEC = header.indexOf('dec_deg');
  for (const row of rows) {
    if (!row[NAME]) continue;
    const id = row[ID];
    const name = row[NAME];
    const ra = Number(row[RA]), dec = Number(row[DEC]), dist = Number(row[DIST]);
    const havePos = [ra, dec, dist].every(Number.isFinite);
    const pos = havePos ? eqToGal(ra, dec, dist) : null;
    allRows.push({
      file: fname, id, name, pos,
      matched: catSlugs.has(id),
    });
  }
}

const matched = allRows.filter(r => r.matched && r.pos);
const unresolved = allRows.filter(r => !r.matched);

console.error(`loaded ${allRows.length} rows | ${matched.length} catalog-matched (with position) | ${unresolved.length} unresolved`);
console.error(`thresholds: overlap<${OVERLAP_LY} ly, near<${NEAR_LY} ly`);
console.error('');

// For each unresolved row with a position, nearest catalog-matched row.
const buckets = { OVERLAP: [], NEAR: [], DISTINCT: [], NO_POS: [] };
for (const u of unresolved) {
  if (!u.pos) {
    buckets.NO_POS.push({ u });
    continue;
  }
  let bestD = Infinity, bestM = null;
  for (const m of matched) {
    const dx = u.pos[0] - m.pos[0];
    const dy = u.pos[1] - m.pos[1];
    const dz = u.pos[2] - m.pos[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < bestD) { bestD = d; bestM = m; }
  }
  const bucket = bestD < OVERLAP_LY ? 'OVERLAP' : bestD < NEAR_LY ? 'NEAR' : 'DISTINCT';
  buckets[bucket].push({ u, bestD, bestM });
}

for (const [bucket, items] of Object.entries(buckets)) {
  if (!items.length) continue;
  console.log(`\n=== ${bucket} (${items.length}) ===`);
  for (const item of items) {
    if (bucket === 'NO_POS') {
      console.log(`  ${item.u.name.padEnd(35)} (${item.u.file}) — no RA/Dec, can't compute position`);
    } else {
      const dStr = item.bestD < 0.01 ? item.bestD.toExponential(2) : item.bestD.toFixed(3);
      console.log(`  ${item.u.name.padEnd(35)} ${dStr.padStart(8)} ly from ${item.bestM.name.padEnd(28)} (${item.u.file})`);
    }
  }
}

console.error(`\nTotals: ${buckets.OVERLAP.length} overlap | ${buckets.NEAR.length} near | ${buckets.DISTINCT.length} distinct | ${buckets.NO_POS.length} no-pos`);
