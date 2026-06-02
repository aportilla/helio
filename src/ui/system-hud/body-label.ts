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
// "Cratered Glacial Moon").
//
// Structure — `[state] [material] core-noun`, a hard 3-token budget so it
// stays a glanceable chip. The noun is mandatory and claims first; state
// outranks material for the remainder. A 3-token iconic noun ("Subglacial
// Ocean Moon") stands alone; a short one ("Iron Moon") leaves room for a
// state. Hyphenated compounds ("Sealed-Ocean", "Rust-Red") count as
// one token, so the vivid words don't blow the budget.
//
// HEAT IS DOMAIN-AWARE: one temperature never wears one word. A hot dry rock
// reads "Baking", a hot ocean "Steaming", a hot gaseous envelope "Searing" — so
// the same 480 K doesn't flatten three very different worlds into one chip.
//
// Three principles govern the vocabulary — the voice is a surveyor's field note,
// dry and clinical, not an orbital postcard:
//   1. GROUND-TRUTH, NOT SPECTACLE. Every word answers "what is it like on the
//      surface / what would the instruments read", never "what does it look
//      like from orbit". Conditions a colonist would feel — temperature,
//      pressure, radiation dose, dust, toxicity — outrank the view from the
//      cruiser. The magnetosphere is the cleanest case of the split: it is named
//      only by its ground face, the surface-radiation hazard it lets through
//      (the "Irradiated" material qualifier); the orbital aurora is off-register
//      and deliberately unnamed.
//   2. VARIETY FROM AXES, NOT SYNONYMS. Worlds read distinctly because they
//      DIFFER (temp, pressure, radiation, dust, chemistry), not because one axis
//      owns a dozen near-synonyms. Each pool is kept tight (≈2 plain words); the
//      spread comes from naming the actually-distinguishing condition.
//   3. PLAIN OVER ORNATE. Where two words mean the same, keep the one a field
//      geologist would write ("Frozen", not "Rime-Sealed"); one vivid word per
//      family is reserved for genuine extremes.
//
// Two registers stay deliberately UNwired — "engineered / megastructural" and
// "eldritch / otherworldly" — they only fit artificial or genuinely anomalous
// bodies the data model doesn't carry yet; add them when those kinds exist
// rather than faking the physics to reach the words.
//
// Each concept is a SYNONYM POOL, not a single word: "hot dry rock" draws from
// {Blistering, Baking, Torrid, …}, "cold" from {Frozen, Icebound, …}. The pick
// is deterministic per (body, concept) — `pick`/`pickNoun` index the pool by
// `hash32(body.id + concept)` — so a world always wears the same words across
// reloads, two concepts on one body draw independently, and no word lives in
// two pools (a state + material pair can never read "Frozen Frozen"). A pool
// word can carry a GUARD on a secondary axis the firing concept doesn't itself
// check — "Glaciated" needs ice, "Wind-Scoured" needs air — and drops out of
// the draw when that axis fails, so a cold airless rock reads "Frozen", never
// "Wind-Scoured". The pools just multiply phrasings; they never change which
// CONCEPT fires (that's the physics-keyed logic below). The coinage core nouns we own (Frostbound,
// Glacial, Desert, Iron, Lava, Veiled Ice, Subglacial Ocean) are pooled too —
// NOUN; the generic astronomy nouns (Gas Giant, Gas Dwarf, Ice Giant, Helium
// Giant) stay fixed, players know them. We keep the chip free of Earth/Sol-
// keyed anchors: there is deliberately no "Super-Earth" (→ scale tail
// "Heavyworld"), no "Hot Jupiter" (→ heat state "Searing Gas Giant"), no "Sub-
// Neptune" (→ "Gas Dwarf"), and no "Gaian" (→ "Garden World").
//
// Bodies also wear their SCALE. The tail noun is size-keyed (see worldNoun): a
// moon spans Moonlet → Moon → Major Moon, a planet Planetoid → World →
// Heavyworld. The gaseous giants instead take a dry scale STATE word ("Massive
// Gas Giant"), since their tail is a fixed archetype noun, not "World".
//
// Archetype → noun:
//   - iconic types the surface-liquid data unlocks read as named worlds
//     (Gaian, Smog, Brimstone, Ammonia Sea, Subglacial Ocean);
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
import { hash32 } from '../../../scripts/lib/prng.mjs';

