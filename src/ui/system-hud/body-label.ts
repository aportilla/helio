// Composed world labels for the body info card — a generative BIOME NAME for the
// place, printed as the card's subtitle beneath the body's name.
//
// WHAT THIS IS NOT: a body taxonomy. The hover card already states the structural
// facts — moon vs planet vs giant, spectral class, temperature, pressure,
// radiation, standing liquid. Re-printing "Moon" / "Gas Giant" here would spend
// the label on the lowest-information word on screen. So the label does the one
// thing the data rows can't: it names what it's like to STAND on the surface.
//
// VOICE: evocative, a landscape field-name — not a dry instrument readout.
//
// GENERATIVE, NOT PLUCKED. The label is built, not looked up: `[LEAD] [TERRAIN]`,
// a single lead descriptor over a terrain noun — "Iron-Streaked Badlands",
// "Smoldering Basalt Wastes", "Storm-Lashed Shallows". Each biome family owns two
// small pools — a `terrain` pool (the head nouns: Badlands, Wastes, Dunes, …) and
// a `lead` pool (its signature adjectives: Smoldering, Wind-Scoured, …) — and the
// label composes one of each. The combinatorics (leads × terrains) give the
// variety; the tight two-slot shape keeps every label 2–3 words.
//
// CONDITIONS REPLACE THE LEAD, THEY DON'T STACK. A notable physical condition —
// an ancient cratered crust, a fire-and-ice day↔night swing, a briny sea, a
// metal-streaked surface — supplies the lead INSTEAD of the family's signature
// adjective, never in addition to it. Exactly one lead is ever emitted, so the
// worst case is `[condition] [two-word terrain]` = three words, not the four-word
// pile-ups a front-stacked modifier layer produced. When more than one condition
// fires, the most place-defining one wins the slot (see COND). Conditions are
// kept genuinely RARE (tail-of-distribution thresholds) so they read as standouts
// and don't smother a family's signature vocabulary — a near-universal axis (like
// tide-lock, ~half of planets) is no axis at all, so it earns no lead.
//
// The metal-rich lead is itself a SUB-GENERATOR: `[metal]-[texture]` composes
// "Nickel-Crusted", "Cobalt-Streaked", "Titanium-Veined" so an iron world isn't
// one fixed phrase. Same composing-not-plucking principle, one level down.
//
// STILL PARAMETER-DRIVEN, NO CLASSIFIER. The family is chosen by a precedence
// cascade over the INDEPENDENT, non-exclusive physics predicates in
// `scripts/lib/body-traits.mjs` (`isLava`, `isGlacial`, `isOcean`, …) plus raw
// settled fields. Nothing collapses the multi-axis physics to a stored type; the
// cascade just decides which axis dominates a world's SENSE OF PLACE.
//
// THREE REGISTERS, by domain:
//   • SURFACE worlds (terrestrial bracket) wear a LANDSCAPE — the families
//     below (Volcanic, Frozen, Salt-Flats, Arid, Oceanic, Lush, Temperate,
//     Toxic, Barren, Tundra, Subterranean, Carbon, Exotic). Salt-Flats is the
//     revived Crystalline slot, keyed on real desiccation (warm + dry + high
//     salinity); Carbon is a dry rocky body in a C/O>1 disk (graphite / tar).
//   • GASEOUS worlds (no ground) wear a SKYSCAPE — a cloudscape register keyed off
//     the gaseous predicates (deriveSky), composed the same `[lead] [terrain]` way.
//   • BELTS / RINGS get no label — the card's subtitleFor returns null for them.
//
// One remapping worth flagging: SUBTERRANEAN keys off `isSubglacialOcean` — a
// buried-ocean world's habitable zone genuinely IS underground — but only when
// the surface is plain water ice. A world wearing a defining exotic frost
// (N₂/CH₄/CO₂/NH₃) reads by that surface instead, so Triton is a nitrogen world,
// not a sea it happens to hide.
//
// HONESTY. Pools and conditions carry GUARDS on secondary axes they assert (a
// kelp lead needs life; an oxidized "Rust-Red" needs weathering; heat phrasings
// need real heat). A condition word is also skipped when the chosen terrain
// already says it (substring conflict), so "Briny Brine Seas" can't happen. The
// frozen family splits on the REAL surface-frost species (procgen's
// surfaceFrostSpecies) so a water-ice world never reads "Methane" and a methane
// world never reads "Glacier". Each pick is deterministic per (body, slot) via
// `hash32(b.id)`, so a world always wears the same name.
//
// Two rules carried over: LIFE earns the family only when it has TRANSFORMED the
// world (complex + high surface impact → Lush); lesser life only biases phrasing
// through guards. And surface RADIATION never touches the label — it's a
// detail-card meter, not a family selector or a lead.
//
// Pure runtime function — no catalog rebuild, no stored label. Thresholds are
// presentation choices; tune the pools + consts freely. `scripts/dump-labels.mjs`
// dumps the whole galaxy's labels (it imports THIS module, so no drift).

import type { Body } from '../../data/stars';
import {
  isClassifiable, isGaseousBody, isVeiledIce, isHelium, isGasGiant, isHotGiant,
  isIceGiant, isBrimstone, isTholin, isAmmoniaSea, isSubglacialOcean, isOcean,
  isChthonian, isMagmaOcean, isLava, isVolcanic, isIron, isFrostbound, isGlacial,
  isDesert,
} from '../../../scripts/lib/body-traits.mjs';
import { hash32 } from '../../../scripts/lib/prng.mjs';

