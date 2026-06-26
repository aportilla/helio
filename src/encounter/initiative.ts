// initiative — the fleet → Press-Turn icon BASE (§3.8.2). The side-aggregating twin of deriveCommands
// in spirit: it turns a SIDE's living ships into the whole-integer base pool of initiative icons that
// side gets to spend this phase. Re-derived at each phase start (a snapshot, I5) so attrition lowers a
// side's tempo over a long fight, bounded by MIN_INITIATIVE so the last ship always acts.
//
// This is the FLEET-SIZE tier only. A component's tempo contribution (e.g. tactical-command-module) is
// NOT summed here — it rides the generic effect substrate as a `tactical-command` effect whose
// phaseStart handler folds a SideDelta into the pool (effects/fold.foldPhaseStart). So the pool a phase
// actually opens with is `max(MIN, base) + Σ effect SideDeltas`, computed by the reducer (step.ts):
// base here + the effect fold there. Keeping components OUT of this leaf is the point — no per-mechanic
// key, the contribution is a declared effect.
//
// A combat-rules leaf: reads the live combatants + the faction registry (for the full zeroed record) +
// the hoisted knobs — no DOM, no catalog, no sim. The fleet→icons floor is the ONLY fractional step in
// the whole loop (§3.8.1); everything downstream is whole icons.

import type { FactionType } from '../factions/types.ts';
import { FACTION_DEFS } from '../factions/registry.ts';
import { isDown, type Combatant } from './state.ts';
import { INITIATIVE_PER_SHIP_MILLI, MIN_INITIATIVE } from './tuning.ts';

// A full per-faction initiative record zeroed for every live faction — the seed the reducer fills the
// live pool from (so indexing by any FactionType is total, never undefined). Present sides overwrite
// their entry; absent factions stay 0 and are never selected (the side walk only visits factions that
// field a combatant).
export function zeroInitiative(): Record<FactionType, number> {
  return Object.fromEntries(FACTION_DEFS.map((d) => [d.id, 0])) as Record<FactionType, number>;
}

// A side's per-phase BASE pool from its CURRENT combatants:
//   max(MIN_INITIATIVE, floor(livingShips × ratio))
// Pass a side's combatants (downed included — they're filtered here); callers narrow to one side. Only
// living SHIPS count toward tempo (bodies/E5 are stationary and add none). The floor is the single
// fractional step; the result is whole icons. Effect SideDeltas (tactical-command, future buffs) are
// added by the reducer on top of this (effects/fold.foldPhaseStart).
export function baseSideInitiative(sideCombatants: readonly Combatant[]): number {
  const living = sideCombatants.filter((c) => c.kind === 'ship' && !isDown(c));
  return Math.max(MIN_INITIATIVE, Math.floor((living.length * INITIATIVE_PER_SHIP_MILLI) / 1000));
}
