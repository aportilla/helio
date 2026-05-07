import { Color } from 'three';

export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'WD' | 'BD';

export interface Star {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cls: SpectralClass;
  // Catalog-stated distance from Sun in ly. Used as a label/reference; may
  // differ slightly from sqrt(x²+y²+z²) after curation/post-processing —
  // we treat distLy as authoritative for display, position as approximate.
  readonly distLy: number;
  // Solar masses. Used for primary determination within a cluster
  // (heaviest member becomes the label anchor) and for mass-weighted
  // barycenters in the post-processor. Approximate (catalog quality).
  readonly mass: number;
  // Stellar radius in solar radii (R☉). Measured where available
  // (interferometry, eclipsing binaries, asteroseismology, Chandrasekhar
  // mass-radius for white dwarfs); main-sequence-relation estimate
  // otherwise. The visualization-side pxSize is derived from this.
  readonly radiusSolar: number;
  // Reference visual disc size in pixels at the default zoom (the shader
  // applies depth-attenuation on top of this). Computed from radiusSolar
  // at module load via a log mapping — see radiusToPxSize.
  readonly pxSize: number;
}

type StarTuple = readonly [string, number, number, number, SpectralClass, number, number, number];

// =============================================================================
// RAW_STARS — catalog tuple [name, x, y, z, class, distLy, mass]
// =============================================================================
//
// Coordinate system: galactic Cartesian (ly). +X toward galactic centre,
// +Z toward north galactic pole. Positions accurate to ~0.5 ly — fine for
// visualization, not navigation.
//
// MULTI-STAR SYSTEMS — curation philosophy
// ----------------------------------------
// Most binary/triple systems in source catalogs share identical Cartesian
// coordinates because the inter-member separation (10-1000 AU = 0.0002-0.02
// ly) is far below our 0.01-ly precision. Two layered mechanisms make those
// systems read correctly at zoom-in:
//
// 1. AUTOMATIC ring distribution. The post-processor (`expandCoincidentSets`
//    below) detects any 2+ stars at effectively-identical positions and
//    distributes them on a small 3D circle of radius MIN_VIS_LY. The ring
//    plane and starting phase are seeded from the primary's name, so each
//    system gets its own orientation in space (no two binaries read as
//    matching horizontal sausages from a top-down view) but every system
//    is stable across reloads. Mass-sorted member ordering is preserved.
//
// 2. MANUAL hierarchy. For systems with known internal hierarchy (a primary
//    plus a wider companion or sub-pair), member positions in this table
//    are nudged to encode that hierarchy. Marked with `// CURATED:` notes.
//    The post-processor still rings any remaining coincident members within
//    those systems, so e.g. 40 Eri's BC sub-pair stays a tight pair while
//    A sits clearly apart.
//
// FUTURE CURATION — guidance
// --------------------------
// Adding stars: append to the tuple list with [name, x, y, z, class, distLy,
// mass, radiusSolar]. Mass values are approximate; ±20% is fine. Radius is
// in solar radii — use a measured value where available, otherwise estimate
// from class (M dwarfs ~0.10–0.50, K dwarfs ~0.6–0.85, G dwarfs ~0.85–1.05,
// F dwarfs ~1.3–1.6, A dwarfs ~1.6–2.0, white dwarfs ~0.008–0.014, brown
// dwarfs ~0.10). If two members share coordinates, that's expected — the
// post-processor handles it.
//
// Encoding hierarchy: if a known multi-system has a primary plus a wider
// companion (or a tight sub-pair), give the wider member a position offset
// from the primary by ~0.08-0.20 ly along any direction. Magnitude reflects
// rough visual hierarchy (tight pair = ~0.08, wider companion = ~0.15-0.20),
// not the literal real-world separation (which is sub-resolution anyway).
// Document the choice with a `// CURATED:` comment so future editors know
// it's a deliberate visualization choice, not a measured position.
//
// Cluster grouping: stars within CLUSTER_THRESHOLD_LY (0.25) are grouped
// into one labelled cluster. If you curate a wide companion at distance > the
// threshold, it'll appear as a separate cluster — adjust the offset down or
// the threshold up to keep them grouped.

