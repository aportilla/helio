// Hoisted economic tunables for the facility seam. Every value is integer milli
// (the sim's unit; MILLI_PER_UNIT = 1000, so 1000 milli = "one unit/turn").
// Kept in one place so balance passes never hunt through def bodies — and so the
// README/plan can reference them by NAME, never by value (a number in prose
// rots the instant it's tuned).
//
// PROVISIONAL: these rates — and the whole EconResource roster — are an early
// interpretation made before Helio's economy is finalized. Because EconResource
// ids are app-internal and never serialized, re-tuning is a non-breaking change.
//
// FLAT by design: a facility's emission is the SAME on every body it sits on — no
// body-physics (richness / biotic) scaling. One facility is one fixed contributor;
// abundance plays no role. The two-way cargo traffic comes from facility MIX (farms
// vs mines vs colonies), not from per-body variation.

// — Farm: grows food, draws a little minerals (tooling, fertilizer). A food
//   provider, the inbound side of a colony's appetite.
export const FARM_FOOD_PRODUCE_MILLI = 8000;
export const FARM_MINERALS_CONSUME_MILLI = 1000;

// — Mining base: extracts minerals, feeds a small workforce on imported food. A
//   mineral provider, the counterpart current to the farm's food.
export const MINE_MINERALS_PRODUCE_MILLI = 8000;
export const MINE_FOOD_CONSUME_MILLI = 1000;

// — Colony: a pure consumer of food + minerals. It produces nothing; it is the
//   demand the farms and mines exist to serve, and the sink that pulls cargo in.
export const COLONY_FOOD_CONSUME_MILLI = 4000;
export const COLONY_MINERALS_CONSUME_MILLI = 4000;

// A PROVIDER (farm / mine) is a pure emitter, not a warehouse: its silo for the
//   good it makes is just ONE TURN of that output (set in registry.ts as the cap
//   = the production rate), so it ships what it makes and holds nothing at rest.
//   The moment a turn passes with no consumer pulling, the silo is full and the
//   sim gluts it — production throttles until cargo ships (the storage-room clamp
//   in produce.ts). Without a cap a provider accumulates without bound, so the
//   lowest-indexed one builds a runaway stockpile and single-sources all demand
//   while its peers silently hoard. The good a provider IMPORTS stays uncapped so
//   it can buffer what it eats.
