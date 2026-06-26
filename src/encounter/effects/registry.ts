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
  // Worked example A (4x-encounter-combat-system §7.5/§3.8.5): the engine's energy recharge as a DECLARED
  // effect, not a hardcoded reducer step. The amount rides on the INSTALL's params, so a second power
  // component simply installs its own `recharge` instance — the two sum in the one fold, with no merge
  // logic. A `phaseStart` handler returning ONE stat outcome, clamped at the energyMax stat: it folds at
  // the owner's SIDE phase start (foldPhaseStart), so when the baton passes to a side EVERY one of its
  // ships recharges AT ONCE — never mid-phase between activations, never only the ships that acted.
  recharge: {
    key: 'recharge',
    label: 'Recharge',
    color: '#3fd2ff',
    tags: ['buff'],
    on: {
      phaseStart: (ctx) => [{ kind: 'stat', statKey: 'energy', delta: ctx.params.amount ?? 0, clampToMaxKey: 'energyMax' }],
    },
  },
  // Worked example B (4x-encounter-combat-system §7.5): a timed shield as a DECLARED effect, minted
  // when a defense component's `raise-shields` resolves (ShipComponentDef.installsOnResolve). `install`
  // splices a `shields` band directly above `hull`, so the dumb damage cascade absorbs into it FIRST —
  // "absorb before hull" is purely this stack order, with NO shield-specific reducer code. `expire` pops
  // the band (and any unspent capacity) when the instance counts out. The fold supplies the band's
  // sourceEffectId, so two raised shields are two independent bands (distinct-instances stacking).
  'shield-segment': {
    key: 'shield-segment',
    label: 'Shield',
    color: '#5b8dd6',
    tags: ['buff', 'shield'],
    on: {
      install: (ctx) => [
        { kind: 'pool', op: 'splice', pool: { key: 'shields', current: ctx.params.capacity ?? 0, max: ctx.params.capacity ?? 0 }, aboveKey: 'hull' },
      ],
      expire: () => [{ kind: 'pool', op: 'drop' }],
    },
  },
  // The Press-Turn tempo contribution as a DECLARED effect, NOT a static `initiative?` registry key
  // (§3.8.2/§3.8.6): the tactical-command-module installs a PERMANENT `tactical-command`, and at the
  // owner's SIDE phase start its `phaseStart` handler returns a SideDelta of +`initiative` icons. The
  // fold sums these into the side's pool — so the contribution is DYNAMIC (only living carriers count,
  // re-folded each phase) and lives on the generic substrate. `stacking: 'presence'` makes it count
  // ONCE per side however many ships carry it (presence-not-count) — a novel side-buff that DOES stack
  // would just be 'sum'; an enemy-applied debuff would return a negative SideDelta. No new keys, no
  // reducer branch.
  'tactical-command': {
    key: 'tactical-command',
    label: 'Tactical Command',
    color: '#f5b942',
    tags: ['buff', 'initiative'],
    stacking: 'presence',
    on: {
      phaseStart: (ctx) => [{ kind: 'side', initiative: ctx.params.initiative ?? 0 }],
    },
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
export const FROZEN_EFFECT_IDS: readonly string[] = ['recharge', 'shield-segment', 'tactical-command'];

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
