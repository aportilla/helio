// EFFECT_DEFS — the single source of truth for every combat effect, the fourth registry-family
// member. Adding an effect is one object here plus one literal in the EffectKey union; the reducer
// folds it by hook presence with no central edit (../README.md). Mirrors src/factions/registry.ts's
// frozen-key discipline exactly. EffectDefs are CODE (never serialized); only ActiveEffect instances
// persist, re-binding to a def by `key`.

import type { EffectDef, EffectKey } from './types.ts';

// The registry, keyed by EffectKey. `satisfies Record<EffectKey, EffectDef>` is the compile layer of
// the frozen-key guard: a union literal with no def here fails to compile, and a stray key is
// rejected. The key IS the replay-binding id; the DEV assert below pins each def's `key` to its
// registry key.
const DEFS = {
  // Worked example A (4x-encounter-combat-system §7.5): the engine's per-cycle energy recharge as a
  // DECLARED effect, not a hardcoded reducer step. The amount rides on the INSTALL's params, so a
  // second power component simply installs its own `recharge` instance — the two sum in the one fold,
  // with no merge logic. Clamped at the derived energyMax stat.
  recharge: {
    key: 'recharge',
    label: 'Recharge',
    color: '#3fd2ff',
    tags: ['buff'],
    onCycleStart: (ctx) => [{ statKey: 'energy', delta: ctx.params.amount ?? 0, clampToMaxKey: 'energyMax' }],
  },
} satisfies Record<EffectKey, EffectDef>;

export const EFFECT_DEFS: readonly EffectDef[] = Object.values(DEFS);

export const EFFECT_BY_KEY: ReadonlyMap<EffectKey, EffectDef> = new Map(
  Object.entries(DEFS) as Array<[EffectKey, EffectDef]>,
);

// The replay validation set, derived from the registry so it can never drift from the union. Typed
// as a string-set because it guards arbitrary keys a replay log might carry.
export const EFFECT_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFS));

// The replay save contract: every EffectKey that has ever shipped. HISTORICAL wire strings,
// deliberately NOT typed as the live union — so renaming a shipped effect can't quietly re-green the
// guard. The CI test asserts each entry is still a live key (EFFECT_KEYS.has), so removing OR
// renaming a shipped id fails, protecting old replays.
export const FROZEN_EFFECT_IDS: readonly string[] = ['recharge'];

// DEV-only module-load invariant: each def's `key` equals its registry key, and every frozen id is
// still live. Mirrors the factions / ships / facilities drift checks — loud in dev, stripped in
// prod, irrelevant under node tests (which assert the same facts explicitly).
if (import.meta.env?.DEV) {
  for (const [key, def] of Object.entries(DEFS)) {
    if (def.key !== key) {
      throw new Error(`[effects] def keyed '${key}' declares key '${def.key}'`);
    }
  }
  for (const id of FROZEN_EFFECT_IDS) {
    if (!EFFECT_KEYS.has(id)) {
      throw new Error(`[effects] frozen id '${id}' is no longer a live key — old replays would break`);
    }
  }
}
