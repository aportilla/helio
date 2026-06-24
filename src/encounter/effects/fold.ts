// fold — the pure effect machinery: collect declared installs (the deriveCommands twin), mint them
// into ActiveEffects at encounter build, and tick a combatant's per-cycle effects at its turn start.
// The fold dispatches by hook PRESENCE — no effectKey branch — exactly as deriveCommands folds
// grants. Pure: it reads the effect registry + the state leaf, nothing app-side.

import { EFFECT_BY_KEY } from './registry.ts';
import type { ActiveEffect, EffectInstall, StatDelta } from './types.ts';
import type { Combatant, EncounterEvent, EncounterState } from '../state.ts';
import { withStat } from '../state.ts';

// The pure twin of deriveCommands: flatMap every provider's declared installs. A provider with no
// installs (most components) is a no-op, exactly as a grantless provider is in deriveCommands.
export function collectInstalls(
  providers: readonly { readonly installs?: readonly EffectInstall[] }[],
): readonly EffectInstall[] {
  return providers.flatMap((p) => p.installs ?? []);
}

// Mint each combatant's declared installs into PERMANENT-or-timed ActiveEffects at encounter build.
// ids are dense + install-order (replay-stable, the cleanse handle); a build-time install is
// self-sourced (sourceId === ownerId). `installsOf` resolves a combatant's providers → installs (for
// a ship: its class components), the combat analog of how shipLoadout resolves its commands.
export function mintEffects(
  combatants: readonly Combatant[],
  installsOf: (combatant: Combatant) => readonly EffectInstall[],
): readonly ActiveEffect[] {
  const effects: ActiveEffect[] = [];
  for (const combatant of combatants) {
    for (const install of installsOf(combatant)) {
      effects.push({
        id: effects.length,
        key: install.effectKey,
        ownerId: combatant.combatId,
        sourceId: combatant.combatId,
        remainingCycles: install.remaining,
        params: install.params,
      });
    }
  }
  return effects;
}

// Apply one StatDelta to a combatant, clamped; returns the updated combatant + the amount ACTUALLY
// applied (0 when a clamp swallowed it — e.g. recharge at full energy), so the caller emits an event
// only on a real change. Integer-milli throughout. (Today statKey resolves to the opaque stat bag;
// when the pool stack lands, it resolves to whichever list owns the key — a lookup, not a branch.)
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
// onCycleStart hooks in install order, apply the deltas, then count down timed instances and drop
// them at 0. Permanent effects (remainingCycles -1) ride on unchanged. Pure — returns the next state
// + the events the renderer animates. combatId === index, so the owner is combatants[actorId].
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
    // Count down a timed instance; a permanent one (−1) rides on. (onExpire's terminal beat lands
    // with the pool-stack slice — no bones effect needs it yet.)
    if (effect.remainingCycles > 0) {
      const remainingCycles = effect.remainingCycles - 1;
      if (remainingCycles > 0) surviving.push({ ...effect, remainingCycles });
      // remainingCycles === 0 → dropped (expired)
    } else {
      surviving.push(effect);
    }
  }
  return { state: { ...state, combatants, effects: surviving }, events };
}
