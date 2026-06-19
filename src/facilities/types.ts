// The facility seam's type vocabulary — the contract every other module in
// src/facilities/ satisfies. Imports nothing app-side at runtime (Body is a
// type-only import, fully erased), and nothing from the sim: PlanetSpec lives
// on the far side of the projector (project.ts), so this file stays a pure
// declaration leaf that node can load without the catalog or the DOM.

import type { Body } from '../data/stars.ts';

// FROZEN serialized contract. These exact strings persist in 'helio.game'
// (keyed by Body.id, value `{id, bodyId, type}`). Adding a member is safe;
// renaming/removing a shipped member breaks old saves — three guards defend
// it (registry FROZEN_FACILITY_IDS + its CI test, the DEV module-load assert,
// and this literal union forcing every switch/Record to update). See the plan
// in plans/4x-facility-definitions-modularity-plan.md §8/§11.
export type FacilityType = 'colony' | 'mining-base' | 'farm';

// Body → its transport-graph node (the value that becomes PlanetSpec.star). In
// the shipped model that node is the body's CLUSTER — one node per cluster, a
// system with a shared pool of bodies: every facility-bearing body resolves to
// its cluster's node, so all bodies in a cluster share it and trade freely, and
// only crossing between clusters costs jump range. The projector needs only the
// signature; economy-bridge.ts supplies the resolver (clusterNodeOfBody) and the
// matching one-node-per-cluster geometry.
export type SimStarResolver = (body: Body) => number;

// Everything the projector hands a def's contribute(). Carries the resource
// count (so a contribution's arrays are the right length) and the body→node
// resolver. Kept sim-free: R is just a number, starOf just a function.
export interface ProjectionCtx {
  // === appResourceTable().count (R). Every Contribution array is this long.
  readonly R: number;
  readonly starOf: SimStarResolver;
}

// One facility's economic emission for a single placement on a body. Shaped to
// match the sim's PlanetSpec (sim/src/world.ts) exactly, so projection is a
// fold with no reshaping: the projector SUMS production/consumption/stock and
// COMBINES storageCeiling across the facilities on a body. Every value is
// integer milli, indexed by EconResource id.
export interface Contribution {
  readonly production: readonly number[];     // per-turn production (milli)
  readonly consumption: readonly number[];    // per-turn consumption (milli)
  readonly stock: readonly number[];          // initial endowment, cold-start only (plan §7.4)
  readonly storageCeiling: readonly number[]; // per-resource ceiling (combine, never add — plan §7.3)
}

// The minimum a placed facility must expose to be queried/projected — just its
// type. game-state's richer Facility ({id, bodyId, type}) is assignable to this,
// so callers pass their Facility[] straight through to addableTypesFor /
// projectBody without adapting.
export interface PlacedFacility {
  readonly type: FacilityType;
}

export interface FacilityDef {
  readonly type: FacilityType;          // === its registry key; a DEV assert pins def.type === key
  readonly label: string;               // 'Colony' — single source for rows + "Add <label>" buttons
  readonly addOrder: number;            // stable display order of the Add button
  readonly maxPerBody: number;          // build cap per (body, type) (v1 = 1; raise to allow stacking)
  readonly retired?: boolean;           // a shipped-then-removed type: no Add button, empty contribute (plan §11)

  // Eligibility as a per-def predicate over catalog physics — replaces the old
  // inline kind gate, honouring the repo's "non-exclusive predicates, no single
  // body classifier" convention. Null physics fields are treated as absent.
  readonly canBuildOn: (body: Body) => boolean;

  // THE seam method: this facility's emission for one placement on `body`.
  // Pure, deterministic, integer-milli. The projector sums these with no
  // facility-type branch (the kernel never sees facility identity).
  readonly contribute: (body: Body, ctx: ProjectionCtx) => Contribution;
}

// A zero Contribution of the right width — the cold-start identity the
// projector folds onto, and what a retired (or economy-less) def emits. A zero
// storageCeiling means "no limit from me" (the common case); the projector
// translates that to the sim's uncapped sentinel (plan §7.3) so this stays
// sim-free.
export function emptyContribution(R: number): Contribution {
  return new ContributionBuilder(R).build();
}

// Mutable scratch for assembling a Contribution by EconResource id. Keeps the
// defs' contribute() bodies declarative and sim-free: they accumulate into the
// four parallel arrays, then build() hands back the readonly Contribution. All
// values are integer milli; storageCeiling left at 0 means uncapped.
export class ContributionBuilder {
  readonly production: number[];
  readonly consumption: number[];
  readonly stock: number[];
  readonly storageCeiling: number[];

  constructor(R: number) {
    this.production = new Array<number>(R).fill(0);
    this.consumption = new Array<number>(R).fill(0);
    this.stock = new Array<number>(R).fill(0);
    this.storageCeiling = new Array<number>(R).fill(0);
  }

  produce(r: number, milli: number): this {
    this.production[r] = (this.production[r] ?? 0) + milli;
    return this;
  }
  consume(r: number, milli: number): this {
    this.consumption[r] = (this.consumption[r] ?? 0) + milli;
    return this;
  }
  endow(r: number, milli: number): this {
    this.stock[r] = (this.stock[r] ?? 0) + milli;
    return this;
  }
  // A finite storage cap for r (milli). Default (unset) is uncapped; the
  // projector COMBINES caps across a body's facilities — finite caps sum, any
  // uncapped facility dominates (never a plain sum of the two — see combineCeiling).
  cap(r: number, milli: number): this {
    this.storageCeiling[r] = milli;
    return this;
  }

  build(): Contribution {
    return {
      production: this.production,
      consumption: this.consumption,
      stock: this.stock,
      storageCeiling: this.storageCeiling,
    };
  }
}
