// Synthetic Body records for the planet-test-grid view. The disc render is a
// pure function of a Body, so these hand-built bodies (5 resource columns × 5
// abundance rows, plus a 6th water-coverage row = 30 cells) drive a visual sweep
// without touching the catalog: every resource cell carries a FIXED mid-
// abundance silicate deposit, and each column sweeps a DIFFERENT second resource
// (metals, volatiles, rare-earths, radioactives, exotics) across the abundance
// tiers (rows) against that constant silicate partner — so the grid reads the
// two-resource pairing (blend + stain + shore) against one stable baseline. The
// varied resource crosses silicate's abundance between t2 and t3, so the
// dominant slot flips mid-column — exercising the high/low handling both ways.
// The bottom row sweeps ocean coverage over one fixed land topology.
//
// GRID_COLUMNS and GRID_ROWS are the intended edit point — re-aim the sweep by
// editing those two arrays. Everything else stays pinned to an Earth-like
// terrestrial baseline so the shader never hits a divide-by / index-by-null
// case; only the six res* fields vary across cells.

import type {
  Body,
  SurfaceLiquidSpecies,
  SurfaceFrostSpecies,
  BiosphereArchetype,
  BiosphereComplexity,
} from '../../data/stars';
import { STARS } from '../../data/stars';

export const GRID_COL_COUNT = 5;
// 5 resource-sweep rows (GRID_ROWS) + 1 water-coverage sweep row at the bottom.
export const GRID_ROW_COUNT = 6;

export interface TestCell {
  body: Body;
  label: string;
}

// Sol's star index drives the ocean-color derivation (the renderer reads
// STARS[hostStarIdx]'s spectral SED), so every synthetic body must point at a
// real star. Fall back to 0 if Sol is somehow absent rather than emit -1.
const SOL_IDX = Math.max(0, STARS.findIndex((s) => s.id === 'sol'));

// The six resource fields in fixed order, so a column spec can name archetypes
// by key and the cell builder can floor the rest uniformly.
type ResKey =
  | 'resMetals'
  | 'resSilicates'
  | 'resVolatiles'
  | 'resRareEarths'
  | 'resRadioactives'
  | 'resExotics';

const RES_KEYS: readonly ResKey[] = [
  'resMetals',
  'resSilicates',
  'resVolatiles',
  'resRareEarths',
  'resRadioactives',
  'resExotics',
];

// Fixed partner deposit present in EVERY cell: mid-abundance silicate (5 on the
// 0..10 scale → abundance 0.5). Columns sweep a DIFFERENT resource against this
// constant silicate background, so the grid reads the two-resource pairing
// against one stable partner rather than varying both axes at once.
const SILICATE_FIXED = 5;

interface ColumnSpec {
  // The VARIED resource this column sweeps across the rows (never silicate — the
  // silicate partner is the fixed background in every cell).
  readonly archetype: ResKey;
  // Short stem composed into the per-cell label (≤ ~9 chars to leave room for
  // the tier suffix under a disc).
  readonly stem: string;
}

// One column per non-silicate resource — each swept against the fixed silicate.
export const GRID_COLUMNS: readonly ColumnSpec[] = [
  { archetype: 'resMetals',       stem: 'metals' },
  { archetype: 'resVolatiles',    stem: 'volatile' },
  { archetype: 'resRareEarths',   stem: 'rareEarth' },
  { archetype: 'resRadioactives', stem: 'radioact' },
  { archetype: 'resExotics',      stem: 'exotic' },
];

interface RowSpec {
  // Value (on the 0..10 res* scale) the VARIED resource takes at this tier —
  // abundance 0.2 → 1.0, swept against the fixed mid silicate (0.5).
  readonly level: number;
  // Short tier marker composed into the label.
  readonly mark: string;
}

// Abundance tiers for the varied resource, trace → motherlode, on the 0..10
// scale. Silicate (0.5) sits between t2 (0.4) and t3 (0.6), so the dominant
// resource flips from silicate to the varied one across that boundary.
export const GRID_ROWS: readonly RowSpec[] = [
  { level: 2,  mark: 't1' }, // trace
  { level: 4,  mark: 't2' }, // sparse
  { level: 6,  mark: 't3' }, // moderate
  { level: 8,  mark: 't4' }, // rich
  { level: 10, mark: 't5' }, // motherlode
];

// Water-coverage sweep — the extra BOTTOM row. Every cell carries the SAME land
// (fixed silicate + metals, both mid, so the disc splits ~50/50 Uplands/
// Lowlands) under increasing ocean cover, so the zone-biased liquid fill reads
// across coverage percentages on one fixed topology: water pools in the
// Lowlands first and climbs into the Uplands as coverage rises.
export const WATER_ROW_COVERAGE: readonly number[] = [0.2, 0.4, 0.6, 0.8, 1.0];