// ─── Secondary-axis guards ──────────────────────────────────────────────────
// Some vocabulary words name the concept that fired them AND quietly assert a
// SECOND physical axis: "Glaciated"/"Icebound" need ice actually on the ground;
// "Wind-Scoured"/"Hoarfrosted" need an atmosphere to move or deposit it. The
// firing concept (cold) is necessary but not sufficient — without its secondary
// axis the word lies about a world it never measured. So a pool word may be a
// bare string OR a `[word, guard]` pair; `pick` draws only from words whose
// guard passes (bare words always pass), keeping the chip honest for THIS body.
// Every pool keeps at least one unguarded word, so the eligible subset is never
// empty. The guards mirror floors used elsewhere (the ice floor matches
// isDrySurface; the air floor sits an order of magnitude above the airless gate)
// so "honest" means the same thing across the module.
type Guard = (b: Body) => boolean;
type Word = string | readonly [string, Guard];
const hasIce: Guard = (b) => (b.iceFraction ?? 0) >= 0.3;          // H2O ice on the surface
const hasAir: Guard = (b) => (b.surfacePressureBar ?? 0) >= 0.01;  // an atmosphere to carry wind / deposit frost
const glowHot: Guard = (b) => (b.avgSurfaceTempK ?? 0) >= 900;     // hot enough to emit visible light ("Incandescent" / "Blazing")
const oxidized: Guard = (b) => (b.dustStrength ?? 0) > 0;          // ferric-oxide weathering → a genuine rust hue, not bare grey metal
const tectonic: Guard = (b) => (b.tectonicActivity ?? 0) >= 0.3;   // faulted crust, not just impact-gardened ("Fissured")
const thinAir: Guard = (b) => (b.surfacePressureBar ?? 1) < 1;     // sun reaches the ground, not a hazed-over greenhouse ("Sun-Scoured")
const hasLand: Guard = (b) => (b.surfaceLiquidFraction ?? 0) < 0.9; // exposed ground for vegetation to cover ("Overgrown")

// ─── Tunable vocabulary ─────────────────────────────────────────────────────
// The swappable words, hoisted so a tone pass is one edit. Each concept is a
// SYNONYM POOL — `pick` draws one deterministically per (body, concept), so the
// same world always wears the same word. Each is grounded in a physical read
// (see the call sites); these are the words, not the gates. No word appears in
// two pools, so a state + material pair can never read "Frozen Frozen". A word
// may be a bare string or a `[word, guard]` pair gated on a secondary physical
// axis (see the secondary-axis guards above) — guarded words drop out when that
// axis fails, so a cold airless world never reads "Wind-Scoured".
// Editing a pool's length reflows that concept's galaxy-wide distribution
// (selection is hash % eligible-len) — harmless, since labels are pure presentation.
const LEXICON = {
  // life — only when it has reshaped the world's physical essence (Verdant).
  // Lesser biospheres live in the info card's dedicated life row, not the chip.
  verdant:     ['Verdant', 'Living', ['Overgrown', hasLand]], // complex biosphere, high surface impact ("Overgrown" needs exposed land)
  // activity
  cryovolcanic:['Cryovolcanic', 'Venting'], // young icy/watery surface — geyser resurfacing (no Ice-/Frost- stem: pairs with cold cores)
  volcanic:    ['Volcanic', 'Eruptive'],     // silicate volcanism on a hot dry body
  sealedOcean: ['Buried-Ocean', 'Sealed-Ocean'], // a subsurface ice-shell ocean — names a feature, so the compound stays
  // scale — the visually-largest gaseous envelopes wear one dry scale word
  // (keys off radiusEarth, gaseous cores only) so a super-jovian reads distinctly.
  colossal:    ['Massive'],
  // heat (domain-aware — see stateModifier)
  scorched:    ['Scorched', 'Charred'],       // extreme dry-rock heat (T ≥ HOT_EXTREME_K); "Charred" is the reserved vivid word
  // hot gaseous envelope — "Incandescent" asserts a visible glow, so it needs
  // true incandescence (T ≥ ~900 K); a merely-330 K giant stays "Searing".
  searing:     ['Searing', ['Incandescent', glowHot]],
  steaming:    ['Steaming', 'Scalding'],      // hot world with standing liquid
  blistering:  ['Baking', ['Sun-Scoured', thinAir]], // hot dry rock; "Sun-Scoured" needs a thin sky
  hothouse:    ['Hothouse', 'Greenhouse'],    // runaway-greenhouse rock (thick hot atm, dry)
  temperate:   ['Temperate', 'Clement'],      // clement, liquid-bearing band
  // cold (T < COLD_K) — the plain word is unguarded; the ice word needs standing
  // ice, the wind word an atmosphere to move it (see the secondary-axis guards).
  frozen:      ['Frozen', ['Icebound', hasIce], ['Wind-Scoured', hasAir]],
  // deep cold (T < DEEP_COLD_K)
  frigid:      ['Frigid', 'Cryogenic'],
  // sky / surface
  smog:        ['Hazy', 'Smoggy'],            // thick organic (tholin) haze
  dust:        ['Dusty', ['Sandblasted', hasAir]], // planet-wide dust load; the wind word needs an atmosphere
  airless:     ['Airless', 'Bare'],           // no meaningful atmosphere over rock
  // ancient, heavily-cratered surface — "Fissured" reads faulting, not impacts.
  cratered:    ['Cratered', 'Pitted', ['Fissured', tectonic]],
  // dynamics & orbital geometry — axes the heat/sky logic ignores, demoted below
  // the surface conditions (see stateModifier): Neptune-class cloud-top jets, an
  // axis tipped past upright, a tide-locked spin, a day↔night swing wide enough
  // to read as two climates. The magnetosphere is NOT named here — its only
  // label is the surface-radiation hazard it lets through (the "Irradiated"
  // material qualifier); the orbital aurora is a view-from-orbit spectacle, off
  // this register entirely.
  storming:    ['Banded', 'Cyclonic'],        // fast cloud-top zonal jets
  riven:       ['Riven'],                      // fire-and-ice: extreme day↔night temperature spread
  toppled:     ['Toppled'],                    // obliquity tipped far past upright (Uranus ≈ 98°)
  twilit:      ['Tide-Locked', 'Twilit'],      // rotation synced to orbit — a fixed day/night face
  // exotic standing liquid (a film the core noun didn't already name). The pools
  // vary the vessel word only — the solvent name stays, so the chip never lies
  // about WHICH liquid it is.
  methaneLake: ['Methane-Lake', 'Methane-Pooled'], // hydrocarbon lakes — the defining Smog-world feature
  ammoniaLake: ['Ammonia-Lake', 'Ammonia-Pooled'],
  nitrogenLake:['Nitrogen-Lake', 'Nitrogen-Pooled'],
  // composition
  briny:       ['Saline', 'Briny'],            // heavy solute load in standing liquid
  sulfurous:   ['Sulfurous', 'Sulfur-Caked'],  // sulfur-dominated surface / volcanism
  // surface radiation — the ground face of the magnetosphere axis: a meter
  // reading, not a light show. Rides the material slot (see materialQualifier).
  irradiated:  ['Irradiated'],                 // high incident surface dose (≥ IRRADIATED_DOSE)
  // economic identity — a rare abundant resource PAIRING (not a single deposit,
  // which lives in the info card's resource row)
  rich:        ['Ore-Rich', 'Mineral-Rich'],   // two abundant deposits incl. a strategic (rare-earth / radioactive)
  veined:      ['Vein-Threaded', 'Lode-Veined'], // an abundant exotic deposit paired with another
} as const;

