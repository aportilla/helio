#!/usr/bin/env node
//
// Lint the per-bracket star CSVs for rows the catalog build can't use, so a
// dead row can't silently rot the pipeline. A row is **non-viable** when it
// can't yield the two things every downstream stage needs:
//
//   - a 3D position  — distance_ly + ra_deg + dec_deg must all be numeric
//   - a spectral class — the catalog string, else inferable from the row's
//     own physics (mass, else absolute/apparent magnitude)
//
// This is the same `resolveSpectralClass` predicate `build-catalog.mjs` runs,
// imported from the shared physics module so lint and build never disagree on
// what survives. A viable row carries enough to derive everything else; a
// non-viable one is a position with no identity and gets dropped at build.
//
// Usage:
//   node scripts/lint-star-csv.mjs            # report non-viable rows; exit 1 if any
//   node scripts/lint-star-csv.mjs --prune    # rewrite the CSVs with them removed
//
// Run it after a scrape/fill/hand-edit (`find-missing-stars --add` +
// `fill-from-stellarcatalog` can leave faint catalog entries with no class or
// mass), and as the regression gate inside `npm run check`.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, serializeCsv } from './lib/catalog-index.mjs';
import { resolveSpectralClass } from './lib/astrophysics.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(REPO_ROOT, 'src/data');
const PRUNE = process.argv.includes('--prune');

// Star-bracket CSVs only — bodies.csv / body_layers.csv have a different schema.
const STAR_CSV = /^(nearest-stars|stars-[\d.]+-[\d.]+ly)\.csv$/;

const num = (cell) => {
  const t = (cell ?? '').trim();
  return t ? Number(t) : NaN;
};
// Apparent magnitude as a number for inference, rejecting infrared J-band
// readings (matches build-catalog's appMagNum) so an IR magnitude can't pose
// as a visual one in the distance modulus.
const appMagNum = (cell) => {
  const s = String(cell ?? '');
  if (/\bJ\b/.test(s)) return NaN;
  const m = /-?\d+(?:\.\d+)?/.exec(s.replace(/−/g, '-'));
  return m ? Number(m[0]) : NaN;
};

// Classify a parsed row against the build's viability rule. Returns null when
// the row is fine, or a short reason string when it would be dropped.
function nonViableReason(row, col) {
  const distLy = num(row[col.dist]);
  const raDeg = num(row[col.ra]);
  const decDeg = num(row[col.dec]);
  if (![distLy, raDeg, decDeg].every(Number.isFinite)) return 'incomplete RA/Dec/distance';
  const cls = resolveSpectralClass({
    rawClass: row[col.cls] ?? '',
    massSun: col.mass >= 0 ? num(row[col.mass]) : NaN,
    absMag: col.abs >= 0 ? num(row[col.abs]) : NaN,
    appMag: col.app >= 0 ? appMagNum(row[col.app]) : NaN,
    distLy,
  });
  if (cls === null) return 'no spectral class';
  return null;
}

const files = readdirSync(DATA_DIR).filter((f) => STAR_CSV.test(f)).sort();
let totalBad = 0;
const reasonTotals = new Map();

for (const fname of files) {
  const path = resolve(DATA_DIR, fname);
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows.shift();
  const col = {
    name: header.indexOf('name'),
    dist: header.indexOf('distance_ly'),
    ra: header.indexOf('ra_deg'),
    dec: header.indexOf('dec_deg'),
    cls: header.indexOf('spectral_class'),
    mass: header.indexOf('mass_msun'),
    app: header.indexOf('app_mag'),
    abs: header.indexOf('abs_mag'),
  };
  for (const k of ['name', 'dist', 'ra', 'dec', 'cls']) {
    if (col[k] < 0) throw new Error(`${fname}: missing required column for '${k}'`);
  }

  const kept = [];
  const bad = [];
  for (const row of rows) {
    if (!row.length || (row.length === 1 && !row[0])) { kept.push(row); continue; }
    const reason = nonViableReason(row, col);
    if (reason) {
      bad.push({ name: row[col.name] || '(unnamed)', reason });
      reasonTotals.set(reason, (reasonTotals.get(reason) ?? 0) + 1);
    } else {
      kept.push(row);
    }
  }

  if (bad.length) {
    totalBad += bad.length;
    console.log(`\n${fname}: ${bad.length} non-viable row(s)`);
    for (const b of bad) console.log(`  - ${b.name} (${b.reason})`);
    if (PRUNE) {
      writeFileSync(path, serializeCsv([header, ...kept]));
    }
  }
}

if (totalBad === 0) {
  console.log('lint-star-csv: all star rows viable.');
  process.exit(0);
}

const summary = [...reasonTotals].map(([r, n]) => `${n} ${r}`).join(', ');
if (PRUNE) {
  console.log(`\nlint-star-csv: pruned ${totalBad} non-viable row(s) — ${summary}.`);
  process.exit(0);
}
console.log(`\nlint-star-csv: ${totalBad} non-viable row(s) — ${summary}. Re-run with --prune to remove them.`);
process.exit(1);
