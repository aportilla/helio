// The economic vocabulary — the resource ids the app moves. SIM-FREE: a plain const, so importing
// the vocabulary (e.g. into the facility registry's contribute() fns, and thus transitively into
// anything that reads a FacilityDef) never drags the standalone sim. The sim-built ResourceTable
// instance lives in ./resource-table.ts — the one module here that reaches the sim for the table;
// the sim owns the table TYPE + its validating constructor, the app owns the instance (the correct
// side of the standalone wall).
//
// EconResource is a const-object + derived union (the erasableSyntaxOnly idiom the sim's
// resources.ts uses, since `enum` is banned). Its ordinals ARE the ResourceTable row indices
// (./resource-table.ts asserts the match at startup), so the roster order is load-bearing.
//
// These ids are app-internal and NEVER serialized into 'helio.game' (that save holds facility
// types, not resources), so the roster is freely re-mappable.

// The v1 roster, deliberately minimal: just the two goods the base facilities move. Farms make
// Food, mines make Minerals, colonies eat both. More resources (and a general resource
// granularity) are a later, additive change.
export const EconResource = {
  Food: 0,
  Minerals: 1,
} as const;
export type EconResource = (typeof EconResource)[keyof typeof EconResource];
