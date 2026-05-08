import { Color } from 'three';
import nearestCsv from './nearest-stars.csv?raw';
import twentyTwentyFiveCsv from './stars-20-25ly.csv?raw';
import twentyFiveThirtyCsv from './stars-25-30ly.csv?raw';
import thirtyThirtyFiveCsv from './stars-30-35ly.csv?raw';
import thirtyFiveFortyCsv from './stars-35-40ly.csv?raw';
import fortyFortyFiveCsv from './stars-40-45ly.csv?raw';
import fortyFiveFiftyCsv from './stars-45-50ly.csv?raw';

export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'WD' | 'BD';

export interface Star {
  // Stable identifier — the stellarcatalog.com slug (e.g. `fomalhaut-a`,
  // `sirius-a`, `gliese-1`), or `sol` for the Sun. Survives display-name
  // edits, so consumers like WAYPOINT_STAR_IDS key on this rather than name.
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cls: SpectralClass;
  // Catalog-stated distance from Sun in ly. The CSV's distance is the
  // upstream Wikipedia value (parallax-derived); √(x²+y²+z²) is computed
  // from the same distance × the unit RA/Dec direction, so the two agree by
  // construction except for floating-point rounding.
  readonly distLy: number;
  // Solar masses. Used for primary determination within a cluster
  // (heaviest member becomes the label anchor) and for mass-weighted
  // barycenters in the post-processor. Approximate (catalog quality).
  readonly mass: number;
  // Stellar radius in solar radii (R☉). Wikipedia's nearest-stars table
  // doesn't carry a radius column, so this is always derived at load time
  // from class + mass — Chandrasekhar M^(-1/3) for WDs, ~Jupiter-radius
  // constant for BDs, and a rough main-sequence M^0.8 elsewhere. The
  // visualization-side pxSize is computed from radiusSolar.
  readonly radiusSolar: number;
  // Reference visual disc size in pixels at the default zoom (the shader
  // applies depth-attenuation on top of this). Computed from radiusSolar
  // at module load via a log mapping — see radiusToPxSize.
  readonly pxSize: number;
}

// =============================================================================
// CSV-driven catalog
// =============================================================================
//
// Source of truth: src/data/nearest-stars.csv, a 1:1 mirror of the main table
// at https://en.wikipedia.org/wiki/List_of_nearest_stars. Refresh by
// re-running `node scripts/scrape-wiki-stars.mjs` (the scraper handles
// rowspan/colspan, single- vs double-quoted attrs, the {{RA|h|m|s}} /
// {{DEC|d|m|s}} templates, and footnote-glyph stripping).
//
// The CSV carries name, distance (ly), constellation, RA/Dec (degrees),
// raw spectral class, mass (M☉), magnitudes, and parallax. At module load
// we:
//   1. Hardcode Sol (Wikipedia lists it with a degenerate distance and no
//      RA/Dec, so it's filtered out by the scraper and re-added here).
//   2. Normalize the raw Wikipedia spectral class (e.g. "M5.5Ve" → 'M',
//      "DA2" → 'WD', "L8±1"/"T1±2"/"Y4" → 'BD').
//   3. Rotate ICRS RA/Dec into galactic Cartesian (+X→galactic centre,
//      +Z→north galactic pole) and scale by distance.
//   4. Derive radiusSolar from class + mass (Wikipedia carries no radius).
//
// Coincident binary/triple members (Wikipedia gives the same RA/Dec for
// every component because real separations are sub-parsec) are then
// distributed onto a small per-system ring by `expandCoincidentSets`
// downstream, exactly as before.

// ICRS → Galactic rotation matrix (J2000), per the IAU 1958 / Hipparcos
// convention. Multiplying [cos(δ)·cos(α), cos(δ)·sin(α), sin(δ)]ᵀ by this
// matrix yields the unit galactic vector (+X→GC, +Y→l=90°, +Z→NGP).
const ICRS_TO_GAL: readonly (readonly [number, number, number])[] = [
  [-0.054875539726, -0.873437108010, -0.483834985808],
  [+0.494109453312, -0.444829589425, +0.746982251810],
  [-0.867666135858, -0.198076386122, +0.455983795705],
];

