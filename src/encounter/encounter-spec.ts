// EncounterSpec — the immutable launch contract an encounter is born from (E1). Built when a
// confirmed offensive action whose `kind` is 'encounter' is dispatched (§2.4): the live-view
// dispatcher assembles the spec from the system's combatants + the launching intent, then the
// EncounterController (E3) turns it into the transient EncounterState. Authored against the durable
// `GameState.ships` (split by factionId), NOT a stub, so combat never blocks on the ship-movement
// system still to come (§9). A pure data leaf — no DOM, no scene, no sim.

import type { ActionIntent } from '../actions/types.ts';
import type { Combatant, CombatantSide } from './state.ts';

export interface EncounterSpec {
  // The faction structure — the renderer's left/right split and a command's target allegiance read
  // it. Mirrors what shipsToActors returns for the live view.
  readonly sides: readonly CombatantSide[];
  // The flat, combatId-indexed roster: `combatants[i].combatId === i`. This is the turn-order /
  // reducer view (§3.2) — `nextActor` walks it, the reducer resolves a target id to its combatant
  // through it. Derived from `sides` so the two can't drift.
  readonly combatants: readonly Combatant[];
  // The offensive intent that launched the encounter — who acted, which action, the first target.
  // The reducer reads it to set the opening `phaseSide`/`initiatorSide` (the attacker acts first,
  // I7/I12); the deterministic PRNG seed (§6.2) is a deferred-mechanics concern hanging off the same
  // launch context. The per-side initiative pool is NOT carried here — it's computed by the reducer at
  // each phase start (fleet base + effect SideDeltas), re-derived from the living roster (I5).
  readonly initiator: ActionIntent;
}

// Compose faction sides + the launching intent into the spec. Places each combatant at its own
// `combatId` so the flat array is the dense turn-order index by construction (independent of side
// order, so an E5 body pass can append body-combatants at higher ids without disturbing the ships).
export function buildEncounterSpec(
  sides: readonly CombatantSide[],
  initiator: ActionIntent,
): EncounterSpec {
  const total = sides.reduce((n, side) => n + side.combatants.length, 0);
  const combatants: Combatant[] = new Array(total);
  for (const side of sides) {
    for (const combatant of side.combatants) {
      combatants[combatant.combatId] = combatant;
    }
  }
  if (import.meta.env?.DEV) {
    // The roster must be dense + correctly indexed — a gap or a misplaced combatId means the
    // numbering (shipsToCombatants / the E5 body pass) drifted from the array the reducer indexes.
    // An explicit length-bounded walk (not forEach, which skips array holes) catches a gap.
    for (let i = 0; i < total; i++) {
      const c = combatants[i];
      if (c === undefined || c.combatId !== i) {
        throw new Error(`[encounter] combatant array not dense at ${i} (combatId ${c?.combatId})`);
      }
    }
  }
  return { sides, combatants, initiator };
}
