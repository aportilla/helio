// Composed, descriptive world labels for the body info card — the
// "explorer's-log" voice: a glanceable field-note chip that reads like a
// surveyor's first impression of a world.
//
// PARAMETER-DRIVEN, NOT CLASS-DRIVEN. There is no single body "type". The label
// is assembled from INDEPENDENT physical axes read straight off the body's
// settled state (`scripts/lib/body-traits.mjs` predicates + raw fields), each
// contributing at most one word, ranked by salience, then printed over a
// structural noun. Two worlds that share a composition but differ physically
// read distinctly because their OTHER axes differ — a venting young icy moon and
// a cratered ancient icy moon both end in "Glacial Moon" but lead with the axis
// that actually separates them. Nothing collapses the multi-axis physics to one
// bucket first; the bucket the renderer also refuses to store (see Body's
// biotic-productivity note) stays decomposed here too.
//
// Structure — `[descriptors…] HEAD`, within a hard TOKEN_BUDGET. The head is the
// body's STRUCTURAL noun: the gaseous-envelope class (Gas Giant / Ice Giant /
// Gas Dwarf / Helium Giant / Veiled Ice), an iconic named world the surface-
// liquid data unlocks (Garden / Smog / Methane Sea / Ammonia Sea / Subglacial
// Ocean / Ocean / Brimstone / Magma Ocean / Chthonian Core / Lava), or a plain
// kind+scale tail (Moonlet → Moon → Major Moon, Planetoid → World → Heavyworld).
// Everything else — including the common terrestrial bulk identity (glacial,
// frostbound, iron, arid) — is a DESCRIPTOR competing for the remaining budget by
// salience, so a world's most-distinguishing conditions win the slots rather
// than its compositional name eating them. The card auto-sizes to the label, so
// the budget is a legibility choice, not a layout limit.
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
//      cruiser. Surface-radiation dose is a clear ground-truth read, but it goes
//      to the detail card, not the chip — the magnetosphere's orbital aurora is
//      off-register, and its ground face is a meter reading the card reports
//      rather than a scarce label token.
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
// two pools (a thermal + composition pair can never read "Frozen Frozen"). A
// pool word can carry a GUARD on a secondary axis the firing concept doesn't
// itself check — "Glaciated" needs ice, "Wind-Scoured" needs air — and drops out
// of the draw when that axis fails, so a cold airless rock reads "Frozen", never
// "Wind-Scoured". The pools just multiply phrasings; they never change which
// CONCEPT fires (that's the physics-keyed logic below). The coinage core nouns we
// own (Frostbound, Glacial, Desert, Iron, Lava, Veiled Ice, Subglacial Ocean)
// are pooled too; the generic astronomy nouns (Gas Giant, Gas Dwarf, Ice Giant,
// Helium Giant) stay fixed, players know them. We keep the chip free of
// Earth/Sol-keyed anchors: there is deliberately no "Super-Earth" (→ scale tail
// "Heavyworld"), no "Hot Jupiter" (→ heat state "Searing Gas Giant"), no "Sub-
// Neptune" (→ "Gas Dwarf"), and no "Gaian" (→ "Garden World").
//
// Bodies wear their SCALE in the head tail (see worldNoun): a moon spans Moonlet
// → Moon → Major Moon, a planet Planetoid → World → Heavyworld. The gaseous
// giants instead take a dry scale DESCRIPTOR ("Massive Gas Giant"), since their
// head is a fixed archetype noun, not "World".
//
// Pure runtime function — no catalog rebuild, no stored label. Thresholds are
// presentation choices (when a world "reads as" scorched / temperate / briny),
// intentionally coarser than the physics; tune them in LEXICON + the threshold
// consts here freely. `scripts/dump-labels.mjs` dumps the whole galaxy's labels
// (it imports THIS function, so no drift) — run it after a vocabulary edit to
// see the new distribution.

