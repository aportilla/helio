#!/usr/bin/env node
// Reads the catalog CSVs in src/data/, runs the full derivation pipeline
// (normalize spectral class → derive mass via M-L chain or jitter → derive
// radius and pxSize → place coincident-set members hierarchically → build
// clusters with COMs), and writes the result to src/data/catalog.generated.json.
//
// The runtime stars.ts imports the JSON; nothing in the bundle depends on
// the CSVs or this pipeline. Re-run (via prebuild/predev/pretypecheck or
// `npm run build:catalog`) whenever a CSV changes.
//
// Mirrors the algorithm that used to live in src/data/stars.ts. KDTree
// pair scans are replaced with brute-force O(n²) here — build-time, not
// per-frame, and ~1500 stars at ~2M ops still completes in milliseconds.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(REPO_ROOT, 'src/data');
const OUT_PATH = resolve(DATA_DIR, 'catalog.generated.json');

const SOURCES = [
  'nearest-stars.csv',
  'stars-20-25ly.csv',
  'stars-25-30ly.csv',
  'stars-30-35ly.csv',
  'stars-35-40ly.csv',
  'stars-40-45ly.csv',
  'stars-45-50ly.csv',
];

// =============================================================================
// Coordinate + class + mass + radius helpers (ported from stars.ts)
// =============================================================================

const ICRS_TO_GAL = [
  [-0.054875539726, -0.873437108010, -0.483834985808],
  [+0.494109453312, -0.444829589425, +0.746982251810],
  [-0.867666135858, -0.198076386122, +0.455983795705],
];

function equatorialToGalactic(raDeg, decDeg, distLy) {
  const ra = raDeg * Math.PI / 180;
  const dec = decDeg * Math.PI / 180;
  const cosDec = Math.cos(dec);
  const xe = cosDec * Math.cos(ra);
  const ye = cosDec * Math.sin(ra);
  const ze = Math.sin(dec);
  const M = ICRS_TO_GAL;
  return {
    x: distLy * (M[0][0] * xe + M[0][1] * ye + M[0][2] * ze),
    y: distLy * (M[1][0] * xe + M[1][1] * ye + M[1][2] * ze),
    z: distLy * (M[2][0] * xe + M[2][1] * ye + M[2][2] * ze),
  };
}

function normalizeSpectralClass(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^D[A-Z]/.test(trimmed)) return 'WD';
  const m = /[OBAFGKMLTY]/.exec(trimmed);
  if (!m) return null;
  const c = m[0];
  if (c === 'L' || c === 'T' || c === 'Y') return 'BD';
  return c;
}

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASS_MASS_RANGE = {
  O:  [16,    90],
  B:  [ 2.1,  16],
  A:  [ 1.4,   2.1],
  F:  [ 1.04,  1.4],
  G:  [ 0.80,  1.04],
  K:  [ 0.45,  0.80],
  M:  [ 0.08,  0.45],
  WD: [ 0.50,  1.00],
  BD: [ 0.013, 0.075],
};

function syntheticMass(cls, x, y, z) {
  const [lo, hi] = CLASS_MASS_RANGE[cls];
  const seed = hash32(`${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`);
  const t = mulberry32(seed)();
  return Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo)));
}

function radiusFromClassMass(cls, mass) {
  if (cls === 'BD') return 0.10;
  if (cls === 'WD') return 0.012 * Math.pow(mass / 0.6, -1 / 3);
  return Math.pow(mass, 0.8);
}

const BC_BY_CLASS = { O: -4.0, B: -1.5, A: -0.3, F: -0.1, G: -0.1, K: -0.8, M: -2.5 };
const ML_ALPHA   = { O:  3.5, B:  3.8, A:  4.0, F:  4.0, G:  4.0, K:  3.0, M: 2.3 };
const PARSEC_PER_LY = 1 / 3.2615637;

