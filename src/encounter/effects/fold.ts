// fold — the pure effect machinery: collect declared installs (the deriveCommands twin), MINT them
// into ActiveEffects (running each one's onInstall pool edits), and tick a combatant's per-cycle
// effects at its turn start (running onCycleStart, then onExpire as a timed instance counts out). The
// fold dispatches by hook PRESENCE — no effectKey branch — exactly as deriveCommands folds grants.
// Pure: it reads the effect registry + the state/pool leaves, nothing app-side.

import { EFFECT_BY_KEY } from './registry.ts';
import type { ActiveEffect, EffectInstall, PoolEdit, StatDelta } from './types.ts';
import type { Combatant, EncounterEvent, EncounterState } from '../state.ts';
import { withPools, withStat } from '../state.ts';
import { dropPoolsBySource, splicePool, type Pool } from '../pools.ts';

// The pure twin of deriveCommands: flatMap every provider's declared installs. A provider with no
// installs (most components) is a no-op, exactly as a grantless provider is in deriveCommands.
export function collectInstalls(
  providers: readonly { readonly installs?: readonly EffectInstall[] }[],
): readonly EffectInstall[] {
  return providers.flatMap((p) => p.installs ?? []);
}

// One mint request: an install plus WHO owns it and WHO sourced it. A build-time mint is self-sourced
// (owner === source === the combatant carrying the component); an on-resolve mint sources from the
// caster (slice 2's shield is self-targeting, so owner === source === the caster there too — a
// non-self install threads ownerId from the target when that lands).
export interface MintRequest {
  readonly install: EffectInstall;
  readonly ownerId: number;
  readonly sourceId: number;
}

// The slice of EncounterState a mint touches — threaded so the SINGLE monotonic `nextEffectId` counter
// is shared by both mint sites (build + on-resolve) and ids can never collide after a drop.
export interface EffectsSlice {
  readonly combatants: readonly Combatant[];
  readonly effects: readonly ActiveEffect[];
  readonly nextEffectId: number;
}

// Apply one PoolEdit to a band stack: 'splice' stamps the owning effect's id onto the new band (so its
// later onExpire can find exactly its own band) and inserts it; 'drop' removes the expiring effect's
// band(s). Shared by the onInstall (mint) and onExpire (tick) paths — the only place a hook's declared
// edit meets the pool operators.
function applyPoolEdit(pools: readonly Pool[], edit: PoolEdit, effectId: number): readonly Pool[] {
  return edit.op === 'splice'
    ? splicePool(pools, { ...edit.pool, sourceEffectId: effectId }, edit.aboveKey)
    : dropPoolsBySource(pools, effectId);
}

// Mint each request into an ActiveEffect with a MONOTONIC id, run its onInstall pool edits against the
// owner, and emit an `install` beat. Both mint sites call this — createEncounterState's build pass
// (which discards the events: the opening loadout needs no renderer beat) and applyCommand's on-resolve
// pass (which keeps them: a shield going up is a beat). Pure; returns the updated slice + the events.
export function installEffects(
  slice: EffectsSlice,
  requests: readonly MintRequest[],
): { readonly slice: EffectsSlice; readonly events: readonly EncounterEvent[] } {
  let combatants = slice.combatants;
  const effects = [...slice.effects];
  const events: EncounterEvent[] = [];
  let nextEffectId = slice.nextEffectId;
  for (const { install, ownerId, sourceId } of requests) {
    const id = nextEffectId++;
    effects.push({ id, key: install.effectKey, ownerId, sourceId, remainingCycles: install.remaining, params: install.params });
    const def = EFFECT_BY_KEY.get(install.effectKey);
    const owner = combatants[ownerId];
    if (def?.onInstall && owner) {
      let pools = owner.pools ?? [];
      for (const edit of def.onInstall({ params: install.params, owner })) {
        pools = applyPoolEdit(pools, edit, id);
      }
      combatants = combatants.map((c, i) => (i === ownerId ? withPools(owner, pools) : c));
    }
    events.push({ kind: 'install', combatId: ownerId, effectKey: install.effectKey, effectId: id });
  }
  return { slice: { combatants, effects, nextEffectId }, events };
}

