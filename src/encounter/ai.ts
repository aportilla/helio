// ai — the opponent's combat policy (§3.7): a PURE function picking the auto-driven side's next
// activation. It reasons over the WHOLE phase side, so a mixed-energy fleet spends its initiative
// instead of forfeiting the phase the moment the active ship can't fire. Pure + deterministic (no PRNG, no float): combat math is still
// the flat placeholder, so a focus-fire argmax needs no roll — the §3.7 fixed-phase-point draw
// discipline only bites once a real damage roll exists. The controller drives it: it re-anchors the
// cursor onto the returned actor (selectActor) and commits, one activation per interval, until the
// policy returns null (the side is stranded → end the phase, §3.8.3 auto-pass).
//
// A combat-rules leaf under src/encounter/ (the reducer/AI source of truth, §3.3): it reads only the
// EncounterState + the action vocabulary, never the scene. The richer policy (timing tiers, combos,
// target valuation) layers on here behind the same signature once the mechanics phase (P-Experiment)
// gives it real stats to reason over.

import type { ActionCommand, ActionIntent } from '../actions/types.ts';
import type { FactionType } from '../factions/types.ts';
import { ENERGY_STAT, isDown, remainingHp, type Combatant, type EncounterState } from './state.ts';

// The next activation for the side whose phase is live (the active cursor is always on it). Returns
// null when no same-side ship has an affordable attack OR no living enemy remains — the caller ends the
// phase (auto-pass). The intent's actor may be ANY same-side ship, not necessarily the active one; the
// controller re-anchors the cursor onto it before committing.
export function chooseAutoIntent(state: EncounterState): ActionIntent | null {
  const side = state.phaseSide;
  // Focus-fire: every attacker this phase aims at the SAME weakest living enemy, so the side
  // concentrates fire to finish targets rather than spreading it. Computed once per activation off the
  // current truth.
  const target = weakestEnemy(state, side);
  if (target === null) return null;
  // The first living same-side ship that can afford an attack (combatId order — the deterministic
  // within-side walk). Iterating the whole side means a charged ship fires even when a lower-combatId
  // one is drained (no phase forfeit when the active ship can't fire).
  for (const c of state.combatants) {
    if (c.factionId !== side || isDown(c)) continue;
    const attack = affordableAttack(c);
    if (attack) return { actorId: c.id, actionId: attack.id, targetIds: [target.id] };
  }
  return null;
}

// The living enemy (any side but `side`) with the LEAST remaining HP, ties broken by the lowest combatId
// (the strict `<` over the combatId-ordered roster keeps the first seen). Null when none lives.
// remainingHp sums the whole pool stack (shields + hull), so "weakest" is "closest to downed" — the
// natural finish-it target.
function weakestEnemy(state: EncounterState, side: FactionType): Combatant | null {
  let best: Combatant | null = null;
  for (const c of state.combatants) {
    if (c.factionId === side || isDown(c)) continue;
    if (best === null || remainingHp(c) < remainingHp(best)) best = c;
  }
  return best;
}

// A combatant's first attack-category command it can pay for (energy >= the salvo's totalCost) — the
// SAME availability gate the player's menu enforces (D6), so the AI never fires a salvo the player
// couldn't. An actor with no energy stat (no cost model) is permissively affordable (Infinity).
function affordableAttack(c: Combatant): ActionCommand | undefined {
  const energy = c.stats?.[ENERGY_STAT] ?? Infinity;
  return c.commands.find((cmd) => cmd.grant.category === 'attack' && cmd.totalCost <= energy);
}