function massFromMagnitude(cls, appMagRaw, distLy) {
  const bc = BC_BY_CLASS[cls];
  const alpha = ML_ALPHA[cls];
  if (bc === undefined || alpha === undefined) return null;
  if (/\bJ\b/.test(appMagRaw)) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(appMagRaw.replace(/−/g, '-'));
  if (!m) return null;
  const appMag = Number(m[0]);
  if (!Number.isFinite(appMag) || distLy <= 0) return null;
  const dPc = distLy * PARSEC_PER_LY;
  const absMag = appMag - 5 * (Math.log10(dPc) - 1);
  const bolMag = absMag + bc;
  const lum = Math.pow(10, (4.74 - bolMag) / 2.5);
  const mass = Math.pow(lum, 1 / alpha);
  const [lo, hi] = CLASS_MASS_RANGE[cls];
  if (mass < lo * 0.5 || mass > hi * 2) return null;
  return mass;
}

const PX_MIN = 3;
const PX_MAX = 18;
const SIZE_EXP = 1 / 3;
const A_MIN = Math.pow(0.0084, SIZE_EXP);
const A_MAX = Math.pow(2.048, SIZE_EXP);
const A_RANGE = A_MAX - A_MIN;

function radiusToPxSize(radiusSolar) {
  const a = Math.pow(radiusSolar, SIZE_EXP);
  const t = (a - A_MIN) / A_RANGE;
  const tc = Math.max(0, Math.min(1, t));
  return PX_MIN + tc * (PX_MAX - PX_MIN);
}

// =============================================================================
// CSV parsing
// =============================================================================

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cell += c;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseCsvCatalog(text, label) {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw new Error(`${label}: empty CSV`);
  const required = (col) => {
    const i = header.indexOf(col);
    if (i < 0) throw new Error(`${label}: missing column ${col}`);
    return i;
  };
  const optional = (col) => header.indexOf(col);
  const ID = required('id');
  const NAME = required('name');
  const DIST = required('distance_ly');
  const RA = required('ra_deg');
  const DEC = required('dec_deg');
  const CLASS = required('spectral_class');
  const MASS = optional('mass_msun');
  const APP_MAG = optional('app_mag');
  const IAU_NAME = optional('iau_name');

  const out = [];
  const num = (cell) => {
    const t = (cell ?? '').trim();
    return t ? Number(t) : NaN;
  };
  for (const row of rows) {
    if (!row.length || (row.length === 1 && !row[0])) continue;
    const name = row[NAME];
    if (!name) continue;
    const distLy = num(row[DIST]);
    const raDeg = num(row[RA]);
    const decDeg = num(row[DEC]);
    if (![distLy, raDeg, decDeg].every(Number.isFinite)) {
      console.warn(`${label}: skipping ${name} (incomplete RA/Dec/distance)`);
      continue;
    }
    const rawClass = (row[CLASS] ?? '').trim();
    const cls = normalizeSpectralClass(rawClass);
    if (cls === null) {
      console.warn(`${label}: skipping ${name} (no spectral class)`);
      continue;
    }
    const pos = equatorialToGalactic(raDeg, decDeg, distLy);
    const massCell = MASS >= 0 ? (row[MASS] ?? '').trim() : '';
    const massRaw = massCell ? Number(massCell) : NaN;
    let mass;
    if (Number.isFinite(massRaw)) {
      mass = massRaw;
    } else {
      const appMagCell = APP_MAG >= 0 ? (row[APP_MAG] ?? '') : '';
      const ml = massFromMagnitude(cls, appMagCell, distLy);
      mass = ml ?? syntheticMass(cls, pos.x, pos.y, pos.z);
    }
    const radiusSolar = radiusFromClassMass(cls, mass);
    const id = (row[ID] ?? '').trim();
    const iauName = IAU_NAME >= 0 ? (row[IAU_NAME] ?? '').trim() : '';
    out.push({
      id, name, iauName, ...pos, cls, rawClass, distLy, mass, radiusSolar,
      pxSize: radiusToPxSize(radiusSolar),
    });
  }
  return out;
}