function equatorialToGalactic(raDeg: number, decDeg: number, distLy: number): { x: number; y: number; z: number } {
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

// Wikipedia spectral classes are MK strings ("M5.5Ve", "G2V", "F5IV–V",
// "DA2", "L8±1", "T7", "Y4", "sdM4", "M?", ...). Squash to our 9-bucket
// SpectralClass enum: white dwarfs (any "D[A-Z]..." prefix) → WD; brown
// dwarfs (L/T/Y) → BD; otherwise the first MK letter wins (handles prefixes
// like 'sd' and trailing peculiarity flags).
//
// Returns null for genuinely-unknown classes (empty cell, or no recognizable
// MK letter anywhere in the string). The loader treats null as "skip this
// row" rather than falling back to 'BD' — guessing class would render the
// star as a visually-wrong tiny red dot rather than honestly omitting it.
// Affects a handful of binary sub-components (Chi1 Orionis B, Gliese 250 Bb,
// Gliese 867 C/D, Gliese 508 Ab/B, WT 460 B) where Wikipedia gave us name +
// position but no spectral type and the catalog has no detail page either.
function normalizeSpectralClass(raw: string): SpectralClass | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^D[A-Z]/.test(trimmed)) return 'WD';
  const m = /[OBAFGKMLTY]/.exec(trimmed);
  if (!m) return null;
  const c = m[0];
  if (c === 'L' || c === 'T' || c === 'Y') return 'BD';
  return c as SpectralClass;
}

// FNV-1a 32-bit string hash. Cheap, stable across runs and platforms — used
// to seed mulberry32 wherever we want a deterministic-per-key random draw
// (per-star mass jitter, per-system ring orientation in expandCoincidentSets).
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

// Mulberry32 PRNG — tiny, fast, good enough for the once-per-load draws we
// need. Reseeded each time so every reload reproduces the same value for
// the same input key (no Heisenberg "looks different every refresh").
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Typical mass range (M☉) per spectral class, matching the standard
// astronomical class boundaries (O ≥ 16, B 2.1–16, A 1.4–2.1, F 1.04–1.4,
// G 0.80–1.04, K 0.45–0.80, M 0.08–0.45 — main-sequence-mass thresholds);
// WD spans the bulk of observed white-dwarf masses, BD the substellar
// range between deuterium- and hydrogen-burning limits. Used for entries
// where Wikipedia's mass column is empty: rather than collapse them to a
// single per-class default (visually identical M dwarfs everywhere), we
// sample log-uniformly within the range using a position-seeded PRNG.
const CLASS_MASS_RANGE: Record<SpectralClass, readonly [number, number]> = {
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

// Derive a deterministic per-star mass from class + position. Same star at
// the same coordinates always gets the same mass across reloads — and
// since Wikipedia gives binary partners identical RA/Dec (which expand
// out to identical pre-ring positions), same-class coincident pairs
// honestly land at the same mass, which is roughly what a real same-class
// binary looks like anyway. Log-uniform across the class range so the
// 6× span on BDs (and the 5× span on M dwarfs) reads as visible variety
// rather than clustering near one end.
function syntheticMass(cls: SpectralClass, x: number, y: number, z: number): number {
  const [lo, hi] = CLASS_MASS_RANGE[cls];
  const seed = hash32(`${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`);
  const t = mulberry32(seed)();
  return Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo)));
}

// Derive radius (R☉) from spectral class + mass:
// - WD: Chandrasekhar M^(−1/3), anchored at ~0.012 R☉ for a typical 0.6 M☉ WD.
// - BD: ~Jupiter-radius constant; mass barely affects radius across L/T/Y.
// - Main sequence: rough M^0.8 anchored at the Sun (1 M☉ = 1 R☉). Loses the
//   subgiant offset for entries like Procyon A (which the prior hand-tuned
//   table caught via measured radii) — accepted regression for 1:1 source-
//   of-truth simplicity.
function radiusFromClassMass(cls: SpectralClass, mass: number): number {
  if (cls === 'BD') return 0.10;
  if (cls === 'WD') return 0.012 * Math.pow(mass / 0.6, -1 / 3);
  return Math.pow(mass, 0.8);
}

// Bolometric correction (M_bol − M_V) by spectral class. Negative everywhere:
// V-band undercaptures total flux for both very hot stars (UV-dominated) and
// cool dwarfs (IR-dominated). Approximate values from the Pecaut & Mamajek
// dwarf-star tables — exact enough for visualization, not for science.
const BC_BY_CLASS: Partial<Record<SpectralClass, number>> = {
  O: -4.0, B: -1.5, A: -0.3, F: -0.1, G: -0.1, K: -0.8, M: -2.5,
};

