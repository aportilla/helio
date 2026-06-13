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
// "Smoldering Basalt Wastes", "Stormy Shallows". Each biome family owns two
// small pools — a `terrain` pool (the head nouns: Badlands, Wastes, Dunes, …) and
// a `lead` pool (its signature adjectives: Smoldering, Scoured, …) — and the
// label composes one of each. The combinatorics (leads × terrains) give the
// variety; the tight two-slot shape keeps every label 2–3 words. Leads stay
// SINGLE words wherever a single word carries the sense — a `[cause]-[effect]`
// compound (Wind-Scoured, Sun-Glittered) just names an off-screen agent the
// effect word (Scoured, Glittering) already implies, so it's spent as one. A
// hyphenated lead earns its second word only when neither half stands alone
// (Storm-Wracked, Coral-Spired) or when it's a sub-generator (the metal lead).
//
// CONDITIONS REPLACE THE LEAD, THEY DON'T STACK. A notable physical condition —
// an ancient cratered crust, a thermal-shock day↔night swing, a briny sea, a
// metal-streaked surface — supplies the lead INSTEAD of the family's signature
// adjective, never in addition to it. Exactly one lead is ever emitted, so the
// worst case is `[condition] [two-word terrain]` = three words, not the four-word
// pile-ups a front-stacked modifier layer produced. When more than one condition
// fires, the most place-defining one wins the slot (see COND). Conditions are
// kept genuinely RARE (tail-of-distribution gates — a hard threshold, or for a
// saturated axis like dust a probability that ramps with it) so they read as
// standouts and don't smother a family's signature vocabulary — a near-universal
// axis (like tide-lock, ~half of planets) is no axis at all, so it earns no lead.
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
//     Toxic, Hydrocarbon, Barren, Tundra, Subterranean, Carbon, Exotic).
//     Salt-Flats is the revived Crystalline slot, keyed on real desiccation
//     (warm + dry + high salinity); Carbon is a dry rocky body in a C/O>1 disk
//     (graphite / tar); Hydrocarbon is the Titan-class cryogenic methane world.
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
  isChthonian, isLava, isVolcanic, isIron, isFrostbound, isGlacial,
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
// textures or moods (a light / scale / stillness register) — anything that asserts
// a measured axis (iron, cratered, dust, tide, briny) lives in COND instead, so a
// lead never lies. Frozen splits water vs
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
    // No 'Molten' lead: it restates a Lava / Magma material ("Molten Lava") and
    // contradicts the cooled ones (Cinder / Pumice / Scoria). Heat-state leads
    // that read true against every material instead.
    lead: ['Smoldering', 'Fissured', 'Cinder-Strewn', 'Vitrified', 'Cooling', 'Charred', 'Seething'],
  },
  // cold SULFUR / TIDAL volcanism (Io-class) — a frozen surface perpetually
  // resurfaced by tidal heating, under an SO2 sky. A physically distinct world
  // from the hot silicate case, so it gets its own sulfur/plume vocabulary.
  volcanicSulfur: {
    label: 'Volcanic',
    terrain: { land: ['Wastes', 'Plains', 'Flats', 'Plume-Fields', 'Snows', 'Lakes', 'Floes', 'Paterae', 'Calderas'],
               mat: ['Sulfur', 'Brimstone', 'Lava'] },
    // Leads name what you'd SEE underfoot — visible volcanism (eruptions / vents /
    // fumes / glow) or the sulfur color (yellow / saffron). The material carries
    // the sulfur, so it lands once — no "Sulfur-Glazed Sulfurous Snows". No tidal
    // lead: the orbital squeezing that DRIVES the volcanism isn't an experience you
    // have standing there — it names the cause, not the place (so we don't say it
    // directly; the physics still selects the family, see deriveBiome).
    lead: ['Erupting', 'Vent-Riddled', 'Smoking', 'Fuming', 'Glowing', 'Cooling', 'Caustic', 'Crusted', 'Yellowed', 'Saffron'],
  },
  // water-ice substrate. The material (Frost / Ice / Rime / …) carries the
  // "frozen", so the lead is free for a TEXTURE / PROCESS or a light / scale /
  // stillness mood — never another ice synonym (no "Frozen Frost"). A cold world
  // can be bleak (Shattered / Scoured) OR beautiful (Glittering / Gleaming) OR
  // vast-and-silent, so ~half the galaxy's ice moons aren't all grey
  // desolation. The shaped ice landforms (Seracs / Pinnacles / Cirques / Crevasse-
  // Fields) are self-complete geomorphology — they sit in BARE_OK_LAND and can
  // stand bare; the flat expanse nouns always take a material so the substrate
  // never goes absent.
  frozen: {
    label: 'Frozen',
    terrain: { land: ['Plains', 'Barrens', 'Flats', 'Sheets', 'Fields', 'Wastes', 'Reaches', 'Steppes',
                       'Seracs', 'Pinnacles', 'Cirques', 'Crevasse-Fields', 'Moraines', 'Nunataks', 'Couloirs'],
               mat: ['Frost', 'Hoarfrost', 'Ice', 'Snow', 'Rime', 'Glacial', 'Firn', 'Verglas'] },
    lead: ['Fractured', 'Shattered', 'Carved', 'Scoured', 'Stark', 'Cracked', 'Splintered', 'Crevassed', 'Striated', 'Buckled',
           'Glittering', 'Gleaming', 'Glistening', 'Dazzling', 'Argent', 'Silent', 'Vast', 'Sweeping', 'Becalmed', 'Pale', 'Bitter', 'Trackless'],
  },
  // volatile-frost substrate — the material word is forced from the body's real
  // surfaceFrostSpecies in deriveBiome (Nitrogen / Methane / Dry-Ice / Ammonia),
  // so this family carries only landforms; the frost species supplies the rest.
  frozenVol: {
    label: 'Frozen',
    terrain: { land: ['Snowfields', 'Barrens', 'Dunes', 'Flats', 'Ridges', 'Plains', 'Reaches', 'Wastes', 'Drifts', 'Glaciers', 'Sastrugi', 'Pans', 'Seracs', 'Pinnacles', 'Penitentes', 'Yardangs', 'Scarps', 'Moraines', 'Nunataks', 'Hollows'] },
    // No 'Frozen' lead: the forced frost species (Nitrogen / Methane / Dry-Ice /
    // Ammonia) IS the frozen veneer, so "Frozen Nitrogen" only restates the
    // material. The lead carries texture or a light / scale / stillness mood.
    lead: ['Rimebound', 'Shattered', 'Drifting', 'Carved', 'Scoured', 'Stark', 'Splintered', 'Crevassed', 'Striated',
           'Glittering', 'Gleaming', 'Glistening', 'Dazzling', 'Argent', 'Silent', 'Vast', 'Pale', 'Becalmed', 'Bitter', 'Trackless'],
  },
  // Material is a physical read (S6): neutral rock anchors the pool; oxidized
  // worlds add red ferric minerals; water-bedded sediments need a water history.
  // Salt / gypsum moved to the Salt-Flats family (they ARE the evaporite read).
  arid: {
    label: 'Arid',
    terrain: { land: ['Dunes', 'Hardpan', 'Badlands', 'Flats', 'Mesas', 'Pans', 'Barrens', 'Drifts', 'Wind-Arches', 'Ergs', 'Yardangs', 'Buttes', 'Escarpments'],
               mat: ['Silica', 'Basalt', 'Regolith', 'Quartz', 'Feldspar', ['Ochre', oxidized], ['Rusty', oxidized], ['Hematite', oxidized], ['Laterite', oxidized], ['Clay', hadWater], ['Sandstone', hadWater], ['Caliche', hadWater]] },
    lead: ['Scoured', ['Crazed', warm], 'Cracked', ['Shimmering', warm], 'Sandblasted', 'Parched', 'Desolate', 'Sere', ['Sunbaked', warm], 'Withered', 'Eroded', 'Wind-Worn'],
  },
  // evaporite salt-flats — the revived Crystalline slot, now keyed on real
  // desiccation: a warm, dry, high-salinity surface wears a bedded mineral
  // crust (halite / gypsum / selenite), the salts a shrinking brine left
  // behind. Distinct from a plain dust desert — it reads its glittering crust.
  evaporite: {
    label: 'Salt Flats',
    terrain: { land: ['Pans', 'Flats', 'Basins', 'Playas', 'Hardpan', 'Beds', 'Crusts', 'Barrens'],
               mat: ['Halite', 'Gypsum', 'Selenite', 'Salt', 'Alkali', 'Natron', 'Borax', 'Soda-Ash'] },
    lead: ['Salt-Crusted', 'Crystalline', 'Glittering', 'Bleached', ['Briny', tepid], 'Mineral-Crusted', ['Glazed', warm], 'Cracked'],
  },
  oceanic: {
    label: 'Oceanic',
    terrain: { land: ['Shallows', 'Seas', 'Atolls', 'Archipelagos', 'Lagoons', 'Reefs', 'Straits', 'Tides'] },
    lead: ['Stormy', ['Bioluminescent', hasLife], ['Kelpy', hasLife], ['Reefed', hasLife], 'Misty', 'Surging', 'Turbulent', 'Serene', 'Tranquil', 'Restless'],
  },
  lush: {
    label: 'Lush',
    terrain: { land: ['Canopies', 'Floodlands', 'Rainforest', 'Floodplains', 'Jungles', 'Wilds', 'Forests', 'Wetlands', 'Plains', 'Valleys', 'Mesas'] },
    lead: ['Smothering', 'Ferny', 'Emerald', 'Spored', 'Viney', 'Mossy', 'Flowering', 'Verdant', 'Bursting'],
  },
  temperate: {
    label: 'Temperate',
    terrain: { land: [['Prairies', hasLife], ['Downs', hasLife], 'Highlands', 'Plateaus', 'Uplands', 'Tablelands', ['Savanna', hasLife], ['Meadows', hasLife], ['Steppes', parched], ['Pasture', hasLife], ['Veldt', hasLife], ['Moors', wet], ['Riverlands', wet], ['Floodplains', wet], ['Wetlands', wet], ['Vales', wet], ['Woodlands', hasLife]] },
    lead: ['Rippled', ['Golden', hasLife], 'Rolling', 'Scattered', ['Seedy', hasLife], ['Heathered', hasLife], 'Mild', 'Dappled', 'Sunlit', 'Halcyon', 'Breeze-Swept', ['Blossoming', hasLife], ['Greening', hasLife], ['Rainy', wet], ['Sunny', parched]],
  },
  // The lead is drawn per-chemistry at the cascade (TOXIC_SULFUR / _HOTHOUSE /
  // _ORGANIC) so an SO₂ world reads sulfuric, a CO₂ runaway corrosive, a tholin
  // world smoggy — honest to what's modeled. No halogen vocab: the atmosphere
  // model tracks only the top-3 gases by abundance, and a halogen (HCl/Cl₂) is
  // always a trace, so it can't be a top-3 signal — "Chlorine" would be a lie.
  // Wet terrains carry a `damp` guard so a dry runaway world isn't a "Marsh".
  toxic: {
    label: 'Toxic',
    terrain: { land: ['Fog Banks', 'Vapor Flats', 'Cliffs', 'Caverns', 'Pall', 'Cloud-Cover', 'Wastes', 'Smog Banks', 'Haze Plains', 'Murk', 'Gloom', 'Hardpan', 'Sinks', 'Fumaroles',
                       ['Scaldlands', warm], ['Cauldrons', warm], ['Solfataras', warm], ['Marshes', damp], ['Bogs', damp], ['Mineral Springs', damp]] },
    lead: ['Corrosive', 'Sulfuric', 'Caustic', 'Smog-Drowned', 'Choking', 'Noxious', 'Fuming', 'Acrid', 'Miasmic', 'Reeking', 'Pestilent', 'Foul', 'Vaporous'],
  },
  // Titan-class hydrocarbon world — cryogenic methane / ethane lakes, tholin-stained
  // dune seas, an orange organic haze. Split from `toxic` the way volcanicSulfur
  // splits from volcanic: it shares only "thick hostile sky" — the SUBSTANCE
  // (hydrocarbons), the temperature (~90 K), and the imagery are all its own, and
  // a generic toxic landform ("Soot-Choked Marshes") buries the one thing that
  // makes it interesting. The MATERIAL names the organic chemistry (so it always
  // appears — none of these landforms is in BARE_OK_LAND); the lead carries the
  // cold + haze. Liquid landforms are `damp`-guarded so a haze-only world reads
  // its dunes, not lakes it doesn't have.
  hydrocarbon: {
    label: 'Hydrocarbon',
    terrain: { land: ['Flats', 'Basins', 'Plains', 'Dunes', 'Lowlands', 'Drifts', 'Barrens',
                       ['Lakes', damp], ['Seas', damp], ['Channels', damp], ['Shores', damp], ['Marshes', damp], ['Fens', damp]],
               mat: ['Methane', 'Ethane', 'Tholin', 'Hydrocarbon', 'Bitumen'] },
    // Leads carry the COLD + HAZE + dimness (universal to a ~90 K orange-smog
    // world); the MATERIAL names the organic compound. No compound words in the
    // lead — "Tar-Stained" beside a Tholin / Bitumen material would just say
    // "tar-stained tar" (tholin IS tar).
    lead: ['Hazy', 'Smog-Veiled', 'Cryogenic', 'Frigid', 'Orange-Hazed', 'Haze-Drowned', 'Sunless'],
  },
  // Material keys on physics (S6): neutral igneous/clastic rock anchors; oxidized
  // worlds wear red ferric rock; slate/shale are water-bedded → need a water past.
  barren: {
    label: 'Barren',
    terrain: { land: ['Plains', 'Flats', 'Fields', 'Mesas', 'Shields', 'Scree', 'Wastes', 'Barrens', 'Reaches', 'Regolith', 'Plateaus', 'Outcrops', 'Talus', 'Massifs', 'Ridges'],
               mat: ['Basalt', 'Boulder', 'Rubble', 'Granite', 'Gravel', 'Anorthosite', 'Breccia', 'Gabbro', 'Flint', ['Ochre', oxidized], ['Rusty', oxidized], ['Slate', hadWater], ['Shale', hadWater]] },
    lead: ['Shattered', 'Polished', 'Silent', 'Cracked', 'Weathered', 'Bleak', 'Desolate', 'Stark', 'Lifeless', 'Sterile', 'Forsaken', 'Gaunt', 'Ashen'],
  },
  tundra: {
    label: 'Tundra',
    terrain: { land: ['Barrens', 'Frost-Heaves', 'Fellfields', 'Permafrost Flats', ['Peat Bogs', (b) => wet(b) && hasLife(b)], ['Scrubland', (b) => parched(b) && hasLife(b)], ['Taiga', hasLife], ['Moss Expanses', hasLife], ['Heath', hasLife], ['Mire', wet], ['Conifer Stands', hasLife]] },
    lead: ['Lichen-Mottled', ['Boggy', wet], 'Hummocked', 'Windswept', 'Snowy', 'Thawing', 'Stunted', ['Sodden', wet]],
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
               mat: ['Graphite', 'Soot', ['Tar', warm], 'Carbide', 'Diamond', 'Char', 'Anthracite'] },
    lead: ['Soot-Black', 'Graphite-Grey', ['Tar-Slicked', warm], 'Glassy', 'Diamond-Dusted', 'Carbonized', 'Pitch-Dark', 'Sintered'],
  },
  // exotic surface chemistry — the only genuinely-alien SURFACE types the data
  // model carries: silicon-based life (lattice worlds, drawn from this pool) and
  // the chthonian stripped-metal core (which draws its own metal-vapor register,
  // CHTHONIAN_LEAD/TERRAIN, not this lattice pool). No gemstone or carbon biome — there's no honest
  // signal for them, so they aren't faked.
  exotic: {
    label: 'Exotic',
    terrain: { land: ['Lattice Forests', 'Crystal Spires', 'Silicate Reefs', 'Crystal Gardens', 'Lattice Reaches', 'Mineral Lattices'] },
    lead: ['Silicon', 'Lattice-Grown', 'Glassy', 'Vitreous', 'Faceted', 'Prismatic', 'Iridescent', 'Opaline'],
  },
  // ── gaseous skyscapes ── The TERRAIN's cloud-gas material is keyed off the
  // body's TOP cloud deck in deriveSky (Jupiter → Ammonia, Neptune → Methane), so
  // these landform pools are pure cloud STRUCTURE. helium + veiledIce instead keep
  // their envelope identity (He / opaque ice) and take no cloud-gas prefix.
  hotGiant:  { label: 'Gas Giant',     terrain: { land: ['Cloud-Seas', 'Inferno', 'Cloud-Hell', 'Bands', 'Sky-Tempest'] },        lead: ['Incandescent', 'Searing', 'Glowing', 'Molten'] },
  gasGiant:  { label: 'Gas Giant',     terrain: { land: ['Cloud-Decks', 'Cloud-Tops', 'Cloud-Streams', 'Skies', 'Veils', 'Cloud-Belts', 'Cloud-Bands', 'Cloud-Whorls', 'Storm-Tracks'] }, lead: ['Banded', 'Churning', 'Roiling', 'Cyclonic', 'Marbled', 'Swirling', 'Mottled', 'Whorled', 'Festooned'] },
  helium:    { label: 'Helium Giant',  terrain: { land: ['Helium Veils', 'Stratified Murk', 'Helium Deeps', 'Helium Shroud'] },   lead: ['Pale', 'Wan', 'Shrouded'] },
  iceGiant:  { label: 'Ice Giant',     terrain: { land: ['Skies', 'Cloud-Mantle', 'Hazes', 'Cirrus', 'Veils'] },                  lead: ['Sapphire', 'Glacial', 'Cyan', 'Still'] },
  veiledIce: { label: 'Veiled Ice',    terrain: { land: ['Ice Deeps', 'Frozen Mantle', 'Ice-Bound Murk', 'Glacial Abyss', 'Frozen Depths'] }, lead: ['Veiled', 'Shrouded', 'Opaque', 'Sunless', 'Lightless', 'Crushing', 'Leaden', 'Fathomless', 'Frigid'] },
  gasDwarf:  { label: 'Gas Dwarf',     terrain: { land: ['Skies', 'Envelope', 'Cloud-Shroud', 'Depths', 'Veils', 'Gloom', 'Hazes', 'Cloud-Deeps', 'Vapor-Seas', 'Murk'] },     lead: ['Hazy', 'Murky', 'Smothered', 'Turbid', 'Sullen', 'Dim', 'Clouded', 'Stagnant', 'Brooding'] },
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
const COVERED = new Set<FamilyKey>(['oceanic', 'lush', 'temperate', 'hydrocarbon']);