// ─── Secondary-axis guards ──────────────────────────────────────────────────
// A pool word may quietly assert a SECOND axis beyond the one that selected its
// family. So a word can be a bare string OR a `[word, guard]` pair; `draw` keeps
// only words whose guard passes. Every pool keeps ≥1 unguarded word.
type Guard = (b: Body) => boolean;
type Word = string | readonly [string, Guard];
const hasLife: Guard = (b) => b.biosphereComplexity != null && b.biosphereComplexity !== 'none';
const oxidized: Guard = (b) => (b.dustStrength ?? 0) > 0;            // ferric weathering → a genuine rust hue
const warm: Guard = (b) => (b.avgSurfaceTempK ?? 0) >= 250;          // heat phrasings need real heat (≥ TEMPERATE_LO_K)
const tepid: Guard = (b) => (b.avgSurfaceTempK ?? 0) < 500;          // "brine" implies recent liquid — not a scorching crust
// Wetness axis (S3): surfaceLiquidFraction is the real moisture measure, so
// wetland / river vocabulary needs genuine standing water and steppe / scrub
// vocabulary needs its absence — instead of the two being hash-drawn regardless.
const wet: Guard = (b) => (b.surfaceLiquidFraction ?? 0) >= WET_LIQUID;
const parched: Guard = (b) => (b.surfaceLiquidFraction ?? 0) < PARCHED_LIQUID;
const damp: Guard = (b) => (b.surfaceLiquidFraction ?? 0) > 0;       // marsh/bog terrain needs some standing liquid
// Surface mineralogy (S6): the desert/barren MATERIAL is a physical read, not
// free flavor. Oxidized (ferric) worlds wear red minerals; water-formed
// sediments (sandstone/clay/shale) need a water history to have ever bedded.
const hadWater: Guard = (b) => (b.bulkWaterFraction ?? 0) > 0.001;

