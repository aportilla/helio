// terminal — when the encounter loop stops, on either of two conditions (§8.4):
//   1. SIDE ELIMINATION — fewer than two factions still field a living combatant. A downed combatant
//      offers no commands, so when a whole side is down that side is exhausted.
//   2. MUTUAL DISENGAGE — a full Press-Turn round passed with no damage-dealing action from either
//      side (§3.8.3): the reducer latches `state.disengaged` at that round boundary (step.beginNextPhase).
//      This is the "all pass a round" exit, now that a phase is voluntarily endable (End Round, ./step
//      endPhase) — a side-level affordance, still NOT a per-ship Pass.
// Pure — reads only the down predicate + the latched flag.

import type { EncounterState } from './state.ts';
import { isDown } from './state.ts';

export function isTerminal(state: EncounterState): boolean {
  if (state.disengaged) return true;
  const livingFactions = new Set<string>();
  for (const combatant of state.combatants) {
    if (!isDown(combatant)) livingFactions.add(combatant.factionId);
  }
  return livingFactions.size < 2;
}
