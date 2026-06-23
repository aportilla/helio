// shipsToActors — projects the durable fleet into menu Actors, split by faction into
// sides. The general adapter the system action menu opens on; the encounter's
// ships-to-combatants (E1) is its combat specialization (it adds combatId, anchoring, and
// per-ShipClassDef commands). Pure and node-testable: it imports only the erased Ship type
// and the controlled-faction pointer, so it pulls in no DOM/catalog/global state.
//
// System scoping is the CALLER's job — pass ships already narrowed to the focused system
// (shipsInSystem). This only filters out 'building' ships (not yet in the field) and
// groups by factionId, preserving first-seen faction order so the split is deterministic.

import type { Ship } from '../game-state-codec.ts';
import { CONTROLLED_FACTION_ID } from '../factions/registry.ts';
import type { Actor, ActionRef, ActorSide } from './types.ts';

// The bones loadout every ship gets: an ATTACK category and a NAVIGATION flee (Pass is
// menu-injected, not a command). Content — the encounter (E1) derives the real loadout
// from each ship's ShipClassDef; until then every ship offers the same placeholder pair.
export const DEFAULT_SHIP_COMMANDS: readonly ActionRef[] = [{ id: 'attack' }, { id: 'flee' }];

// One ship → one Actor. `commands` defaults to the bones loadout; a caller (the encounter)
// passes a per-class set. Ship stats stay opaque/empty here — the stat bag is content the
// combat profile fills, not something the live-view menu needs.
export function shipToActor(ship: Ship, commands: readonly ActionRef[] = DEFAULT_SHIP_COMMANDS): Actor {
  return { id: ship.id, commands };
}

// Ready ships → faction sides. `commandsFor` lets a consumer vary the loadout per ship
// (default: the bones pair); the order of sides follows first-seen factionId in `ships`.
export function shipsToActors(
  ships: readonly Ship[],
  commandsFor: (ship: Ship) => readonly ActionRef[] = () => DEFAULT_SHIP_COMMANDS,
): readonly ActorSide[] {
  const byFaction = new Map<string, Actor[]>();
  for (const ship of ships) {
    if (ship.status !== 'ready') continue; // 'building' ships aren't in the field yet
    let actors = byFaction.get(ship.factionId);
    if (!actors) {
      actors = [];
      byFaction.set(ship.factionId, actors);
    }
    actors.push(shipToActor(ship, commandsFor(ship)));
  }
  return [...byFaction].map(([factionId, actors]) => ({
    factionId,
    controlled: factionId === CONTROLLED_FACTION_ID,
    actors,
  }));
}
