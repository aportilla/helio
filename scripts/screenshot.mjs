// screenshot.mjs — capture the running app headlessly.
//
// Boots the Vite dev server in-process (open:false so it never pops a real
// browser), drives a headless Chromium via puppeteer to the galaxy view, waits
// for the WebGL canvas to settle (the scene auto-selects Sol and warms shaders),
// and writes a PNG. No dev server needs to be running first; the `prescreenshot`
// hook regenerates the catalog. See docs/dev-tooling.md.
//
// Run: `npm run screenshot [-- --out=PATH --width=W --height=H --wait=MS]`
//   --out=PATH   output file (default screenshots/galaxy.png)
//   --width/-height  viewport size (default 1280×800)
//   --wait=MS    settle delay after the canvas appears (default 3000)

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (key, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : dflt;
};
const OUT = resolve(REPO, flag('out', 'screenshots/galaxy.png'));
const WIDTH = Number(flag('width', 1280));
const HEIGHT = Number(flag('height', 800));
const WAIT_MS = Number(flag('wait', 3000));

mkdirSync(dirname(OUT), { recursive: true });

// In-process dev server — overrides the config's server.open so nothing pops up.
const server = await createServer({ root: REPO, server: { open: false } });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) {
  await server.close();
  throw new Error('screenshot: Vite did not report a local URL');
}
console.log(`serving ${url}`);

// --no-sandbox keeps it working in containers/CI; we only ever load our own
// localhost app, so the sandbox loss is not a real exposure here.
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.warn('[page error]', e.message));
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('canvas', { timeout: 15000 });
  // Let the scene settle: auto-select animation, shader warm, first frames.
  await new Promise((r) => setTimeout(r, WAIT_MS));
  await page.screenshot({ path: OUT });
  console.log(`wrote ${OUT}`);
} finally {
  await browser.close();
  await server.close();
}
