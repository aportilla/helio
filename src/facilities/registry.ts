// FACILITY_DEFS — the single source of truth for every facility type. Adding a
// facility is one object here plus one literal in the FacilityType union: its
// save-key, UI label, Add-button order, build cap, body-eligibility predicate,
// and economic projection all flow from that one edit. This collapses what used
// to be smeared across game-state.ts, facilities-panel.ts, and system-scene.ts.

import type { Body } from '../data/stars.ts';
import type { FacilityDef, FacilityType } from './types.ts';
import { ContributionBuilder } from './types.ts';
import { abundanceMilli, scaleByRichness } from './abundance.ts';
import { EconResource } from './resource-vocab.ts';
import {
  COLONY_ENERGY_CONSUME_MILLI,
  COLONY_ENERGY_PRODUCE_MILLI,
  COLONY_FOOD_CONSUME_MILLI,
  COLONY_FOOD_PRODUCE_AT_FULL_MILLI,
  MINE_ENERGY_CONSUME_MILLI,
  MINE_ENERGY_PRODUCE_MILLI,
  MINE_FOOD_CONSUME_MILLI,
  MINE_OUTPUT_AT_FULL_MILLI,
} from './tuning.ts';

// Today's eligibility rule, authored once: a solid body you can put extraction /
// habitation on (planet, moon, or belt — never a star or a ring). Each def still
// OWNS its predicate (so a future type can diverge with zero ripple); they just
// happen to share this helper in v1. Reads kind directly — no body classifier.
function isSolidExtractionSite(body: Body): boolean {
  return body.kind === 'planet' || body.kind === 'moon' || body.kind === 'belt';
}

// Strategic resources a mining base extracts; each scaled by its site richness.
const MINED_RESOURCES: readonly EconResource[] = [
  EconResource.Alloys,
  EconResource.Minerals,
  EconResource.Volatiles,
  EconResource.RareTech,
  EconResource.Exotics,
];

// A mining base needs SOMETHING to extract — at least one strategic resource
// present. Without this gate a mine on a barren belt would project a degenerate
// zero-production node that still consumes a PlanetId (plan §10). The crisp
// boolean here (does the button appear?) is kept distinct from the weighted rate
// (how much it produces) for legibility.
function hasExtractableRichness(body: Body): boolean {
  return MINED_RESOURCES.some((res) => abundanceMilli(body, res) > 0);
}

// The registry, keyed by FacilityType. `satisfies Record<FacilityType, ...>` is
// the compile layer of the frozen-key guard (plan §11.3a): adding a literal to
// the FacilityType union without adding a def here fails to compile, and a key
// that isn't a FacilityType is rejected. The key IS the save id; the DEV assert
// below pins each def's own `type` field to its key.
const DEFS = {
  colony: {
    type: 'colony',
    label: 'Colony',
    addOrder: 0,
    maxPerBody: 1,
    canBuildOn: isSolidExtractionSite,
    // A habitation node: farms what local biology supports, runs a reactor, and
    // always eats. Lush worlds export food; barren ones import it.
    contribute: (body: Body, ctx) => {
      const c = new ContributionBuilder(ctx.R);
      const foodRichness = abundanceMilli(body, EconResource.Food);
      c.produce(EconResource.Food, scaleByRichness(COLONY_FOOD_PRODUCE_AT_FULL_MILLI, foodRichness));
      c.consume(EconResource.Food, COLONY_FOOD_CONSUME_MILLI);
      c.produce(EconResource.Energy, COLONY_ENERGY_PRODUCE_MILLI);
      c.consume(EconResource.Energy, COLONY_ENERGY_CONSUME_MILLI);
      return c.build();
    },
  },
  'mining-base': {
    type: 'mining-base',
    label: 'Mining base',
    addOrder: 1,
    maxPerBody: 1,
    // Diverges from colony: a solid site that also has something worth mining.
    canBuildOn: (body: Body) => isSolidExtractionSite(body) && hasExtractableRichness(body),
    // An extractor node: each strategic resource scaled by the matching site
    // richness; powers itself and feeds a small workforce.
    contribute: (body: Body, ctx) => {
      const c = new ContributionBuilder(ctx.R);
      for (const res of MINED_RESOURCES) {
        c.produce(res, scaleByRichness(MINE_OUTPUT_AT_FULL_MILLI, abundanceMilli(body, res)));
      }
      c.produce(EconResource.Energy, MINE_ENERGY_PRODUCE_MILLI);
      c.consume(EconResource.Energy, MINE_ENERGY_CONSUME_MILLI);
      c.consume(EconResource.Food, MINE_FOOD_CONSUME_MILLI);
      return c.build();
    },
  },
} satisfies Record<FacilityType, FacilityDef>;

export const FACILITY_DEFS: readonly FacilityDef[] = Object.values(DEFS);

export const FACILITY_BY_TYPE: ReadonlyMap<FacilityType, FacilityDef> = new Map(
  Object.entries(DEFS) as Array<[FacilityType, FacilityDef]>,
);

// Add-button order: buildable (non-retired) defs, sorted by addOrder. The panel
// renders one "Add <label>" button per entry; system-scene checks placement
// eligibility through addableTypesFor (eligibility.ts), which filters this list.
export const ADD_ORDER: readonly FacilityType[] = FACILITY_DEFS.filter((d) => !d.retired)
  .slice()
  .sort((a, b) => a.addOrder - b.addOrder)
  .map((d) => d.type);

// The persistence validation set, derived from the registry so it can never
// drift from the union (game-state.ts reads this to reject unknown saved types).
// Typed as a string-set because it validates arbitrary parsed JSON.
export const FACILITY_TYPES: ReadonlySet<string> = new Set(Object.keys(DEFS));

// Single source of a facility's display name — rows and "Add <label>" buttons.
export function facilityLabel(type: FacilityType): string {
  return FACILITY_BY_TYPE.get(type)?.label ?? type;
}

// The localStorage save contract: every facility id that has ever shipped. These
// are HISTORICAL wire strings, deliberately NOT typed as the live FacilityType
// union — so renaming a shipped type can't quietly re-green the guard by editing
// this list under compiler pressure. The CI test (test/registry.test.ts) asserts
// each entry is still a live type (FACILITY_TYPES.has), so removing OR renaming a
// shipped id fails — protecting old saves from a compiler-invisible "cleanup". A
// retired type stays here AND in the registry as a `retired: true` tombstone def
// (plan §11), never deleted outright.
export const FROZEN_FACILITY_IDS: readonly string[] = ['colony', 'mining-base'];

// DEV-only module-load invariant: each def's `type` field equals its registry key,
// and every frozen id is still a live type. Mirrors the catalog drift check in
// stars.ts — loud in dev, stripped in prod, irrelevant under node tests (which
// assert the same facts explicitly). import.meta.env is undefined outside Vite,
// hence the optional chain.
if (import.meta.env?.DEV) {
  for (const [key, def] of Object.entries(DEFS)) {
    if (def.type !== key) {
      throw new Error(`[facilities] def keyed '${key}' declares type '${def.type}'`);
    }
  }
  for (const id of FROZEN_FACILITY_IDS) {
    if (!FACILITY_TYPES.has(id)) {
      throw new Error(`[facilities] frozen id '${id}' is no longer a live type — old saves would break`);
    }
  }
}