// Core-noun synonym pools — only the evocative nouns we coined, so the biggest
// bare-noun collision buckets ("Glacial Moon", "Frostbound Moon") break up too.
// The generic astronomy nouns (Gas Giant, Gas Dwarf, Ice Giant, Helium Giant)
// stay fixed in `coreFor` — players recognize them. The label vocabulary stays
// free of Earth/Sol-keyed anchors, so there is no Super-Earth / Hot Jupiter /
// Sub-Neptune / Gaian (see coreFor). The world/moon tail is appended at the
// call site, so these are the qualifier only.
const NOUN = {
  frostbound:      ['Frostbound', 'Frost-Sealed'],
  glacial:         ['Glacial', 'Ice-Mantled'],
  desert:          ['Arid', 'Desert'],
  iron:            ['Iron', 'Ferrous', ['Rust-Red', oxidized]], // Rust-Red needs oxidative weathering; Iron/Ferrous are the reduced-grey default
  // Size tails — they REPLACE the bare "Moon" / "World" word for the size
  // extremes (see worldNoun); medium bodies keep the plain tail. The qualifier
  // still prefixes: "Iron Moonlet", "Irradiated Major Moon", "Baking Heavyworld".
  // Kept disjoint from every other pool — a tail is the noun, never a state /
  // material word. Planets carry their scale here too (a large terrestrial reads
  // "Heavyworld", which is also where the old Earth-keyed "Super-Earth" went).
  moonSmall:       ['Moonlet', 'Small Moon'],   // a small attendant moon
  moonLarge:       ['Major Moon'],              // Mars-plus — a world in its own right (planetary-science "major moon")
  planetSmall:     ['Planetoid', 'Dwarf-Planet'], // a small sub-Mars world
  planetLarge:     ['Heavyworld'],              // a massive high-gravity world (absorbs the old Earth-keyed "Super-Earth")
  lava:            ['Lava', 'Molten'],
  // Iconic two-word nouns — a frozen volatile world under an opaque envelope,
  // and a liquid-water ocean buried beneath an ice shell. Both stand alone (the
  // 3-token budget leaves no room for a state), so the pool varies the noun
  // only. Kept disjoint from LEXICON.sealedOcean so the buried-ocean STATE
  // ("Sealed-Ocean Smog Moon") never reads the same as a subglacial CORE.
  veiledIce:       ['Veiled Ice', 'Shrouded Ice'],
  subglacialOcean: ['Subglacial Ocean', 'Ice-Shell Ocean'],
} as const;

