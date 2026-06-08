// Synthetic Body records for the planet-test-grid view. The disc render is a
// pure function of a Body, so these hand-built bodies (5 composition columns × 6
// age rows = 30 cells) drive a clean visual sweep of how a FROZEN surface ages,
// and how that differs between an ICE-SHELL world and a ROCKY world wearing
// snow — without touching the catalog. Two axes are swept:
//
//   • columns → bulkWaterFraction  — the composition axis: rocky (≈0) → ice
//     shell (≈0.6). The renderer maps bulk water+volatile through a continuous
//     smoothstep (shellFraction, ICE_SHELL_LO/HI ≈ 0.05..0.45 in disc-palette),
//     so the LEFT columns read as rocky snowballs, the RIGHT columns as
//     ice-shell worlds (Europa/Callisto), and the MIDDLE columns blend the two
//     aging modes — a gradient across the row, not a switch. Surface ice
//     COVERAGE is held high (BASELINE.iceFraction) so every cell reads as fully
//     frozen and only the aging behaviour differs.
//   • rows → CONVENTIONAL age (0 fresh top → 1 ancient bottom). For an ice
//     shell that's the Europa→Callisto arc: bright clean ice + linea → dark
//     sublimation dust mantle with bright ice-floored craters. For a rocky
//     snowball it stays bright snow, just gaining dark rock-floored craters.
//
// Everything ELSE is pinned to one constant baseline so only the two swept axes
// move cell-to-cell. The resource pairing (silicate primary + metals secondary)
// is identical in every cell, so the dust-lag / regolith colour is constant. The
// disc id is shared across the whole grid (SHARED_DISC_ID), so the seeded
// crater/worley LAYOUT is byte-identical in every cell — as an axis ramps you
// watch the SAME field age, not a new random pattern.
//
// BULK_WATER_COLUMNS and AGE_ROWS are the intended edit point — re-aim the sweep
// by editing those two arrays (and GRID_COL_COUNT / GRID_ROW_COUNT to match).

import type {
  Body,
  SurfaceLiquidSpecies,
  SurfaceFrostSpecies,
  BiosphereArchetype,
  BiosphereComplexity,
} from '../../data/stars';
import { STARS } from '../../data/stars';
import { shellFractionFor } from '../system-diagram/disc-palette';

// 5 bulk-water (composition) columns × 6 age rows.
export const GRID_COL_COUNT = 5;
export const GRID_ROW_COUNT = 6;

export interface TestCell {
  body: Body;
  label: string;
}

// Sol's star index drives the ocean-color derivation (the renderer reads
// STARS[hostStarIdx]'s spectral SED), so every synthetic body must point at a
// real star. Fall back to 0 if Sol is somehow absent rather than emit -1.
const SOL_IDX = Math.max(0, STARS.findIndex((s) => s.id === 'sol'));

// Columns — bulkWaterFraction, the composition axis. The renderer ramps
// shellFraction over bulk water+volatile via a continuous smoothstep
// (ICE_SHELL_LO/HI ≈ 0.05..0.45 in disc-palette). These values are chosen to
// sample shellFraction EVENLY — with the baseline's ~0.005 bulk volatile they
// land at ≈ 0.0 / 0.25 / 0.50 / 0.75 / 1.0 — so reading left→right across a row
// steps the aging mode by an even quarter: a pure rocky snowball (col 0)
// continuously becomes a full Callisto-style ice shell (col 4), the blended
// middle on display rather than a hard regime boundary. Re-aim by inverting the
// smoothstep for the shellFraction targets you want.
export const BULK_WATER_COLUMNS: readonly number[] = [0.0, 0.176, 0.245, 0.314, 0.55];

// Rows — CONVENTIONAL surface age: 0.0 = freshly resurfaced (top) → 1.0 =
// ancient / unresurfaced (bottom), so the column reads as one body weathering
// downward (brilliant fresh ice → dark dusty cratered globe).
//
// IMPORTANT: the Body.surfaceAge FIELD is INVERTED from this — in the renderer
// surfaceAge 1.0 means young/recently-resurfaced and 0.0 means ancient (it's
// really "surface youth": crater density is (1 − surfaceAge)², linea fires on
// HIGH surfaceAge, relief survives on LOW). So each row stores
// surfaceAge = 1 − age, and the label shows the intuitive `age`.
export const AGE_ROWS: readonly number[] = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0];