function loadCatalog(sources) {
  const stars = [{
    id: 'sol',
    name: 'Sol',
    iauName: '',
    x: 0, y: 0, z: 0,
    cls: 'G',
    rawClass: 'G2V',
    distLy: 0,
    mass: 1.0,
    radiusSolar: 1.0,
    pxSize: radiusToPxSize(1.0),
  }];
  const seen = new Set(['sol']);
  for (const { text, label } of sources) {
    for (const s of parseCsvCatalog(text, label)) {
      if (seen.has(s.id)) {
        console.warn(`${label}: dropping duplicate ${s.id} (${s.name}) (already loaded from earlier source)`);
        continue;
      }
      seen.add(s.id);
      stars.push(s);
    }
  }
  return stars;
}

// =============================================================================
// Hierarchical multi-star layout (ported from stars.ts expandCoincidentSets)
// =============================================================================

const R_OUTER = 0.05;
const R_INNER = 0.015;
const COINCIDENT_EPS_LY = 0.001;

function parseComponentPath(suffix) {
  if (suffix === '') return ['a'];
  if (!/^[a-z]{1,2}$/.test(suffix)) return null;
  return suffix.length === 1 ? [suffix] : [suffix[0], suffix[1]];
}

function longestCommonPrefix(strs) {
  if (strs.length === 0) return '';
  let p = strs[0];
  for (let i = 1; i < strs.length && p.length > 0; i++) {
    while (!strs[i].startsWith(p)) p = p.slice(0, -1);
  }
  return p;
}

function buildSystemBasis(rng) {
  const theta = rng() * Math.PI * 2;
  const cosPhi = 2 * rng() - 1;
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  const nx = sinPhi * Math.cos(theta);
  const ny = sinPhi * Math.sin(theta);
  const nz = cosPhi;
  let rx = 1, ry = 0, rz = 0;
  if (Math.abs(nx) > 0.9) { rx = 0; ry = 1; }
  let ux = ry * nz - rz * ny;
  let uy = rz * nx - rx * nz;
  let uz = rx * ny - ry * nx;
  const ulen = Math.hypot(ux, uy, uz);
  ux /= ulen; uy /= ulen; uz /= ulen;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  return { ux, uy, uz, vx, vy, vz };
}

function tryHierarchicalLayout(stars, out, setIndices, cx, cy, cz, rng) {
  const ids = setIndices.map(i => stars[i].id);
  let lcp = longestCommonPrefix(ids);
  if (lcp.endsWith('-')) lcp = lcp.slice(0, -1);

  const parsed = [];
  for (const idx of setIndices) {
    const after = stars[idx].id.slice(lcp.length).replace(/^-/, '');
    const path = parseComponentPath(after);
    if (path === null) return false;
    parsed.push({ idx, path });
  }

  const topByLetter = new Map();
  for (const { idx, path } of parsed) {
    let slot = topByLetter.get(path[0]);
    if (!slot) { slot = { starIdx: null, children: [] }; topByLetter.set(path[0], slot); }
    if (path.length === 1) slot.starIdx = idx;
    else slot.children.push({ letter: path[1], starIdx: idx });
  }

  const basis = buildSystemBasis(rng);
  const startOuter = rng() * Math.PI * 2;
  const topLetters = Array.from(topByLetter.keys()).sort();
  const numTop = topLetters.length;

  for (let k = 0; k < numTop; k++) {
    const slot = topByLetter.get(topLetters[k]);
    const slotR = numTop > 1 ? R_OUTER : 0;
    const angle = startOuter + (k / Math.max(1, numTop)) * Math.PI * 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const ox = cx + (ca * basis.ux + sa * basis.vx) * slotR;
    const oy = cy + (ca * basis.uy + sa * basis.vy) * slotR;
    const oz = cz + (ca * basis.uz + sa * basis.vz) * slotR;

    if (slot.starIdx !== null) {
      out[slot.starIdx] = { ...stars[slot.starIdx], x: ox, y: oy, z: oz };
    }
    if (slot.children.length > 0) {
      slot.children.sort((a, b) => a.letter.localeCompare(b.letter));
      const startInner = rng() * Math.PI * 2;
      const n = slot.children.length;
      for (let j = 0; j < n; j++) {
        const ang = startInner + (j / n) * Math.PI * 2;
        const cc = Math.cos(ang), sc = Math.sin(ang);
        const childIdx = slot.children[j].starIdx;
        out[childIdx] = {
          ...stars[childIdx],
          x: ox + (cc * basis.ux + sc * basis.vx) * R_INNER,
          y: oy + (cc * basis.uy + sc * basis.vy) * R_INNER,
          z: oz + (cc * basis.uz + sc * basis.vz) * R_INNER,
        };
      }
    }
  }
  return true;
}