// Generic dry rocky-world baseline. Deliberately NOT Earth-like: no surface
// ocean, no biosphere, a thin abiotic atmosphere, and no cloud deck — so the
// disc's visible surface is the swept resource mineralogy rather than being
// buried under blue water + green biome. Every required Body field carries a
// real value; cells override only id/name/formalName and the six res* fields.
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
  bulkWaterFraction: 0.00023,
  bulkMetalFraction: 0.32,
  bulkVolatileFraction: 0.005,
  largestBodyKm: null,
  shepherdBodyIdx: null,
  avgSurfaceTempK: 288,
  surfaceTempMinK: 184,
  surfaceTempMaxK: 330,
  waterFraction: 0,
  iceFraction: 0,
  surfaceLiquidFraction: 0,
  surfaceLiquidSpecies: null as SurfaceLiquidSpecies | null,
  subsurfaceOceanSpecies: null as SurfaceLiquidSpecies | null,
  surfaceFrostSpecies: null as SurfaceFrostSpecies | null,
  carbonWorld: false,
  salinity: null,
  surfaceAge: 0.7,
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
  // No cloud deck — a clear thin atmosphere keeps the resource-driven surface
  // fully visible across the sweep.
  cloudLayers: [],
  surfaceOpacity: 1,
  hazeAerosols: {},
  dustStrength: 0,
  resMetals: 5,
  resSilicates: 6,
  resVolatiles: 7,
  resRareEarths: 5,
  resRadioactives: 4,
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

// Build a Body from the dry rocky baseline plus per-cell overrides. Pinned
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

// Six res* fields for a cell: a fixed mid silicate partner in every cell, plus
// the column's varied resource swept by `level`; everything else zero. So each
// cell is exactly two resources — constant silicate + the column's sweep.
function cellResources(column: ColumnSpec, row: RowSpec): Pick<Body, ResKey> {
  const out = {} as Record<ResKey, number>;
  for (const key of RES_KEYS) out[key] = 0;
  out.resSilicates = SILICATE_FIXED;   // fixed mid partner in every cell
  out[column.archetype] = row.level;   // the swept resource for this column
  return out as Pick<Body, ResKey>;
}

// 30 cells in ROW-MAJOR order: index = row * GRID_COL_COUNT + col. Row 0 is the
// TOP row (trace tier), col 0 the LEFT column (metals).
// Every cell shares ONE disc id so the shader's per-body seed
// (hash32('disc:' + id) in disc-palette) is identical across the whole grid:
// the procedural texture LAYOUT — worley surface cells, crater + cloud
// placement — stays fixed, so the only thing that changes cell-to-cell is the
// swept resource/tier parameter, not the seeded random pattern. That isolation
// is the point of the grid. Safe because the test view never picks or looks a
// body up by id.
const SHARED_DISC_ID = 'test-cell';

export function buildTestGrid(): TestCell[] {
  const cells: TestCell[] = [];
  // Resource-sweep rows (rows 0 .. GRID_ROWS.length-1).
  for (let row = 0; row < GRID_ROWS.length; row++) {
    const rowSpec = GRID_ROWS[row];
    for (let col = 0; col < GRID_COL_COUNT; col++) {
      const colSpec = GRID_COLUMNS[col];
      const label = `${colSpec.stem} ${rowSpec.mark}`;
      const body = makeTestBody({
        id: SHARED_DISC_ID,
        hostId: 'sol',
        name: label,
        formalName: label,
        ...cellResources(colSpec, rowSpec),
      });
      cells.push({ body, label });
    }
  }
  // Bottom row — water-coverage sweep over ONE fixed land topology. Fixed
  // silicate + metals (both mid → ~50/50 split), all other deposits zeroed so
  // the land reads as that two-resource pairing under the rising ocean.
  for (let col = 0; col < GRID_COL_COUNT; col++) {
    const coverage = WATER_ROW_COVERAGE[col];
    const label = `ocean ${Math.round(coverage * 100)}%`;
    const body = makeTestBody({
      id: SHARED_DISC_ID,
      hostId: 'sol',
      name: label,
      formalName: label,
      resMetals: 5,
      resSilicates: 5,
      resVolatiles: 0,
      resRareEarths: 0,
      resRadioactives: 0,
      resExotics: 0,
      surfaceLiquidFraction: coverage,
      surfaceLiquidSpecies: 'water',
      salinity: 0.035,
    });
    cells.push({ body, label });
  }
  return cells;
}