// Mass-luminosity exponent: L/L☉ = (M/M☉)^α. Steeper for high-mass, shallower
// for low-mass M dwarfs. Approximate; the formula's main job here is to keep
// brighter stars heavier and dimmer ones lighter, not to reach research
// accuracy.
const ML_ALPHA: Partial<Record<SpectralClass, number>> = {
  O: 3.5, B: 3.8, A: 4.0, F: 4.0, G: 4.0, K: 3.0, M: 2.3,
};

const PARSEC_PER_LY = 1 / 3.2615637;

// Compute mass from spectral class + apparent V-band magnitude + distance via
// the standard chain: distance modulus → absolute V mag → bolometric mag (via
// per-class BC) → luminosity → mass (via per-class M-L exponent). Returns
// null when the chain doesn't apply or gives an out-of-range result, which
// punts the row to the procedural-jitter fallback:
//
// - WD/BD classes have no entry in BC_BY_CLASS / ML_ALPHA (white dwarfs are
//   off the main sequence; brown-dwarf luminosity is age-degenerate, so
//   magnitude alone can't pin down mass).
// - J-band magnitudes (used for substellar objects in our CSVs) carry a "J"
//   suffix and are skipped — V-band BC values would mis-correct them.
// - Magnitudes given as a range ("10.3–10.33") fall to the first numeric.
// - Results outside [0.5·class_lo, 2·class_hi] are rejected, catching
//   misclassifications, subgiants/giants whose elevated luminosity would
//   inflate the inferred mass, and bad input data.
function massFromMagnitude(cls: SpectralClass, appMagRaw: string, distLy: number): number | null {
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

// Minimal CSV parser — RFC-4180-ish. We control the upstream format so we
// don't need to worry about exotic quoting or BOMs.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
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

// Parse one CSV file into Star[] (no Sol prepend, no dedupe — those happen
// at the union level so multiple CSVs can be concatenated cleanly). Missing
// optional columns (mass on the 20-25 ly CSV, etc.) are tolerated; per-row
// missing distance/RA/Dec causes the row to be skipped with a DEV warning.
function parseCsvCatalog(text: string, label: string): Star[] {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw new Error(`${label}: empty CSV`);
  const required = (col: string) => {
    const i = header.indexOf(col);
    if (i < 0) throw new Error(`${label}: missing column ${col}`);
    return i;
  };
  const optional = (col: string) => header.indexOf(col); // -1 if absent
  const ID = required('id');
  const NAME = required('name');
  const DIST = required('distance_ly');
  const RA = required('ra_deg');
  const DEC = required('dec_deg');
  const CLASS = required('spectral_class');
  const MASS = optional('mass_msun');
  const APP_MAG = optional('app_mag');

  const out: Star[] = [];
  // Number('') === 0, so a blanket `Number(cell)` on an empty CSV cell
  // would silently produce 0 — a finite value that passes the "missing
  // RA/Dec" check below and lands the star at the celestial-equator-axis
  // origin. Treat empty cells as NaN explicitly so the skip path triggers.
  const num = (cell: string | undefined): number => {
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
      // Distance/RA/Dec missing — can't place in 3D, skip rather than emit
      // NaN geometry. Most often hits brown-dwarf rows where Wikipedia
      // hasn't filled in coordinates yet.
      if (import.meta.env?.DEV) console.warn(`${label}: skipping ${name} (incomplete RA/Dec/distance)`);
      continue;
    }
    const cls = normalizeSpectralClass(row[CLASS]);
    if (cls === null) {
      // No usable spectral class — render-time defaults would mis-classify
      // the star as a brown dwarf. Skip with a DEV warning so the gap is
      // visible without polluting the scene.
      if (import.meta.env?.DEV) console.warn(`${label}: skipping ${name} (no spectral class)`);
      continue;
    }
    const pos = equatorialToGalactic(raDeg, decDeg, distLy);
    // Mass priority: real catalog value > computed via M-L chain (class +
    // app-mag + distance) > position-seeded procedural jitter. The chain
    // wins for un-massed main-sequence rows whose magnitude carries the
    // information; jitter only fires when both real mass and a usable
    // V-band magnitude are missing (WDs, BDs, J-band-only entries).
    //
    // Note: Number('') === 0, which would silently give every mass-less
    // row a zero mass and divide 0/0 → NaN COMs. Treat empty cells as
    // missing so the priority chain takes over.
    const massCell = MASS >= 0 ? (row[MASS] ?? '').trim() : '';
    const massRaw = massCell ? Number(massCell) : NaN;
    let mass: number;
    if (Number.isFinite(massRaw)) {
      mass = massRaw;
    } else {
      const appMagCell = APP_MAG >= 0 ? (row[APP_MAG] ?? '') : '';
      const ml = massFromMagnitude(cls, appMagCell, distLy);
      mass = ml ?? syntheticMass(cls, pos.x, pos.y, pos.z);
    }
    const radiusSolar = radiusFromClassMass(cls, mass);
    const id = (row[ID] ?? '').trim();
    out.push({
      id, name, ...pos, cls, distLy, mass, radiusSolar,
      pxSize: radiusToPxSize(radiusSolar),
    });
  }
  return out;
}

