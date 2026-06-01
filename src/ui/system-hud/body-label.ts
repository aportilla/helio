// Composed, descriptive world labels for the body info card — the
// "explorer's-log" voice: a glanceable field-note chip that reads like a
// surveyor's first impression of a world.
//
// The body's TYPE comes from `classifyBody` (scripts/lib/body-archetype.mjs)
// — a physics-derived archetype, the single source that replaced the stored
// `worldClass` category. This module is the PRESENTATION layer on top: it
// turns the archetype into an evocative core noun and layers the single most
// salient state + a composition adjective, so two bodies that share an
// archetype but differ physically read distinctly ("Verdant Gaian World" vs
// "Crater-Scarred Glacial Moon").
//
// Structure — `[state] [material] core-noun`, a hard 3-token budget so it
// stays a glanceable chip. The noun is mandatory and claims first; state
// outranks material for the remainder. A 3-token iconic noun ("Subglacial
// Ocean Moon") stands alone; a short one ("Iron Moon") leaves room for a
// state. Hyphenated compounds ("Tidally-Heated", "Crater-Scarred") count as
// one token, so the vivid words don't blow the budget.
//
// The vocabulary is HEAT-DOMAIN-AWARE: one temperature never wears one word.
// A hot dry rock reads "Blistering", a hot ocean "Steaming", a hot gaseous
// envelope "Searing" — so the same 480 K doesn't flatten three very different
// worlds into the same chip the way a single "Torrid" did.
//
// Archetype → noun:
//   - iconic types the surface-liquid data unlocks read as named worlds
//     (Gaian, Smog, Brimstone, Ammonia/Glacial Sea, Subglacial Ocean);
//   - the rest read as their evocative base (Glacial, Frostbound, Desert, …).
// State + material then key off physical fields directly (surface liquid
// species/cover, salinity, subsurface ocean, haze, biosphere, temperature).
// Reads that mean H2O ice specifically stay on `iceFraction`; "wet"/"liquid"
// reads use `surfaceLiquidFraction` (any solvent).
//
// Pure runtime function — no catalog rebuild, no stored label. Thresholds are
// presentation choices (when a world "reads as" scorched / temperate /
// briny), intentionally coarser than the physics; tune them in LEXICON +
// the threshold consts here freely. `scripts/dump-labels.mjs` dumps the whole
// galaxy's labels (it imports THIS function, so no drift) — run it after a
// vocabulary edit to see the new distribution.

import type { AtmGas, Body } from '../../data/stars';
import { classifyBody } from '../../../scripts/lib/body-archetype.mjs';

// ─── Tunable vocabulary ─────────────────────────────────────────────────────
// The swappable words, hoisted so a tone pass is one edit. Each is grounded
// in a physical read (see the call sites); these are the words, not the gates.
const LEXICON = {
  // life — only when it has reshaped the world's physical essence (Verdant).
  // Lesser biospheres live in the info card's dedicated life row, not the chip.
  verdant:     'Verdant',        // complex biosphere, high surface impact
  // activity
  tidal:       'Tidally-Heated', // tidally-flexed, perpetually-resurfaced moon
  cryovolcanic:'Cryovolcanic',   // young icy/watery surface — geyser resurfacing
  volcanic:    'Volcanic',       // silicate volcanism on a hot dry body
  sealedOcean: 'Sealed-Ocean',   // buried ice-shell ocean under a frozen crust
  // heat (domain-aware — see stateModifier)
  scorched:    'Scorched',       // extreme dry-rock heat (T ≥ HOT_EXTREME_K)
  searing:     'Searing',        // hot gaseous envelope
  steaming:    'Steaming',       // hot world with standing liquid
  blistering:  'Blistering',     // hot dry rock (sub-extreme)
  hothouse:    'Hothouse',       // runaway-greenhouse rock (thick hot atm, dry)
  temperate:   'Temperate',      // clement, liquid-bearing band
  frozen:      'Frozen',         // cold (T < COLD_K)
  frigid:      'Frigid',         // deep cold (T < DEEP_COLD_K)
  // sky / surface
  smog:        'Smog-Shrouded',  // thick organic (tholin) haze
  dust:        'Dust-Choked',    // planet-wide dust load
  airless:     'Airless',        // no meaningful atmosphere over rock
  cratered:    'Crater-Scarred', // ancient, heavily-cratered surface
  // exotic standing liquid (a film the core noun didn't already name)
  methaneLake: 'Methane-Lake',   // hydrocarbon lakes — the defining Smog-world feature
  ammoniaLake: 'Ammonia-Lake',
  nitrogenLake:'Nitrogen-Lake',
  sulfurPool:  'Sulfur-Pool',
  // composition
  briny:       'Briny',          // heavy solute load in standing liquid
  sulfurous:   'Sulfurous',      // sulfur-dominated surface / volcanism
  // economic identity — a rare abundant resource PAIRING (not a single
  // deposit, which lives in the info card's resource row)
  rich:        'Rich',           // two abundant deposits incl. a strategic (rare-earth / radioactive)
  veined:      'Veined',         // an abundant exotic deposit paired with another
} as const;