const RAW_STARS: readonly StarTuple[] = [
  ['Sun',                  0.000,  0.000,   0.000, 'G',   0.00, 1.00,    1.000  ],
  // CURATED: Proxima moved out from the AB pair to ~0.20 ly distance.
  // Source data placed it at 0.045 ly from AB; the true astronomical value
  // is ~0.21 ly. Direction follows the original AB→Proxima vector.
  ['Proxima Centauri',    -1.569, -1.259,  -3.830, 'M',   4.24, 0.122,   0.145  ],
  ['Alpha Cen A',         -1.710, -1.400,  -3.830, 'G',   4.37, 1.10,    1.224  ],
  ['Alpha Cen B',         -1.710, -1.400,  -3.830, 'K',   4.37, 0.91,    0.863  ],
  ["Barnard's Star",       5.070,  2.190,   2.600, 'M',   5.96, 0.144,   0.196  ],
  ['Luhman 16',           -5.360, -3.350,  -1.270, 'BD',  6.50, 0.034,   0.100  ],
  ['Wolf 359',            -1.870,  7.210,  -1.540, 'M',   7.86, 0.090,   0.144  ],
  ['Lalande 21185',       -6.470,  1.140,   4.810, 'M',   8.29, 0.39,    0.392  ],
  ['Sirius A',             1.930,  8.070,  -2.470, 'A',   8.60, 2.06,    1.711  ],
  ['Sirius B',             1.930,  8.070,  -2.470, 'WD',  8.60, 1.02,    0.0084 ],
  ['Luyten 726-8 A',       6.250, -4.830,  -5.460, 'M',   8.73, 0.10,    0.140  ],
  ['Luyten 726-8 B',       6.250, -4.830,  -5.460, 'M',   8.73, 0.10,    0.140  ],
  ['Ross 154',             8.520,  0.640,  -2.700, 'M',   9.69, 0.17,    0.240  ],
  ['Ross 248',             7.400, -0.340,   6.520, 'M',  10.30, 0.136,   0.160  ],
  ['Epsilon Eridani',      3.280, -8.130,  -5.350, 'K',  10.50, 0.82,    0.735  ],
  ['Lacaille 9352',        8.510, -2.600,  -6.450, 'M',  10.74, 0.50,    0.474  ],
  ['Ross 128',            -5.430,  6.400,   6.600, 'M',  11.03, 0.17,    0.197  ],
  ['EZ Aquarii',           9.400, -2.840,  -5.950, 'M',  11.27, 0.10,    0.175  ],
  ['Procyon A',           -4.760,  9.880,   1.390, 'F',  11.40, 1.50,    2.048  ],
  ['Procyon B',           -4.760,  9.880,   1.390, 'WD', 11.40, 0.60,    0.012  ],
  ['61 Cygni A',           6.470,  3.030,   9.000, 'K',  11.40, 0.70,    0.665  ],
  ['61 Cygni B',           6.470,  3.030,   9.000, 'K',  11.40, 0.63,    0.595  ],
  ['Struve 2398 A',        3.310,  4.010,  10.730, 'M',  11.53, 0.39,    0.350  ],
  ['Struve 2398 B',        3.310,  4.010,  10.730, 'M',  11.53, 0.32,    0.300  ],
  ['Groombridge 34 A',     1.220, -0.540,  11.700, 'M',  11.62, 0.41,    0.380  ],
  ['Groombridge 34 B',     1.220, -0.540,  11.700, 'M',  11.62, 0.16,    0.160  ],
  ['DX Cancri',           -4.290,  9.900,   4.850, 'M',  11.68, 0.087,   0.110  ],
  ['Epsilon Indi',         8.800, -5.540,  -5.560, 'K',  11.82, 0.76,    0.711  ],
  ['Tau Ceti',             3.530, -9.610,  -5.450, 'G',  11.91, 0.78,    0.793  ],
  ['GJ 1061',             -2.550, -1.520, -11.680, 'M',  12.04, 0.12,    0.156  ],
  ['YZ Ceti',              6.080, -6.450,  -8.060, 'M',  12.13, 0.13,    0.168  ],
  ["Luyten's Star",       -6.440,  9.980,   1.220, 'M',  12.36, 0.26,    0.350  ],
  ["Teegarden's Star",     9.060,  5.820,  -5.050, 'M',  12.50, 0.090,   0.107  ],
  ['SCR 1845-6357',        8.680, -2.800,  -8.790, 'M',  12.57, 0.075,   0.100  ],
  ["Kapteyn's Star",       6.490, -2.620, -10.810, 'M',  12.76, 0.281,   0.291  ],
  ['Lacaille 8760',        9.380, -3.950,  -7.540, 'M',  12.87, 0.60,    0.510  ],
  ['Kruger 60 A',          4.890,  1.370,  11.960, 'M',  13.15, 0.27,    0.350  ],
  ['Kruger 60 B',          4.890,  1.370,  11.960, 'M',  13.15, 0.18,    0.240  ],
  ['DENIS 1048-39',       -9.760,  5.760,  -5.300, 'M',  13.20, 0.080,   0.100  ],
  ['Ross 614 A',          -5.680,  8.020,  -9.210, 'M',  13.40, 0.22,    0.270  ],
  ['Ross 614 B',          -5.680,  8.020,  -9.210, 'M',  13.40, 0.11,    0.130  ],
  ['Wolf 1061',            4.730,  2.720,  12.870, 'M',  14.05, 0.30,    0.307  ],
  ["van Maanen's Star",    5.230, -6.490, -11.010, 'WD', 14.07, 0.68,    0.0094 ],
  ['Gliese 1',             4.140, -5.370, -12.300, 'M',  14.22, 0.45,    0.480  ],
  ['Wolf 424 A',          -4.580, 11.800,   6.940, 'M',  14.31, 0.143,   0.170  ],
  ['Wolf 424 B',          -4.580, 11.800,   6.940, 'M',  14.31, 0.131,   0.160  ],
  ['TZ Arietis',          -2.120,  9.990, -10.470, 'M',  14.60, 0.13,    0.160  ],
  ['Gliese 687',           6.090,  4.940,  12.260, 'M',  14.79, 0.40,    0.420  ],
  ['LHS 292',             -7.270,  7.050,  -9.950, 'M',  14.80, 0.080,   0.110  ],
  ['Gliese 674',           7.500,  3.980, -11.700, 'M',  14.80, 0.35,    0.370  ],
  ['Gliese 440 (WD)',     -9.560,  5.810,  -8.870, 'WD', 15.10, 0.62,    0.0130 ],
  ['GJ 1245 A',            4.680,  4.270,  13.700, 'M',  15.20, 0.12,    0.140  ],
  ['GJ 1245 B',            4.680,  4.270,  13.700, 'M',  15.20, 0.12,    0.130  ],
  ['Gliese 876',           5.630, -7.580, -11.420, 'M',  15.30, 0.37,    0.376  ],
  ['LHS 288',             -4.520,  1.240, -14.550, 'M',  15.60, 0.10,    0.130  ],
  ['Gliese 412 A',       -11.480,  7.650,   7.380, 'M',  15.83, 0.48,    0.390  ],
  ['Gliese 412 B',       -11.480,  7.650,   7.380, 'M',  15.83, 0.10,    0.130  ],
  ['Groombridge 1618',    -9.150,  6.580,  11.030, 'K',  15.89, 0.66,    0.620  ],
  ['AD Leonis',           -8.240, 12.420,   4.430, 'M',  16.19, 0.42,    0.390  ],
  ['Gliese 832',           9.420, -4.300, -12.330, 'M',  16.20, 0.45,    0.480  ],
  ['DEN 0255-4700',        6.410, -9.870, -10.820, 'BD', 16.20, 0.025,   0.090  ],
  ['GJ 1116 A',           -9.380, 12.600,   3.120, 'M',  16.30, 0.10,    0.120  ],
  ['GJ 1116 B',           -9.380, 12.600,   3.120, 'M',  16.30, 0.10,    0.110  ],
  ['Gliese 581',           6.540,  5.710, -13.810, 'M',  16.30, 0.31,    0.299  ],
  // CURATED: 40 Eridani is a hierarchical triple — A is the K-type primary,
  // BC is a tight WD+M sub-pair (~400 AU). Source had ABC all coincident;
  // BC pair offset by 0.08 ly in +y so the A-vs-BC hierarchy reads at zoom-in.
  ['40 Eridani A',        -2.220, -4.210, -15.590, 'K',  16.30, 0.84,    0.812  ],
  ['40 Eridani B',        -2.220, -4.130, -15.590, 'WD', 16.30, 0.57,    0.0140 ],
  ['40 Eridani C',        -2.220, -4.130, -15.590, 'M',  16.30, 0.20,    0.310  ],
  ['EV Lacertae',          7.280,  3.150,  14.490, 'M',  16.47, 0.32,    0.360  ],
  ['70 Ophiuchi A',       10.780, -2.050,  12.480, 'K',  16.60, 0.89,    0.860  ],
  ['70 Ophiuchi B',       10.780, -2.050,  12.480, 'K',  16.60, 0.71,    0.660  ],
  ['Altair',              12.950,  2.560,   9.930, 'A',  16.73, 1.79,    1.790  ],
  ['Gliese 1002',         -6.720,-11.170, -11.040, 'M',  16.00, 0.12,    0.137  ],
  ['EI Cancri',          -10.960, 12.820,   3.460, 'M',  17.10, 0.17,    0.180  ],
  // CURATED: Gliese 570 — A is the K primary, BC is a tight M+M sub-pair.
  // Source had ABC coincident; BC offset by 0.08 ly in +y for hierarchy.
  ['Gliese 570 A',        12.520,  1.970, -11.650, 'K',  17.20, 0.80,    0.740  ],
  ['Gliese 570 B',        12.520,  2.050, -11.650, 'M',  17.20, 0.55,    0.460  ],
  ['Gliese 570 C',        12.520,  2.050, -11.650, 'M',  17.20, 0.16,    0.180  ],
  ['Gliese 169.1 A',     -10.470,  6.900,  11.950, 'M',  17.52, 0.39,    0.420  ],
  ['Gliese 783 A',        10.160, -1.090, -14.570, 'K',  17.62, 0.79,    0.710  ],
  ['Gliese 783 B',        10.160, -1.090, -14.570, 'M',  17.62, 0.14,    0.160  ],
  ['Gliese 892',           3.900,  4.080,  16.940, 'K',  17.72, 0.79,    0.690  ],
  ['Eta Cassiopeiae A',    0.150,  6.100,  16.970, 'G',  19.42, 0.97,    1.040  ],
  ['Eta Cassiopeiae B',    0.150,  6.100,  16.970, 'K',  19.42, 0.57,    0.660  ],
  // CURATED: 36 Ophiuchi — AB is the tight K+K binary, C is a wider K
  // companion. Source had ABC coincident; C offset by 0.10 ly in +y so the
  // AB-vs-C hierarchy reads at zoom-in. AB stay coincident (post-processor
  // rings them). Component A carries the IAU-approved proper name
  // "Guniibuu" (Kamilaroi/Euahlayi, "robin red-breast"); B and C retain
  // their Flamsteed designations since neither has a proper name. Per
  // Wikipedia, the three masses (A 0.75, B 0.76, C 0.72 M☉) are within
  // measurement noise of each other; A and B are swapped here (0.76/0.75)
  // so A stays the cluster primary — every popular reference calls it
  // "36 Oph A" / "Guniibuu", and surfacing B as the label would feel wrong.
  ['Guniibuu',            14.040, -2.200,  11.960, 'K',  19.42, 0.76,    0.690  ],
  ['36 Ophiuchi B',       14.040, -2.200,  11.960, 'K',  19.42, 0.75,    0.680  ],
  ['36 Ophiuchi C',       14.040, -2.100,  11.960, 'K',  19.42, 0.72,    0.650  ],
  ['HR 7703 A',           13.850, -3.220, -11.720, 'K',  19.62, 0.79,    0.710  ],
  ['HR 7703 B',           13.850, -3.220, -11.720, 'M',  19.62, 0.20,    0.200  ],
  ['82 Eridani',          -3.850, -9.380, -16.380, 'G',  19.71, 0.93,    0.940  ],
  ['Delta Pavonis',        8.240, -5.190, -17.250, 'G',  19.92, 0.99,    1.220  ],
  ['Sigma Draconis',       3.270,  0.720,  18.580, 'K',  18.77, 0.81,    0.778  ],
  ['Gliese 33',            3.060, -8.140, -13.830, 'K',  17.42, 0.78,    0.790  ],
  ['Gliese 205',          -9.210, 11.860,  -7.180, 'M',  18.50, 0.63,    0.550  ],
  ['Gliese 250 A',        -8.740, 13.900,  -6.720, 'K',  18.70, 0.55,    0.590  ],
  ['Gliese 250 B',        -8.740, 13.900,  -6.720, 'M',  18.70, 0.18,    0.180  ],
  ['Gliese 229 A',        -5.500, 11.790, -12.470, 'M',  18.79, 0.50,    0.450  ],
  ['Gliese 229 B',        -5.500, 11.790, -12.470, 'BD', 18.79, 0.05,    0.100  ],
  ['Gliese 693',           8.500,  4.120, -15.420, 'M',  19.03, 0.27,    0.300  ],
];

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