function evenRingLayout(stars, out, setIndices, cx, cy, cz, rng) {
  const basis = buildSystemBasis(rng);
  const startAngle = rng() * Math.PI * 2;
  const n = setIndices.length;
  setIndices.forEach((idx, k) => {
    const angle = startAngle + (k / n) * Math.PI * 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    out[idx] = {
      ...stars[idx],
      x: cx + (ca * basis.ux + sa * basis.vx) * R_OUTER,
      y: cy + (ca * basis.uy + sa * basis.vy) * R_OUTER,
      z: cz + (ca * basis.uz + sa * basis.vz) * R_OUTER,
    };
  });
}

// Brute-force replacement for KDTree.pairsWithin used at runtime. Catalog
// is ~1500 stars → ~1.1M ops; sub-millisecond at build time, and avoids
// duplicating kdtree.ts into Node-land.
function pairsWithinBrute(stars, radius, cb) {
  const r2 = radius * radius;
  const n = stars.length;
  for (let i = 0; i < n; i++) {
    const a = stars[i];
    for (let j = i + 1; j < n; j++) {
      const b = stars[j];
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= r2) cb(i, j);
    }
  }
}

function expandCoincidentSets(stars) {
  const out = stars.map(s => ({ ...s }));
  const n = stars.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  pairsWithinBrute(stars, COINCIDENT_EPS_LY, (i, j) => {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  });
  const sets = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = sets.get(r);
    if (!g) { g = []; sets.set(r, g); }
    g.push(i);
  }
  for (const set of sets.values()) {
    if (set.length < 2) continue;
    set.sort((a, b) => stars[b].mass - stars[a].mass);
    const cx = stars[set[0]].x, cy = stars[set[0]].y, cz = stars[set[0]].z;
    const rng = mulberry32(hash32(stars[set[0]].id));
    const placed = tryHierarchicalLayout(stars, out, set, cx, cy, cz, rng);
    if (!placed) evenRingLayout(stars, out, set, cx, cy, cz, rng);
  }
  return out;
}

// =============================================================================
// Cluster detection (ported from stars.ts buildClusters)
// =============================================================================

const CLUSTER_THRESHOLD_LY = 0.25;

function buildClusters(stars) {
  const n = stars.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  pairsWithinBrute(stars, CLUSTER_THRESHOLD_LY, (i, j) => {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  });
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(i);
  }
  return Array.from(groups.values()).map(members => {
    const primary = members.reduce(
      (best, m) => {
        const mm = stars[m].mass, mb = stars[best].mass;
        if (mm > mb) return m;
        if (mm < mb) return best;
        return stars[m].pxSize > stars[best].pxSize ? m : best;
      },
      members[0],
    );
    const ordered = [primary, ...members.filter(m => m !== primary)];
    let sumM = 0, sumX = 0, sumY = 0, sumZ = 0;
    for (const m of ordered) {
      const s = stars[m];
      sumM += s.mass;
      sumX += s.mass * s.x;
      sumY += s.mass * s.y;
      sumZ += s.mass * s.z;
    }
    const com = { x: sumX / sumM, y: sumY / sumM, z: sumZ / sumM };
    return { primary, members: ordered, com };
  });
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const t0 = performance.now();
  const sources = await Promise.all(SOURCES.map(async (f) => ({
    text: await readFile(resolve(DATA_DIR, f), 'utf8'),
    label: f,
  })));
  const raw = loadCatalog(sources);
  const stars = expandCoincidentSets(raw);
  const clusters = buildClusters(stars);
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify({ stars, clusters }));
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`build-catalog: ${stars.length} stars, ${clusters.length} clusters → ${OUT_PATH} (${ms} ms)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
