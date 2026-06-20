#!/usr/bin/env node
//
// Enforces the standalone-sim wall (facility-definitions plan §11.1). Two rules,
// both load-bearing for determinism + the "sim is a separate, swappable core"
// commitment:
//
//   1. sim/src/** imports nothing from the app. The economy core is standalone;
//      a single `../../src` import would couple it to the browser bundle and
//      break the planned WASM port.
//   2. src/** imports the sim ONLY from src/facilities/. The projector
//      (src/facilities/project.ts) + the resource-vocab bridge are the one
//      quarantined seam; a second importer elsewhere silently erodes it.
//
// This node script — not a lint rule — owns the sim wall. It's the spiritual
// `no-restricted-imports`/`no-restricted-paths` check, but oxlint's `import`
// plugin is too false-positive-prone for path-based zones, so the deterministic
// script stays the source of truth. check.mjs already owns the node-script idiom.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIM_SRC = resolve(REPO_ROOT, 'sim/src');
const APP_SRC = resolve(REPO_ROOT, 'src');
const FACILITIES = resolve(REPO_ROOT, 'src/facilities');

// Matches the module specifier of static import/export-from, side-effect imports,
// and dynamic import('...') with a string-literal argument (the idiomatic way a
// future lazy engine-bridge would pull the sim — exactly the second-importer case
// this guard exists to catch). A dynamic import whose specifier is a computed or
// template expression can't be caught by a lexer and is out of scope; an AST-based
// import rule would cover it, but we deliberately don't route the wall through
// oxlint (see the header), so that edge stays a documented blind spot.
const SPECIFIER = /(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]|import\s*(?:\(\s*)?['"]([^'"]+)['"]/g;

function tsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = resolve(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

function specifiersOf(file) {
  const src = readFileSync(file, 'utf8');
  const specs = [];
  for (const m of src.matchAll(SPECIFIER)) specs.push(m[1] ?? m[2]);
  return specs;
}

// Resolve a relative specifier (extension or not) to an absolute path prefix —
// we only need the directory/file location, not the exact resolved file.
//
// Scope limits, both deliberate: the guard reasons only about relative
// specifiers, so a tsconfig/Vite path alias to the sim would slip past it (add
// such an alias to the resolver here if one is ever introduced). And it scans
// only sim/src and src/ — build/tooling scripts under scripts/ are out of
// scope because they never enter the shipped bundle, so a sim import there
// can't couple the app to the standalone core.
function resolveRelative(fromFile, spec) {
  return resolve(dirname(fromFile), spec);
}

const isWithin = (parent, p) => p === parent || p.startsWith(parent + '/');

const violations = [];

// Rule 1 — sim/src must not reach into the app.
for (const file of tsFilesUnder(SIM_SRC)) {
  for (const spec of specifiersOf(file)) {
    if (!spec.startsWith('.')) continue; // bare specifiers (node:, packages) are fine
    const target = resolveRelative(file, spec);
    if (!isWithin(SIM_SRC, target)) {
      violations.push(`${relative(REPO_ROOT, file)} imports '${spec}' — sim/src must not escape the standalone core`);
    }
  }
}

// Rule 2 — only src/facilities may import the sim.
for (const file of tsFilesUnder(APP_SRC)) {
  if (isWithin(FACILITIES, file)) continue; // the one allowed seam
  for (const spec of specifiersOf(file)) {
    if (!spec.startsWith('.')) continue;
    const target = resolveRelative(file, spec);
    if (isWithin(SIM_SRC, target)) {
      violations.push(`${relative(REPO_ROOT, file)} imports '${spec}' — only src/facilities/ may import the sim`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write('check-sim-boundary: FAILED\n');
  for (const v of violations) process.stderr.write(`  - ${v}\n`);
  process.exit(1);
}
process.stdout.write('check-sim-boundary: sim/app boundary intact.\n');
