#!/usr/bin/env node
//
// One-shot validation umbrella — the fast gates that catch most problems after
// a procgen / schema / runtime change. Run in sequence, failing fast on the
// first non-zero exit:
//
//   - lint-star-csv — does every star CSV row carry (or yield) the class +
//     position the build needs? Fails on a row a scrape/edit left dead.
//   - build:catalog — does the data pipeline parse + procgen + emit without
//     throwing? `--strict` also fails on any dropped star row.
//   - tsc --noEmit — does the runtime still type-check?
//   - tsc -p tsconfig.test.json — do the test sources type-check?
//   - check-sim-boundary — is the standalone-sim import wall intact?
//   - audit-procgen — do the observed distributions match the priors, or did a
//     tweak land outside its expected envelope?
//
// Each step streams its stdout/stderr live. On the first non-zero exit the
// script bails out and propagates that code, so a `npm run check` in a tight
// edit loop fails fast. (This list is the authoritative order — docs point
// here rather than re-enumerating it.)

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
  { label: 'lint-star-csv',      cmd: 'node', args: ['scripts/lint-star-csv.mjs'] },
  { label: 'build:catalog',      cmd: 'node', args: ['scripts/build-catalog.mjs', '--strict'] },
  // Direct tsc to skip the pretypecheck hook (which would rebuild the catalog).
  { label: 'tsc --noEmit',       cmd: 'npx',  args: ['tsc', '--noEmit'] },
  { label: 'tsc tests',          cmd: 'npx',  args: ['tsc', '-p', 'tsconfig.test.json'] },
  { label: 'check-sim-boundary', cmd: 'node', args: ['scripts/check-sim-boundary.mjs'] },
  { label: 'audit-procgen',      cmd: 'node', args: ['scripts/audit-procgen.mjs'] },
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