// Deterministic synonym selection: the same (body, concept) always resolves to
// the same word. Keying on the concept namespaces the hash, so a body's heat
// word and its dust word are drawn independently. Guarded words ([word, guard]
// pairs) are kept only when their secondary axis passes, so the draw runs over
// the words honest for THIS body — still `hash % len`, just over the survivors.
function draw(b: Body, ns: string, pool: readonly Word[]): string {
  const eligible = pool.filter((w) => typeof w === 'string' || w[1](b));
  const w = eligible[hash32(b.id + '§' + ns) % eligible.length];
  return typeof w === 'string' ? w : w[0];
}
function pick(b: Body, key: keyof typeof LEXICON): string {
  return draw(b, key, LEXICON[key]);
}
function pickNoun(b: Body, key: keyof typeof NOUN): string {
  return draw(b, key, NOUN[key]);
}

// ─── Presentation thresholds ────────────────────────────────────────────────
// Surface-liquid cover below which an ammonia/nitrogen film reads as a state
// modifier ("Ammonia-Lake") rather than the world's defining sea. Mirrors the
// classifier's own floor so the Brimstone noun and the lake modifier never
// both describe the same liquid. (Hydrocarbon has its own lower floor below.)
const LAKE_COVER_FLOOR = 0.05;
// Solute load at which a standing liquid reads "Briny". Rare by design — a
// genuine landmark, not wallpaper (the salinity distribution cliffs above 0.6).
const BRINY_SALINITY = 0.6;
// Methane (hydrocarbon) lakes define a Smog world; show them at the floor
// procgen assigns the hydrocarbon species at (MIN_SURFACE_LIQUID_COVER — a
// trace film below it never gets a species, so a lower floor here is dead) and
// promote a drowned surface (≥ METHANE_SEA_COVER) to a methane-sea core noun.
const METHANE_LAKE_FLOOR = 0.05;
const METHANE_SEA_COVER = 0.5;
// A deposit at/above this grade (of 10) reads "abundant" — well past the
// typical strong deposit (~5), approaching motherlode. A PAIRING of two
// abundant deposits where at least one is strategic / exotic is a rare
// economic landmark (~1% of worlds); a single deposit or a bulk-only pair
// stays in the resource row.
const ABUNDANT_DEPOSIT = 7;
// Radius (Earth radii) at/above which a gaseous envelope reads as a landmark
// of scale ("Massive Gas Giant"). Set past Jupiter (~11.2 R⊕) so the scale word
// is earned by genuine super-jovians, not every gas giant — the disc physics
// saturates near 1 Jupiter radius, so this keys off the visually largest discs
// in the galaxy.
const COLOSSAL_RADIUS = 12;
// Incident surface-radiation dose (0..1) at/above which a body wears the
// "Irradiated" material qualifier. High bar by design — the dose distribution
// is bimodal (unshielded airless / thin-atmosphere worlds saturate near 1), so
// this keeps the word a flagged hazard rather than wallpaper; the belt-bathed
// moons of a magnetized giant are the signature case. Decoupled from
// temperature, so it layers onto a frozen OR a baking world alike.
const IRRADIATED_DOSE = 0.85;
// Moon-size bins (Earth radii). Most moons stay a plain "Moon"; the tails peel
// off only the genuine extremes — a small moonlet below MOON_SMALL_R and a
// Mars-plus near-planet at/above MOON_LARGE_R (our procgen moons skew large, so
// this earns its grandeur near the top of the size distribution). Planets keep
// "World" — their archetype noun already carries scale (Gas Giant, Colossal …).
const MOON_SMALL_R = 0.18;
const MOON_LARGE_R = 0.80;
// Planet-size bins (Earth radii), the terrestrial analogue. A sub-Mars world
// reads "Planetoid" and a massive high-gravity world (≥ PLANET_LARGE_R, the old
// Super-Earth band) reads "Megaworld"; Mars (~0.53) and Earth-mass worlds stay
// a plain "World". Gaseous planets never take a terrestrial tail (see worldNoun
// / coreFor's veiled-ice case).
const PLANET_SMALL_R = 0.50;
const PLANET_LARGE_R = 1.25;
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
const ANCIENT_AGE = 0.12;
// Dynamics / orbital-geometry gates (stateModifier §7b, 8, 11) — the axes the
// heat/sky logic ignores. Each is set near the top of its galaxy-wide
// distribution so the word stays a landmark, not wallpaper.
const STORM_WIND_MS = 250;    // Neptune-class cloud-top jet → visibly storm-banded
const RIVEN_SWING_K = 500;    // day↔night surface-temp spread that reads as fire-and-ice
const TOPPLED_TILT_DEG = 60;  // axis tipped far past upright (Uranus ≈ 98°)
const TIDELOCK_TOL = 0.05;    // rotation within ±5% of the orbital period → tide-locked

