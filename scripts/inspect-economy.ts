// inspect-economy.ts — headless economy inspector.
//
// Boots the economy sim on the REAL cluster geometry (read straight from
// catalog.generated.json, no browser, no game save) and runs a small scenario,
// printing the per-turn flow so you can sanity-check economy behaviour — reach,
// intra- vs inter-cluster transfers, shortfalls — without launching the app.
//
// Node strips the .ts at runtime; it imports the sim + the facilities geometry
// adapter directly (the same modules the live bridge uses), so distances and
// reach match production. This is the saved form of the throwaway `node *.ts`
// checks used while wiring the economy — see docs/dev-tooling.md.
//
// Run: `npm run inspect:economy [-- --turns=N --reach=LY]`
//   --turns=N   turns to step (default 8)
//   --reach=LY  jump reach in light-years (default 9, mirrors economy-bridge REACH_LY)
// Edit SCENARIO below to inspect your own pattern of producers/consumers.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EconomyEngine, makeWorld, defaultBalance, starDistance, asStar,
} from '../sim/src/index.ts';
import { buildGeometry, LY_TO_SIM_UNITS } from '../src/facilities/sim-geometry.ts';
import { appResourceTable } from '../src/facilities/resource-table.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const numArg = (key: string, dflt: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? Number(hit.slice(key.length + 3)) : dflt;
};
const TURNS = numArg('turns', 8);
const REACH_LY = numArg('reach', 9);
const REACH_UNITS = Math.round(REACH_LY * LY_TO_SIM_UNITS);

const catalog = JSON.parse(
  readFileSync(resolve(REPO, 'src/data/catalog.generated.json'), 'utf8'),
) as { clusters: Array<{ com: { x: number; y: number; z: number } }> };

const geometry = buildGeometry(catalog.clusters.map((c) => c.com));
const resources = appResourceTable();
const R = resources.count;
const NAME = resources.metas.map((m) => m.name);
const FOOD = 0;
const ALLOYS = 1;

// Farthest cluster from node 0 that's still within one jump, so the inter-cluster
// leg routes a real haul against the actual galaxy whatever the catalog looks
// like (the nearest is often near-coincident and reads as 0 ly).
let neighbor = -1;
let best = -1;
for (let s = 1; s < geometry.starCount; s++) {
  const d = starDistance(geometry, asStar(0), asStar(s));
  if (d <= REACH_UNITS && d > best) { best = d; neighbor = s; }
}

const col = (idx: number, val: number): number[] => {
  const a = new Array<number>(R).fill(0);
  a[idx] = val;
  return a;
};

// SCENARIO — edit to taste. Each planet sits on a cluster node (by index); same
// node = same system (free 1-turn self-leg), different node = jump-routed.
const SCENARIO: Array<{ label: string; star: number; production: number[]; consumption: number[] }> = [
  { label: 'farm (cluster 0)', star: 0, production: col(FOOD, 6000), consumption: col(FOOD, 0) },
  { label: 'town (cluster 0)', star: 0, production: col(FOOD, 0), consumption: col(FOOD, 4000) },
  ...(neighbor >= 0
    ? [{ label: `mine (cluster ${neighbor})`, star: neighbor, production: col(ALLOYS, 5000), consumption: col(FOOD, 3000) }]
    : []),
];

const world = makeWorld({
  geometry,
  resources,
  cfg: defaultBalance({ jumpRadius: REACH_UNITS }),
  seed: 0x5e1f0501,
  planets: SCENARIO.map((p) => ({ star: p.star, production: p.production, consumption: p.consumption })),
});
const engine = new EconomyEngine(world, { checkInvariants: true });

const u = (milli: number): string => String(milli / 1000);
console.log(
  `geometry: ${geometry.starCount} clusters | reach ${REACH_LY} ly | inter-cluster haul cluster 0 → `
  + (neighbor >= 0 ? `${neighbor} (${(best / LY_TO_SIM_UNITS).toFixed(2)} ly, within reach)` : 'none in reach'),
);
SCENARIO.forEach((p, i) => console.log(`  p${i} ${p.label}`));
console.log('');

for (let t = 1; t <= TURNS; t++) {
  const rep = engine.step();
  console.log(`turn ${String(t).padStart(2)} | dispatched ${u(rep.dispatched)} delivered ${u(rep.delivered)} | unmet demands ${rep.unmet}`);
  SCENARIO.forEach((_, p) => {
    const held = NAME.map((n, r) => (world.stock[p * R + r] ? `${n} ${u(world.stock[p * R + r]!)}` : null)).filter(Boolean);
    console.log(`         p${p}: ${held.length ? held.join(', ') : '—'}`);
  });
}

const digest = engine.getReadDigest();
console.log(`\nedge flows (this turn): ${digest.edgeFlows.length}`);
for (const f of digest.edgeFlows) {
  console.log(`  ${NAME[f.resource]} ${u(f.unitsMilli)} : system ${f.fromSystem} → ${f.toSystem}${f.through ? ' (relay)' : ''}`);
}
console.log('shortfalls:');
let anyShort = false;
for (const pr of digest.planets.values()) {
  for (const [rid, rr] of pr.byResource) {
    if (rr.shortfall !== null) {
      anyShort = true;
      console.log(`  planet ${pr.planet} ${NAME[rid as number]}: cover ${u(rr.coverMilli)}, reason ${rr.shortfall}`);
    }
  }
}
if (!anyShort) console.log('  (none)');