// Apply one StatDelta to a combatant, clamped; returns the updated combatant + the amount ACTUALLY
// applied (0 when a clamp swallowed it — e.g. recharge at full energy), so the caller emits an event
// only on a real change. Integer-milli throughout. statKey resolves ONLY against the opaque stat bag
// (energy lives there); pool-stack HP is changed via PoolEdit + the damage cascade, never here, so a
// StatDelta and a pool never cross. (A unified stat-or-pool lookup is deferred to the DoT/HoT slice.)
function applyDelta(combatant: Combatant, d: StatDelta): { readonly combatant: Combatant; readonly applied: number } {
  const current = combatant.stats?.[d.statKey] ?? 0;
  let next = current + d.delta;
  if (d.clampToMaxKey !== undefined) {
    const max = combatant.stats?.[d.clampToMaxKey];
    if (max !== undefined) next = Math.min(next, max);
  }
  if (d.clampToZero) next = Math.max(0, next);
  const applied = next - current;
  return applied === 0 ? { combatant, applied: 0 } : { combatant: withStat(combatant, d.statKey, next), applied };
}

// Tick the active combatant's per-cycle effects (its OWN turn start, §3.2): run each of its
// onCycleStart hooks in install order and apply the deltas, then count down timed instances. On the
// cycle a timed instance reaches 0 it ticks ITS onCycleStart first (the final tick), then runs onExpire
// against the evolving owner and is dropped; permanent effects (remainingCycles −1) ride on. Pure —
// returns the next state + the events the renderer animates. combatId === index, so the owner is
// combatants[actorId].
export function tickCycleStart(
  state: EncounterState,
  actorId: number,
): { readonly state: EncounterState; readonly events: readonly EncounterEvent[] } {
  const events: EncounterEvent[] = [];
  let combatants = state.combatants;
  const surviving: ActiveEffect[] = [];
  for (const effect of state.effects) {
    if (effect.ownerId !== actorId) {
      surviving.push(effect); // someone else's effect — untouched this tick
      continue;
    }
    const def = EFFECT_BY_KEY.get(effect.key);
    const owner = combatants[actorId];
    if (def?.onCycleStart && owner) {
      for (const delta of def.onCycleStart({ params: effect.params, owner })) {
        const { combatant, applied } = applyDelta(combatants[actorId]!, delta);
        if (applied !== 0) {
          combatants = combatants.map((c, i) => (i === actorId ? combatant : c));
          events.push({ kind: 'effect', combatId: actorId, effectKey: effect.key, statKey: delta.statKey, delta: applied });
        }
      }
    }
    // Count down a timed instance; a permanent one (−1) rides on unchanged.
    if (effect.remainingCycles > 0) {
      const remainingCycles = effect.remainingCycles - 1;
      if (remainingCycles > 0) {
        surviving.push({ ...effect, remainingCycles }); // still ticking
      } else {
        // Expiring THIS cycle (after its final onCycleStart): run onExpire against the OWNER as the
        // tick has left it (so a same-tick recharge change isn't clobbered), emit the chip-down beat,
        // then drop the instance (do not push to surviving).
        const expiringOwner = combatants[actorId];
        if (def?.onExpire && expiringOwner) {
          let pools = expiringOwner.pools ?? [];
          for (const edit of def.onExpire({ params: effect.params, owner: expiringOwner })) {
            pools = applyPoolEdit(pools, edit, effect.id);
          }
          combatants = combatants.map((c, i) => (i === actorId ? withPools(expiringOwner, pools) : c));
        }
        events.push({ kind: 'expire', combatId: actorId, effectKey: effect.key, effectId: effect.id });
      }
    } else {
      surviving.push(effect); // permanent
    }
  }
  return { state: { ...state, combatants, effects: surviving }, events };
}