// ─── Biome families: a terrain (noun) pool + a lead (adjective) pool ─────────
// `[lead] [terrain]` composes the label. Terrains are pure nouns (some carry a
// material, e.g. "Basalt Wastes"); leads are the family's axis-NEUTRAL signature
// textures — anything that asserts a measured axis (iron, cratered, dust, tide,
// briny) lives in COND instead, so a lead never lies. Frozen splits water vs
// volatile ice (see deriveBiome); the volatile pool carries the species in the
// terrain so the lead stays free.
// A terrain is a sub-generator: a `land` (landform noun) pool, optionally crossed
// with a `mat` (material qualifier) pool to compose `[material] [landform]` —
// "Basalt Wastes", "Amethyst Spires" — the same composing-not-plucking idea as
// the metal lead, one slot down. A hash gate leaves a share of terrains bare
// ("Calderas") so labels keep their 2-word / 3-word mix. Families whose terrains
// are self-complete (oceanic, lush, …) carry no `mat`.
interface Terrain { land: readonly Word[]; mat?: readonly Word[]; }
interface Family { label: string; terrain: Terrain; lead: readonly Word[]; }
const FAMILIES = {
  // hot silicate volcanism (lava / magma / warm-melt rock)
  volcanic: {
    label: 'Volcanic',
    terrain: { land: ['Wastes', 'Terraces', 'Plains', 'Fields', 'Seas', 'Flats', 'Badlands', 'Calderas', 'Desolation'],
               mat: ['Basalt', 'Lava', 'Ash', 'Obsidian', 'Magma', 'Cinder', 'Pumice', 'Scoria'] },
    lead: ['Smoldering', 'Fissured', 'Cinder-Strewn', 'Glassblown', 'Cooling', 'Molten', 'Charred', 'Seething'],
  },
  // cold SULFUR / TIDAL volcanism (Io-class) — a frozen surface perpetually
  // resurfaced by tidal heating, under an SO2 sky. A physically distinct world
  // from the hot silicate case, so it gets its own sulfur/plume vocabulary.
  volcanicSulfur: {
    label: 'Volcanic',
    terrain: { land: ['Wastes', 'Plains', 'Flats', 'Plume-Fields', 'Snows', 'Lakes', 'Floes', 'Paterae', 'Calderas'],
               mat: ['Sulfur', 'Brimstone', 'Sulfur-Dioxide', 'Lava'] },
    // leads carry the PROCESS (tidal / plume / eruption); the material carries the
    // sulfur, so "sulfur" lands once — no "Sulfur-Glazed Sulfurous Snows".
    lead: ['Plume-Wracked', 'Eruption-Scarred', 'Tidal-Wracked', 'Caustic', 'Resurfaced', 'Frostless', 'Cooling', 'Crusted', 'Yellow-Crusted', 'Smoking'],
  },
  // water-ice substrate
  frozen: {
    label: 'Frozen',
    terrain: { land: ['Plains', 'Barrens', 'Flats', 'Sheets', 'Fields', 'Wastes', 'Reaches', 'Steppes'],
               mat: ['Frost', 'Hoarfrost', 'Ice', 'Snow', 'Rime', 'Glacial'] },
    lead: ['Fractured', 'Shattered', 'Rime-Locked', 'Wind-Carved', 'Frozen', 'Eternal'],
  },
  // volatile-frost substrate — the material word is forced from the body's real
  // surfaceFrostSpecies in deriveBiome (Nitrogen / Methane / Dry-Ice / Ammonia),
  // so this family carries only landforms; the frost species supplies the rest.
  frozenVol: {
    label: 'Frozen',
    terrain: { land: ['Snowfields', 'Barrens', 'Dunes', 'Flats', 'Ridges', 'Plains', 'Reaches', 'Wastes', 'Drifts', 'Glaciers', 'Sastrugi', 'Pans'] },
    lead: ['Frozen', 'Rimebound', 'Shattered', 'Drifting', 'Wind-Carved', 'Wind-Scoured', 'Eternal', 'Stark'],
  },
  // Material is a physical read (S6): neutral rock anchors the pool; oxidized
  // worlds add red ferric minerals; water-bedded sediments need a water history.
  // Salt / gypsum moved to the Salt-Flats family (they ARE the evaporite read).
  arid: {
    label: 'Arid',
    terrain: { land: ['Dunes', 'Hardpan', 'Badlands', 'Flats', 'Mesas', 'Pans', 'Barrens', 'Drifts', 'Wind-Arches'],
               mat: ['Silica', 'Basalt', 'Regolith', ['Ochre', oxidized], ['Rust-Red', oxidized], ['Hematite', oxidized], ['Clay', hadWater], ['Sandstone', hadWater], ['Caliche', hadWater]] },
    lead: ['Wind-Scoured', ['Sun-Fractured', warm], 'Cracked', ['Heat-Shimmer', warm], 'Sandblasted', 'Parched', 'Desolate'],
  },
  // evaporite salt-flats — the revived Crystalline slot, now keyed on real
  // desiccation: a warm, dry, high-salinity surface wears a bedded mineral
  // crust (halite / gypsum / selenite), the salts a shrinking brine left
  // behind. Distinct from a plain dust desert — it reads its glittering crust.
  evaporite: {
    label: 'Salt Flats',
    terrain: { land: ['Pans', 'Flats', 'Basins', 'Playas', 'Hardpan', 'Beds', 'Crusts', 'Barrens'],
               mat: ['Halite', 'Gypsum', 'Selenite', 'Salt', 'Alkali', 'Natron', 'Borax', 'Soda-Ash'] },
    lead: ['Salt-Crusted', 'Crystalline', 'Glittering', 'Bleached', ['Brine-Caked', tepid], 'Mineral-Crusted', ['Sun-Glazed', warm], 'Cracked'],
  },
  oceanic: {
    label: 'Oceanic',
    terrain: { land: ['Shallows', 'Seas', 'Atolls', 'Archipelagos', 'Lagoons', 'Reefs', 'Waterworld', 'Tides'] },
    lead: ['Storm-Lashed', ['Bioluminescent', hasLife], ['Kelp-Choked', hasLife], ['Coral-Spired', hasLife], 'Mist-Veiled', 'Wind-Driven', 'Endless', 'Restless'],
  },
  lush: {
    label: 'Lush',
    terrain: { land: ['Canopy', 'Floodlands', 'Rainforest', 'Floodplains', 'Jungles', 'Wilds', 'Forests', 'Wetlands'] },
    lead: ['Smothering', 'Fern-Choked', 'Emerald', 'Spore-Drifting', 'Vine-Tangled', 'Moss-Draped', 'Orchid-Laden', 'Verdant'],
  },
  temperate: {
    label: 'Temperate',
    terrain: { land: ['Prairies', ['Savanna', hasLife], ['Meadows', hasLife], ['Steppes', parched], ['Pasture', hasLife], ['Moors', wet], ['Riverlands', wet], ['Floodplains', wet], ['Wetlands', wet], ['Woodlands', hasLife]] },
    lead: ['Wind-Rippled', ['Golden', hasLife], 'Rolling', 'Scattered', ['Seed-Strewn', hasLife], ['Heather-Clad', hasLife], 'Mild', 'Dappled', ['Rain-Fed', wet], ['Sun-Baked', parched]],
  },
  // The lead is drawn per-chemistry at the cascade (TOXIC_SULFUR / _HOTHOUSE /
  // _ORGANIC) so an SO₂ world reads sulfuric, a CO₂ runaway corrosive, a tholin
  // world smoggy — honest to what's modeled. No halogen vocab: the atmosphere
  // model tracks only the top-3 gases by abundance, and a halogen (HCl/Cl₂) is
  // always a trace, so it can't be a top-3 signal — "Chlorine" would be a lie.
  // Wet terrains carry a `damp` guard so a dry runaway world isn't a "Marsh".
  toxic: {
    label: 'Toxic',
    terrain: { land: ['Fog Banks', 'Vapor Flats', 'Haze', 'Cloud-Cover', 'Wastes', ['Marshes', damp], ['Bogs', damp], ['Mineral Springs', damp]] },
    lead: ['Corrosive', 'Sulfuric', 'Caustic', 'Smog-Drowned', 'Choking', 'Noxious'],
  },
  // Material keys on physics (S6): neutral igneous/clastic rock anchors; oxidized
  // worlds wear red ferric rock; slate/shale are water-bedded → need a water past.
  barren: {
    label: 'Barren',
    terrain: { land: ['Plains', 'Flats', 'Fields', 'Mesas', 'Shields', 'Scree', 'Wastes', 'Barrens', 'Reaches', 'Regolith'],
               mat: ['Basalt', 'Boulder', 'Rubble', 'Granite', 'Gravel', ['Ochre', oxidized], ['Rust-Stained', oxidized], ['Slate', hadWater], ['Shale', hadWater]] },
    lead: ['Shattered', 'Wind-Polished', 'Silent', 'Cracked', 'Weathered', 'Bleak', 'Desolate', 'Stark'],
  },
  tundra: {
    label: 'Tundra',
    terrain: { land: ['Barrens', ['Peat Bogs', wet], ['Scrubland', parched], 'Taiga', 'Moss Expanses', 'Heath', ['Mire', wet], ['Conifer Stands', hasLife]] },
    lead: ['Lichen-Mottled', ['Boggy', wet], 'Frost-Heaved', ['Wind-Flattened', parched], 'Snow-Dusted', 'Thawing', 'Stunted', ['Sodden', wet]],
  },
  // Every subglacial-ocean world is cold (a buried sea needs an ice lid), so the
  // terrain is ice-cavern imagery — no hot karst / lava-tubes, which can't form
  // under a frozen shell.
  subterranean: {
    label: 'Subterranean',
    terrain: { land: ['Caverns', 'Crystal Grottos', 'Cavern Depths', 'Ice Caverns', 'Brine Seas', 'Hollows', 'Glacial Vaults', 'Deep Warrens'] },
    lead: ['Honeycombed', 'Echoing', ['Fungal', hasLife], 'Stalactite-Hung', 'Sunless', 'Ice-Bound', ['Glowworm-Lit', hasLife], 'Lightless'],
  },
  // carbon worlds — a C/O>1 disk condenses graphite / carbides instead of
  // silicate rock, so a dry rocky body wears a soot-black graphite / tar
  // surface. "Tar" phrasings need warmth (solid bitumen reads dark, not slick).
  carbon: {
    label: 'Carbon',
    terrain: { land: ['Plains', 'Wastes', 'Flats', 'Fields', 'Reaches', 'Barrens', 'Dunes', 'Drifts'],
               mat: ['Graphite', 'Soot', ['Tar', warm], 'Carbide', 'Diamond', 'Coke', 'Anthracite'] },
    lead: ['Soot-Black', 'Graphite-Grey', ['Tar-Slicked', warm], 'Glassy', 'Diamond-Dusted', 'Carbonized', 'Pitch-Dark', 'Sintered'],
  },
  // exotic surface chemistry — the only genuinely-alien SURFACE types the data
  // model carries: silicon-based life (lattice worlds, drawn from this pool) and
  // the chthonian stripped-metal core (forced 'Metallic Vapor Wastes' in the
  // cascade, bypassing the pool). No gemstone or carbon biome — there's no honest
  // signal for them, so they aren't faked.
  exotic: {
    label: 'Exotic',
    terrain: { land: ['Lattice Forests', 'Crystal Spires', 'Silicate Reefs', 'Glass Gardens', 'Lattice Reaches', 'Mineral Lattices'] },
    lead: ['Silicon', 'Lattice-Grown', 'Glassy', 'Vitreous', 'Faceted', 'Prismatic'],
  },
  // ── gaseous skyscapes ── The TERRAIN's cloud-gas material is keyed off the
  // body's TOP cloud deck in deriveSky (Jupiter → Ammonia, Neptune → Methane), so
  // these landform pools are pure cloud STRUCTURE. helium + veiledIce instead keep
  // their envelope identity (He / opaque ice) and take no cloud-gas prefix.
  hotGiant:  { label: 'Gas Giant',     terrain: { land: ['Cloud-Seas', 'Inferno', 'Cloud-Hell', 'Bands', 'Sky-Tempest'] },        lead: ['Incandescent', 'Searing', 'Glowing', 'Molten'] },
  gasGiant:  { label: 'Gas Giant',     terrain: { land: ['Cloud-Decks', 'Cloud-Tops', 'Cloud-Streams', 'Skies', 'Veils', 'Cloud-Belts'] }, lead: ['Banded', 'Churning', 'Roiling', 'Cyclonic', 'Marbled'] },
  helium:    { label: 'Helium Giant',  terrain: { land: ['Helium Veils', 'Stratified Murk', 'Helium Deeps', 'Helium Shroud'] },   lead: ['Pale', 'Wan', 'Shrouded'] },
  iceGiant:  { label: 'Ice Giant',     terrain: { land: ['Skies', 'Cloud-Mantle', 'Hazes', 'Frost-Clouds', 'Veils'] },            lead: ['Frozen', 'Glacial', 'Cyan', 'Still'] },
  veiledIce: { label: 'Veiled Ice',    terrain: { land: ['Ice Deeps', 'Frozen Mantle', 'Ice-Bound Murk'] },                       lead: ['Veiled', 'Shrouded', 'Opaque'] },
  gasDwarf:  { label: 'Gas Dwarf',     terrain: { land: ['Skies', 'Envelope', 'Cloud-Shroud', 'Murk', 'Veils', 'Haze'] },         lead: ['Hazy', 'Murky', 'Smothered'] },
} as const satisfies Record<string, Family>;
type FamilyKey = keyof typeof FAMILIES;

