// Public runtime API for the star catalog. The catalog data itself is
// precomputed by scripts/build-catalog.mjs (parses src/data/*.csv, runs
// normalization, hierarchical multi-star layout, cluster detection,
// COM computation) and lives in catalog.generated.json. That JSON is
// gitignored — the npm scripts (build:catalog, prebuild, predev,
// pretypecheck) keep it in sync with the CSVs.
//
// This module:
//   - Re-exports the precomputed STARS and STAR_CLUSTERS as immutable arrays.
//   - Owns the runtime k-d trees over both (rebuilt fresh on each module
//     load — the trees are mutable index instances, not catalog data).
//   - Owns the type definitions other modules consume.
//   - Owns runtime-only constants (CLASS_COLOR for the stars shader,
//     WAYPOINT_STAR_IDS for the labels module).
//
// Adding a new CSV column? Update parseCsvCatalog in build-catalog.mjs
// and add the field to the Star interface here. The two have to agree —
// there's no type bridge between the build script and the runtime.

import { Color } from 'three';
import { KDTree3 } from './kdtree';
import catalog from './catalog.generated.json';

export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'WD' | 'BD';

export interface Star {
  // Stable identifier — the stellarcatalog.com slug (e.g. `fomalhaut-a`,
  // `sirius-a`, `gliese-1`), or `sol` for the Sun. Survives display-name
  // edits, so consumers like WAYPOINT_STAR_IDS key on this rather than name.
  readonly id: string;
  readonly name: string;
  // IAU canonical designation (e.g. "Alpha Centauri B" for the row whose
  // display `name` is "Toliman"). Empty when it would duplicate `name` —
  // the renderer treats empty as "no separate IAU line to draw," which is
  // the case for ~95% of catalog rows where `name` already IS the IAU
  // form (`Sirius A`, `Capella Aa`, `61 Cygni A`). Populated only for
  // hand-curated colloquial entries.
  readonly iauName: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cls: SpectralClass;
  // Raw spectral string from the CSV (e.g. "G2V", "M4.0Ve", "DA1.9"). Kept
  // alongside the normalized single-letter `cls` because the raw form
  // carries luminosity class + variability flags that the info card wants
  // to surface; `cls` stays internal to color/font lookups.
  readonly rawClass: string;
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
  // doesn't carry a radius column, so this is always derived at build
  // time from class + mass — Chandrasekhar M^(-1/3) for WDs, ~Jupiter-radius
  // constant for BDs, and a rough main-sequence M^0.8 elsewhere. The
  // visualization-side pxSize is computed from radiusSolar.
  readonly radiusSolar: number;
  // Reference visual disc size in pixels at the default zoom (the shader
  // applies depth-attenuation on top of this). Derived from radiusSolar
  // via a cube-root mapping in build-catalog.mjs.
  readonly pxSize: number;
  // Indices into BODIES of every planet that directly orbits this star,
  // sorted by semi-major axis ascending. Empty for stars with no known or
  // procgen-assigned planets. Moons of those planets are not in this list —
  // they live on each planet's own `moons` array.
  readonly planets: readonly number[];
  // Indices into BODIES of every belt that orbits this star (asteroid
  // belt, Kuiper analog, debris disk), sorted by semi-major axis. Parallel
  // to `planets`; belts are kept on their own list so consumers can iterate
  // structural bands without inspecting every body's `kind`.
  readonly belts: readonly number[];
}

export type WorldClass =
  | 'rocky' | 'ocean' | 'ice' | 'desert' | 'lava'
  | 'gas_dwarf' | 'gas_giant' | 'ice_giant';
// Biosphere is two orthogonal axes:
//   - archetype: what kind of life (carbon/water, methane/cryogenic, etc.)
//   - tier: how developed (prebiotic → microbial → complex → gaian)
// Sterile bodies carry tier='none' and archetype=null. Anything else is
// guaranteed to have both axes set.
export type BiosphereArchetype =
  | 'carbon_aqueous'      // Earth-standard, water + carbon
  | 'subsurface_aqueous'  // ice-shell ocean (Europa, Enceladus)
  | 'aerial'              // gas-giant atmospheric
  | 'cryogenic'           // methane/ethane solvent (Titan-hypothesized)
  | 'silicate'            // crystalline mineral metabolism
  | 'sulfur';             // sulfur-cycle / thermal-vent biology
