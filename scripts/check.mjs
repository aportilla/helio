#!/usr/bin/env node
//
// One-shot validation umbrella. Runs the four checks that catch most
// problems after a procgen / schema / runtime change:
//
//   1. lint-star-csv — does every star CSV row carry (or yield) the class +
//      position the build needs? Fails on a row a scrape/edit left dead.
//   2. build:catalog — does the data pipeline parse + procgen + emit
//      without throwing? `--strict` also fails on any dropped star row.
//   3. tsc --noEmit  — does the runtime still type-check?
//   4. check-sim-boundary — is the standalone-sim import wall intact?
//   5. audit-procgen — do the observed distributions match the priors,
//      or did a tweak land outside its expected envelope?
//
// Each step streams its stdout/stderr live. On the first non-zero exit
// the script bails out and propagates that code, so a `npm run check`
// in a tight edit loop fails fast.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
  { label: '[1/5] lint-star-csv',     cmd: 'node', args: ['scripts/lint-star-csv.mjs'] },
  { label: '[2/5] build:catalog',     cmd: 'node', args: ['scripts/build-catalog.mjs', '--strict'] },
  // Direct tsc to skip the pretypecheck hook (which would rebuild the
  // catalog a second time).
  { label: '[3/5] tsc --noEmit',      cmd: 'npx',  args: ['tsc', '--noEmit'] },
  { label: '[4/5] check-sim-boundary', cmd: 'node', args: ['scripts/check-sim-boundary.mjs'] },
  { label: '[5/5] audit-procgen',     cmd: 'node', args: ['scripts/audit-procgen.mjs'] },
];

for (const step of steps) {
  process.stdout.write(`\n=== ${step.label} ===\n`);
  const r = spawnSync(step.cmd, step.args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    process.stderr.write(`\ncheck: ${step.label} failed (exit ${r.status ?? 'signal'}).\n`);
    process.exit(r.status ?? 1);
  }
}
process.stdout.write('\ncheck: all steps passed.\n');
