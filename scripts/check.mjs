#!/usr/bin/env node
//
// One-shot validation umbrella. Runs the three checks that catch most
// problems after a procgen / schema / runtime change:
//
//   1. build:catalog — does the data pipeline parse + procgen + emit
//      without throwing? Also gives an updated body count.
//   2. tsc --noEmit  — does the runtime still type-check?
//   3. audit-procgen — do the observed distributions match the priors,
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
  { label: '[1/3] build:catalog', cmd: 'node',      args: ['scripts/build-catalog.mjs'] },
  // Direct tsc to skip the pretypecheck hook (which would rebuild the
  // catalog a second time).
  { label: '[2/3] tsc --noEmit',  cmd: 'npx',       args: ['tsc', '--noEmit'] },
  { label: '[3/3] audit-procgen', cmd: 'node',      args: ['scripts/audit-procgen.mjs'] },
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
