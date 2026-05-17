#!/usr/bin/env node
//
// Pretty-print one row from `src/data/bodies.csv` (or any CSV under
// `--csv=<path>`) with column names spelled out. Distinguishes the
// three CSV-side cell states that the build collapses to null at
// runtime:
//
//   - a literal value             — printed verbatim
//   - 'n/a'                       — printed dimmed as "(n/a)" (the
//                                   author asserted "this field does
//                                   not apply to this body")
//   - empty                       — printed as "(empty — procgen)"
//                                   (the author left this for the
//                                   Filler to populate)
//
// Useful when authoring or auditing curated rows (Sol's hand-tuned
// planets / moons / belts / ring) and verifying that column positions
// stayed aligned after a CSV schema tweak.
//
// Usage:   node scripts/inspect-csv.mjs <id> [--csv=<path>]
// Example: node scripts/inspect-csv.mjs sol-main-belt
//          node scripts/inspect-csv.mjs alpha-cen-a --csv=src/data/stars-0-5ly.csv

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
let id = null;
let csvArg = 'src/data/bodies.csv';
for (const a of args) {
  if (a.startsWith('--csv=')) csvArg = a.slice('--csv='.length);
  else if (!id) id = a;
}
if (!id) {
  process.stderr.write('usage: node scripts/inspect-csv.mjs <id> [--csv=<path>]\n');
  process.exit(2);
}

const csvPath = resolve(REPO_ROOT, csvArg);
let text;
try {
  text = readFileSync(csvPath, 'utf8');
} catch (err) {
  process.stderr.write(`inspect-csv: cannot read ${csvPath} (${err.message}).\n`);
  process.exit(1);
}

// Bodies and stars CSVs don't carry quoted fields with embedded commas
// today — a naive split is sufficient and keeps this script free of
// CSV-parsing dependencies. If quoted-field rows ever land, swap this
// for the parser in scripts/lib/catalog-index.mjs.
const lines = text.split(/\r?\n/).filter(l => l.length > 0);
if (lines.length < 2) {
  process.stderr.write(`inspect-csv: ${csvArg} has no data rows.\n`);
  process.exit(1);
}
const header = lines[0].split(',');
const dataLines = lines.slice(1);

const row = dataLines.find(l => l.split(',')[0] === id);
if (!row) {
  process.stderr.write(`inspect-csv: no row with id=${id} in ${csvArg}\n`);
  const hints = dataLines
    .map(l => l.split(',')[0])
    .filter(rid => rid.includes(id))
    .slice(0, 5);
  if (hints.length) process.stderr.write(`  did you mean: ${hints.join(', ')}?\n`);
  process.exit(1);
}
const cells = row.split(',');

// Column-name width for aligned output. Pad to longest header so the
// `=` characters land in one column.
const keyWidth = header.reduce((m, h) => Math.max(m, h.length), 0);

const out = [`${csvArg}:`];
for (let i = 0; i < header.length; i++) {
  const name = header[i].padEnd(keyWidth);
  const raw = (cells[i] ?? '').trim();
  let val;
  if (raw === '')         val = '(empty — procgen)';
  else if (raw === 'n/a') val = '(n/a)';
  else                    val = raw;
  out.push(`  ${name} = ${val}`);
}
process.stdout.write(out.join('\n') + '\n');
