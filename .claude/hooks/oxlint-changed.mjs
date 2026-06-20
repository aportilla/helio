#!/usr/bin/env node
// PostToolUse hook — lints ONLY the file Claude just edited, using the repo's
// own oxlint + .oxlintrc.json. On a finding it exits 2 so the diagnostics are
// fed back to Claude to fix in the same edit loop; clean files and non-source
// edits pass silently. Fails OPEN: if oxlint can't run, the edit is never
// blocked. No new deps — shells out to the already-installed oxlint binary.
//
// Wired via .claude/settings.json → hooks.PostToolUse (matcher Edit|Write|MultiEdit).

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const LINTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // no / garbled stdin — never interfere with editing
}

const file = payload?.tool_input?.file_path;
if (typeof file !== 'string' || !LINTABLE.test(file)) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
const bin = `${projectDir}/node_modules/.bin/oxlint`;

const res = spawnSync(bin, [file], { cwd: projectDir, encoding: 'utf8' });

// Fail open: a missing binary or spawn error must never block an edit.
if (res.error || res.status == null) process.exit(0);
if (res.status === 0) process.exit(0); // lint-clean

const report = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
process.stderr.write(
  `oxlint flagged the file you just edited (${file}). Fix before continuing:\n\n${report}\n`,
);
process.exit(2);