export type BiosphereTier =
  | 'none'        // sterile
  | 'prebiotic'   // organic chemistry, no replicating life
  | 'microbial'   // simple unicellular
  | 'complex'     // multicellular ecosystems
  | 'gaian';      // life has reshaped planet chemistry (Earth post-GOE)
export type BodyKind = 'planet' | 'moon' | 'belt' | 'ring';
export type BodySource = 'catalog' | 'procgen';

// Procgen mass/radius taxonomy used by the Architect when sampling a
// planet's physical spec and ring/moon priors. Persisted on the body so
// downstream consumers don't have to reverse-engineer it from the
// many-to-one `worldClass` mapping (a 2 M⊕ super_earth and a 2 M⊕ rocky
// can both land at worldClass='desert' but carry different priors).
// Null for non-planet kinds and for curated-system planets where the
// Architect/backfill didn't run.
export type PlanetType =
  | 'hot_rocky' | 'rocky' | 'super_earth'
  | 'sub_neptune' | 'neptune' | 'jupiter';

// Belt / ring sub-classification. 'asteroid' and 'debris' have rocky
// chunks; 'ice' is volatile-dominated. Rings constrain to ice / debris
// only — dust rings (Jupiter, Uranus inner) are deliberately not modeled
// because they're visually negligible and gameplay-irrelevant.
export type BeltClass = 'asteroid' | 'ice' | 'debris';

// Rings are physically restricted to 'ice' or 'debris' — an "asteroid
// ring" is not a real configuration (a single planet can't accumulate a
// belt of km-scale rocky bodies above its Roche limit; debris is the
// rocky-equivalent). The architect and the bodies.csv validator both
// enforce this; the type makes the constraint legible at use sites.
export type RingClass = Extract<BeltClass, 'ice' | 'debris'>;

// Population-structure axis for belts. Orthogonal to BeltClass (which
// captures composition + location). 'discrete' = a small number of large
// parent bodies dominate the mass distribution (Sol Main Belt: Ceres
// alone is ~35% of Main Belt mass; Kuiper Belt: Pluto/Eris similar);
// gameplay maps to "sortie to a specific named body." 'collisional' =
// mass spread across a steep power-law size distribution dominated by
// dust + small parents (debris disks); gameplay maps to "sweep-harvest
// a region." This is the field that actually distinguishes an asteroid
// belt (primordial planetesimal survivors) from a debris field (second-
// generation collisional dust) — under the old schema they shared a
// composition enum and were otherwise indistinguishable.
export type PopulationModel = 'discrete' | 'collisional';

