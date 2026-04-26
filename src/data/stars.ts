import { Color } from 'three';

export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'WD' | 'BD';

export interface Star {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cls: SpectralClass;
  readonly distLy: number;
}

type StarTuple = readonly [string, number, number, number, SpectralClass, number];

// Positions in galactic cartesian coords (ly): x toward galactic centre,
// z toward north galactic pole. Approximated from known distances / RA-Dec
// for the solar neighbourhood (< ~0.5 ly accuracy — fine for visualization).
const RAW_STARS: readonly StarTuple[] = [
  ['Sun',                 0.00,  0.00,   0.00, 'G',   0.00],
  ['Proxima Centauri',   -1.68, -1.37,  -3.83, 'M',   4.24],
  ['Alpha Cen A',        -1.71, -1.40,  -3.83, 'G',   4.37],
  ['Alpha Cen B',        -1.71, -1.40,  -3.83, 'K',   4.37],
  ["Barnard's Star",      5.07,  2.19,   2.60, 'M',   5.96],
  ['Luhman 16',          -5.36, -3.35,  -1.27, 'BD',  6.50],
  ['Wolf 359',           -1.87,  7.21,  -1.54, 'M',   7.86],
  ['Lalande 21185',      -6.47,  1.14,   4.81, 'M',   8.29],
  ['Sirius A',            1.93,  8.07,  -2.47, 'A',   8.60],
  ['Sirius B',            1.93,  8.07,  -2.47, 'WD',  8.60],
  ['Luyten 726-8 A',      6.25, -4.83,  -5.46, 'M',   8.73],
  ['Luyten 726-8 B',      6.25, -4.83,  -5.46, 'M',   8.73],
  ['Ross 154',            8.52,  0.64,  -2.70, 'M',   9.69],
  ['Ross 248',            7.40, -0.34,   6.52, 'M',  10.30],
  ['Epsilon Eridani',     3.28, -8.13,  -5.35, 'K',  10.50],
  ['Lacaille 9352',       8.51, -2.60,  -6.45, 'M',  10.74],
  ['Ross 128',           -5.43,  6.40,   6.60, 'M',  11.03],
  ['EZ Aquarii',          9.40, -2.84,  -5.95, 'M',  11.27],
  ['Procyon A',          -4.76,  9.88,   1.39, 'F',  11.40],
  ['Procyon B',          -4.76,  9.88,   1.39, 'WD', 11.40],
  ['61 Cygni A',          6.47,  3.03,   9.00, 'K',  11.40],
  ['61 Cygni B',          6.47,  3.03,   9.00, 'K',  11.40],
  ['Struve 2398 A',       3.31,  4.01,  10.73, 'M',  11.53],
  ['Struve 2398 B',       3.31,  4.01,  10.73, 'M',  11.53],
  ['Groombridge 34 A',    1.22, -0.54,  11.70, 'M',  11.62],
  ['Groombridge 34 B',    1.22, -0.54,  11.70, 'M',  11.62],
  ['DX Cancri',          -4.29,  9.90,   4.85, 'M',  11.68],
  ['Epsilon Indi',        8.80, -5.54,  -5.56, 'K',  11.82],
  ['Tau Ceti',            3.53, -9.61,  -5.45, 'G',  11.91],
  ['GJ 1061',            -2.55, -1.52, -11.68, 'M',  12.04],
  ['YZ Ceti',             6.08, -6.45,  -8.06, 'M',  12.13],
  ["Luyten's Star",      -6.44,  9.98,   1.22, 'M',  12.36],
  ["Teegarden's Star",    9.06,  5.82,  -5.05, 'M',  12.50],
  ['SCR 1845-6357',       8.68, -2.80,  -8.79, 'M',  12.57],
  ["Kapteyn's Star",      6.49, -2.62, -10.81, 'M',  12.76],
  ['Lacaille 8760',       9.38, -3.95,  -7.54, 'M',  12.87],
  ['Kruger 60 A',         4.89,  1.37,  11.96, 'M',  13.15],
  ['Kruger 60 B',         4.89,  1.37,  11.96, 'M',  13.15],
  ['DENIS 1048-39',      -9.76,  5.76,  -5.30, 'M',  13.20],
  ['Ross 614 A',         -5.68,  8.02,  -9.21, 'M',  13.40],
  ['Ross 614 B',         -5.68,  8.02,  -9.21, 'M',  13.40],
  ['Wolf 1061',           4.73,  2.72,  12.87, 'M',  14.05],
  ["van Maanen's Star",   5.23, -6.49, -11.01, 'WD', 14.07],
  ['Gliese 1',            4.14, -5.37, -12.30, 'M',  14.22],
  ['Wolf 424 A',         -4.58, 11.80,   6.94, 'M',  14.31],
  ['Wolf 424 B',         -4.58, 11.80,   6.94, 'M',  14.31],
  ['TZ Arietis',         -2.12,  9.99, -10.47, 'M',  14.60],
  ['Gliese 687',          6.09,  4.94,  12.26, 'M',  14.79],
  ['LHS 292',            -7.27,  7.05,  -9.95, 'M',  14.80],
  ['Gliese 674',          7.50,  3.98, -11.70, 'M',  14.80],
  ['Gliese 440 (WD)',    -9.56,  5.81,  -8.87, 'WD', 15.10],
  ['GJ 1245 A',           4.68,  4.27,  13.70, 'M',  15.20],
  ['GJ 1245 B',           4.68,  4.27,  13.70, 'M',  15.20],
  ['Gliese 876',          5.63, -7.58, -11.42, 'M',  15.30],
  ['LHS 288',            -4.52,  1.24, -14.55, 'M',  15.60],
  ['Gliese 412 A',      -11.48,  7.65,   7.38, 'M',  15.83],
  ['Gliese 412 B',      -11.48,  7.65,   7.38, 'M',  15.83],
  ['Groombridge 1618',   -9.15,  6.58,  11.03, 'K',  15.89],
  ['AD Leonis',          -8.24, 12.42,   4.43, 'M',  16.19],
  ['Gliese 832',          9.42, -4.30, -12.33, 'M',  16.20],
  ['DEN 0255-4700',       6.41, -9.87, -10.82, 'BD', 16.20],
  ['GJ 1116 A',          -9.38, 12.60,   3.12, 'M',  16.30],
  ['GJ 1116 B',          -9.38, 12.60,   3.12, 'M',  16.30],
  ['Gliese 581',          6.54,  5.71, -13.81, 'M',  16.30],
  ['40 Eridani A',       -2.22, -4.21, -15.59, 'K',  16.30],
  ['40 Eridani B',       -2.22, -4.21, -15.59, 'WD', 16.30],
  ['40 Eridani C',       -2.22, -4.21, -15.59, 'M',  16.30],
  ['EV Lacertae',         7.28,  3.15,  14.49, 'M',  16.47],
  ['70 Ophiuchi A',      10.78, -2.05,  12.48, 'K',  16.60],
  ['70 Ophiuchi B',      10.78, -2.05,  12.48, 'K',  16.60],
  ['Altair',             12.95,  2.56,   9.93, 'A',  16.73],
  ['Gliese 1002',        -6.72,-11.17, -11.04, 'M',  16.00],
  ['EI Cancri',         -10.96, 12.82,   3.46, 'M',  17.10],
  ['Gliese 570 A',       12.52,  1.97, -11.65, 'K',  17.20],
  ['Gliese 570 B',       12.52,  1.97, -11.65, 'M',  17.20],
  ['Gliese 570 C',       12.52,  1.97, -11.65, 'M',  17.20],
  ['Gliese 169.1 A',    -10.47,  6.90,  11.95, 'M',  17.52],
  ['Gliese 783 A',       10.16, -1.09, -14.57, 'K',  17.62],
  ['Gliese 783 B',       10.16, -1.09, -14.57, 'M',  17.62],
  ['Gliese 892',          3.90,  4.08,  16.94, 'K',  17.72],
  ['Eta Cassiopeiae A',   0.15,  6.10,  16.97, 'G',  19.42],
  ['Eta Cassiopeiae B',   0.15,  6.10,  16.97, 'K',  19.42],
  ['36 Ophiuchi A',      14.04, -2.20,  11.96, 'K',  19.48],
  ['36 Ophiuchi B',      14.04, -2.20,  11.96, 'K',  19.48],
  ['36 Ophiuchi C',      14.04, -2.20,  11.96, 'K',  19.48],
  ['HR 7703 A',          13.85, -3.22, -11.72, 'K',  19.62],
  ['HR 7703 B',          13.85, -3.22, -11.72, 'M',  19.62],
  ['82 Eridani',         -3.85, -9.38, -16.38, 'G',  19.71],
  ['Delta Pavonis',       8.24, -5.19, -17.25, 'G',  19.92],
  ['Sigma Draconis',      3.27,  0.72,  18.58, 'K',  18.77],
  ['Gliese 33',           3.06, -8.14, -13.83, 'K',  17.42],
  ['Gliese 205',         -9.21, 11.86,  -7.18, 'M',  18.50],
  ['Gliese 250 A',       -8.74, 13.90,  -6.72, 'K',  18.70],
  ['Gliese 250 B',       -8.74, 13.90,  -6.72, 'M',  18.70],
  ['Gliese 229 A',       -5.50, 11.79, -12.47, 'M',  18.79],
  ['Gliese 229 B',       -5.50, 11.79, -12.47, 'BD', 18.79],
  ['Gliese 693',          8.50,  4.12, -15.42, 'M',  19.03],
];

export const STARS: readonly Star[] = RAW_STARS.map(([name, x, y, z, cls, distLy]) => ({
  name, x, y, z, cls, distLy,
}));

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

// Reference radii in solar radii (R☉). Real stellar radii span ~6 orders of
// magnitude (WD ≈ 0.01, supergiant > 1000), so the shader uses log10 to map
// them into a readable visual range.
const CLASS_RADIUS: Record<SpectralClass, number> = {
  O: 10.0, B: 4.0, A: 1.7, F: 1.3, G: 1.0,
  K: 0.7,  M: 0.3, WD: 0.01, BD: 0.1,
};

// Visual size attribute for the stars shader. Shifted+scaled so the Sun
// (R=1) lands at ~4.4 shader units (matching the original Sun size); the
// shader then clamps the final pixel size to [2, 28].
export const CLASS_SIZE: Record<SpectralClass, number> = Object.fromEntries(
  Object.entries(CLASS_RADIUS).map(([cls, r]) => [cls, 4.4 + Math.log10(r) * 1.6]),
) as Record<SpectralClass, number>;