// FNV-1a 32-bit string hash. Used to seed mulberry32 so each multi-star
// system gets its own deterministic ring orientation. Cheap, stable across
// runs and platforms — we don't need cryptographic quality, just consistent
// bucketing of strings → 32-bit ints.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

// Mulberry32 PRNG. Tiny, fast, and good enough for picking ring orientation
// once per system at module load. Seeded from the primary's name hash so
// every reload puts the binary in the same place — no frame-to-frame jitter,
// no Heisenberg-style "looks different every time you load the page".
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
    const rng = mulberry32(hash32(stars[set[0]].name));
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

const RAW_STAR_OBJECTS: Star[] = RAW_STARS.map(
  ([name, x, y, z, cls, distLy, mass, radiusSolar]) => ({
    name, x, y, z, cls, distLy, mass, radiusSolar,
    pxSize: radiusToPxSize(radiusSolar),
  }),
);

export const STARS: readonly Star[] = expandCoincidentSets(RAW_STAR_OBJECTS);

// =============================================================================
// Cluster detection
// =============================================================================

// Stars within this pairwise distance (ly) get grouped into a cluster, sharing
// one visible label and a multi-line hover tooltip listing every member. Bumped
// from 0.20 to 0.25 to comfortably contain Alpha Cen + Proxima after curation
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
