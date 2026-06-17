#!/usr/bin/env node
//
// Guards the one quiet drift the dual-use kernel's hand-written .d.mts can't
// catch. gas-potency.mjs's GAS_POTENCY is declared `Record<AtmGas, number>`, but
// TS trusts that declaration without checking the JS literal, and every call site
// reads it through `?? 0` — so a newly-added AtmGas with no potency entry compiles
// AND renders (as a fully-transparent gas) with no error. (Plain export-name drift
// is already caught by tsc when the app imports an undeclared member; THIS is the
// value-content gap the .d.mts header explicitly warns about.)
//
// Assert GAS_POTENCY carries exactly the AtmGas vocabulary: every union member is
// a key, and no key is a phantom. Wired into `npm run check`.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAS_POTENCY } from './lib/gas-potency.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Extract the AtmGas string-literal members from its TS union declaration — the
// single source of truth the .d.mts points GAS_POTENCY at.
const starsSrc = readFileSync(resolve(ROOT, 'src/data/stars.ts'), 'utf8');
const decl = starsSrc.match(/export type AtmGas\s*=([\s\S]*?);/);
if (!decl) {
  process.stderr.write('check-gas-potency: could not find the AtmGas union in src/data/stars.ts\n');
  process.exit(1);
}
const atmGases = [...decl[1].matchAll(/'([^']+)'/g)].map((g) => g[1]);

const potencyKeys = new Set(Object.keys(GAS_POTENCY));
const violations = [];
for (const g of atmGases) {
  if (!potencyKeys.has(g)) {
    violations.push(`AtmGas '${g}' has no GAS_POTENCY entry — it would render as a fully-transparent gas (masked by the call sites' ?? 0)`);
  }
}
for (const k of potencyKeys) {
  if (!atmGases.includes(k)) violations.push(`GAS_POTENCY has key '${k}' that is not an AtmGas member — a stale/typo entry`);
}

if (violations.length > 0) {
  process.stderr.write('check-gas-potency: FAILED\n');
  for (const v of violations) process.stderr.write(`  - ${v}\n`);
  process.exit(1);
}
process.stdout.write(`check-gas-potency: GAS_POTENCY covers all ${atmGases.length} AtmGas species.\n`);