// ─── Cross-cutting condition leads ──────────────────────────────────────────
// A notable measured axis supplies the lead INSTEAD of the family signature. At
// most one fires (highest prio whose family applies + whose word doesn't echo the
// terrain). Composition reads (iron, briny, sulfurous) outrank dynamics (riven,
// storm) outrank age/dust, because they define the place more.
// The bare-rock families where a metal-streaked lead reads true. Exotic
// (silicon-life) is excluded — its surface has its own mineralogy, not iron.
const ROCKY = new Set<FamilyKey>(['volcanic', 'arid', 'barren']);
const WET = new Set<FamilyKey>(['oceanic', 'temperate']);
// Liquid- or vegetation-covered surfaces where dust load and impact craters don't
// read as the place — so the dusty / cratered conditions skip them.
const COVERED = new Set<FamilyKey>(['oceanic', 'lush', 'temperate']);

// Metal-rich lead sub-generator: `[metal]-[texture]`. The metals are the
// abundant siderophiles a differentiated rock actually concentrates (no precious
// jackpots — those are a resource-row read, not a whole landscape); the texture
// is how the lode reads underfoot. Composed, not plucked, so a metal world wears
// "Iron-Streaked" / "Cobalt-Crusted" / "Titanium-Veined" by the same hash draw.
const ORE_METAL = ['Iron', 'Nickel', 'Cobalt', 'Chromium', 'Titanium', 'Manganese', 'Vanadium', 'Ferrous'];
const ORE_TEXTURE = ['Streaked', 'Crusted', 'Strewn', 'Veined', 'Laced', 'Ribboned'];

