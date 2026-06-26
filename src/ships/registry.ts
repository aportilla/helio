// SHIP_CLASS_DEFS — the single source of truth for every ship class. Adding a
// class is one object here plus one literal in the ShipClassType union: its save-key
// (classId), build-flow label, display color, build time, and sprite budget all flow
// from that one edit. Mirrors src/facilities/registry.ts exactly, deliberately, so
// the frozen-key discipline reads identically across both registries.

import type { ShipClassDef, ShipClassType } from './types.ts';
import { CORVETTE_BUILD_TURNS, CORVETTE_SPRITE_SIZE_PX } from './tuning.ts';

// The registry, keyed by ShipClassType. `satisfies Record<ShipClassType, ...>` is
// the compile layer of the frozen-key guard: adding a literal to the union without
// a def here fails to compile, and a key that isn't a ShipClassType is rejected.
// The key IS the save id; the DEV assert below pins each def's `type` to its key.
const DEFS = {
  corvette: {
    type: 'corvette',
    label: 'Corvette',
    color: '#b9c4d0', // steel — a hull grey distinct from the facility chip hues
    buildTurns: CORVETTE_BUILD_TURNS,
    spriteSizePx: CORVETTE_SPRITE_SIZE_PX,
    // The v1 basic loadout every corvette flies with (no build UI yet): a small engine (a recharge
    // effect, no action) + a small laser (ATTACK). These component ids back the ship's derived action ids.
    components: ['small-engine', 'small-laser'],
  },
} satisfies Record<ShipClassType, ShipClassDef>;

export const SHIP_CLASS_DEFS: readonly ShipClassDef[] = Object.values(DEFS);

export const SHIP_CLASS_BY_TYPE: ReadonlyMap<ShipClassType, ShipClassDef> = new Map(
  Object.entries(DEFS) as Array<[ShipClassType, ShipClassDef]>,
);

// The persistence validation set, derived from the registry so it can never drift
// from the union (game-state-codec.ts reads this to reject unknown saved classIds).
// Typed as a string-set because it validates arbitrary parsed JSON.
export const SHIP_CLASS_TYPES: ReadonlySet<string> = new Set(Object.keys(DEFS));

// The class the Build-Ship action constructs in v1 — a single class; an in-builder
// picker is deferred. Named so the one site that starts a build has a single source
// rather than an inline string.
export const DEFAULT_SHIP_CLASS: ShipClassType = 'corvette';

// Single source of a class's display name — build rows now, fleet labels later.
export function shipClassLabel(type: ShipClassType): string {
  return SHIP_CLASS_BY_TYPE.get(type)?.label ?? type;
}

// Single source of a class's display COLOR. Currently DORMANT: the fleet sprite tints
// by FACTION color (src/factions/), not class color, so this is reserved for a later
// per-class accent / build preview. A literal sRGB hex; with ColorManagement OFF it
// renders verbatim through both the canvas painter and the scene shaders. White
// fallback only guards a future retired tombstone (color is required on a live def).
export function shipClassColor(type: ShipClassType): string {
  return SHIP_CLASS_BY_TYPE.get(type)?.color ?? '#ffffff';
}

// The v1 build cost: how many galaxy turns a class takes. The build stepper reads
// this once at start to stamp completesOnTurn (game-state.ts). 1-turn fallback only
// guards a future retired class.
export function buildTurns(type: ShipClassType): number {
  return SHIP_CLASS_BY_TYPE.get(type)?.buildTurns ?? 1;
}

// The localStorage save contract: every classId that has ever shipped. HISTORICAL
// wire strings, deliberately NOT typed as the live ShipClassType union — so renaming
// a shipped class can't quietly re-green the guard under compiler pressure. The CI
// test (test/registry.test.ts) asserts each entry is still a live type
// (SHIP_CLASS_TYPES.has), so removing OR renaming a shipped id fails, protecting old
// saves from a compiler-invisible "cleanup".
export const FROZEN_SHIP_CLASS_IDS: readonly string[] = ['corvette'];

// DEV-only module-load invariant: each def's `type` equals its registry key, and
// every frozen id is still a live type. Mirrors the facilities + catalog drift
// checks — loud in dev, stripped in prod, irrelevant under node tests (which assert
// the same facts explicitly). import.meta.env is undefined outside Vite, hence the
// optional chain.
if (import.meta.env?.DEV) {
  for (const [key, def] of Object.entries(DEFS)) {
    if (def.type !== key) {
      throw new Error(`[ships] def keyed '${key}' declares type '${def.type}'`);
    }
  }
  for (const id of FROZEN_SHIP_CLASS_IDS) {
    if (!SHIP_CLASS_TYPES.has(id)) {
      throw new Error(`[ships] frozen id '${id}' is no longer a live type — old saves would break`);
    }
  }
}