// ─── Presentation thresholds ────────────────────────────────────────────────
// Surface-liquid cover below which an ammonia/nitrogen film reads as a state
// modifier ("Ammonia-Lake") rather than the world's defining sea. Mirrors the
// classifier's own floor so the Brimstone noun and the lake modifier never
// both describe the same liquid. (Hydrocarbon has its own lower floor below.)
const LAKE_COVER_FLOOR = 0.05;
// Solute load at which a standing liquid reads "Briny". Rare by design — a
// genuine landmark, not wallpaper (the salinity distribution cliffs above 0.6).
const BRINY_SALINITY = 0.6;
// Methane (hydrocarbon) lakes define a Smog world; show them above a low floor
// (Titan's poles are only ~3% covered) and promote a drowned surface
// (≥ METHANE_SEA_COVER) to a methane-sea core noun.
const METHANE_LAKE_FLOOR = 0.02;
const METHANE_SEA_COVER = 0.5;
// A deposit at/above this grade (of 10) reads "abundant" — well past the
// typical strong deposit (~5), approaching motherlode. A PAIRING of two
// abundant deposits where at least one is strategic / exotic is a rare
// economic landmark (~1% of worlds); a single deposit or a bulk-only pair
// stays in the resource row.
const ABUNDANT_DEPOSIT = 7;
// Heat bands. One temperature wears different words by domain (see above).
const HOT_K = 330;          // standing-liquid steams / dry rock blisters
const HOT_EXTREME_K = 600;  // dry rock reads "Scorched"
const TEMPERATE_LO_K = 250; // clement band floor
const COLD_K = 220;         // reads "Frozen"
const DEEP_COLD_K = 90;     // reads "Frigid"
// Cryovolcanism / cratering surface-age gates (0..1, 1 = freshly resurfaced).
// Cryovolcanism reads on the youngest ~30% of icy surfaces — a notable
// resurfacing signal that also keeps the dominant cold-moon buckets from
// collapsing to one bare chip.
const CRYOVOLCANIC_AGE = 0.7;
const TIDAL_AGE = 0.85;
const ANCIENT_AGE = 0.12;

// Axes a core noun already conveys, so a state modifier on the same axis is
// redundant and gets skipped. 'methane' covers a hydrocarbon surface;
// each cryogenic-liquid species maps to a material so the redundant-axis
// skip logic stays meaningful across the non-water sea cores.
type Material = 'gas' | 'rock' | 'iron' | 'ice' | 'water' | 'methane' | 'ammonia' | 'nitrogen' | 'sulfur';
interface Core {
  noun: string;
  hot?: boolean;        // core already reads as hot — skip hot temp adjectives
  cold?: boolean;       // core already reads as cold — skip cold temp adjectives
  volcanic?: boolean;   // core already reads as molten/active — skip "Volcanic"
  temperate?: boolean;  // core is itself a temperate living world — skip "Temperate"/"Verdant"
  hazy?: boolean;       // core already implies organic smog — skip "Smog-Shrouded"
  generic?: boolean;    // bare "Rocky" — drop the prefix when a modifier carries character
  uncharted?: boolean;  // no classifiable physics — emit the noun alone
  material?: Material;
}

function atmFrac(b: Body, gas: AtmGas): number {
  if (b.atm1 === gas) return b.atm1Frac ?? 0;
  if (b.atm2 === gas) return b.atm2Frac ?? 0;
  if (b.atm3 === gas) return b.atm3Frac ?? 0;
  return 0;
}

function isMoon(b: Body): boolean {
  return b.kind === 'moon';
}

// "Moon" for moons, "World" for planets.
function worldNoun(b: Body): string {
  return isMoon(b) ? 'Moon' : 'World';
}

