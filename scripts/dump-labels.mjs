#!/usr/bin/env node
//
// Dump every composed body label across the whole procgen galaxy, so the
// "property-driven mad lib" in src/ui/system-hud/body-label.ts can be read
// in bulk rather than one hover-card at a time.
//
// This imports the REAL composeWorldLabel from the .ts source (Node strips
// the types — body-label.ts's only runtime import is classifyBody.mjs), so
// what's printed here is byte-identical to what the BodyInfoCard renders.
// No reimplementation, no drift.
//
// Labels are only meaningful for planets + moons — belts and rings get a
// separate info-card path (subtitleFor returns null for them), so they're
// excluded here.
//
// Usage:
//   node scripts/dump-labels.mjs              analytical summary (default)
//   node scripts/dump-labels.mjs --all        every body, grouped by archetype
//   node scripts/dump-labels.mjs --examples=N N example bodies per distinct label
//   node scripts/dump-labels.mjs --csv        machine-readable: one row per body
//
// The summary is the foundation for a creative pass: it surfaces the whole
// label vocabulary, how often each phrase fires, where worlds collapse to an
// identical chip, and which modifier words never (or always) appear.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBody } from './lib/body-archetype.mjs';
import { composeWorldLabel } from '../src/ui/system-hud/body-label.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = resolve(REPO_ROOT, 'src/data/catalog.generated.json');

let cat;
try {
  cat = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
} catch (err) {
  process.stderr.write(`dump-labels: cannot read ${CATALOG_PATH} (${err.message}).\nRun \`npm run build:catalog\` first.\n`);
  process.exit(1);
}
const { stars, bodies } = cat;

// --- args -------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const MODE_ALL = has('--all');
const MODE_CSV = has('--csv');
const EXAMPLES = valOf('examples') != null ? Math.max(1, parseInt(valOf('examples'), 10) || 1) : 0;

// --- subjects ---------------------------------------------------------------
// Only kinds that get a composed label: planets + moons.

const subjects = bodies.filter((b) => b.kind === 'planet' || b.kind === 'moon');

// Decorate each with its label + archetype + a host-star class once.
function hostStarOf(b) {
  if (b.hostStarIdx != null) return stars[b.hostStarIdx];
  if (b.hostBodyIdx != null) {
    const host = bodies[b.hostBodyIdx];
    if (host?.hostStarIdx != null) return stars[host.hostStarIdx];
  }
  return null;
}

const rows = subjects.map((b) => {
  const star = hostStarOf(b);
  return {
    b,
    id: b.id,
    kind: b.kind,
    label: composeWorldLabel(b),
    arch: classifyBody(b),
    starCls: star ? (star.cls || star.rawClass || '?') : '?',
  };
});

// --- formatters -------------------------------------------------------------

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}
function pct(n, d) {
  return d ? (n / d * 100).toFixed(1).padStart(5) + '%' : '   — ';
}
function num(v, d = 0) {
  return v == null ? '—' : Number(v).toFixed(d);
}

// Compact physics tail — the inputs the label keys off, so a label can be
// judged against the world it describes.
function physics(b) {
  const T = b.avgSurfaceTempK;
  const P = b.surfacePressureBar;
  const liq = b.surfaceLiquidFraction ?? 0;
  const parts = [
    `T=${T == null ? '—' : num(T) + 'K'}`,
    `P=${P == null ? '—' : num(P, P < 1 ? 3 : 1) + 'b'}`,
  ];
  if (liq > 0) parts.push(`liq=${num(liq, 2)}${b.surfaceLiquidSpecies ? ':' + b.surfaceLiquidSpecies : ''}`);
  if ((b.iceFraction ?? 0) > 0.05) parts.push(`ice=${num(b.iceFraction, 2)}`);
  if (b.subsurfaceOceanSpecies) parts.push(`subO=${b.subsurfaceOceanSpecies}`);
  if (b.biosphereComplexity && b.biosphereComplexity !== 'none') parts.push(`bio=${b.biosphereComplexity}`);
  if ((b.dustStrength ?? 0) >= 0.3) parts.push(`dust=${num(b.dustStrength, 2)}`);
  parts.push(`r=${num(b.radiusEarth, 2)}`);
  return parts.join(' ');
}

// ============================================================================
// CSV mode — one row per body, machine-readable.
// ============================================================================

if (MODE_CSV) {
  const cols = ['id', 'kind', 'label', 'archetype', 'starClass', 'tempK', 'pressureBar',
    'liquidFrac', 'liquidSpecies', 'iceFrac', 'subsurfaceOcean', 'biosphere', 'massEarth', 'radiusEarth'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of [...rows].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))) {
    const b = r.b;
    lines.push([
      b.id, b.kind, r.label, r.arch, r.starCls,
      b.avgSurfaceTempK, b.surfacePressureBar, b.surfaceLiquidFraction, b.surfaceLiquidSpecies,
      b.iceFraction, b.subsurfaceOceanSpecies, b.biosphereComplexity, b.massEarth, b.radiusEarth,
    ].map(esc).join(','));
  }
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

