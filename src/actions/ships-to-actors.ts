// shipsToActors — projects the durable fleet into menu Actors, split by faction into sides. The
// general adapter the system action menu opens on; the encounter's ships-to-combatants (E1) is its
// combat specialization (it adds combatId, anchoring, and a transient stat bag). Pure and
// node-testable: nothing from the DOM, catalog, global state, or — unlike the body adapter — the
// sim; it reads only the erased Ship type and the neutral ship/action leaves.
//
// System scoping is the CALLER's job — pass ships already narrowed to the focused system
// (shipsInSystem). This only filters out 'building' ships (not yet in the field) and defers the
// faction grouping to actorSides, which preserves first-seen faction order so the split is
// deterministic.
//
// Commands are DERIVED, not enumerated: a ship's loadout is its class's default component list
// (ShipClassDef.components), each component a grant-PROVIDER whose grants deriveCommands collects +
// merges — the SAME projection bodies-to-actors runs over a body's facilities (the ship↔body
// symmetry, plans/4x-modular-ship-components.md §5). Until the loadout build flow (Phase 3)
// serializes per-ship components, every ship of a class shares its class preset.

import type { Ship } from '../game-state-codec.ts';
import type { ActionCommand, Actor, ActorSide } from './types.ts';
import { SHIP_CATEGORIES } from './registry.ts';
import { deriveCommands, type GrantProvider } from './derive.ts';
import { actorSides } from './sides.ts';
import { COMPONENT_BY_TYPE } from '../ships/components/registry.ts';

// A ship's loadout as grant-providers: the ship's OWN ordered module list (it has no class), each
// component one provider whose id is its type and whose grants are the ShipComponentDef's declared
// grants — the exact shape bodies-to-actors builds from a body's facilities. Identical components (e.g.
// two lasers) then merge into one scaled command, just as identical facilities would.
function shipProviders(ship: Ship): readonly GrantProvider[] {
  return ship.components.map((type) => ({ id: type, grants: COMPONENT_BY_TYPE.get(type)?.grants }));
}

// The commands a ship offers — its loadout's grants, derived + merged (the same projection the body
// adapter runs). A ship's commands ARE its components'; a consumer may pass a per-ship override via
// commandsFor (the seam exists for varying a loadout per ship), but absent that this is the source.
export function shipLoadout(ship: Ship): readonly ActionCommand[] {
  return deriveCommands(shipProviders(ship));
}

// One ship → one Actor. `commands` defaults to the ship's loadout; a caller (the encounter) passes
// a per-ship set. Ship stats stay opaque/empty here — the energy stat bag is content the combat
// profile fills, not something the live-view menu needs.
export function shipToActor(ship: Ship, commands: readonly ActionCommand[] = shipLoadout(ship)): Actor {
  return { id: ship.id, commands, categories: SHIP_CATEGORIES };
}

// Ready ships → faction sides. `commandsFor` lets a consumer vary the loadout per ship (default:
// the ship's own loadout); the deterministic faction split is the shared actorSides helper.
export function shipsToActors(
  ships: readonly Ship[],
  commandsFor: (ship: Ship) => readonly ActionCommand[] = shipLoadout,
): readonly ActorSide[] {
  return actorSides(
    ships
      .filter((ship) => ship.status === 'ready') // 'building' ships aren't in the field yet
      .map((ship) => ({ factionId: ship.factionId, actor: shipToActor(ship, commandsFor(ship)) })),
  );
}
