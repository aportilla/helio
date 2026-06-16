// Hoisted economic tunables for the facility seam. Every value is integer milli
// (the sim's unit; MILLI_PER_UNIT = 1000, so 1000 milli = "one unit/turn").
// Kept in one place so balance passes never hunt through def bodies — and so the
// README/plan can reference them by NAME, never by value (a number in prose
// rots the instant it's tuned).
//
// PROVISIONAL (plan §8, decision D2): these rates — and the whole EconResource
// roster — are an early interpretation made before Helio's economy is finalized.
// Because EconResource ids are app-internal and never serialized, re-tuning or
// re-mapping is a non-breaking change.

// One "unit" of site richness in milli. abundanceMilli() maps a body's 0..10
// catalog index (and 0..1 biotic scalars) onto [0, RICHNESS_MILLI_PER_UNIT];
// it doubles as the fixed-point denominator for every richness-scaled rate, so
// a base rate is literally "output per turn at full (1.0) richness".
export const RICHNESS_MILLI_PER_UNIT = 1000;

// How strongly a body's radioactives index feeds RareTech, on top of its rare
// earths (as a fraction of RICHNESS_MILLI_PER_UNIT — 500 ⇒ half weight).
export const RARE_RADIO_WEIGHT_MILLI = 500;

// — Colony: a habitation node. Farms what local biology supports, runs a
//   reactor, and always eats. A lush world is a net food exporter; a barren one
//   imports — which is exactly the demand signal the transport core exists for.
export const COLONY_FOOD_PRODUCE_AT_FULL_MILLI = 6000;
export const COLONY_FOOD_CONSUME_MILLI = 4000;
export const COLONY_ENERGY_PRODUCE_MILLI = 4000;
export const COLONY_ENERGY_CONSUME_MILLI = 3000;

// — Mining base: an extractor node. Each strategic resource it pulls is scaled
//   by the matching site richness; it powers itself and feeds a small workforce.
export const MINE_OUTPUT_AT_FULL_MILLI = 5000;
export const MINE_ENERGY_PRODUCE_MILLI = 5000;
export const MINE_ENERGY_CONSUME_MILLI = 4000;
export const MINE_FOOD_CONSUME_MILLI = 1000;