// Toxic chemistry lead pools — the cascade draws one per the world's hostile
// chemistry so a sulfuric world, a CO₂ runaway and a tholin smog read distinctly
// (instead of one forced lead). Every word is honest to a MODELED gas: SO₂ →
// sulfuric acid (caustic, acid-rain), CO₂ runaway → corrosive/choking heat,
// tholin haze → organic smog. No halogen words (HCl/Cl₂ aren't modeled).
const TOXIC_SULFUR = ['Sulfuric', 'Caustic', 'Acid-Rain', 'Acid-Etched', 'Sulfur-Choked'];
const TOXIC_HOTHOUSE = ['Corrosive', 'Choking', 'Smothering', 'Searing'];
const TOXIC_ORGANIC = ['Smog-Drowned', 'Hazy', 'Tar-Veiled', 'Murky', 'Soot-Choked'];
function oreLead(b: Body): string {
  // 'Ferrous' is an adjective, not a metal noun — let it stand alone ("Ferrous
  // Badlands") rather than read "Ferrous-Veined".
  const metal = draw(b, 'ore:metal', ORE_METAL);
  if (metal === 'Ferrous') return metal;
  const ox = oxidized(b) ? 'Rust' : metal;   // an oxidized iron world rusts red
  return `${ox}-${draw(b, 'ore:tex', ORE_TEXTURE)}`;
}

interface Cond {
  key: string;
  prio: number;
  conflicts: readonly string[];
  gate: (b: Body) => boolean;
  applies: (key: FamilyKey, sky: boolean) => boolean;
  words?: readonly Word[];     // a fixed pool …
  gen?: (b: Body) => string;   // … or a sub-generator (one wins)
}
// Conditions in priority order; thresholds sit at the tail of each distribution
// so the lead reads as a genuine standout, not the family norm. (Tide-lock is
// deliberately absent: ~half of planets are locked, so it distinguishes nothing.)
const COND: readonly Cond[] = [
  { key: 'iron', prio: 70, gen: oreLead, conflicts: ['iron', 'ferrous', 'rust', 'metal'],
    gate: (b) => isIron(b), applies: (k, sky) => !sky && ROCKY.has(k) },
  { key: 'briny', prio: 66, words: ['Briny', 'Saline'], conflicts: ['brine', 'saline', 'salt'],
    gate: (b) => (b.salinity ?? 0) >= BRINY_SALINITY && (b.surfaceLiquidFraction ?? 0) > 0, applies: (k, sky) => !sky && WET.has(k) },
  { key: 'sulfurous', prio: 64, words: ['Sulfurous', 'Sulfur-Caked'], conflicts: ['sulfur'],
    gate: (b) => atmFrac(b, 'SO2') >= 0.3 || (b.bioticSulfur ?? 0) >= 0.3, applies: (k, sky) => !sky && k !== 'volcanic' && k !== 'volcanicSulfur' && k !== 'toxic' },
  { key: 'riven', prio: 60, words: ['Riven', 'Fire-and-Ice'], conflicts: ['fire', 'riven'],
    gate: (b) => softGE(b, 'riven', thermalSwingK(b), RIVEN_SWING_K, RIVEN_SWING_W), applies: (k, sky) => !sky && k !== 'volcanic' },
  // Terrestrial only: a gas giant's signature leads (Banded/Churning/Cyclonic) are
  // already the storm vocabulary, so a storming condition would just smother them.
  { key: 'storming', prio: 50, words: ['Storm-Wracked', 'Tempest-Swept', 'Storm-Lashed'], conflicts: ['storm', 'tempest', 'gale', 'cyclonic'],
    gate: (b) => maxCloudWindMs(b) >= STORM_WIND_MS, applies: (_k, sky) => !sky },
  { key: 'dusty', prio: 45, words: ['Dust-Veiled', 'Dust-Choked'], conflicts: ['dust'],
    gate: (b) => (b.dustStrength ?? 0) >= DUST_STRENGTH, applies: (k, sky) => !sky && !COVERED.has(k) },
  { key: 'cratered', prio: 40, words: ['Cratered', 'Pitted', 'Battered'], conflicts: ['crater', 'meteor', 'pocked', 'regolith'],
    gate: (b) => (b.surfaceAge ?? 1) <= ANCIENT_AGE, applies: (k, sky) => !sky && k !== 'volcanic' && !COVERED.has(k) },
];

// ─── Presentation thresholds ────────────────────────────────────────────────
const HOT_K = 330;
const TEMPERATE_LO_K = 250;
const COLD_K = 220;
const DRY_LIQUID = 0.1;
const DRY_ICE = 0.3;
const OCEAN_COVER = 0.5;
const HOTHOUSE_PRESSURE_BAR = 5; // Venus-class runaway greenhouse
const HOTHOUSE_TEMP_K = 340;
const LUSH_IMPACT = 0.5;         // transformative-biosphere gate
const RIVEN_SWING_K = 900;       // ~p95 day↔night spread — a true fire-and-ice landmark
const STORM_WIND_MS = 250;
const BRINY_SALINITY = 0.6;
const DUST_STRENGTH = 0.5;
const ANCIENT_AGE = 0.12;
// Soft-edge half-widths (see softGE): the ± band over which an edge body coin-
// flips rather than snapping. Kept small so only genuine boundary cases waver.
const COLD_K_W = 6;        // frozen ↔ tundra temperature edge (K)
const RIVEN_SWING_W = 60;  // fire-and-ice swing edge (K), ~proportional to its p95 gate
const EVAPORITE_SALINITY = 0.6; // salt concentrated well above the leach baseline → a crust, not a salty rock
const EVAPORITE_WARM_K = 273;   // warm enough that a brine evaporated rather than froze out
const WET_LIQUID = 0.2;         // standing-water cover that reads as wetland / river country
const PARCHED_LIQUID = 0.08;    // below this a clement world reads as dry steppe / scrub