// ============================================================================
// --all — every body, grouped by archetype then label, with physics tail.
// ============================================================================

if (MODE_ALL) {
  console.log('ALL COMPOSED LABELS — grouped by archetype, then label');
  console.log('catalog: ' + CATALOG_PATH);
  console.log(`subjects: ${rows.length} (${rows.filter(r => r.kind === 'planet').length} planets, ${rows.filter(r => r.kind === 'moon').length} moons)`);

  const byArch = new Map();
  for (const r of rows) {
    if (!byArch.has(r.arch)) byArch.set(r.arch, []);
    byArch.get(r.arch).push(r);
  }
  const archOrder = [...byArch.keys()].sort((a, b) => byArch.get(b).length - byArch.get(a).length);

  for (const a of archOrder) {
    const group = byArch.get(a);
    console.log();
    console.log(`══ ${a}  (${group.length}) ` + '═'.repeat(Math.max(0, 56 - a.length - String(group.length).length)));
    const sorted = [...group].sort((x, y) => x.label.localeCompare(y.label) || x.id.localeCompare(y.id));
    for (const r of sorted) {
      console.log(`  ${pad(r.label, 30)} ${pad(r.id, 26)} ${pad(r.starCls, 4)} ${physics(r.b)}`);
    }
  }
  console.log();
  process.exit(0);
}

// ============================================================================
// Default — analytical summary.
// ============================================================================

console.log('BODY LABEL VOCABULARY — what the mad-lib actually produces');
console.log('catalog: ' + CATALOG_PATH);
console.log();
console.log(`  subjects: ${rows.length}  (${rows.filter(r => r.kind === 'planet').length} planets, ${rows.filter(r => r.kind === 'moon').length} moons)`);

// --- 1. Diversity ----------------------------------------------------------

const labelCounts = new Map();
for (const r of rows) labelCounts.set(r.label, (labelCounts.get(r.label) ?? 0) + 1);
const distinct = labelCounts.size;
const singletons = [...labelCounts.values()].filter((n) => n === 1).length;

console.log(`  distinct labels: ${distinct}   (${pct(distinct, rows.length).trim()} of subjects are uniquely phrased)`);
console.log(`  singletons: ${singletons}   one-of-a-kind labels`);
console.log(`  median bodies per label: ${(() => {
  const v = [...labelCounts.values()].sort((a, b) => a - b);
  return v[v.length >> 1];
})()}`);

// --- 2. Full frequency table ------------------------------------------------

console.log();
console.log('=== Every distinct label, by frequency ===');
console.log('  count   share   label');
console.log('  -----   -----   -----');
const ranked = [...labelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
for (const [label, n] of ranked) {
  console.log(`  ${pad(n, 5, true)}   ${pct(n, rows.length)}   ${label}`);
}

// --- 3. Per-archetype label breakdown --------------------------------------

console.log();
console.log('=== Label variety within each archetype ===');
console.log('  archetype          | bodies | labels | label (count) …');
console.log('  -------------------+--------+--------+----------------');
const byArch = new Map();
for (const r of rows) {
  if (!byArch.has(r.arch)) byArch.set(r.arch, []);
  byArch.get(r.arch).push(r);
}
const archRanked = [...byArch.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [a, group] of archRanked) {
  const counts = new Map();
  for (const r of group) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  const variants = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([l, n]) => `${l} (${n})`).join(', ');
  console.log(`  ${pad(a, 18)} | ${pad(group.length, 6, true)} | ${pad(counts.size, 6, true)} | ${variants}`);
}

// --- 4. Modifier-word frequency --------------------------------------------
// Tokenize each label and count words. Reveals dead modifiers (a word the
// code can emit but never does) and over-leaned ones. Core nouns and the
// bare "World"/"Moon" tail are listed too — the contrast is the point.

console.log();
console.log('=== Word frequency across all labels ===');
console.log('  (every space-separated token; hyphenated compounds stay one word)');
console.log('  count   word');
console.log('  -----   ----');
const wordCounts = new Map();
for (const r of rows) {
  for (const w of r.label.split(' ')) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
}
for (const [w, n] of [...wordCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`  ${pad(n, 5, true)}   ${w}`);
}

// --- 5. Collision spotlight -------------------------------------------------
// The most-repeated labels, with a few real examples + their physics, so you
// can judge whether the bodies sharing a chip are genuinely alike or whether
// the label is flattening real variety.

console.log();
console.log('=== Collision spotlight — the most-repeated labels ===');
console.log('  (do these bodies really read the same? if not, the label is too coarse)');
const SPOTLIGHT = 12;
const EX = EXAMPLES || 3;
for (const [label, n] of ranked.slice(0, SPOTLIGHT)) {
  console.log();
  console.log(`  ▸ ${label}  ×${n}`);
  const members = rows.filter((r) => r.label === label);
  for (const r of members.slice(0, EX)) {
    console.log(`      ${pad(r.id, 26)} ${pad(r.starCls, 4)} ${physics(r.b)}`);
  }
  if (members.length > EX) console.log(`      … +${members.length - EX} more`);
}

console.log();