// Surface free of standing liquid (any species) + ice — gates the silicate-
// volcanism modifier so a wet/icy/hydrocarbon-lake body's activity reads as
// cryovolcanic (or nothing), not "Volcanic". iceFraction stays H2O ice;
// surfaceLiquidFraction generalizes "wet" past water alone.
function isDrySurface(b: Body): boolean {
  return (b.surfaceLiquidFraction ?? 0) < 0.1 && (b.iceFraction ?? 0) < 0.3;
}

// Archetype → evocative core noun + the axes it already implies. The
// archetype is the physics-derived type (classifyBody); this turns it into
// the player-facing noun and the redundant-axis flags the state layer reads.
function coreFor(b: Body): Core {
  const w = worldNoun(b);
  switch (classifyBody(b)) {
    // ─── gaseous ───
    case 'hot_jupiter':      return { noun: 'Hot Jupiter', hot: true, material: 'gas' };
    case 'gas_giant':        return { noun: 'Gas Giant', material: 'gas' };
    case 'ice_giant':        return { noun: 'Ice Giant', cold: true, material: 'gas' };
    case 'sub_neptune':      return { noun: 'Sub-Neptune', material: 'gas' };
    // A cold, ice/water-rich sub-Neptune under an opaque H2 envelope — a
    // frozen mini-Neptune. cold + gaseous (no surface) → no temp/composition
    // modifier; the 3-token noun stands alone.
    case 'veiled_ice':       return { noun: `Veiled Ice ${w}`, cold: true, material: 'gas' };
    case 'helium':           return { noun: 'Helium Giant', material: 'gas' };
    // ─── iconic surface / subsurface liquid ───
    case 'gaian':            return { noun: `Gaian ${w}`, material: 'water', temperate: true };
    case 'tholin': {
      // A cold methane world: orange organic (tholin) smog over hydrocarbon
      // lakes. The smog is the player-facing noun (jargon-free, and it's what
      // you'd see); a drowned surface promotes to a methane sea. cold + hazy
      // skip the redundant Frozen / Smog-Shrouded modifiers (the noun, never
      // "Frozen" — these surfaces are methane, not water ice).
      if ((b.surfaceLiquidFraction ?? 0) >= METHANE_SEA_COVER) {
        return { noun: `Methane Sea ${w}`, cold: true, hazy: true, material: 'methane' };
      }
      return { noun: `Smog ${w}`, cold: true, hazy: true, material: 'methane' };
    }
    case 'brimstone':        return { noun: `Brimstone ${w}`, hot: true, volcanic: true, material: 'sulfur' };
    case 'ammonia_sea':      return { noun: `Ammonia Sea ${w}`, cold: true, material: 'ammonia' };
    case 'glacial_sea':      return { noun: `Glacial Sea ${w}`, cold: true, material: 'nitrogen' };
    case 'subglacial_ocean': return { noun: `Subglacial Ocean ${w}`, cold: true, material: 'ice' };
    case 'ocean':            return { noun: `Ocean ${w}`, material: 'water' };
    // ─── terrestrial base ───
    case 'lava':             return { noun: `Lava ${w}`, hot: true, volcanic: true, material: 'rock' };
    case 'magma_ocean':      return { noun: 'Magma Ocean', hot: true, volcanic: true, material: 'rock' };
    case 'volcanic':         return { noun: `Volcanic ${w}`, volcanic: true, material: 'rock' };
    // A stripped giant core is hot AND molten — flag both so a redundant
    // "Volcanic"/"Scorched" never stacks onto "Chthonian Core".
    case 'chthonian':        return { noun: 'Chthonian Core', hot: true, volcanic: true, material: 'iron' };
    case 'iron':             return { noun: `Iron ${w}`, material: 'iron' };
    case 'frostbound':       return { noun: `Frostbound ${w}`, cold: true, material: 'methane' };
    case 'glacial':          return { noun: `Glacial ${w}`, cold: true, material: 'ice' };
    case 'super_earth':      return { noun: 'Super-Earth', material: 'rock' };
    case 'desert':           return { noun: `Desert ${w}`, material: 'rock' };
    case 'rocky':            return { noun: `Rocky ${w}`, material: 'rock', generic: true };
    case 'unknown':          return { noun: 'Uncharted World', uncharted: true };
  }
}