// Constant rocky baseline shared by every cell. Deliberately dry (no ocean, no
// biosphere, a thin clear abiotic atmosphere, no cloud deck) so the disc's
// visible surface is the decoration sweep — craters, linea, ice caps — over a
// constant resource topo rather than being buried under water / biome / cloud.
//
// avgSurfaceTempK is pinned COLD (below the ICE_RELAX_T_LO ice-relaxation
// window in disc-palette) on purpose: warm-ice viscous relaxation scales relief
// erosion by iceFraction, which would flatten the terraced topo on the high-ice
// columns and confound the relief baseline across the ice axis. Holding the
// surface cold keeps relief a pure function of surfaceAge (the row axis), so
// every column shares one relief baseline and the decoration deltas read clean.
//
// resSilicates (primary, surface) + resMetals (secondary, subsurface) are the
// only non-zero deposits and are FIXED in every cell — so the topo colour is
// constant and the craters / linea always reveal the same metals subsurface
// against the same silicate ground.
const BASELINE: Body = {
  id: 'test-baseline',
  hostId: 'sol',
  kind: 'planet',
  formalName: 'Test Baseline',
  name: 'Test Baseline',
  source: 'procgen',
  hostStarIdx: SOL_IDX,
  hostBodyIdx: null,
  semiMajorAu: 1,
  formationAu: 1,
  eccentricity: 0.0167,
  inclinationDeg: 0,
  periodDays: 365.25,
  orbitalPhaseDeg: 90,
  rotationPeriodHours: 23.93,
  axialTiltDeg: 23.44,
  innerAu: null,
  outerAu: null,
  innerPlanetRadii: null,
  outerPlanetRadii: null,
  massEarth: 1,
  radiusEarth: 1,
  // bulkWaterFraction is swept per-cell (columns) — it drives the renderer's
  // shellFraction ramp; this is just the baseline default.
  bulkWaterFraction: 0.00023,
  bulkMetalFraction: 0.32,
  bulkVolatileFraction: 0.005,
  largestBodyKm: null,
  shepherdBodyIdx: null,
  // Cold surface — see the ice-relaxation note in the header comment.
  avgSurfaceTempK: 110,
  surfaceTempMinK: 95,
  surfaceTempMaxK: 125,
  // Surface ice coverage held HIGH for every cell so both regimes (rocky
  // snowball + ice shell) read as fully frozen discs and only the aging
  // behaviour differs across the grid. iceCoverageForFraction saturates by 0.75,
  // so 0.95 → a wholly frozen disc.
  iceFraction: 0.95,
  surfaceLiquidFraction: 0,
  surfaceLiquidSpecies: null as SurfaceLiquidSpecies | null,
  subsurfaceOceanSpecies: null as SurfaceLiquidSpecies | null,
  surfaceFrostSpecies: null as SurfaceFrostSpecies | null,
  carbonWorld: false,
  salinity: null,
  // surfaceAge is swept per-cell (rows); 0.5 is just the baseline default.
  surfaceAge: 0.5,
  magneticFieldGauss: 0.5,
  tectonicActivity: 0.8,
  surfaceRadiation: 0.0194,
  surfacePressureBar: 0.3,
  atm1: 'CO2',
  atm1Frac: 0.95,
  atm2: 'N2',
  atm2Frac: 0.04,
  atm3: 'Ar',
  atm3Frac: 0.01,
  // No cloud deck — a clear thin atmosphere keeps the decoration sweep visible.
  cloudLayers: [],
  surfaceOpacity: 1,
  hazeAerosols: {},
  dustStrength: 0,
  // Fixed two-resource pairing in EVERY cell: silicate surface + metals
  // subsurface, so the topo colour is constant and craters/linea reveal the
  // same metals subsurface against the same silicate ground.
  resMetals: 4,
  resSilicates: 6,
  resVolatiles: 0,
  resRareEarths: 0,
  resRadioactives: 0,
  resExotics: 0,
  bioticCarbonAqueous: 0,
  bioticSubsurfaceAqueous: 0,
  bioticAerial: null,
  bioticCryogenic: null,
  bioticSilicate: 0,
  bioticSulfur: 0,
  biosphereArchetype: null as BiosphereArchetype | null,
  biosphereComplexity: null as BiosphereComplexity | null,
  biosphereSurfaceImpact: 0,
  moons: [],
  ring: null,
};

// Build a Body from the constant baseline plus per-cell overrides. Pinned
// host/kind/source fields are reapplied after the spread so a caller can't
// accidentally detach a body from Sol's SED.
export function makeTestBody(overrides: Partial<Body>): Body {
  return {
    ...BASELINE,
    ...overrides,
    hostStarIdx: SOL_IDX,
    hostBodyIdx: null,
    kind: 'planet',
    source: 'procgen',
    moons: [],
    ring: null,
  };
}

// Every cell shares ONE disc id so the shader's per-body seed
// (hash32('disc:' + id) in disc-palette) is identical across the whole grid:
// the procedural texture LAYOUT — worley surface cells, crater + linea
// placement — stays fixed, so the only thing that changes cell-to-cell is the
// swept bulkWaterFraction / surfaceAge, not the seeded random pattern. That
// isolation is the point of the grid. Safe because the test view never picks or
// looks a body up by id.
const SHARED_DISC_ID = 'test-cell';

export function buildTestGrid(): TestCell[] {
  const cells: TestCell[] = [];
  // Row-major: index = row * GRID_COL_COUNT + col. Row 0 is the TOP row
  // (conventional age 0 → freshly resurfaced); col 0 the LEFT column
  // (bulk water 0 → rocky snowball).
  for (let row = 0; row < GRID_ROW_COUNT; row++) {
    const age = AGE_ROWS[row];          // conventional: 0 fresh → 1 ancient
    const surfaceAge = 1 - age;         // field is inverted (high = young)
    for (let col = 0; col < GRID_COL_COUNT; col++) {
      const bulkWaterFraction = BULK_WATER_COLUMNS[col];
      const base = makeTestBody({
        id: SHARED_DISC_ID,
        hostId: 'sol',
        bulkWaterFraction,
        surfaceAge,
      });
      // Caption by shellFraction (0→100) — the axis that actually drives the
      // disc's aging, derived through the same disc-palette ramp the renderer
      // uses — so the column reads as the 0→1 ice-shell sweep you see, not the
      // raw bulkWater input. Re-apply the label to name/formalName via a spread
      // since Body is readonly.
      const label = `shell${Math.round(shellFractionFor(base) * 100)} age${age.toFixed(1)}`;
      const body: Body = { ...base, name: label, formalName: label };
      cells.push({ body, label });
    }
  }
  return cells;
}