import type { AtmGas, Body } from '../../data/stars';
import {
  isClassifiable, isGaseousBody, isVeiledIce, isHelium, isGasGiant, isIceGiant,
  isGaian, isTholin, isBrimstone, isAmmoniaSea, isSubglacialOcean, isOcean,
  isChthonian, isMagmaOcean, isLava, isVolcanic, isIron, isFrostbound, isGlacial, isDesert,
} from '../../../scripts/lib/body-traits.mjs';
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
// two pools, so a thermal + composition pair can never read "Frozen Frozen". A
// word may be a bare string or a `[word, guard]` pair gated on a secondary
// physical axis (see the secondary-axis guards above) — guarded words drop out
// when that axis fails, so a cold airless world never reads "Wind-Scoured".
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
  // heat (domain-aware — see descriptors)
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
  // the surface conditions (see descriptors): Neptune-class cloud-top jets, an
  // axis tipped past upright, a tide-locked spin, a day↔night swing wide enough
  // to read as two climates. The magnetosphere is NOT named here at all — the
  // surface-radiation dose is a detail-card reading, not a chip token (it may
  // later tint another token as a secondary influence, but it never claims a
  // slot of its own); the orbital aurora is a view-from-orbit spectacle, off
  // this register entirely.
  storming:    ['Banded', 'Cyclonic'],        // fast cloud-top zonal jets
  riven:       ['Riven'],                      // fire-and-ice: extreme day↔night temperature spread
  toppled:     ['Toppled'],                    // obliquity tipped far past upright (Uranus ≈ 98°)
  twilit:      ['Tide-Locked', 'Twilit'],      // rotation synced to orbit — a fixed day/night face
  // exotic standing liquid (a film the head didn't already name). The pools vary
  // the vessel word only — the solvent name stays, so the chip never lies about
  // WHICH liquid it is.
  methaneLake: ['Methane-Lake', 'Methane-Pooled'], // hydrocarbon lakes — the defining Smog-world feature
  ammoniaLake: ['Ammonia-Lake', 'Ammonia-Pooled'],
  nitrogenLake:['Nitrogen-Lake', 'Nitrogen-Pooled'],
  // composition
  briny:       ['Saline', 'Briny'],            // heavy solute load in standing liquid
  sulfurous:   ['Sulfurous', 'Sulfur-Caked'],  // sulfur-dominated surface / volcanism
  // economic identity — a rare abundant resource PAIRING (not a single deposit,
  // which lives in the info card's resource row)
  rich:        ['Ore-Rich', 'Mineral-Rich'],   // two abundant deposits incl. a strategic (rare-earth / radioactive)
  veined:      ['Vein-Threaded', 'Lode-Veined'], // an abundant exotic deposit paired with another
} as const;