// Build the full catalog: Sol + every CSV's contents, deduped by name. The
// 0-20 ly source wins over 20-25 ly on conflict (the nearer page is the
// more authoritative for any star Wikipedia editors moved between
// brackets). DEV-mode warnings flag any cross-CSV duplicate so we know if
// upstream pages drift into overlap.
function loadCatalog(): Star[] {
  // Sol comes first so it lands at index 0 and the rest of the catalog
  // mirrors Wikipedia's distance-sorted order. Position is the origin and
  // class/mass/radius are the canonical 1.0 (R☉ / M☉) values.
  const stars: Star[] = [{
    id: 'sol',
    name: 'Sol',
    x: 0, y: 0, z: 0,
    cls: 'G',
    distLy: 0,
    mass: 1.0,
    radiusSolar: 1.0,
    pxSize: radiusToPxSize(1.0),
  }];
  const seen = new Set<string>(['sol']);
  const sources: { text: string; label: string }[] = [
    { text: nearestCsv, label: 'nearest-stars.csv' },
    { text: twentyTwentyFiveCsv, label: 'stars-20-25ly.csv' },
    { text: twentyFiveThirtyCsv, label: 'stars-25-30ly.csv' },
    { text: thirtyThirtyFiveCsv, label: 'stars-30-35ly.csv' },
    { text: thirtyFiveFortyCsv, label: 'stars-35-40ly.csv' },
    { text: fortyFortyFiveCsv, label: 'stars-40-45ly.csv' },
    { text: fortyFiveFiftyCsv, label: 'stars-45-50ly.csv' },
  ];
  for (const { text, label } of sources) {
    for (const s of parseCsvCatalog(text, label)) {
      if (seen.has(s.id)) {
        if (import.meta.env?.DEV) console.warn(`${label}: dropping duplicate ${s.id} (${s.name}) (already loaded from earlier source)`);
        continue;
      }
      seen.add(s.id);
      stars.push(s);
    }
  }
  return stars;
}

// =============================================================================
// Post-processor: ring out coincident sets so binary partners are visible
// =============================================================================
//
// Minimum visible separation (ly) for coincident-coordinate members. Picked
// so that at default zoom (orbit 50 ly) the displacement is ~1.5 px (visually
// merged with the primary) and at close zoom (orbit 5 ly) it's ~10 px (clear
// pair). Increase if binary partners feel too clumped at zoom-in; decrease
// if they feel too separated at default zoom.
const MIN_VIS_LY = 0.04;
// Two stars within this distance (ly) are treated as coincident — i.e. the
// catalog says "same place" within rounding. Has to be smaller than the
// smallest curated hierarchical offset (0.08 ly) so curated layouts aren't
// collapsed into the ring.
const COINCIDENT_EPS_LY = 0.001;