// A rare abundant resource PAIRING that defines a world's economic identity:
// "Veined" when an exotic deposit is in the mix (the jackpot), else "Rich"
// for a strategic (rare-earth / radioactive) pairing. Bulk-only pairs
// (metal / silicate / volatile) are the ubiquitous default and stay unnamed;
// a single abundant deposit isn't a pairing — it lives in the resource row.
function resourcePairWord(b: Body): string | null {
  let abundant = 0, exotic = false, strategic = false;
  if ((b.resExotics ?? 0)      >= ABUNDANT_DEPOSIT) { abundant++; exotic = true; }
  if ((b.resRareEarths ?? 0)   >= ABUNDANT_DEPOSIT) { abundant++; strategic = true; }
  if ((b.resRadioactives ?? 0) >= ABUNDANT_DEPOSIT) { abundant++; strategic = true; }
  if ((b.resMetals ?? 0)       >= ABUNDANT_DEPOSIT) abundant++;
  if ((b.resSilicates ?? 0)    >= ABUNDANT_DEPOSIT) abundant++;
  if ((b.resVolatiles ?? 0)    >= ABUNDANT_DEPOSIT) abundant++;
  if (abundant < 2) return null;
  if (exotic) return LEXICON.veined;
  if (strategic) return LEXICON.rich;
  return null;
}

// The single most salient state adjective, in descending salience. Returns
// the first that fires; null when the body is unremarkable on every axis.
function stateModifier(b: Body, core: Core): string | null {
  const T = b.avgSurfaceTempK;
  const P = b.surfacePressureBar;
  const gas = core.material === 'gas';
  const liquid = b.surfaceLiquidFraction ?? 0;

  // 1. Life — only when it has reshaped the world's physical essence
  //    (Verdant). Microbial / non-transformative complex life stays in the
  //    info card's dedicated life row, not the headline chip.
  if (b.biosphereComplexity === 'complex' && (b.biosphereSurfaceImpact ?? 0) >= 0.5 && !core.temperate) return LEXICON.verdant;

  // 2. Surface character. Methane lakes are the defining feature of a Smog
  //    world — shown above a low floor (Titan's are only ~3% cover); a drowned
  //    surface is already named a Methane Sea by the core noun. Then tidal
  //    resurfacing, then the other exotic-solvent films.
  if (b.surfaceLiquidSpecies === 'hydrocarbon'
      && liquid >= METHANE_LAKE_FLOOR && liquid < METHANE_SEA_COVER) return LEXICON.methaneLake;
  if (isMoon(b) && (b.surfaceAge ?? 0) >= TIDAL_AGE) return LEXICON.tidal;
  // Other exotic surface lakes the core noun didn't already name — ammonia /
  // nitrogen films on a cold base (Glacial / Frostbound) below their full-sea
  // threshold. (Hydrocarbon is handled above; sulfur reaches Brimstone.)
  if (liquid >= LAKE_COVER_FLOOR && !/Sea|Ocean|Brimstone/.test(core.noun)) {
    switch (b.surfaceLiquidSpecies) {
      case 'ammonia_water':
      case 'ammonia':  return LEXICON.ammoniaLake;
      case 'nitrogen': return LEXICON.nitrogenLake;
      case 'sulfur':   return LEXICON.sulfurPool;
      default: break;
    }
  }

  // 3. Economic identity — a rare abundant resource pairing (Rich / Veined).
  //    A landmark that outranks the transient surface states below, but not a
  //    world's defining standing liquids (above) or transformative life.
  const lode = resourcePairWord(b);
  if (lode !== null) return lode;

  // 4. Surface activity.
  // Cryovolcanism: a young icy/watery surface (planets, or moons the tidal
  // branch missed).
  if ((core.material === 'ice' || core.material === 'methane' || core.material === 'water')
      && core.cold && (b.surfaceAge ?? 0) >= CRYOVOLCANIC_AGE) return LEXICON.cryovolcanic;
  // A buried ice-shell ocean on a body that doesn't already wear one (a
  // Smog moon over a hidden sea — Titan); skipped where the core is itself
  // a (sub)glacial ocean or surface sea.
  if (b.subsurfaceOceanSpecies != null && liquid < LAKE_COVER_FLOOR
      && !/Sea|Ocean/.test(core.noun)) return LEXICON.sealedOcean;
  // Silicate volcanism on a hot, active, dry body the core didn't already
  // mark molten.
  if (!core.volcanic && isDrySurface(b)
      && (b.tectonicActivity ?? 0) >= 0.55 && (b.surfaceAge ?? 0) >= 0.6
      && T !== null && T >= 400) return LEXICON.volcanic;

  // 5. Runaway greenhouse — a thick, hot atmosphere over a dry surface (Venus).
  if (!core.hot && core.material === 'rock' && P !== null && P >= 5
      && T !== null && T >= 340 && liquid < 0.05) return LEXICON.hothouse;

  // 6. Heat — domain-aware, so one temperature never wears one word. A hot
  //    ocean steams, a hot gaseous envelope sears, an extreme dry rock is
  //    scorched, a merely-hot dry rock blisters. Wet outranks dry-extreme so
  //    a high-pressure 600 K+ ocean reads "Steaming", not "Scorched".
  if (!core.hot && T !== null) {
    if (T >= HOT_K && liquid >= 0.1) return LEXICON.steaming;
    if (T >= HOT_EXTREME_K && !gas) return LEXICON.scorched;
    if (T >= HOT_K && gas) return LEXICON.searing;
    if (T >= HOT_K) return LEXICON.blistering;
  }

  // 7. Distinctive atmosphere texture — organic smog (Titan tholin) or a
  //    dust-choked sky. Skipped on cores that already imply smog.
  if (!core.hazy && b.hazeAerosols && (b.hazeAerosols['THOLIN'] ?? 0) >= 0.3) return LEXICON.smog;
  if ((b.dustStrength ?? 0) >= 0.5) return LEXICON.dust;

  // 8. Milder temperature bands — skipped on the axis the core implies.
  if (T !== null) {
    // Temperate reads as notable only where there's surface liquid of any
    // species (or the core is a water world) — an airless 290 K rock isn't.
    if (!core.temperate && T >= TEMPERATE_LO_K && T < HOT_K && (liquid > 0 || core.material === 'water')) return LEXICON.temperate;
    if (!core.cold && !gas && T < DEEP_COLD_K) return LEXICON.frigid;
    if (!core.cold && !gas && T < COLD_K) return LEXICON.frozen;
  }

  // 9. Airless rocky body (Luna-class).
  if (core.material === 'rock' && (P === null || P < 0.001)) return LEXICON.airless;

  // 10. Ancient, heavily-cratered surface (Mercury, Callisto). Skipped on
  //    molten/volcanic cores — a repaved surface isn't cratered.
  if (!core.hot && !core.volcanic && (b.surfaceAge ?? 1) <= ANCIENT_AGE) return LEXICON.cratered;

  return null;
}

