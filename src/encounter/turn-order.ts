// turn-order — the bones turn cursor. `nextActor` advances round-robin by combatId, skipping downed
// combatants: the single pluggable seam §3.2 names, so the deferred speed/`readyTick` refinement
// replaces the RULE here without touching its callers. Pure — reads only EncounterState + the down
// predicate.

import type { EncounterState } from './state.ts';
import { isDown } from './state.ts';

// The next LIVING combatant's combatId strictly after the active one in cyclic combatId order, or
// undefined when no OTHER living combatant exists (the active is the last one standing → the
// encounter is terminal, ./terminal). The walk visits each other combatant exactly once (steps
// 1..n-1), so a downed combatant is passed over and a wrap from the highest id back round is what
// the reducer reads to bump `round`.
export function nextActor(state: EncounterState): number | undefined {
  const n = state.combatants.length;
  for (let step = 1; step < n; step++) {
    const id = (state.activeId + step) % n;
    const candidate = state.combatants[id];
    if (candidate && !isDown(candidate)) return id;
  }
  return undefined;
}
