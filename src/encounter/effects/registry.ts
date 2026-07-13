// EFFECT_DEFS — the single source of truth for every combat effect, the fourth registry-family
// member. Adding an effect is one object here plus one literal in the EffectKey union; the reducer
// folds it by hook presence with no central edit (../README.md). Mirrors src/factions/registry.ts's
// frozen-key discipline exactly. EffectDefs are CODE (never serialized); only ActiveEffect instances
// persist, re-binding to a def by `key`.

import type { EffectDef, EffectKey, EffectOutcome } from './types.ts';
import { SHIELD_RESIST } from '../tuning.ts';

// The pool-band key BOTH shield sources (the timed raise-shields segment and the always-on generator)
// splice — shared so a weapon's `eff:shields` effectiveness applies to either, and the generator finds
// "its" band by the same name. The per-combatant fritz timer is a plain stat the generator reads + counts
// down (no new substrate state) — distinct from energy, living in the same opaque stat bag.
const SHIELD_KEY = 'shields';
const SHIELD_COOLDOWN = 'shieldCooldown';

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
        { kind: 'pool', op: 'splice', pool: { key: SHIELD_KEY, current: ctx.params.capacity ?? 0, max: ctx.params.capacity ?? 0, resistByType: SHIELD_RESIST }, aboveKey: 'hull' },
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
  // A one-shot HIT as a DECLARED effect — so the reducer holds no hardcoded attack behaviour fork.
  // A weapon mints it on each resolved TARGET via
  // installsOnResolve (the same path the shield's raise-shields uses, non-self), with `remaining: 0`
  // so it applies once and never rides on. Its `install` handler cascades a `damage` pool outcome through
  // the target's stack — shields absorb before hull purely by stack order, so there is zero attack-
  // specific code in the fold. The hit MAGNITUDE is install param (the weapon's stat, declared on the
  // component), so a stronger gun is a bigger param, not new code. This is the seam EVERY enemy-applied
  // effect grows behind — a debuff / slow / taunt / the Disruption Virus initiative swing is a new
  // EffectDef + an installsOnResolve entry, never a reducer branch. `color`/`tags` are nominal: a hit
  // renders through the damage event's tracer (§14), not an effect chip.
  damage: {
    key: 'damage',
    label: 'Damage',
    color: '#ff5a5a',
    tags: ['attack'],
    on: {
      // The hit's MAGNITUDE is `amount`; its TYPE rides on the install (`ctx.damageType`, e.g. 'energy') and
      // is stamped onto the `damage` PoolEdit so the cascade scales it by each target band's RESISTANCE to
      // that type (./pools + src/encounter/tuning SHIELD_RESIST / HULL_RESIST — the numbers live on the
      // defence). No `damageType` ⇒ a flat, type-agnostic hit. The damage stays a uniform pool outcome — no
      // per-weapon code.
      install: (ctx) => {
        const amount = ctx.params.amount ?? 0;
        return [ctx.damageType !== undefined
          ? { kind: 'pool', op: 'damage', amount, damageType: ctx.damageType }
          : { kind: 'pool', op: 'damage', amount }];
      },
    },
  },
  // Worked example E — an ALWAYS-ON shield that consumes energy to maintain and FRITZES OUT when fully
  // stripped, expressed as ONE permanent effect's `phaseStart` state machine: NO reactive trigger, NO new
  // lifecycle moment, NO mutable-state bag. It reads only its owner's pools + stats (the handler's whole
  // context) and emits ordinary outcomes. `install` splices a full `shields` band above hull. At each of
  // the owner's SIDE phase starts the band is in one of four states the handler branches on, mutually
  // exclusively, from the single owner snapshot:
  //   • UP (band present, current > 0): pay `upkeep` energy (StatDelta, clamp ≥0) + `restore` toward cap by
  //     `regen` — but only if energy covers the upkeep ("consumes energy to maintain": a drained ship's
  //     shield stops regenerating).
  //   • COLLAPSED (band present, current 0 — a hit emptied it last phase): `drop` the dead band + set the
  //     `shieldCooldown` stat to `fritzPhases`. The shield is now DOWN.
  //   • FRITZING (no band, cooldown > 1): count the cooldown down by 1.
  //   • REBOOT (no band, cooldown ≤ 1 but > 0): clear the cooldown + re-`splice` a FULL band. (Reboot to
  //     full, NOT cold: a `current 0` band would be indistinguishable from a just-collapsed one and re-fritz
  //     every phase. The N-phase gap was the cost; `regen` recovers PARTIAL hits, reboot recovers a total
  //     collapse.)
  // The fritz timer is just a stat the handler reads + decrements, and "is the band there?" is its own
  // memory — so a crisp N-phase lockout needs zero substrate growth beyond the `restore` op. `current === 0`
  // therefore means UNAMBIGUOUSLY "just collapsed" (the band is never parked at 0). The 1-phase detection
  // lag (collapse is noticed at the NEXT phase start) is accepted; a reactive `damageTaken` moment would
  // make it instant but is deferred. (Assumes ONE shields band per ship — the generator finds its band by
  // key; a ship also flying a raise-shields segment would need the effect's own id, deferred.)
  'shield-generator': {
    key: 'shield-generator',
    label: 'Shield Generator',
    color: '#5b8dd6',
    tags: ['buff', 'shield'],
    on: {
      install: (ctx) => [
        { kind: 'pool', op: 'splice', pool: { key: SHIELD_KEY, current: ctx.params.capacity ?? 0, max: ctx.params.capacity ?? 0, resistByType: SHIELD_RESIST }, aboveKey: 'hull' },
      ],
      phaseStart: (ctx) => {
        const band = ctx.owner.pools?.find((p) => p.key === SHIELD_KEY);
        const cooldown = ctx.owner.stats?.[SHIELD_COOLDOWN] ?? 0;
        if (band && band.current > 0) {
          const upkeep = ctx.params.upkeep ?? 0;
          if ((ctx.owner.stats?.energy ?? 0) < upkeep) return []; // can't afford upkeep ⇒ no regen this phase
          const out: EffectOutcome[] = [];
          if (upkeep > 0) out.push({ kind: 'stat', statKey: 'energy', delta: -upkeep, clampToZero: true });
          out.push({ kind: 'pool', op: 'restore', amount: ctx.params.regen ?? 0 });
          return out;
        }
        if (band && band.current === 0) { // present but emptied — JUST collapsed
          // `delta` SETS the timer to fritzPhases (not adds): cooldown is 0 here in normal flow (band
          // present ⟹ cooldown 0, the invariant the drop+set / clear+splice pairs maintain), but the
          // set-form is robust even if it weren't. The explicit `current === 0` (not a bare `if (band)`
          // riding on the UP branch's return) keeps this self-contained.
          return [
            { kind: 'pool', op: 'drop' },
            { kind: 'stat', statKey: SHIELD_COOLDOWN, delta: (ctx.params.fritzPhases ?? 0) - cooldown },
          ];
        }
        if (cooldown > 1) return [{ kind: 'stat', statKey: SHIELD_COOLDOWN, delta: -1 }]; // still fritzing
        if (cooldown > 0) { // reboot: clear the timer, re-splice a FULL band (never 0 — see the note above)
          const capacity = ctx.params.capacity ?? 0;
          return [
            { kind: 'stat', statKey: SHIELD_COOLDOWN, delta: -cooldown },
            { kind: 'pool', op: 'splice', pool: { key: SHIELD_KEY, current: capacity, max: capacity, resistByType: SHIELD_RESIST }, aboveKey: 'hull' },
          ];
        }
        return [];
      },
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
export const FROZEN_EFFECT_IDS: readonly string[] = ['recharge', 'shield-segment', 'tactical-command', 'damage', 'shield-generator'];

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