// Core-noun synonym pools — only the evocative nouns we coined, so the biggest
// bare-noun collision buckets break up too. The generic astronomy nouns (Gas
// Giant, Gas Dwarf, Ice Giant, Helium Giant) stay fixed in `deriveCore` —
// players recognize them. The label vocabulary stays free of Earth/Sol-keyed
// anchors, so there is no Super-Earth / Hot Jupiter / Sub-Neptune / Gaian. The
// world/moon tail is appended at the call site, so these are the qualifier only.
const NOUN = {
  frostbound:      ['Frostbound', 'Frost-Sealed'],
  glacial:         ['Glacial', 'Ice-Mantled'],
  desert:          ['Arid', 'Desert'],
  iron:            ['Iron', 'Ferrous', ['Rust-Red', oxidized]], // Rust-Red needs oxidative weathering; Iron/Ferrous are the reduced-grey default
  // Size tails — the head's kind+scale word. Most bodies read the plain tail
  // ("Moon" / "World"); only the size extremes wear a distinct one (see
  // MOON_*_R / PLANET_*_R). Kept single-token where possible so the scale never
  // crowds a physical descriptor out of the budget. Kept disjoint from every
  // other pool — a tail is the head, never a descriptor word. Planets carry
  // their scale here too (a large terrestrial reads "Heavyworld", which is also
  // where the old Earth-keyed "Super-Earth" went).
  moonSmall:       ['Moonlet'],                 // a small attendant moon
  moonLarge:       ['Major Moon'],              // Mars-plus — a world in its own right (planetary-science "major moon")
  planetSmall:     ['Planetoid', 'Dwarf-Planet'], // a small sub-Mars world
  planetLarge:     ['Heavyworld'],              // a massive high-gravity world (absorbs the old Earth-keyed "Super-Earth")
  lava:            ['Lava', 'Molten'],
  // Iconic two-word nouns — a frozen volatile world under an opaque envelope,
  // and a liquid-water ocean buried beneath an ice shell. Kept disjoint from
  // LEXICON.sealedOcean so the buried-ocean DESCRIPTOR ("Sealed-Ocean Smog
  // Moon") never reads the same as a subglacial HEAD.
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
// Total token budget for the whole chip including the head. Four keeps the chip
// glanceable while leaving room for a structural head plus the two or three
// physical axes that actually distinguish similar worlds; the info card auto-
// sizes its width to the label, so this is a legibility choice, not a layout cap.
const TOKEN_BUDGET = 4;
// Surface-liquid cover below which an ammonia/nitrogen film reads as a descriptor
// ("Ammonia-Lake") rather than the world's defining sea. Mirrors the head's own
// floor so the Brimstone head and the lake descriptor never both describe the
// same liquid. (Hydrocarbon has its own lower floor below.)
const LAKE_COVER_FLOOR = 0.05;
// Solute load at which a standing liquid reads "Briny". Rare by design — a
// genuine landmark, not wallpaper (the salinity distribution cliffs above 0.6).
const BRINY_SALINITY = 0.6;
// Methane (hydrocarbon) lakes define a Smog world; show them at the floor procgen
// assigns the hydrocarbon species at (MIN_SURFACE_LIQUID_COVER — a trace film
// below it never gets a species, so a lower floor here is dead) and promote a
// drowned surface (≥ METHANE_SEA_COVER) to a methane-sea head.
const METHANE_LAKE_FLOOR = 0.05;
const METHANE_SEA_COVER = 0.5;
// A deposit at/above this grade (of 10) reads "abundant" — well past the typical
// strong deposit (~5), approaching motherlode. A PAIRING of two abundant
// deposits where at least one is strategic / exotic is a rare economic landmark
// (~1% of worlds); a single deposit or a bulk-only pair stays in the resource row.
const ABUNDANT_DEPOSIT = 7;
// Radius (Earth radii) at/above which a gaseous envelope reads as a landmark of
// scale ("Massive Gas Giant"). Set past Jupiter (~11.2 R⊕) so the scale word is
// earned by genuine super-jovians, not every gas giant — the disc physics
// saturates near 1 Jupiter radius, so this keys off the visually largest discs
// in the galaxy.
const COLOSSAL_RADIUS = 12;
// Moon-size bins (Earth radii). Most moons stay a plain "Moon"; the tails peel
// off only the genuine extremes — a small moonlet below MOON_SMALL_R and a
// Mars-plus near-planet at/above MOON_LARGE_R (our procgen moons skew large, so
// this earns its grandeur near the top of the size distribution).
const MOON_SMALL_R = 0.18;
const MOON_LARGE_R = 0.80;
// Planet-size bins (Earth radii), the terrestrial analogue. A sub-Mars world
// reads "Planetoid" and a massive high-gravity world (≥ PLANET_LARGE_R, the old
// Super-Earth band) reads "Heavyworld"; Mars (~0.53) and Earth-mass worlds stay
// a plain "World". Gaseous planets never take a terrestrial tail (their head is
// a fixed gaseous noun; veiled-ice uses plainTail).
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
// Silicate-volcanism state gate — a hot, active, dry surface the head didn't
// already mark molten (the molten heads set core.volcanic). Above the predicate's
// own tidal/warm gates so the WORD reads as visible eruptive resurfacing.
const VOLCANIC_STATE_TECT = 0.55;
const VOLCANIC_STATE_AGE = 0.6;
const VOLCANIC_STATE_TEMP_K = 400;
// Dynamics / orbital-geometry gates — the axes the heat/sky logic ignores. Each
// is set near the top of its galaxy-wide distribution so the word stays a
// landmark, not wallpaper.
const STORM_WIND_MS = 250;    // Neptune-class cloud-top jet → visibly storm-banded
const RIVEN_SWING_K = 500;    // day↔night surface-temp spread that reads as fire-and-ice
const TOPPLED_TILT_DEG = 60;  // axis tipped far past upright (Uranus ≈ 98°)
const TIDELOCK_TOL = 0.05;    // rotation within ±5% of the orbital period → tide-locked
// Runaway-greenhouse gate (Venus) — a thick, hot, dry atmosphere over rock.
const HOTHOUSE_PRESSURE_BAR = 5;
const HOTHOUSE_TEMP_K = 340;

// Axes the head already conveys, so a descriptor on the same axis is redundant
// and gets skipped. 'methane' covers a hydrocarbon surface; each sea head solvent
// maps to a material so the redundant-axis skip stays meaningful across the
// non-water sea heads.
type Material = 'gas' | 'rock' | 'iron' | 'ice' | 'water' | 'methane' | 'ammonia' | 'sulfur';
interface Core {
  head: string;          // the structural / iconic noun phrase the descriptors print before
  hot?: boolean;         // head already reads as hot — skip hot temp descriptors
  cold?: boolean;        // head/composition already reads as cold — skip cold temp descriptors
  volcanic?: boolean;    // head already reads as molten/active — skip "Volcanic"
  temperate?: boolean;   // head is itself a temperate living world — skip "Temperate"/"Verdant"
  hazy?: boolean;        // head already implies organic smog — skip "Smog"
  seaCore?: boolean;     // head already names a surface/subsurface sea — skip lake/sealed-ocean descriptors
  uncharted?: boolean;   // no classifiable physics — emit the head alone
  material: Material;
  composition?: string;  // the demoted bulk identity word (Glacial / Iron / Arid / …), a descriptor
}

// A single ranked descriptor: a resolved word, the grammatical SLOT it prints in
// (lower = further left, away from the noun), and a keep PRIORITY (higher wins a
// scarce budget slot). Slot and priority are independent: radiation prints far
// left ("Irradiated …") but outranks composition for the budget.
interface Descriptor { readonly slot: number; readonly prio: number; readonly word: string; }
// Print slots, left → right (the head sits to the right of them all).
const SLOT = {
  LEAD: 0,     // life, defining lakes, economic identity, buried ocean
  SKY: 1,      // smog, dust, airless
  AGE: 2,      // cratered
  DYN: 3,      // riven, twilit, toppled, storming, colossal scale
  THERMAL: 4,  // heat / cold band
  ACTIVITY: 5, // volcanic, cryovolcanic, briny, sulfurous
  COMP: 6,     // the bulk composition word, adjacent to the head
} as const;

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
// plain tail ("Moon" / "World"); only the size extremes wear a distinct one (see
// MOON_*_R / PLANET_*_R). The pick is the same deterministic per-(body) draw as
// every other pool. Gaseous planets do NOT route through here for a terrestrial
// tail — deriveCore's gaseous cases carry their own fixed noun (the lone
// exception, veiled-ice, uses plainTail).
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
// gaseous veiled-ice head, whose "World"/"Moon" must not read as a terrestrial
// "Heavyworld").
function plainTail(b: Body): string {
  return isMoon(b) ? 'Moon' : 'World';
}

// Surface free of standing liquid (any species) + ice — gates the silicate-
// volcanism descriptor so a wet/icy/hydrocarbon-lake body's activity reads as
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

// The structural / iconic head + the axes it already implies (redundancy flags
// the descriptor layer reads) + the demoted composition word, all read straight
// off physics predicates — no stored or collapsed type. Order is a head-naming
// priority only: the gaseous bracket, then the iconic named worlds the surface-
// liquid data unlocks, then a plain kind+scale tail carrying the common bulk
// identity as a `composition` descriptor rather than as the head itself.
function deriveCore(b: Body): Core {
  if (!isClassifiable(b)) return { head: `Uncharted ${plainTail(b)}`, material: 'rock', uncharted: true };
  const tail = worldNoun(b);

  // ─── gaseous bracket — the head IS the structural envelope class ───
  if (isGaseousBody(b)) {
    if (isVeiledIce(b)) return { head: `${pickNoun(b, 'veiledIce')} ${plainTail(b)}`, cold: true, material: 'gas' };
    if (isHelium(b))    return { head: 'Helium Giant', material: 'gas' };
    if (isGasGiant(b))  return { head: 'Gas Giant', material: 'gas' };
    if (isIceGiant(b))  return { head: 'Ice Giant', cold: true, material: 'gas' };
    return { head: 'Gas Dwarf', material: 'gas' };
  }

  // ─── iconic named worlds — surface/subsurface liquid + molten extremes ───
  if (isBrimstone(b)) return { head: `Brimstone ${tail}`, hot: true, volcanic: true, material: 'sulfur' };
  if (isTholin(b)) {
    if ((b.surfaceLiquidFraction ?? 0) >= METHANE_SEA_COVER) {
      return { head: `Methane Sea ${tail}`, cold: true, hazy: true, seaCore: true, material: 'methane' };
    }
    return { head: `Smog ${tail}`, cold: true, hazy: true, material: 'methane' };
  }
  if (isGaian(b))           return { head: `Garden ${tail}`, material: 'water', temperate: true, seaCore: true };
  if (isAmmoniaSea(b))      return { head: `Ammonia Sea ${tail}`, cold: true, seaCore: true, material: 'ammonia' };
  if (isSubglacialOcean(b)) return { head: `${pickNoun(b, 'subglacialOcean')} ${tail}`, cold: true, seaCore: true, material: 'ice' };
  if (isChthonian(b))       return { head: 'Chthonian Core', hot: true, volcanic: true, material: 'iron' };
  if (isMagmaOcean(b))      return { head: 'Magma Ocean', hot: true, volcanic: true, seaCore: true, material: 'rock' };
  if (isLava(b))            return { head: `${pickNoun(b, 'lava')} ${tail}`, hot: true, volcanic: true, material: 'rock' };
  if (isOcean(b))           return { head: `Ocean ${tail}`, seaCore: true, material: 'water' };

  // ─── common terrestrial bulk — a plain head, the identity rides as a
  //     composition descriptor so the budget goes to what distinguishes worlds ───
  if (isIron(b))       return { head: tail, composition: pickNoun(b, 'iron'), material: 'iron' };
  if (isFrostbound(b)) return { head: tail, composition: pickNoun(b, 'frostbound'), cold: true, material: 'methane' };
  if (isGlacial(b))    return { head: tail, composition: pickNoun(b, 'glacial'), cold: true, material: 'ice' };
  if (isDesert(b))     return { head: tail, composition: pickNoun(b, 'desert'), material: 'rock' };
  return { head: tail, material: 'rock' };   // generic rock — the descriptor stack carries all its character
}

// The head noun phrase alone — exposed for dump-labels.mjs so it can group the
// galaxy by head without re-deriving (it imports THIS module, so no drift).
export function coreNoun(b: Body): string {
  return deriveCore(b).head;
}

// A rare abundant resource PAIRING that defines a world's economic identity:
// "Veined" when an exotic deposit is in the mix (the jackpot), else "Rich" for a
// strategic (rare-earth / radioactive) pairing. Bulk-only pairs (metal /
// silicate / volatile) are the ubiquitous default and stay unnamed; a single
// abundant deposit isn't a pairing — it lives in the resource row. Returns the
// LEXICON concept key (the word is resolved by the caller's pick).
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

// Every physical axis that reads as notable on THIS body, each resolved to a
// word with a print slot + keep priority. The budget then keeps the highest-
// priority axes that fit and prints them in slot order. No first-match collapse:
// a world surfaces as many distinguishing axes as the budget holds.
function descriptors(b: Body, core: Core): Descriptor[] {
  const out: Descriptor[] = [];
  const push = (slot: number, prio: number, word: string) => out.push({ slot, prio, word });
  const fire = (key: keyof typeof LEXICON, slot: number, prio: number) => push(slot, prio, pick(b, key));

  const T = b.avgSurfaceTempK;
  const P = b.surfacePressureBar;
  const gas = core.material === 'gas';
  const liquid = b.surfaceLiquidFraction ?? 0;
  const sp = b.surfaceLiquidSpecies;

  // ── LEAD: the identity-defining reads that outrank surface conditions ──
  // Life — only when it has reshaped the world's physical essence (Verdant).
  // Microbial / non-transformative complex life stays in the info card's life row.
  if (b.biosphereComplexity === 'complex' && (b.biosphereSurfaceImpact ?? 0) >= 0.5 && !core.temperate) {
    fire('verdant', SLOT.LEAD, 95);
  }
  // Defining surface lakes the head didn't already name. Methane lakes are the
  // signature of a Smog world (Titan's are only ~3% cover); a drowned surface is
  // already a Methane Sea head. Then the other exotic-solvent films on a cold base.
  if (sp === 'hydrocarbon' && liquid >= METHANE_LAKE_FLOOR && liquid < METHANE_SEA_COVER) {
    fire('methaneLake', SLOT.LEAD, 72);
  } else if (liquid >= LAKE_COVER_FLOOR && !core.seaCore) {
    if (sp === 'ammonia_water' || sp === 'ammonia') fire('ammoniaLake', SLOT.LEAD, 72);
    else if (sp === 'nitrogen') fire('nitrogenLake', SLOT.LEAD, 72);
  }
  // A buried ice-shell ocean on a body that doesn't already wear one (a dry,
  // haze-shrouded Smog world over a hidden sea).
  if (b.subsurfaceOceanSpecies != null && liquid < LAKE_COVER_FLOOR && !core.seaCore) {
    fire('sealedOcean', SLOT.LEAD, 68);
  }
  // Economic identity — a rare abundant resource pairing.
  const lode = resourcePairKey(b);
  if (lode !== null) fire(lode, SLOT.LEAD, 60);

  // ── COMP: the demoted bulk identity, adjacent to the head ──
  if (core.composition) push(SLOT.COMP, 90, core.composition);

  // ── ACTIVITY ──
  // Cryovolcanism: a young icy/watery surface on a cold core.
  if ((core.material === 'ice' || core.material === 'methane' || core.material === 'water')
      && core.cold && (b.surfaceAge ?? 0) >= CRYOVOLCANIC_AGE) {
    fire('cryovolcanic', SLOT.ACTIVITY, 66);
  }
  // Silicate volcanism on a hot/young/active, dry body the head didn't already
  // mark molten — covers the warm-melt and tidal-volcanic predicate cases.
  if (!core.volcanic && isVolcanic(b) && isDrySurface(b)
      && ((b.tectonicActivity ?? 0) >= VOLCANIC_STATE_TECT
          && (b.surfaceAge ?? 0) >= VOLCANIC_STATE_AGE
          && T !== null && T >= VOLCANIC_STATE_TEMP_K
          || (T !== null && T < VOLCANIC_STATE_TEMP_K))) {
    fire('volcanic', SLOT.ACTIVITY, 64);
  }

  // ── THERMAL (domain-aware) — at most one fires ──
  let thermal = false;
  // Runaway greenhouse — a thick, hot atmosphere over a dry surface (Venus).
  if (!core.hot && core.material === 'rock' && P !== null && P >= HOTHOUSE_PRESSURE_BAR
      && T !== null && T >= HOTHOUSE_TEMP_K && liquid < 0.05) {
    fire('hothouse', SLOT.THERMAL, 76); thermal = true;
  }
  if (!thermal && !core.hot && T !== null) {
    if (T >= HOT_K && liquid >= 0.1) { fire('steaming', SLOT.THERMAL, 75); thermal = true; }
    else if (T >= HOT_EXTREME_K && !gas) { fire('scorched', SLOT.THERMAL, 75); thermal = true; }
    else if (T >= HOT_K && gas) { fire('searing', SLOT.THERMAL, 75); thermal = true; }
    else if (T >= HOT_K) { fire('blistering', SLOT.THERMAL, 75); thermal = true; }
  }
  if (!thermal && T !== null) {
    const tideLocked = !gas && isTideLocked(b);
    if (tideLocked && T >= TEMPERATE_LO_K && T < HOT_K) { fire('twilit', SLOT.DYN, 50); }
    else if (!core.temperate && T >= TEMPERATE_LO_K && T < HOT_K && (liquid > 0 || core.material === 'water')) {
      fire('temperate', SLOT.THERMAL, 73); thermal = true;
    }
    if (!core.cold && !gas && T < DEEP_COLD_K) { fire('frigid', SLOT.THERMAL, 74); thermal = true; }
    else if (!core.cold && !gas && T < COLD_K) { fire('frozen', SLOT.THERMAL, 74); thermal = true; }
  }

  // ── SKY: atmosphere texture ──
  if (!core.hazy && b.hazeAerosols && (b.hazeAerosols['THOLIN'] ?? 0) >= 0.3) fire('smog', SLOT.SKY, 44);
  if ((b.dustStrength ?? 0) >= 0.5) fire('dust', SLOT.SKY, 46);
  if (core.material === 'rock' && (P === null || P < 0.001)) fire('airless', SLOT.SKY, 38);

  // ── AGE: ancient, heavily-cratered surface (skipped on molten/volcanic heads) ──
  if (!core.hot && !core.volcanic && (b.surfaceAge ?? 1) <= ANCIENT_AGE) fire('cratered', SLOT.AGE, 36);

  // ── DYN: orbital geometry & dynamics — the gas giant's primary differentiators ──
  if (!gas && !core.hot && !core.seaCore && thermalSwingK(b) >= RIVEN_SWING_K) fire('riven', SLOT.DYN, 48);
  if ((b.axialTiltDeg ?? 0) >= TOPPLED_TILT_DEG) fire('toppled', SLOT.DYN, 32);
  if (maxCloudWindMs(b) >= STORM_WIND_MS) fire('storming', SLOT.DYN, 34);
  if (gas && !core.hot && (b.radiusEarth ?? 0) >= COLOSSAL_RADIUS) fire('colossal', SLOT.DYN, 33);

  // ── ACTIVITY (chemistry): briny / sulfurous, adjacent to composition ──
  if ((sp === 'water' || sp === 'ammonia_water') && (b.salinity ?? 0) >= BRINY_SALINITY) {
    fire('briny', SLOT.ACTIVITY, 56);
  }
  if (core.material !== 'gas' && core.material !== 'sulfur'
      && (atmFrac(b, 'SO2') >= 0.3 || (b.bioticSulfur ?? 0) >= 0.3)) {
    fire('sulfurous', SLOT.ACTIVITY, 56);
  }

  return out;
}

function tokenCount(s: string): number {
  // Hyphenated compounds ("Sealed-Ocean", "Subglacial Ocean") count by word; a
  // hyphen stays one token.
  return s.split(' ').length;
}

// Compose the full label: `[descriptors…] HEAD`, within TOKEN_BUDGET. The head is
// mandatory and claims first; the remaining budget goes to the highest-priority
// physical axes that fit, printed in grammatical slot order — so a world reads
// with as many of its distinguishing axes as the chip holds, not one collapsed
// identity.
export function composeWorldLabel(b: Body): string {
  const core = deriveCore(b);
  if (core.uncharted) return core.head;

  let budget = TOKEN_BUDGET - tokenCount(core.head);
  const kept: Descriptor[] = [];
  // Keep by priority (most distinguishing first), bounded by the token budget.
  for (const d of [...descriptors(b, core)].sort((a, z) => z.prio - a.prio)) {
    const tc = tokenCount(d.word);
    if (tc <= budget) { kept.push(d); budget -= tc; }
  }
  // Print in slot order (left → right), head last.
  kept.sort((a, z) => a.slot - z.slot || z.prio - a.prio);
  return [...kept.map((d) => d.word), core.head].join(' ');
}