function expandCoincidentSets(stars: readonly Star[]): Star[] {
  const out: Star[] = stars.map(s => ({ ...s }));
  const visited = new Set<number>();
  const eps2 = COINCIDENT_EPS_LY * COINCIDENT_EPS_LY;
  for (let i = 0; i < stars.length; i++) {
    if (visited.has(i)) continue;
    const set: number[] = [i];
    visited.add(i);
    for (let j = i + 1; j < stars.length; j++) {
      if (visited.has(j)) continue;
      const dx = stars[i].x - stars[j].x;
      const dy = stars[i].y - stars[j].y;
      const dz = stars[i].z - stars[j].z;
      if (dx * dx + dy * dy + dz * dz < eps2) {
        set.push(j);
        visited.add(j);
      }
    }
    if (set.length < 2) continue;
    // Mass-sort the set so the heaviest member becomes the cluster primary
    // downstream — labels and droplines anchor on it. The angle assignment
    // below is randomized per system (not "primary at angle 0"), so the
    // primary's screen position is no longer a stable reference direction.
    set.sort((a, b) => stars[b].mass - stars[a].mass);
    const cx = stars[set[0]].x, cy = stars[set[0]].y, cz = stars[set[0]].z;

    // Per-system ring orientation. Without this, every coincident pair sat
    // along +X in the galactic plane, so a top-down view showed every
    // binary as an identical horizontal "= =" pair. Picking a random unit
    // normal seeded by the primary's name gives each system its own
    // tilt+phase, stable across reloads.
    const rng = mulberry32(hash32(stars[set[0]].id));
    // Uniform random unit vector on the sphere — the ring lies in the
    // plane perpendicular to this. Standard inverse-CDF method: theta is
    // the azimuth, cosPhi is the latitude (uniform in cos to avoid pole
    // bunching that comes from picking phi uniform in [0,π]).
    const theta = rng() * Math.PI * 2;
    const cosPhi = 2 * rng() - 1;
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
    const nx = sinPhi * Math.cos(theta);
    const ny = sinPhi * Math.sin(theta);
    const nz = cosPhi;
    // Build an orthonormal basis (u, v) in the plane ⊥ n. Cross n with the
    // world axis least parallel to it (avoids the degenerate near-zero
    // cross when the normal happens to align with our reference axis), then
    // v = n × u rounds out the basis.
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
    const startAngle = rng() * Math.PI * 2;

    const n = set.length;
    set.forEach((idx, k) => {
      const angle = startAngle + (k / n) * Math.PI * 2;
      const c = Math.cos(angle), s = Math.sin(angle);
      out[idx] = {
        ...stars[idx],
        x: cx + (c * ux + s * vx) * MIN_VIS_LY,
        y: cy + (c * uy + s * vy) * MIN_VIS_LY,
        z: cz + (c * uz + s * vz) * MIN_VIS_LY,
      };
    });
  }
  return out;
}

// =============================================================================
// Visual properties
// =============================================================================

// Stellar colors approximated from blackbody spectra at each spectral class's
// typical surface temperature (Mitchell Charity table).
//   O ~30000K  blue            B ~15000K  blue-white      A ~9000K   white
//   F ~6800K   pale yellow     G ~5800K   yellow (Sun)    K ~4500K   pale orange
//   M ~3300K   orange-red      WD ~10000K very pale blue  BD ~1500K  deep red
export const CLASS_COLOR: Record<SpectralClass, Color> = {
  O:  new Color(0x9bb0ff),
  B:  new Color(0xaabfff),
  A:  new Color(0xcad8ff),
  F:  new Color(0xf8f7ff),
  G:  new Color(0xfff4e8),
  K:  new Color(0xffd2a1),
  M:  new Color(0xffb56c),
  WD: new Color(0xc8d2ff),
  BD: new Color(0xa64633),
};

// Map a solar-radius value to the per-star reference pixel size baked into
// each Star.pxSize. The shader takes that value, multiplies by uPxScale/600
// and the depth-attenuation factor, and rounds to integer pixels. So pxSize
// is the rendered disc diameter at default zoom (orbit 50 ly) when the star
// sits at the camera focus.
//
// Real radii in this catalog span ~250× (Sirius B 0.0084 → Procyon A 2.048),
// so a linear mapping would make WDs invisible and A-class dwarfs dominate.
// Log10 compresses too aggressively in the other direction — under that
// mapping, an M dwarf at 0.144 R☉ and an A dwarf at 1.71 R☉ rendered at
// ~11 vs ~18 px (a ~1.6× ratio), close enough that the brightest class
// barely stood out from the field. Cube-root strikes the balance: the
// 250× radius range becomes a ~6× pixel range across the [3, 18] band, so
// Wolf 359 lands ~8 px and Sirius A ~17 px (a ~2× ratio matching what the
// old per-class CLASS_SIZE table produced) — clear class separation with
// within-class variation preserved (Wolf 359 0.144 vs Lalande 21185 0.392
// render as visibly different M dwarfs).
const PX_MIN = 3;
const PX_MAX = 18;
const SIZE_EXP = 1 / 3;
const A_MIN = Math.pow(0.0084, SIZE_EXP);  // Sirius B → 3 px
const A_MAX = Math.pow(2.048, SIZE_EXP);   // Procyon A → 18 px
const A_RANGE = A_MAX - A_MIN;

