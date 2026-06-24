// terminal — when the encounter loop stops. The bones terminal is SIDE ELIMINATION: the encounter
// is over once fewer than two factions still field a living combatant. This is the faithful reading
// of the "action-exhaustion" terminal (§12 E2) — a downed combatant offers no commands, so when a
// whole side is down no command on that side is available, i.e. that side is exhausted. The plan's
// "all Pass a round" clause is moot: the menu has no Pass verb (Esc closes), so a mutual-pass round
// can't arise; flee-to-exit is the §5.5 escape, wired at E4. Pure — reads only the down predicate.

import type { EncounterState } from './state.ts';
import { isDown } from './state.ts';

export function isTerminal(state: EncounterState): boolean {
  const livingFactions = new Set<string>();
  for (const combatant of state.combatants) {
    if (!isDown(combatant)) livingFactions.add(combatant.factionId);
  }
  return livingFactions.size < 2;
}
