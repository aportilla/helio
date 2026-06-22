// FACILITY_DEFS — the single source of truth for every facility type. Adding a
// facility is one object here plus one literal in the FacilityType union: its
// save-key, UI label, Add-button order, build cap, body-eligibility predicate,
// and economic projection all flow from that one edit. This collapses what used
// to be smeared across game-state.ts, the system-view facilities UI, and system-scene.ts.

import type { Body } from '../data/stars.ts';
import type { FacilityDef, FacilityType } from './types.ts';
import { ContributionBuilder, emptyContribution } from './types.ts';
import { EconResource } from './resource-vocab.ts';
import {
  COLONY_FOOD_CONSUME_MILLI,
  COLONY_MINERALS_CONSUME_MILLI,
  FARM_FOOD_PRODUCE_MILLI,
  FARM_MINERALS_CONSUME_MILLI,
  MINE_FOOD_CONSUME_MILLI,
  MINE_MINERALS_PRODUCE_MILLI,
} from './tuning.ts';

// The one eligibility rule, authored once: a solid body you can place a facility
// on (planet, moon, or belt — never a star or a ring). A static STRUCTURAL gate,
// not a body-physics calc; the kind is read directly, no body classifier. Each def
// still OWNS its predicate (so a future type can diverge with zero ripple); v1 they
// all share this one — no facility's emission or eligibility reads body dynamics.
function isSolidSite(body: Body): boolean {
  return body.kind === 'planet' || body.kind === 'moon' || body.kind === 'belt';
}

// The registry, keyed by FacilityType. `satisfies Record<FacilityType, ...>` is
// the compile layer of the frozen-key guard: adding a literal to
// the FacilityType union without adding a def here fails to compile, and a key
// that isn't a FacilityType is rejected. The key IS the save id; the DEV assert
// below pins each def's own `type` field to its key.
const DEFS = {
  colony: {
    type: 'colony',
    label: 'Colony',
    color: '#5ec8ff', // cyan — the civic hue, matching the HUD's selection accent
    addOrder: 0,
    maxPerBody: 1,
    canBuildOn: isSolidSite,
    // A pure consumer: a population that eats food and uses minerals, and produces
    // nothing. It is the demand the farms and mines exist to serve — the sink that
    // pulls both currents of cargo in. Flat: the same appetite on every body.
    contribute: (_body: Body, ctx) => {
      const c = new ContributionBuilder(ctx.R);
      c.consume(EconResource.Food, COLONY_FOOD_CONSUME_MILLI);
      c.consume(EconResource.Minerals, COLONY_MINERALS_CONSUME_MILLI);
      return c.build();
    },
  },
  'mining-base': {
    type: 'mining-base',
    label: 'Mining base',
    color: '#d7b070', // ore tan — minerals
    addOrder: 1,
    maxPerBody: 1,
    canBuildOn: isSolidSite,
    // A mineral provider: a FAUCET that mints minerals on demand (up to its
    // per-turn rating) and feeds a small workforce on imported food. It holds
    // nothing at rest — a mine with no buyer makes nothing, no silo, no glut.
    contribute: (_body: Body, ctx) => {
      const c = new ContributionBuilder(ctx.R);
      c.produce(EconResource.Minerals, MINE_MINERALS_PRODUCE_MILLI);
      c.consume(EconResource.Food, MINE_FOOD_CONSUME_MILLI);
      return c.build();
    },
  },
  farm: {
    type: 'farm',
    label: 'Farm',
    color: '#8ae89a', // green — food (the signalPositive family)
    addOrder: 2,
    maxPerBody: 1,
    canBuildOn: isSolidSite,
    // A food provider: a FAUCET that grows food on demand (up to its per-turn
    // rating) and draws a little minerals for tooling. It holds nothing at rest —
    // a farm with no buyer makes nothing, so surplus never gluts.
    contribute: (_body: Body, ctx) => {
      const c = new ContributionBuilder(ctx.R);
      c.produce(EconResource.Food, FARM_FOOD_PRODUCE_MILLI);
      c.consume(EconResource.Minerals, FARM_MINERALS_CONSUME_MILLI);
      return c.build();
    },
  },
  shipyard: {
    type: 'shipyard',
    label: 'Shipyard',
    color: '#b884e0', // violet — construction/industry, distinct from the economy hues
    addOrder: 3,
    maxPerBody: 1,
    enablesShipbuilding: true,
    canBuildOn: isSolidSite,
    // NOT an economy producer: a shipyard unlocks ship construction (the Build-Ship
    // pill), not a resource flow. It emits the zero Contribution so the projector
    // folds nothing onto the body's stock/flows — including the speculative
    // next-turn preview — and the build stepper can never perturb the economy.
    contribute: (_body: Body, ctx) => emptyContribution(ctx.R),
  },
} satisfies Record<FacilityType, FacilityDef>;

export const FACILITY_DEFS: readonly FacilityDef[] = Object.values(DEFS);

export const FACILITY_BY_TYPE: ReadonlyMap<FacilityType, FacilityDef> = new Map(
  Object.entries(DEFS) as Array<[FacilityType, FacilityDef]>,
);

// Add-button order: buildable (non-retired) defs, sorted by addOrder. The sidebar's
// SystemContext renders one "Add <label>" pill per entry; system-scene checks
// placement eligibility through addableTypesFor (eligibility.ts), which filters this list.
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

// Single source of a facility's display COLOR — the on-body icon chip in the
// system view (and, later, a matching chip in the sidebar rows). A literal sRGB
// hex; with ColorManagement OFF it renders verbatim through both the canvas
// painter and the scene shaders. White fallback is unreachable for a live type
// (color is required on FacilityDef) — it only guards a future retired tombstone.
export function facilityColor(type: FacilityType): string {
  return FACILITY_BY_TYPE.get(type)?.color ?? '#ffffff';
}

// The localStorage save contract: every facility id that has ever shipped. These
// are HISTORICAL wire strings, deliberately NOT typed as the live FacilityType
// union — so renaming a shipped type can't quietly re-green the guard by editing
// this list under compiler pressure. The CI test (test/registry.test.ts) asserts
// each entry is still a live type (FACILITY_TYPES.has), so removing OR renaming a
// shipped id fails — protecting old saves from a compiler-invisible "cleanup". A
// retired type stays here AND in the registry as a `retired: true` tombstone def,
// never deleted outright.
export const FROZEN_FACILITY_IDS: readonly string[] = ['colony', 'mining-base', 'farm', 'shipyard'];

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