// One planet or moon. Catalog-sourced rows come from
// scripts/scrape-planets-from-stellarcatalog.mjs; hand-seeded Sol bodies and
// (later) procgen output share the same shape. `kind` discriminates whether
// `hostStarIdx` or `hostBodyIdx` is populated — never both — and whether
// `moons` is meaningful (only planets have moons).
//
// Nullable fields encode two CSV-side states that collapse here: an empty
// cell ("unknown, fill at build-time procgen") and `n/a` ("not applicable,
// never has a value"). Once procgen ships, empties get synthesized and only
// genuine n/a values remain null at runtime.
export interface Body {
  readonly id: string;
  readonly hostId: string;
  readonly kind: BodyKind;
  readonly formalName: string;
  readonly name: string;
  readonly source: BodySource;
  // Discriminated by `kind`: planet bodies set `hostStarIdx`, moon bodies set
  // `hostBodyIdx`. The other is always null.
  readonly hostStarIdx: number | null;
  readonly hostBodyIdx: number | null;
  // Orbit (around the host star for planets/belts; around the host
  // planet for moons/rings).
  readonly semiMajorAu: number | null;
  readonly eccentricity: number | null;
  readonly inclinationDeg: number | null;
  readonly periodDays: number | null;
  readonly orbitalPhaseDeg: number | null;
  readonly rotationPeriodHours: number | null;
  readonly axialTiltDeg: number | null;
  // Belt (kind='belt') extent in AU. Ring (kind='ring') extent in
  // multiples of the host planet's radius. All four are null for
  // planet / moon kinds.
  readonly innerAu: number | null;
  readonly outerAu: number | null;
  readonly innerPlanetRadii: number | null;
  readonly outerPlanetRadii: number | null;
  // Physical. radiusEarth is null for belt/ring kinds; massEarth is
  // meaningful (total belt mass) for belts but null for rings.
  readonly massEarth: number | null;
  readonly radiusEarth: number | null;
  // Belt / ring sub-class. Null for planet / moon kinds.
  readonly beltClass: BeltClass | null;
  // Population structure for belts. Null for planet / moon / ring kinds.
  // See PopulationModel: 'discrete' for primordial parent-body-dominated
  // belts (asteroid, ice), 'collisional' for second-generation dust
  // (debris).
  readonly populationModel: PopulationModel | null;
  // Diameter of the largest body in the belt, in km. For 'discrete'
  // populations this is a meaningful "show up on the system map" anchor
  // (Sol Main Belt's Ceres = 940 km; Kuiper Belt's Pluto = 2376 km).
  // For 'collisional' populations the largest parent is small (debris
  // disks have no Vesta-equivalent — their existence implies the
  // collision cascade hasn't run out of material yet, which requires
  // many small parents rather than a few large ones). Null on planets,
  // moons, rings.
  readonly largestBodyKm: number | null;
  // Index into BODIES of the gas/ice giant that dynamically shepherds
  // this belt (mean-motion resonance stabilizer for 'asteroid' and 'ice'
  // classes; analog of Jupiter for Sol's Main Belt, Neptune for the
  // Kuiper Belt). Null on debris fields (no shepherd needed —
  // collisional dust isn't dynamically stabilized), on belts that
  // formed without a giant in the system, and on planet/moon/ring kinds.
  readonly shepherdBodyIdx: number | null;
  // Architect's mass/radius taxonomy. See `PlanetType` for semantics.
  readonly planetType: PlanetType | null;
  // Surface character. All null for belt / ring kinds (no surface).
  readonly worldClass: WorldClass | null;
  readonly avgSurfaceTempK: number | null;
  readonly surfaceTempMinK: number | null;
  readonly surfaceTempMaxK: number | null;
  readonly waterFraction: number | null;
  readonly iceFraction: number | null;
  readonly albedo: number | null;
  readonly magneticFieldGauss: number | null;
  readonly tectonicActivity: number | null;
  // Atmosphere — top three gases by fraction. atm1 is the dominant species.
  readonly surfacePressureBar: number | null;
  readonly atm1: string | null;
  readonly atm1Frac: number | null;
  readonly atm2: string | null;
  readonly atm2Frac: number | null;
  readonly atm3: string | null;
  readonly atm3Frac: number | null;
  // Resources — 0..10 indices, calibrated against Earth (5/6/7/5/4/0).
  readonly resMetals: number | null;
  readonly resSilicates: number | null;
  readonly resVolatiles: number | null;
  readonly resRareEarths: number | null;
  readonly resRadioactives: number | null;
  readonly resExotics: number | null;
  // Life — two-axis. archetype is null on sterile bodies (tier='none') and
  // on bodies where the Filler skipped the roll (gas giants in curated
  // systems, etc.). When tier ≠ 'none', archetype is guaranteed non-null.
  readonly biosphereArchetype: BiosphereArchetype | null;
  readonly biosphereTier: BiosphereTier | null;
  // Indices into BODIES of moons orbiting this body, sorted by semi-major
  // axis ascending. Always empty when `kind === 'moon'` (no sub-moons modeled).
  readonly moons: readonly number[];
  // Index into BODIES of this body's ring system, or null. Only planet
  // kinds can carry a ring; the catalog enforces at most one ring per
  // planet — multi-band ring systems (Saturn's A/B/C, Uranus's epsilon /
  // delta / etc.) collapse into a single ring row with bounding
  // inner/outer radii.
  readonly ring: number | null;
}