export function radiusToPxSize(radiusSolar: number): number {
  const a = Math.pow(radiusSolar, SIZE_EXP);
  const t = (a - A_MIN) / A_RANGE;
  const tc = Math.max(0, Math.min(1, t));
  return PX_MIN + tc * (PX_MAX - PX_MIN);
}

export const STARS: readonly Star[] = expandCoincidentSets(loadCatalog());

// =============================================================================
// Cluster detection
// =============================================================================

// Stars within this pairwise distance (ly) get grouped into a cluster, sharing
// one visible label, one selection reticle, and one dropline. Bumped from 0.20
// to 0.25 to comfortably contain Alpha Cen + Proxima after curation
// (Proxima now sits ~0.20 ly from AB instead of the source data's ~0.05 ly).
// Larger values risk over-clustering unrelated stars; smaller miss real
// hierarchical systems.
const CLUSTER_THRESHOLD_LY = 0.25;

export interface StarCluster {
  // Index into STARS of the heaviest member (the cluster's "primary").
  readonly primary: number;
  // All member star indices, primary first.
  readonly members: readonly number[];
  // Mass-weighted center of mass (Σmᵢ·rᵢ / Σmᵢ) in galactic ly, computed
  // once at module load. The selection reticle, dropline anchor, and
  // left-click focus animation all use this so a multi-star system reads
  // as one entity rather than as its individually-selectable members.
  // For single-member clusters, com === primary's position by construction.
  readonly com: { readonly x: number; readonly y: number; readonly z: number };
}

function buildClusters(): readonly StarCluster[] {
  const n = STARS.length;
  // Union-find so transitive closure handles chains (A near B, B near C → all one cluster).
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const t2 = CLUSTER_THRESHOLD_LY * CLUSTER_THRESHOLD_LY;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = STARS[i].x - STARS[j].x;
      const dy = STARS[i].y - STARS[j].y;
      const dz = STARS[i].z - STARS[j].z;
      if (dx * dx + dy * dy + dz * dz <= t2) {
        const ri = find(i), rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(i);
  }
  return Array.from(groups.values()).map(members => {
    // Primary = highest mass. Falls back to pxSize (i.e. radius) as a
    // tie-breaker (degenerate if two members have identical mass, which is
    // rare and visually-indistinguishable anyway).
    const primary = members.reduce(
      (best, m) => {
        const mm = STARS[m].mass, mb = STARS[best].mass;
        if (mm > mb) return m;
        if (mm < mb) return best;
        return STARS[m].pxSize > STARS[best].pxSize ? m : best;
      },
      members[0],
    );
    const ordered = [primary, ...members.filter(m => m !== primary)];
    // Mass-weighted COM. Mass is in solar masses; the absolute scale cancels
    // in the division, so we don't need to normalize. Single-member clusters
    // collapse to that member's position regardless of mass value.
    let sumM = 0, sumX = 0, sumY = 0, sumZ = 0;
    for (const m of ordered) {
      const s = STARS[m];
      sumM += s.mass;
      sumX += s.mass * s.x;
      sumY += s.mass * s.y;
      sumZ += s.mass * s.z;
    }
    const com = { x: sumX / sumM, y: sumY / sumM, z: sumZ / sumM };
    return { primary, members: ordered, com };
  });
}

export const STAR_CLUSTERS: readonly StarCluster[] = buildClusters();

const STAR_TO_CLUSTER = (() => {
  const m = new Int32Array(STARS.length);
  STAR_CLUSTERS.forEach((cluster, idx) => {
    for (const member of cluster.members) m[member] = idx;
  });
  return m;
})();

export function clusterIndexFor(starIdx: number): number {
  return STAR_TO_CLUSTER[starIdx];
}

// Curated waypoint stars — bright, well-known anchors distributed across the
// catalog's 0–50 ly range. The galaxy view fades their cluster labels in as
// the camera moves away from Sol, so the player has named landmarks to
// orient by once they've left home territory (every other label has been
// culled by the focus/camera-distance ramps in labels.ts by that point).
//
// Keyed by stable slug id rather than display name, so display-name edits
// (e.g. swapping "Alpha Piscis Austrini" → "Fomalhaut") don't break
// waypoint membership. The id matches the cluster *primary* — the heaviest
// member, which the label is anchored on.
export const WAYPOINT_STAR_IDS: ReadonlySet<string> = new Set([
  'sol',
  'altair',
  'vega',
  'arcturus',
  'pollux',
  'iota-persei',
  'eta-leporis',
  'nu-phoenicis',
  'fomalhaut-a'
]);