// A composition adjective adjacent to the noun, when distinctive and not
// already carried by the core's material or the chosen state.
function materialQualifier(b: Body, core: Core, state: string | null): string | null {
  // A heavy solute load reads "Briny" — only where there's standing liquid.
  if ((b.surfaceLiquidFraction ?? 0) > 0 && (b.salinity ?? 0) >= BRINY_SALINITY) return LEXICON.briny;
  // Sulfur-dominated surface or sulfur-cycle volcanism (not a gaseous body
  // nor a Brimstone core). Skipped if the state already names sulfur.
  if (core.material !== 'gas' && core.material !== 'sulfur' && state !== LEXICON.sulfurPool
      && (atmFrac(b, 'SO2') >= 0.3 || (b.bioticSulfur ?? 0) >= 0.3)) return LEXICON.sulfurous;
  return null;
}

function tokenCount(parts: readonly string[]): number {
  // Hyphenated compounds ("Tidally-Heated", "Subglacial Ocean") count by word;
  // a hyphen stays one token.
  return parts.reduce((n, p) => n + p.split(' ').length, 0);
}

// Compose the full label: [state] [material] core-noun, within a hard 3-token
// budget. The noun is mandatory and claims first; state outranks material for
// the remainder — so a 3-token iconic noun stands alone, a 2-token noun takes
// a state, and a 1-token noun can take both.
export function composeWorldLabel(b: Body): string {
  const core = coreFor(b);
  if (core.uncharted) return core.noun;

  const state = stateModifier(b, core);
  const material = materialQualifier(b, core, state);

  // A bare "Rocky" prefix reads worse than letting an adjective carry the
  // character — "Steaming World", not "Steaming Rocky World".
  let noun = core.noun;
  if (core.generic && (state || material)) noun = worldNoun(b);

  let budget = 3 - tokenCount([noun]);
  const parts: string[] = [];
  if (state && tokenCount([state]) <= budget) { parts.push(state); budget -= tokenCount([state]); }
  if (material && tokenCount([material]) <= budget) { parts.push(material); budget -= tokenCount([material]); }
  parts.push(noun);
  return parts.join(' ');
}