// ─── Deterministic pool draw ────────────────────────────────────────────────
// Keeps only guard-passing words, then (if `avoid` is given) drops words that
// share a token with the terrain so a lead never echoes its noun ("Salt-Crusted
// Salt Flats"); falls back to the unfiltered set if that would empty the pool.
function tokensOf(s: string): string[] {
  return s.toLowerCase().split(/[ -]/);
}
function draw(b: Body, ns: string, pool: readonly Word[], avoid?: ReadonlySet<string>): string {
  let eligible = pool.filter((w) => typeof w === 'string' || w[1](b));
  if (avoid) {
    const clear = eligible.filter((w) => !tokensOf(typeof w === 'string' ? w : w[0]).some((t) => avoid.has(t)));
    if (clear.length) eligible = clear;
  }
  const w = eligible[hash32(b.id + '§' + ns) % eligible.length];
  return typeof w === 'string' ? w : w[0];
}

// ─── Soft classification edges ──────────────────────────────────────────────
// A hard threshold (`T >= COLD_K`) puts a cliff in the galaxy-wide distribution
// at the boundary: every 219 K world frozen, every 221 K world not. Instead, near
// a threshold treat the decision as a COIN FLIP weighted by distance — a body
// sitting on the edge is ~50/50, ramping to certainty by ±`w`. The coin is
// `hash01(id + axis)`, so it's deterministic per (body, axis) and a world always
// resolves the same way; `w` is the per-edge half-width.
//
// SAFETY: in a first-match cascade with per-family secondary gates, a careless
// soft edge can flip a body into an ill-fitting family (a dry tundra world tipped
// past the temperate edge would fall through to Barren). So softening is applied
// ONLY where a flip is safe: (a) CONDITION gates, which change the lead but never
// the family; (b) cross-family temp edges where BOTH sides accept the edge
// population (frozen↔tundra — both want ice), softened with the SAME axis on each
// side so exactly one claims an edge body; (c) within-family forks (oceanic
// frozen-over). Family bands with divergent secondary gates stay hard.
function hash01(s: string): number {
  return hash32(s) / 4294967296; // 2^32 — map the 32-bit hash into [0, 1)
}
function smoothstep(lo: number, hi: number, x: number): number {
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  const t = (x - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}
// Probabilistic `x >= T`: certain below `T - w`, certain above `T + w`, ~50/50 at
// `T`. Negate with the SAME (b, axis) for the complementary `x < T` so two sides
// of one boundary stay mutually exclusive.
function softGE(b: Body, axis: string, x: number, T: number, w: number): boolean {
  return hash01(b.id + '§soft:' + axis) < smoothstep(T - w, T + w, x);
}

// ─── Field helpers ──────────────────────────────────────────────────────────
function isDry(b: Body): boolean {
  return (b.surfaceLiquidFraction ?? 0) < DRY_LIQUID && (b.iceFraction ?? 0) < DRY_ICE;
}
function atmFrac(b: Body, gas: string): number {
  if (b.atm1 === gas) return b.atm1Frac ?? 0;
  if (b.atm2 === gas) return b.atm2Frac ?? 0;
  if (b.atm3 === gas) return b.atm3Frac ?? 0;
  return 0;
}
function maxCloudWindMs(b: Body): number {
  let m = 0;
  for (const c of b.cloudLayers) if (c.windSpeedMS > m) m = c.windSpeedMS;
  return m;
}
function thermalSwingK(b: Body): number {
  if (b.surfaceTempMaxK == null || b.surfaceTempMinK == null) return 0;
  return b.surfaceTempMaxK - b.surfaceTempMinK;
}
function isLushLife(b: Body): boolean {
  return b.biosphereComplexity === 'complex'
    && (b.biosphereSurfaceImpact ?? 0) >= LUSH_IMPACT
    && b.biosphereArchetype === 'carbon_aqueous';
}

// ─── Biome selection ────────────────────────────────────────────────────────
// The resolved place: which family pool (for the signature lead + grouping), the
// drawn terrain noun, whether it's a gaseous skyscape, and an optional forced
// lead (an iconic, honesty-required adjective the conditions/signature mustn't
// override). `uncharted` short-circuits to a bare head.
interface Sense {
  key: FamilyKey;
  terrain: string;
  sky: boolean;
  leadForce?: string;
  uncharted?: boolean;
}
// Compose the terrain: draw a landform, and (for families with a material pool)
// cross ~2/3 of them with a material — "Basalt Wastes" — leaving the rest bare so
// the 2-word / 3-word label mix survives. Guards against a material echoing its
// landform.
function terrainOf(b: Body, key: FamilyKey): string {
  const t: Terrain = FAMILIES[key].terrain;
  const land = draw(b, 'land:' + key, t.land);
  if (t.mat && hash32(b.id + '§matgate:' + key) % 3 !== 0) {
    const m = draw(b, 'mat:' + key, t.mat);
    if (!tokensOf(land).includes(m.toLowerCase())) return `${m} ${land}`;
  }
  return land;
}
function sense(b: Body, key: FamilyKey, opts: { terrain?: string; sky?: boolean; leadForce?: string } = {}): Sense {
  return {
    key,
    terrain: opts.terrain ?? terrainOf(b, key),
    sky: opts.sky ?? false,
    leadForce: opts.leadForce,
  };
}

// Cloud chemistry → the terrain MATERIAL: the visible top cloud deck's gas
// becomes the prefix ("Ammonia Cloud-Decks"). Helium and Veiled-Ice are excluded
// — they're defined by their bulk envelope (He / opaque ice), not a cloud deck.
const CLOUD_GAS_WORD: Record<string, string> = {
  NH3: 'Ammonia', CH4: 'Methane', H2O: 'Water-Cloud', N2: 'Nitrogen',
  NH4SH: 'Sulfide', H2SO4: 'Sulfuric', SALT: 'Alkali', SILICATE: 'Silicate',
};
const CLOUD_KEYED = new Set<FamilyKey>(['hotGiant', 'gasGiant', 'iceGiant', 'gasDwarf']);
// The gas of the highest cloud deck — the visible top of a gaseous envelope.
function topCloudGas(b: Body): string | null {
  let gas: string | null = null, maxAlt = -1;
  for (const c of b.cloudLayers) if (c.altitudeNorm > maxAlt) { maxAlt = c.altitudeNorm; gas = c.gas; }
  return gas;
}

// Gaseous bodies wear a cloudscape: structural class (size/temp) picks the family
// + its lead character, while the top cloud deck's gas supplies the terrain
// material — so two same-size giants read distinctly by their real chemistry.
function deriveSky(b: Body): Sense {
  let key: FamilyKey;
  if (isVeiledIce(b)) key = 'veiledIce';
  else if (isHelium(b)) key = 'helium';
  else if (isGasGiant(b)) key = isHotGiant(b) ? 'hotGiant' : 'gasGiant';
  else if (isIceGiant(b)) key = 'iceGiant';
  else key = 'gasDwarf';
  const land = draw(b, 'land:' + key, FAMILIES[key].terrain.land);
  let terrain = land;
  if (CLOUD_KEYED.has(key)) {
    const gas = topCloudGas(b);
    const word = gas ? CLOUD_GAS_WORD[gas] : undefined;
    if (word && !tokensOf(land).includes(word.toLowerCase())) terrain = `${word} ${land}`;
  }
  return sense(b, key, { sky: true, terrain });
}

// Surface-frost substrate (S1): the real solid-volatile veneer (procgen's
// surfaceFrostSpecies) drives the frozen-world label instead of guessing it
// from bulk composition. A defining EXOTIC frost — N₂/CH₄/CO₂/NH₃, anything but
// plain water ice — also OUT-RANKS a buried ocean: a nitrogen-frost world reads
// by the surface it wears, not the sea it hides. The material word is forced
// from the species; water carries no word (it's the plain Frozen family).
const FROST_WORD: Partial<Record<NonNullable<Body['surfaceFrostSpecies']>, string>> = {
  nitrogen: 'Nitrogen', methane: 'Methane', carbon_dioxide: 'Dry-Ice', ammonia: 'Ammonia',
};
function hasExoticFrost(b: Body): boolean {
  const f = b.surfaceFrostSpecies;
  return f != null && f !== 'water';
}

// The precedence cascade — most-defining sense-of-place first.
function deriveBiome(b: Body): Sense {
  if (!isClassifiable(b)) return { key: 'barren', terrain: 'Uncharted', sky: false, uncharted: true };
  if (isGaseousBody(b)) return deriveSky(b);

  const T = b.avgSurfaceTempK ?? 0;
  const liquid = b.surfaceLiquidFraction ?? 0;

  // ── Molten / volcanic extremes ──
  if (isBrimstone(b)) return sense(b, 'volcanic', { leadForce: 'Sulfur-Choked' });
  if (isLava(b) || isMagmaOcean(b)) return sense(b, 'volcanic');
  if (isChthonian(b)) return sense(b, 'exotic', { leadForce: 'Metallic', terrain: 'Vapor Wastes' });

  // ── Exotic / sulfur biospheres — silicon-based life draws the lattice pool ──
  if (b.biosphereArchetype === 'silicate' && hasLife(b)) return sense(b, 'exotic');
  if (b.biosphereArchetype === 'sulfur' && hasLife(b)) return sense(b, 'volcanicSulfur');

  // ── Carbon worlds — a dry rocky body in a C/O>1 disk wears a graphite / tar
  //    surface. A formation read (not temperature), so it out-ranks the
  //    landscape families below; a molten carbon world already read as lava. ──
  if (b.carbonWorld) return sense(b, 'carbon');

  // ── Volcanism — split hot silicate vs cold sulfur/tidal (Io reads its sulfur
  //    volcanism + tidal resurfacing, not generic basalt or its SO2 sky). The
  //    cold-yet-active body is tidal; SO2 / biotic sulfur mark the sulfur case. ──
  if (isVolcanic(b) && isDry(b)) {
    const sulfur = atmFrac(b, 'SO2') >= 0.3 || (b.bioticSulfur ?? 0) >= 0.2 || T < 500;
    return sense(b, sulfur ? 'volcanicSulfur' : 'volcanic');
  }

  // ── Transformative life ──
  if (isLushLife(b)) return sense(b, 'lush');

  // ── Toxic / hostile atmospheres — keyed by chemistry; lead + terrain both
  //    DRAW (so a hostile world isn't one fixed phrase), the lead from the pool
  //    that matches its poison. ──
  if (isTholin(b)) return sense(b, 'toxic', { leadForce: draw(b, 'tox:organic', TOXIC_ORGANIC) });
  if ((b.surfacePressureBar ?? 0) >= HOTHOUSE_PRESSURE_BAR && T >= HOTHOUSE_TEMP_K && isDry(b)) {
    return sense(b, 'toxic', { leadForce: draw(b, 'tox:hothouse', TOXIC_HOTHOUSE) });
  }
  if (atmFrac(b, 'SO2') >= 0.3) return sense(b, 'toxic', { leadForce: draw(b, 'tox:sulfur', TOXIC_SULFUR) });

  // ── Oceanic ── (briny rides as a condition; a frozen-over sea forces its lead+terrain).
  //    Within-family fork: softening the freeze edge only swaps the lead/terrain, the
  //    family stays oceanic — so it's safe with its own 'oceanFreeze' axis.
  if (isOcean(b) || isAmmoniaSea(b) || liquid >= OCEAN_COVER) {
    if (!softGE(b, 'oceanFreeze', T, COLD_K, COLD_K_W)) return sense(b, 'oceanic', { leadForce: 'Frozen-Over', terrain: 'Seas' });
    return sense(b, 'oceanic');
  }

  // ── Subterranean — a buried ice-shell ocean, BUT only when the surface is
  //    plain water ice. A world wearing a defining exotic frost (N₂/CH₄/CO₂/NH₃)
  //    reads by that surface instead (Triton is a nitrogen world, not a sea), so
  //    it falls through to Frozen below. ──
  if (isSubglacialOcean(b) && !hasExoticFrost(b)) {
    if (hasLife(b)) return sense(b, 'subterranean', { leadForce: 'Fungal', terrain: 'Cavern Depths' });
    if (b.subsurfaceOceanSpecies === 'water') return sense(b, 'subterranean', { leadForce: 'Sunless', terrain: 'Brine Seas' });
    return sense(b, 'subterranean');
  }

  // ── Frozen — keyed by the REAL surface-frost species (S1): an exotic frost
  //    forces its substrate material (Nitrogen / Methane / Dry-Ice / Ammonia)
  //    over a drawn landform, water ice is the plain Frozen family. The
  //    icy-but-not-glacial cold case shares its COLD_K edge with Tundra below
  //    (same 'coldK' axis), so an edge body coin-flips between the two — both
  //    want ice, so neither flip drops it into an ill-fitting family. ──
  if (isFrostbound(b) || isGlacial(b) || hasExoticFrost(b) || ((b.iceFraction ?? 0) >= DRY_ICE && !softGE(b, 'coldK', T, COLD_K, COLD_K_W))) {
    const fw = b.surfaceFrostSpecies ? FROST_WORD[b.surfaceFrostSpecies] : undefined;
    if (fw) return sense(b, 'frozenVol', { terrain: `${fw} ${draw(b, 'land:frozenVol', FAMILIES.frozenVol.terrain.land)}` });
    return sense(b, 'frozen'); // water-ice substrate
  }

  // ── Tundra — cold-but-not-frozen marginal band with moisture or life. Its lower
  //    COLD_K edge is soft and shares the 'coldK' axis with Frozen above, so the
  //    two stay mutually exclusive across the boundary. The TEMPERATE_LO_K upper
  //    edge stays HARD: Temperate's secondary gate (liquid/life) differs, so a soft
  //    flip there could strand a dry icy world in Barren. ──
  if (softGE(b, 'coldK', T, COLD_K, COLD_K_W) && T < TEMPERATE_LO_K && (liquid > 0 || (b.iceFraction ?? 0) > 0.05 || hasLife(b))) {
    return sense(b, 'tundra');
  }

  // Resources (the buried economy grid) deliberately do NOT select a biome — a
  // rare-earth lode is not a surface. Biome keys off surface physics only; the
  // grid stays in the info-card resource row. (No Crystalline/evaporite or carbon
  // biome: the procgen produces no distinct population for them — high bulk
  // water/volatile + warm + dry reads as a hot Volcanic/Toxic world, which is what
  // it is. Adding those biomes honestly would need a new procgen surface signal.)

  // ── Evaporite salt-flats — a dried, salt-concentrated basin: high salinity
  //    (the aridity-concentration proxy, well above the leach baseline), warm so
  //    a brine evaporated rather than froze, dry so the mineral crust lies bare.
  //    Reads its glittering crust, distinct from a plain dust desert. ──
  if (isDesert(b) && (b.surfacePressureBar ?? 0) >= 0.001
      && T >= EVAPORITE_WARM_K && (b.salinity ?? 0) >= EVAPORITE_SALINITY) {
    return sense(b, 'evaporite');
  }

  // ── Arid — a dry rock with a sky to weather it (any temperature; airless dry
  //    rock falls through to Barren, where wind-less regolith phrasing is honest) ──
  if (isDesert(b) && (b.surfacePressureBar ?? 0) >= 0.001) return sense(b, 'arid');

  // ── Temperate — a clement band with standing liquid or life ──
  if (T >= TEMPERATE_LO_K && T < HOT_K && (liquid > 0 || hasLife(b))) return sense(b, 'temperate');

  // ── Barren — the dead-rock default (iron rides as a condition) ──
  return sense(b, 'barren');
}

// The biome FAMILY name — exposed for dump-labels.mjs so it can group the galaxy
// by family without re-deriving (it imports THIS module, so no drift).
export function coreNoun(b: Body): string {
  const s = deriveBiome(b);
  return s.uncharted ? 'Uncharted' : FAMILIES[s.key].label;
}

// The single lead: a forced iconic adjective if the cascade set one, else the
// top firing cross-cutting condition (whose family applies and whose word doesn't
// echo the terrain), else the family's signature texture. Always exactly one.
function leadFor(b: Body, s: Sense): string {
  if (s.leadForce) return s.leadForce;
  const terrainLower = s.terrain.toLowerCase();
  for (const c of COND) { // COND is authored in priority order
    if (!c.applies(s.key, s.sky) || !c.gate(b)) continue;
    if (c.conflicts.some((x) => terrainLower.includes(x))) continue;
    return c.gen ? c.gen(b) : draw(b, 'cond:' + c.key, c.words!);
  }
  return draw(b, 'lead:' + s.key, FAMILIES[s.key].lead, new Set(tokensOf(s.terrain)));
}

// Compose the label: `[lead] [terrain]` — one lead descriptor over a terrain
// noun, 2–3 words. No stacking: a salient condition replaces the signature lead
// rather than piling in front of it.
export function composeWorldLabel(b: Body): string {
  const s = deriveBiome(b);
  if (s.uncharted) return s.terrain;
  return `${leadFor(b, s)} ${s.terrain}`;
}