// Metal-rich lead sub-generator: `[metal]-[texture]`. The metals are the
// abundant siderophiles a differentiated rock actually concentrates (no precious
// jackpots — those are a resource-row read, not a whole landscape); the texture
// is how the lode reads underfoot. Composed, not plucked, so a metal world wears
// "Iron-Streaked" / "Cobalt-Crusted" / "Titanium-Veined" by the same hash draw.
const ORE_METAL = ['Iron', 'Nickel', 'Cobalt', 'Chromium', 'Titanium', 'Manganese', 'Vanadium', 'Ferrous'];
const ORE_TEXTURE = ['Streaked', 'Crusted', 'Strewn', 'Veined', 'Laced', 'Ribboned'];

// Toxic chemistry lead pools — the cascade draws one per the world's hostile
// chemistry so a sulfuric world and a CO₂ runaway read distinctly (instead of one
// forced lead). Every word is honest to a MODELED gas: SO₂ → sulfuric acid
// (caustic, acid-rain), CO₂ runaway → corrosive/choking heat. (The organic tholin
// case is its own `hydrocarbon` family now, not a toxic lead.) No halogen words
// (HCl/Cl₂ aren't modeled).
const TOXIC_SULFUR = ['Sulfuric', 'Caustic', 'Acid-Rain', 'Acid-Etched', 'Sulfur-Choked', 'Vitriolic', 'Acrid'];
const TOXIC_HOTHOUSE = ['Corrosive', 'Choking', 'Smothering', 'Searing', 'Stifling', 'Blistering', 'Suffocating', 'Scorching'];
// Frozen-over ocean — a standing sea capped by ice. Both slots DRAW (terrain via
// its own cold-sea pool, not the warm oceanic landforms) so two ice-locked
// oceans read distinctly; every word still says "frozen sea".
const FROZEN_OVER_LEAD = ['Frozen-Over', 'Ice-Capped', 'Frost-Locked', 'Ice-Sheathed', 'Pack-Iced', 'Ice-Bound', 'Frost-Rimed'];
const FROZEN_OVER_TERRAIN = ['Seas', 'Shallows', 'Floes', 'Tides', 'Pack-Ice', 'Narrows', 'Expanse'];
// Molten-sulfur sea (Io-class brimstone) — terrain draws from the volcanic pool;
// these leads name the sulfur so it lands once and varies across worlds.
const BRIMSTONE_LEAD = ['Sulfur-Choked', 'Brimstoned', 'Sulfurous', 'Fumed', 'Sulfury', 'Yellowed'];
// Stripped hot-Jupiter metal core (chthonian) — its own metal-vapor register
// (the exotic family pool is silicon-life lattice vocab, wrong for a bare core).
const CHTHONIAN_LEAD = ['Metallic', 'Iron-Vapor', 'Molten-Metal', 'Slag-Crusted', 'Smelted', 'Vapor-Wreathed'];
const CHTHONIAN_TERRAIN = ['Vapor Wastes', 'Metal Wastes', 'Slag Plains', 'Core Barrens', 'Iron Flats', 'Smelt-Fields'];
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
    gate: (b) => atmFrac(b, 'SO2') >= 0.3 || (b.bioticSulfur ?? 0) >= 0.3, applies: (k, sky) => !sky && k !== 'volcanic' && k !== 'volcanicSulfur' && k !== 'toxic' && k !== 'exotic' },
  { key: 'riven', prio: 60, words: ['Riven', 'Thermally-Shocked'], conflicts: ['riven', 'thermal', 'shock'],
    gate: (b) => softGE(b, 'riven', thermalSwingK(b), RIVEN_SWING_K, RIVEN_SWING_W), applies: (k, sky) => !sky && k !== 'volcanic' },
  // Terrestrial only: a gas giant's signature leads (Banded/Churning/Cyclonic) are
  // already the storm vocabulary, so a storming condition would just smother them.
  { key: 'storming', prio: 50, words: ['Storm-Wracked', 'Tempest-Swept', 'Stormy'], conflicts: ['storm', 'tempest', 'gale', 'cyclonic'],
    gate: (b) => maxCloudWindMs(b) >= STORM_WIND_MS, applies: (_k, sky) => !sky },
  { key: 'dusty', prio: 45, words: ['Dust-Veiled', 'Dust-Choked'], conflicts: ['dust'],
    gate: (b) => dustClaimsLead(b), applies: (k, sky) => !sky && !COVERED.has(k) },
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
const RIVEN_SWING_K = 900;       // ~p95 day↔night spread — a true thermal-shock landmark
const STORM_WIND_MS = 250;
const BRINY_SALINITY = 0.6;
// Dust claims the lead PROBABILISTICALLY, not on a hard threshold. The procgen
// dustStrength field saturates — most dry, thin-air, moderate-T worlds pin near
// 1.0 — so a `>= T` gate would make "Dust-Veiled" the norm for the whole dry
// population rather than a tail standout. Instead the claim probability ramps with
// strength (smoothstep over [LO, HI]) and is capped below 1, so the dustiest worlds
// usually read dusty, middling ones occasionally, and even a maxed-dust world
// sometimes yields the slot to its family signature — dust reads as graded flavor
// across the dry families rather than a blanket takeover. Per-(body) deterministic.
const DUST_LEAD_LO = 0.45;      // below this strength the dust lead never fires
const DUST_LEAD_HI = 1.0;       // strength at which the claim probability peaks
const DUST_LEAD_MAX_PROB = 0.5; // ceiling — even a maxed-dust world reads dusty only ~half the time
const ANCIENT_AGE = 0.12;
// Soft-edge half-widths (see softGE): the ± band over which an edge body coin-
// flips rather than snapping. Kept small so only genuine boundary cases waver.
const COLD_K_W = 6;        // frozen ↔ tundra temperature edge (K)
const RIVEN_SWING_W = 60;  // thermal-shock swing edge (K), ~proportional to its p95 gate
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
// Crude morphological stem so the echo guard catches INFLECTED repeats —
// "Drifting" beside "Drifts" share the stem "drift", which a raw-token compare
// (two different strings) would miss, leaking "Drifting Nitrogen Drifts". Strips
// one trailing ing/ed/es/s/e when ≥3 chars remain; enough to stop a lead rhyming
// with its own terrain noun without needing a real stemmer. The trailing-e strip
// catches a participle vs. its base noun ("Crevassed" → crevass ↔ "Crevasse" →
// crevass), which the consonant suffixes alone would leak.
function stemOf(t: string): string {
  for (const suf of ['ing', 'ed', 'es', 's', 'e']) {
    if (t.length - suf.length >= 3 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}
function draw(b: Body, ns: string, pool: readonly Word[], avoid?: ReadonlySet<string>): string {
  let eligible = pool.filter((w) => typeof w === 'string' || w[1](b));
  if (avoid) {
    const avoidStems = new Set([...avoid].map(stemOf));
    const clear = eligible.filter((w) => !tokensOf(typeof w === 'string' ? w : w[0]).some((t) => avoidStems.has(stemOf(t))));
    if (clear.length) eligible = clear;
  }
  const w = eligible[hash32(b.id + '§' + ns) % eligible.length]!;
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
// Whether the dust condition claims the lead slot — a capped probability ramping
// with dustStrength (see the DUST_LEAD_* consts) rather than a hard threshold, so
// a saturated dust field reads as a graded tail standout, not a dry-world default.
function dustClaimsLead(b: Body): boolean {
  const p = DUST_LEAD_MAX_PROB * smoothstep(DUST_LEAD_LO, DUST_LEAD_HI, b.dustStrength ?? 0);
  return hash01(b.id + '§dustlead') < p;
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
// Landforms self-sufficient enough to stand without a material qualifier — a
// distinctive geomorphology (Badlands, Calderas, Mesas) or itself a substance
// (Regolith, Scree, Snows). Every OTHER landform in a material-bearing family is
// a bare expanse noun — Plains, Flats, Wastes, Seas — that names a shape but no
// substance, so a "[descriptor] [expanse]" label ("Pitted Plains") reads as a
// prefix/suffix pair with no meat. Those ALWAYS take a material ("Pitted Frost
// Plains"); only the self-complete forms below keep the optional matgate. Listing
// the exceptions (not the generics) makes "needs a material" the safe default, so
// a newly-added expanse noun can't silently go bare.
const BARE_OK_LAND = new Set<string>([
  'Terraces', 'Badlands', 'Calderas', 'Desolation', 'Plume-Fields', 'Paterae',
  'Snows', 'Floes', 'Dunes', 'Hardpan', 'Mesas', 'Drifts', 'Wind-Arches',
  'Playas', 'Shields', 'Scree', 'Regolith', 'Sastrugi',
  'Seracs', 'Pinnacles', 'Cirques', 'Crevasse-Fields',
  'Moraines', 'Nunataks', 'Couloirs', 'Ergs', 'Yardangs', 'Buttes',
  'Escarpments', 'Outcrops', 'Talus', 'Massifs',
]);
// Compose the terrain: draw a landform, then (for families with a material pool)
// cross it with a material — "Basalt Wastes". Bare expanse nouns always take one;
// self-complete landforms only ~2/3 of the time, so the 2-word / 3-word label mix
// survives. Guards against a material echoing its landform.
function terrainOf(b: Body, key: FamilyKey): string {
  const t: Terrain = FAMILIES[key].terrain;
  const land = draw(b, 'land:' + key, t.land);
  const matgate = !BARE_OK_LAND.has(land) || hash32(b.id + '§matgate:' + key) % 3 !== 0;
  if (t.mat && matgate) {
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
  NH3: 'Ammonia', CH4: 'Methane', H2O: 'Water', N2: 'Nitrogen',
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

  // ── Molten / volcanic extremes ── Chthonian leads: a stripped hot-Jupiter core
  //    is hot enough to also read as lava, but the bare metal core is the rarer,
  //    more-defining identity — so it claims the world ahead of generic melt.
  if (isChthonian(b)) {
    const terrain = draw(b, 'chthonian:terrain', CHTHONIAN_TERRAIN);
    return sense(b, 'exotic', { leadForce: draw(b, 'chthonian:lead', CHTHONIAN_LEAD, new Set(tokensOf(terrain))), terrain });
  }
  if (isBrimstone(b)) return sense(b, 'volcanic', { leadForce: draw(b, 'brimstone:lead', BRIMSTONE_LEAD) });
  if (isLava(b)) return sense(b, 'volcanic');

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

  // ── Hydrocarbon (Titan-class) — a cryogenic organic world reads its methane /
  //    ethane / tholin chemistry through the family's material slot, NOT as a
  //    generic toxic haze. Above the toxic checks: it's the more-specific world. ──
  if (isTholin(b)) return sense(b, 'hydrocarbon');

  // ── Toxic / hostile atmospheres — keyed by chemistry; the lead DRAWS from the
  //    pool that matches its poison (so a hostile world isn't one fixed phrase). ──
  if ((b.surfacePressureBar ?? 0) >= HOTHOUSE_PRESSURE_BAR && T >= HOTHOUSE_TEMP_K && isDry(b)) {
    return sense(b, 'toxic', { leadForce: draw(b, 'tox:hothouse', TOXIC_HOTHOUSE) });
  }
  if (atmFrac(b, 'SO2') >= 0.3) return sense(b, 'toxic', { leadForce: draw(b, 'tox:sulfur', TOXIC_SULFUR) });

  // ── Oceanic ── (briny rides as a condition; a frozen-over sea draws an ice-locked lead+terrain).
  //    Within-family fork: softening the freeze edge only swaps the lead/terrain, the
  //    family stays oceanic — so it's safe with its own 'oceanFreeze' axis.
  if (isOcean(b) || isAmmoniaSea(b) || liquid >= OCEAN_COVER) {
    if (!softGE(b, 'oceanFreeze', T, COLD_K, COLD_K_W)) {
      const terrain = draw(b, 'oceanFrozen:terrain', FROZEN_OVER_TERRAIN);
      return sense(b, 'oceanic', { leadForce: draw(b, 'oceanFrozen:lead', FROZEN_OVER_LEAD, new Set(tokensOf(terrain))), terrain });
    }
    return sense(b, 'oceanic');
  }

  // ── Subterranean — a buried ice-shell ocean, BUT only when the surface is
  //    plain water ice. A world wearing a defining exotic frost (N₂/CH₄/CO₂/NH₃)
  //    reads by that surface instead (Triton is a nitrogen world, not a sea), so
  //    it falls through to Frozen below. Lead + terrain both DRAW from the family
  //    pools like every other family — the life signal rides on the guarded
  //    Fungal / Glowworm-Lit leads (so two ice moons read distinctly rather than
  //    both forcing one fixed phrase), not a forced override. ──
  if (isSubglacialOcean(b) && !hasExoticFrost(b)) return sense(b, 'subterranean');

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
