// step — the pure combat reducer (the bones core, §3.3). `createEncounterState` seeds the initial
// state from a launch spec; `applyCommand` folds one committed intent into a new state + the events
// the renderer animates. ZERO gameplay math: a flat placeholder effect (subtract a fixed amount from
// the target's hull) stands in for the deferred damage model, so the loop reads as combat with no
// committed formula and no PRNG (§0, §6.4) — no float reaches here. The reducer is the single source
// of truth and the (later) AI/replay path; the UI only produces intents and reads state.

import type { ActionIntent } from '../actions/types.ts';
import { commandFor } from '../actions/derive.ts';
import type { EncounterSpec } from './encounter-spec.ts';
import type { Combatant, EncounterEvent, EncounterState } from './state.ts';
import { HULL_STAT, isDown } from './state.ts';
import { nextActor } from './turn-order.ts';
import { PLACEHOLDER_DAMAGE_MILLI, PLACEHOLDER_HULL_MILLI } from './tuning.ts';

// A combatant with one stat key overwritten — the immutable update the pure reducer makes (a new
// combatant, never a mutation). Spreading the union preserves the `kind` discriminant.
function withStat(combatant: Combatant, key: string, value: number): Combatant {
  return { ...combatant, stats: { ...combatant.stats, [key]: value } };
}

// Seed the initial state from the launch spec. Every combatant gets the bones placeholder hull
// stamped into its stats — the effect-free adapter ships none (real pool-stack HP lands with the
// effect substrate), so this is what makes the bones loop killable. The first actor is the initiator
// (the attacker that launched the encounter) when its combatant resolves, else combatId 0 —
// deterministic either way.
export function createEncounterState(spec: EncounterSpec): EncounterState {
  const combatants = spec.combatants.map((c) => withStat(c, HULL_STAT, PLACEHOLDER_HULL_MILLI));
  const initiator = combatants.find((c) => c.id === spec.initiator.actorId);
  return { combatants, activeId: initiator?.combatId ?? 0, round: 1 };
}

// Fold one committed intent into the next state. The bones branch only on the command's CATEGORY,
// read off the actor's own resolved command (no central lookup): an ATTACK lands the flat
// placeholder on each named target, anything else (navigation/support) simply passes the turn
// (flee-to-exit is the §5.5 escape, wired at E4). Whatever the action, the turn cursor then advances
// off the post-effect roster, so a just-downed combatant is skipped and a wrap bumps the round.
export function applyCommand(
  state: EncounterState,
  intent: ActionIntent,
): { readonly state: EncounterState; readonly events: readonly EncounterEvent[] } {
  const actor = state.combatants.find((c) => c.id === intent.actorId);
  if (import.meta.env?.DEV && actor && actor.combatId !== state.activeId) {
    throw new Error(`[encounter] intent actor ${intent.actorId} is not the active combatant ${state.activeId}`);
  }

  const events: EncounterEvent[] = [];
  let combatants = state.combatants;
  const command = actor ? commandFor(actor, intent.actionId) : undefined;

  if (actor && command?.grant.category === 'attack') {
    for (const targetId of intent.targetIds) {
      const idx = combatants.findIndex((c) => c.id === targetId);
      const target = combatants[idx];
      if (!target || isDown(target)) continue; // can't hit a missing or already-downed combatant
      const hull = target.stats?.[HULL_STAT];
      if (hull === undefined) {
        // An unstatted target (a combatant not seeded through createEncounterState): a visible hit,
        // but no hull to deplete and so never downed — keeps the reducer total.
        events.push({ kind: 'damage', source: actor.combatId, target: target.combatId, amount: PLACEHOLDER_DAMAGE_MILLI });
        continue;
      }
      const after = Math.max(0, hull - PLACEHOLDER_DAMAGE_MILLI);
      combatants = combatants.map((c, i) => (i === idx ? withStat(target, HULL_STAT, after) : c));
      events.push({ kind: 'damage', source: actor.combatId, target: target.combatId, amount: hull - after });
      if (after <= 0) events.push({ kind: 'down', combatId: target.combatId });
    }
  }

  // Advance the turn off the (possibly mutated) roster. nextActor returns undefined only when no
  // OTHER combatant can act (the encounter is terminal) — then hold the cursor; otherwise a wrap to
  // a lower-or-equal combatId means a new round began. (next can never equal activeId: the cursor
  // excludes the active combatant, so `<` alone detects the wrap.)
  const next = nextActor({ combatants, activeId: state.activeId, round: state.round });
  const nextState: EncounterState = next === undefined
    ? { combatants, activeId: state.activeId, round: state.round }
    : { combatants, activeId: next, round: state.round + (next < state.activeId ? 1 : 0) };

  return { state: nextState, events };
}
