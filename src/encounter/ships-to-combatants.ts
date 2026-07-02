// shipsToCombatants — projects the durable fleet into combat Combatants, split by faction into
// sides. The combat specialization of the system view's `ships-to-actors` (§9, §12 E1): same
// 'ready' filter, same deterministic faction split (the shared groupByFaction core), same DERIVED
// loadout (a ship's commands ARE its components' grants, via shipLoadout) — it adds only the combat
// identity an Actor lacks: a `kind`, the `combatId` turn-order index, and the ship's `components` list
// (the source of its installs + Σ-battery energyMax).
//
// System scoping is the CALLER's job — pass ships already narrowed to the focused system
// (shipsInSystem), exactly as ships-to-actors expects. Pure and node-testable: it reads only the
// erased Ship type and the neutral action/ship leaves — no DOM, catalog, global state, or sim.

import type { Ship } from '../game-state-codec.ts';
import { groupByFaction } from '../actions/sides.ts';
import { SHIP_CATEGORIES } from '../actions/registry.ts';
import { grantKeyOf } from '../actions/derive.ts';
import { shipLoadout } from '../actions/ships-to-actors.ts';
import { COMPONENT_BY_TYPE, shipEnergyMax } from '../ships/components/registry.ts';
import type { ShipComponentType } from '../ships/components/types.ts';
import { collectInstalls } from './effects/fold.ts';
import type { EffectInstall } from './effects/types.ts';
import type { Combatant, CombatantSide, ShipCombatant } from './state.ts';

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
    components: ship.components,
    commands: shipLoadout(ship),
    categories: SHIP_CATEGORIES,
  };
}

// A combatant's DECLARED effect installs as the substrate sees them — the combat analog of
// shipLoadout: for a ship, its OWN module list is the install PROVIDERS (each component may declare
// `installs`), flattened through the same collectInstalls fold that mirrors deriveCommands.
// createEncounterState feeds this to mintEffects to seed the encounter's ActiveEffects. A body has
// no installs until its E5 producer lands.
export function combatantInstalls(combatant: Combatant): readonly EffectInstall[] {
  if (combatant.kind !== 'ship') return [];
  const components = combatant.components;
  return collectInstalls(components.map((type) => ({ installs: COMPONENT_BY_TYPE.get(type)?.installs })));
}

// A combatant's combat energy CAPACITY (energyMax) — Σ the `battery` its modules contribute, the
// energy-model twin of combatantInstalls (both read the ship's OWN component list). createEncounterState
// seeds energyMax AND a charged start (energy = energyMax) from this, so a loadout's salvo budget IS its
// parts' batteries: a single-laser ship derives 9_000 and fires exactly one salvo before its drive
// recharges. A body carries no components until E5, so it contributes none (energyMax 0).
export function combatantEnergyMax(combatant: Combatant): number {
  if (combatant.kind !== 'ship') return 0;
  return shipEnergyMax(combatant.components);
}

// A ship's TIMED on-resolve installs for ONE resolved action — the on-resolve twin of combatantInstalls.
// The action's wire id `"<componentId>:<grantKey>"` names the providing component directly, and the
// reducer only reaches here once commandFor has confirmed the actor actually carries the command, so
// this reads `installsOnResolve[grantKey]` straight off that component rather than re-deriving from the
// class loadout (build-time `installs` come from ALL components; on-resolve installs come from the one
// component whose grant fired). A body's on-resolve installs land with its E5 producer.
export function combatantInstallsOnResolve(combatant: Combatant, actionId: string): readonly EffectInstall[] {
  if (combatant.kind !== 'ship') return [];
  const colon = actionId.lastIndexOf(':');
  const providerId = colon < 0 ? actionId : actionId.slice(0, colon);
  return COMPONENT_BY_TYPE.get(providerId as ShipComponentType)?.installsOnResolve?.[grantKeyOf(actionId)] ?? [];
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