export interface StarCluster {
  // Index into STARS of the heaviest member (the cluster's "primary").
  readonly primary: number;
  // All member star indices, primary first.
  readonly members: readonly number[];
  // Mass-weighted center of mass (Σmᵢ·rᵢ / Σmᵢ) in galactic ly, computed
  // at build time. The selection reticle, dropline anchor, and left-click
  // focus animation all use this so a multi-star system reads as one
  // entity rather than as its individually-selectable members. For
  // single-member clusters, com === primary's position by construction.
  readonly com: { readonly x: number; readonly y: number; readonly z: number };
}

// JSON imports are typed as `any` by default; assert to the precomputed
// shape. The build script is the only writer; any drift between the JSON
// and these interfaces shows up at usage sites, not here.
export const STARS: readonly Star[] = catalog.stars as readonly Star[];
export const STAR_CLUSTERS: readonly StarCluster[] = catalog.clusters as readonly StarCluster[];
export const BODIES: readonly Body[] = catalog.bodies as readonly Body[];

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

// Diagrammatic disc color per WorldClass. Used by SystemDiagram (and any
// future planet-rendering consumer). Bodies whose worldClass is still null
// (catalog rows the scraper couldn't classify, awaiting build-time procgen)
// render in WORLD_CLASS_UNKNOWN_COLOR so they read as "TBD" rather than
// ambiguously slotting into one of the real classes.
export const WORLD_CLASS_COLOR: Record<WorldClass, Color> = {
  rocky:     new Color(0xc4956a),
  ocean:     new Color(0x4a9fd9),
  ice:       new Color(0xd6e8f0),
  desert:    new Color(0xe4a854),
  lava:      new Color(0xd64a3a),
  gas_dwarf: new Color(0xa090c8),
  gas_giant: new Color(0xc4a878),
  ice_giant: new Color(0x5a9ad6),
};
export const WORLD_CLASS_UNKNOWN_COLOR = new Color(0x808080);

// Disc / chunk color per BeltClass. Asteroid belts read brown-tan
// (rocky/metallic dominant), ice belts pale cyan (water ice), debris
// fields dusty olive (mixed rocky + processed material).
export const BELT_CLASS_COLOR: Record<BeltClass, Color> = {
  asteroid: new Color(0xa89060),
  ice:      new Color(0xb8d8e8),
  debris:   new Color(0x806848),
};

// Narrowing accessor for ring bodies. Rings store their composition
// in the same `beltClass` column as belts (one column per row, shared
// schema), but the value is constrained to RingClass — the build
// validator and the architect both reject 'asteroid' for rings. This
// accessor exposes the narrower type so ring-rendering code doesn't
// have to handle an 'asteroid' branch that can never fire. Throws on
// invariant violation (something bypassed both writers).
export function ringClass(body: Body): RingClass {
  if (body.kind !== 'ring') {
    throw new Error(`ringClass: ${body.id} is kind=${body.kind}, not 'ring'`);
  }
  const c = body.beltClass;
  if (c === null || c === 'asteroid') {
    throw new Error(`ringClass: ${body.id} has invalid beltClass=${c}`);
  }
  return c;
}

// =============================================================================
// Runtime spatial indices
// =============================================================================

// Spatial index over STAR_CLUSTERS keyed by COM. Backs nearestClusterIdxTo
// (called per-frame from scene.tick). Rebuilt at module load — the tree is
// a mutable index instance, not data.
const CLUSTER_TREE = new KDTree3(STAR_CLUSTERS, c => c.com);

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

// Nearest cluster (by COM) to (x, y, z). Returns -1 only if STAR_CLUSTERS is
// empty (defensive — in practice the catalog always has Sol).
export function nearestClusterIdxTo(x: number, y: number, z: number): number {
  return CLUSTER_TREE.nearest(x, y, z);
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