// Axes a core noun already conveys, so a state modifier on the same axis is
// redundant and gets skipped. 'methane' covers a hydrocarbon surface; each
// sea-core solvent maps to a material so the redundant-axis skip logic stays
// meaningful across the non-water sea cores.
type Material = 'gas' | 'rock' | 'iron' | 'ice' | 'water' | 'methane' | 'ammonia' | 'sulfur';
interface Core {
  noun: string;
  hot?: boolean;        // core already reads as hot — skip hot temp adjectives
  cold?: boolean;       // core already reads as cold — skip cold temp adjectives
  volcanic?: boolean;   // core already reads as molten/active — skip "Volcanic"
  temperate?: boolean;  // core is itself a temperate living world — skip "Temperate"/"Verdant"
  hazy?: boolean;       // core already implies organic smog — skip "Smog-Shrouded"
  seaCore?: boolean;    // core already names a surface/subsurface sea or ocean — skip lake/sealed-ocean modifiers
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

// The tail noun: a size-keyed word for the body's kind. Most bodies read the
// plain tail ("Moon" / "World"); only the size extremes wear a distinct one
// (see MOON_*_R / PLANET_*_R). The pick is the same deterministic per-(body)
// draw as every other pool, so a body always wears the same size word. Gaseous
// planets do NOT route through here for a terrestrial tail — coreFor's gaseous
// cases carry their own fixed noun (the lone exception, veiled-ice, uses
// plainTail), so "Megaworld" et al. only ever describe rock/ice surfaces.
function worldNoun(b: Body): string {
  const r = b.radiusEarth ?? 0;
  if (isMoon(b)) {
    if (r < MOON_SMALL_R) return pickNoun(b, 'moonSmall');
    if (r >= MOON_LARGE_R) return pickNoun(b, 'moonLarge');
    return 'Moon';
  }
  if (r < PLANET_SMALL_R) return pickNoun(b, 'planetSmall');
  if (r >= PLANET_LARGE_R) return pickNoun(b, 'planetLarge');
  return 'World';
}

// The plain, size-agnostic tail — used where a size word would mislead (the
// gaseous veiled-ice core, whose "World"/"Moon" must not read as a terrestrial
// "Megaworld").
function plainTail(b: Body): string {
  return isMoon(b) ? 'Moon' : 'World';
}

// Surface free of standing liquid (any species) + ice — gates the silicate-
// volcanism modifier so a wet/icy/hydrocarbon-lake body's activity reads as
// cryovolcanic (or nothing), not "Volcanic". iceFraction stays H2O ice;
// surfaceLiquidFraction generalizes "wet" past water alone.
function isDrySurface(b: Body): boolean {
  return (b.surfaceLiquidFraction ?? 0) < 0.1 && (b.iceFraction ?? 0) < 0.3;
}

// Peak cloud-top zonal wind across a body's stratified decks (0 if cloudless) —
// the storm register's axis.
function maxCloudWindMs(b: Body): number {
  let m = 0;
  for (const c of b.cloudLayers) if (c.windSpeedMS > m) m = c.windSpeedMS;
  return m;
}

// Day↔night (or seasonal) surface-temperature spread; 0 when either bound is
// unknown (gaseous bodies, belts) so the fire-and-ice register can't fire on them.
function thermalSwingK(b: Body): number {
  if (b.surfaceTempMaxK == null || b.surfaceTempMinK == null) return 0;
  return b.surfaceTempMaxK - b.surfaceTempMinK;
}

// Rotation synchronized to the orbit — one face holds toward the primary, the
// permanent-day/night world the twilit register names.
function isTideLocked(b: Body): boolean {
  if (b.rotationPeriodHours == null || b.periodDays == null || b.periodDays <= 0) return false;
  return Math.abs(b.rotationPeriodHours - b.periodDays * 24) / (b.periodDays * 24) <= TIDELOCK_TOL;
}

// Archetype → evocative core noun + the axes it already implies. The
// archetype is the physics-derived type (classifyBody); this turns it into
// the player-facing noun and the redundant-axis flags the state layer reads.
function coreFor(b: Body): Core {
  const w = worldNoun(b);
  switch (classifyBody(b)) {
    // ─── gaseous ───
    // A hot Jupiter is just a gas giant that's blazing — drop the Sol-keyed
    // noun (and the hot flag) so the heat-domain state carries it instead:
    // "Searing Gas Giant", "Broiling Gas Giant".
    case 'hot_jupiter':
    case 'gas_giant':        return { noun: 'Gas Giant', material: 'gas' };
    case 'ice_giant':        return { noun: 'Ice Giant', cold: true, material: 'gas' };
    // The small gaseous/volatile-envelope world — the "gas dwarf" to the gas
    // giant. Replaces the Sol-keyed "Sub-Neptune"; heat/scale states still vary
    // it ("Searing Gas Dwarf").
    case 'sub_neptune':      return { noun: 'Gas Dwarf', material: 'gas' };
    // A cold, ice/water-rich sub-Neptune under an opaque H2 envelope — a
    // frozen mini-Neptune. cold + gaseous (no surface) → no temp/composition
    // modifier; the 3-token noun stands alone.
    case 'veiled_ice':       return { noun: `${pickNoun(b, 'veiledIce')} ${plainTail(b)}`, cold: true, material: 'gas' };
    case 'helium':           return { noun: 'Helium Giant', material: 'gas' };
    // ─── iconic surface / subsurface liquid ───
    // A temperate, life-bearing water world — the classic "garden world". Sol-
    // free (was "Gaian", from Gaia/Earth); its scale tail still shows ("Garden
    // Megaworld"). temperate skips the redundant Temperate/Verdant states.
    case 'gaian':            return { noun: `Garden ${w}`, material: 'water', temperate: true };
    case 'tholin': {
      // A cold methane world: orange organic (tholin) smog over hydrocarbon
      // lakes. The smog is the player-facing noun (jargon-free, and it's what
      // you'd see); a drowned surface promotes to a methane sea. cold + hazy
      // skip the redundant Frozen / Smog-Shrouded modifiers (the noun, never
      // "Frozen" — these surfaces are methane, not water ice).
      if ((b.surfaceLiquidFraction ?? 0) >= METHANE_SEA_COVER) {
        return { noun: `Methane Sea ${w}`, cold: true, hazy: true, seaCore: true, material: 'methane' };
      }
      return { noun: `Smog ${w}`, cold: true, hazy: true, material: 'methane' };
    }
    case 'brimstone':        return { noun: `Brimstone ${w}`, hot: true, volcanic: true, material: 'sulfur' };
    case 'ammonia_sea':      return { noun: `Ammonia Sea ${w}`, cold: true, seaCore: true, material: 'ammonia' };
    case 'subglacial_ocean': return { noun: `${pickNoun(b, 'subglacialOcean')} ${w}`, cold: true, seaCore: true, material: 'ice' };
    case 'ocean':            return { noun: `Ocean ${w}`, seaCore: true, material: 'water' };
    // ─── terrestrial base ───
    case 'lava':             return { noun: `${pickNoun(b, 'lava')} ${w}`, hot: true, volcanic: true, material: 'rock' };
    case 'magma_ocean':      return { noun: 'Magma Ocean', hot: true, volcanic: true, seaCore: true, material: 'rock' };
    case 'volcanic':         return { noun: `Volcanic ${w}`, volcanic: true, material: 'rock' };
    // A stripped giant core is hot AND molten — flag both so a redundant
    // "Volcanic"/"Scorched" never stacks onto "Chthonian Core".
    case 'chthonian':        return { noun: 'Chthonian Core', hot: true, volcanic: true, material: 'iron' };
    case 'iron':             return { noun: `${pickNoun(b, 'iron')} ${w}`, material: 'iron' };
    case 'frostbound':       return { noun: `${pickNoun(b, 'frostbound')} ${w}`, cold: true, material: 'methane' };
    case 'glacial':          return { noun: `${pickNoun(b, 'glacial')} ${w}`, cold: true, material: 'ice' };
    // A massive terrestrial — the band real astronomy calls a "super-Earth",
    // which we don't: it's a generic big rock, so it reads exactly like 'rocky'
    // and lets its scale tail ("Megaworld") and surface state carry it, with no
    // Earth-keyed anchor in the chip.
    case 'super_earth':      return { noun: `Rocky ${w}`, material: 'rock', generic: true };
    case 'desert':           return { noun: `${pickNoun(b, 'desert')} ${w}`, material: 'rock' };
    case 'rocky':            return { noun: `Rocky ${w}`, material: 'rock', generic: true };
    case 'unknown':          return { noun: 'Uncharted World', uncharted: true };
  }
}

// A rare abundant resource PAIRING that defines a world's economic identity:
// "Veined" when an exotic deposit is in the mix (the jackpot), else "Rich"
// for a strategic (rare-earth / radioactive) pairing. Bulk-only pairs
// (metal / silicate / volatile) are the ubiquitous default and stay unnamed;
// a single abundant deposit isn't a pairing — it lives in the resource row.
// Returns the LEXICON concept key (the word is resolved by the caller's pick).
function resourcePairKey(b: Body): 'veined' | 'rich' | null {
  let abundant = 0, exotic = false, strategic = false;
  if ((b.resExotics ?? 0)      >= ABUNDANT_DEPOSIT) { abundant++; exotic = true; }
  if ((b.resRareEarths ?? 0)   >= ABUNDANT_DEPOSIT) { abundant++; strategic = true; }
  if ((b.resRadioactives ?? 0) >= ABUNDANT_DEPOSIT) { abundant++; strategic = true; }
  if ((b.resMetals ?? 0)       >= ABUNDANT_DEPOSIT) abundant++;
  if ((b.resSilicates ?? 0)    >= ABUNDANT_DEPOSIT) abundant++;
  if ((b.resVolatiles ?? 0)    >= ABUNDANT_DEPOSIT) abundant++;
  if (abundant < 2) return null;
  if (exotic) return 'veined';
  if (strategic) return 'rich';
  return null;
}

// The single most salient state adjective, in descending salience. Returns
// the resolved synonym for the first concept that fires, or null when the body
// is unremarkable on every axis.
function stateModifier(b: Body, core: Core): string | null {
  const T = b.avgSurfaceTempK;
  const P = b.surfacePressureBar;
  const gas = core.material === 'gas';
  const liquid = b.surfaceLiquidFraction ?? 0;
  // Resolve a concept to its deterministic synonym.
  const fire = (key: keyof typeof LEXICON) => pick(b, key);

  // 1. Life — only when it has reshaped the world's physical essence
  //    (Verdant). Microbial / non-transformative complex life stays in the
  //    info card's dedicated life row, not the headline chip.
  if (b.biosphereComplexity === 'complex' && (b.biosphereSurfaceImpact ?? 0) >= 0.5 && !core.temperate) return fire('verdant');

  // 2. Surface character. Methane lakes are the defining feature of a Smog
  //    world — shown above a low floor (Titan's are only ~3% cover); a drowned
  //    surface is already named a Methane Sea by the core noun. Then the other
  //    exotic-solvent films.
  if (b.surfaceLiquidSpecies === 'hydrocarbon'
      && liquid >= METHANE_LAKE_FLOOR && liquid < METHANE_SEA_COVER) return fire('methaneLake');
  // Other exotic surface lakes the core noun didn't already name — ammonia /
  // nitrogen films on a cold base (Glacial / Frostbound). Hydrocarbon is
  // handled above; sulfur never reaches here — its cover never spans a partial
  // band, so any sulfur surface liquid is already a Brimstone core (there is
  // no sulfur lake modifier).
  if (liquid >= LAKE_COVER_FLOOR && !core.seaCore) {
    switch (b.surfaceLiquidSpecies) {
      case 'ammonia_water':
      case 'ammonia':  return fire('ammoniaLake');
      case 'nitrogen': return fire('nitrogenLake');
      default: break;
    }
  }

  // 3. Economic identity — a rare abundant resource pairing (Rich / Veined).
  //    A landmark that outranks the transient surface states below, but not a
  //    world's defining standing liquids (above) or transformative life.
  const lode = resourcePairKey(b);
  if (lode !== null) return fire(lode);

  // 4. Surface activity.
  // Cryovolcanism: a young icy/watery surface on a cold core.
  if ((core.material === 'ice' || core.material === 'methane' || core.material === 'water')
      && core.cold && (b.surfaceAge ?? 0) >= CRYOVOLCANIC_AGE) return fire('cryovolcanic');
  // A buried ice-shell ocean on a body that doesn't already wear one. A
  // liquid-free buried-ocean world is already a Subglacial Ocean core, so this
  // only fires when something else claimed the core first: a dry, haze-
  // shrouded Smog world (surface lakes below the floor) over a hidden sea.
  if (b.subsurfaceOceanSpecies != null && liquid < LAKE_COVER_FLOOR
      && !core.seaCore) return fire('sealedOcean');
  // Silicate volcanism on a hot, active, dry body the core didn't already
  // mark molten.
  if (!core.volcanic && isDrySurface(b)
      && (b.tectonicActivity ?? 0) >= 0.55 && (b.surfaceAge ?? 0) >= 0.6
      && T !== null && T >= 400) return fire('volcanic');

  // 5. Runaway greenhouse — a thick, hot atmosphere over a dry surface (Venus).
  if (!core.hot && core.material === 'rock' && P !== null && P >= 5
      && T !== null && T >= 340 && liquid < 0.05) return fire('hothouse');

  // 6. Heat — domain-aware, so one temperature never wears one word. A hot
  //    ocean steams, a hot gaseous envelope sears, an extreme dry rock is
  //    scorched, a merely-hot dry rock blisters. Wet outranks dry-extreme so
  //    a high-pressure 600 K+ ocean reads "Steaming", not "Scorched".
  if (!core.hot && T !== null) {
    if (T >= HOT_K && liquid >= 0.1) return fire('steaming');
    if (T >= HOT_EXTREME_K && !gas) return fire('scorched');
    if (T >= HOT_K && gas) return fire('searing');
    if (T >= HOT_K) return fire('blistering');
  }

  // 7. Distinctive atmosphere texture — organic smog (Titan tholin) or a
  //    dust-choked sky. Skipped on cores that already imply smog.
  if (!core.hazy && b.hazeAerosols && (b.hazeAerosols['THOLIN'] ?? 0) >= 0.3) return fire('smog');
  if ((b.dustStrength ?? 0) >= 0.5) return fire('dust');

  // 7b. Fire-and-ice — a day↔night swing so wide the world is two climates at
  //    once (airless or slow-rotating rock). Above the mild single-temperature
  //    bands it would otherwise flatten into; non-gaseous + no buffering sea +
  //    not molten (a lava world is fire-and-fire, its swing isn't the story).
  if (!gas && !core.hot && !core.seaCore && thermalSwingK(b) >= RIVEN_SWING_K) return fire('riven');

  // 8. Twilight & milder temperature bands — skipped on the axis the core implies.
  if (T !== null) {
    // A tide-locked clement world holds one face to its star — a permanent
    // day/night split that reads more vividly than the plain temperate band, so
    // it claims that band first. Needs a solid surface to have faces at all.
    if (!gas && isTideLocked(b) && T >= TEMPERATE_LO_K && T < HOT_K) return fire('twilit');
    // Temperate reads as notable only where there's surface liquid of any
    // species (or the core is a water world) — an airless 290 K rock isn't.
    if (!core.temperate && T >= TEMPERATE_LO_K && T < HOT_K && (liquid > 0 || core.material === 'water')) return fire('temperate');
    if (!core.cold && !gas && T < DEEP_COLD_K) return fire('frigid');
    if (!core.cold && !gas && T < COLD_K) return fire('frozen');
  }

  // 9. Airless rocky body (Luna-class).
  if (core.material === 'rock' && (P === null || P < 0.001)) return fire('airless');

  // 10. Ancient, heavily-cratered surface (Mercury, Callisto). Skipped on
  //    molten/volcanic cores — a repaved surface isn't cratered.
  if (!core.hot && !core.volcanic && (b.surfaceAge ?? 1) <= ANCIENT_AGE) return fire('cratered');

  // 11. Orbital geometry & dynamics — demoted below every surface condition
  //    above (Principle 1: ground-truth leads, the view from orbit follows).
  //    These fire only when nothing more material did — for a gas giant, whose
  //    surface reads can't, they're the primary differentiators.
  // Toppled axis — obliquity tipped far past upright (Uranus-class).
  if ((b.axialTiltDeg ?? 0) >= TOPPLED_TILT_DEG) return fire('toppled');
  // Cloud-top zonal jets read as visible banding / cyclones (Neptune-class).
  if (maxCloudWindMs(b) >= STORM_WIND_MS) return fire('storming');
  // A giant large enough to be a landmark of its own scale. Gaseous cores only.
  if (gas && !core.hot && (b.radiusEarth ?? 0) >= COLOSSAL_RADIUS) return fire('colossal');

  return null;
}

// A composition adjective adjacent to the noun, when distinctive and not
// already carried by the core's material.
function materialQualifier(b: Body, core: Core): string | null {
  // A heavy solute load reads "Briny" — only on an aqueous standing liquid
  // (water / ammonia-water brine). Salinity is a water-chemistry scalar (procgen
  // depresses the freeze point only for these species), so a cryogenic methane /
  // nitrogen film or a molten-sulfur sea never reads "Briny".
  if ((b.surfaceLiquidSpecies === 'water' || b.surfaceLiquidSpecies === 'ammonia_water')
      && (b.salinity ?? 0) >= BRINY_SALINITY) return pick(b, 'briny');
  // Sulfur-dominated surface or sulfur-cycle volcanism (not a gaseous body
  // nor a Brimstone core).
  if (core.material !== 'gas' && core.material !== 'sulfur'
      && (atmFrac(b, 'SO2') >= 0.3 || (b.bioticSulfur ?? 0) >= 0.3)) return pick(b, 'sulfurous');
  // High incident surface-radiation dose — the ground face of the magnetosphere
  // axis (the orbital aurora is deliberately unnamed). Layers onto the world's
  // nature in the material slot rather than displacing its state; last, so the
  // rarer, more specific briny / sulfurous reads win the slot when both apply.
  if ((b.surfaceRadiation ?? 0) >= IRRADIATED_DOSE) return pick(b, 'irradiated');
  return null;
}

function tokenCount(parts: readonly string[]): number {
  // Hyphenated compounds ("Sealed-Ocean", "Subglacial Ocean") count by word;
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
  const material = materialQualifier(b, core);

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
