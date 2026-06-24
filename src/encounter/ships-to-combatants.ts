// shipsToCombatants — projects the durable fleet into combat Combatants, split by faction into
// sides. The combat specialization of the system view's `ships-to-actors` (§9, §12 E1): same
// 'ready' filter, same deterministic faction split (the shared groupByFaction core), same DERIVED
// loadout (a ship's commands ARE its components' grants, via shipLoadout) — it adds only the combat
// identity an Actor lacks: a `kind`, the `combatId` turn-order index, and the `classId` anchor.
//
// System scoping is the CALLER's job — pass ships already narrowed to the focused system
// (shipsInSystem), exactly as ships-to-actors expects. Pure and node-testable: it reads only the
// erased Ship type and the neutral action/ship leaves — no DOM, catalog, global state, or sim.

import type { Ship } from '../game-state-codec.ts';
import { groupByFaction } from '../actions/sides.ts';
import { SHIP_CATEGORIES } from '../actions/registry.ts';
import { shipLoadout } from '../actions/ships-to-actors.ts';
import type { CombatantSide, ShipCombatant } from './state.ts';

// One ship → one combatant at its assigned combatId. Commands are the ship's derived loadout (the
// SAME shipLoadout the system-view actor uses) and the palette is the shared SHIP_CATEGORIES, so a
// combatant and a live-view ship offer an identical menu — only the combat identity differs. The
// stat bag / HP pools stay absent (the effect-free bones, §4); the combat profile fills them later.
export function shipToCombatant(ship: Ship, combatId: number): ShipCombatant {
  return {
    kind: 'ship',
    id: ship.id,
    combatId,
    factionId: ship.factionId,
    classId: ship.classId,
    commands: shipLoadout(ship),
    categories: SHIP_CATEGORIES,
  };
}

// Ready ships → faction sides of combatants. Mirrors shipsToActors: drop 'building' ships (not in
// the field), group through groupByFaction (first-seen faction order, controlled side flagged),
// then number the combatants densely in flatten order — ships-first across the whole roster, so an
// E5 body pass can append its combatants with continued ids. The dense, deterministic numbering is
// what makes the turn order (§3.2) replay-stable.
export function shipsToCombatants(ships: readonly Ship[]): readonly CombatantSide[] {
  let combatId = 0;
  return groupByFaction(
    ships
      .filter((ship) => ship.status === 'ready') // 'building' ships aren't in the field yet
      .map((ship) => ({ factionId: ship.factionId, item: ship })),
  ).map(({ factionId, controlled, items }) => ({
    factionId,
    controlled,
    combatants: items.map((ship) => shipToCombatant(ship, combatId++)),
  }));
}
