// bodiesToActors — projects facility-bearing catalog bodies into menu Actors, split by
// ownership into sides. The body twin of ships-to-actors.ts: the same ActorSide shape and
// controlled-faction split, so the system action menu opens on a planet / moon / belt
// exactly as it opens on a ship. M3 makes bodies even-handed ACTORS (and, separately,
// targets); the encounter's later ship-to-planet phase SPECIALIZES this (adding a combatId +
// a stat bag), it does not re-invent a body→actor path.
//
// Pure and node-testable: it imports only the erased PlacedFacility type, the entity-id
// codec, the controlled-faction pointer, and the action vocabulary — no catalog, no save, no
// DOM. The CALLER resolves the two things only it can know and hands them in per body: the
// BODIES index (the scene anchor key the entity id encodes) and the owning factionId
// (ownerFactionId(bodyId)).
//
// Commands are FACILITY-GATED and, for the bones, PLACEHOLDER: a facility type maps to a
// fixed command set (mining-base ⇒ mine, colony ⇒ establish). The real per-facility loadouts
// — and which verbs are actor commands vs. target-only verbs (bombard targets an enemy body;
// no body offers it as an actor in the bones) — arrive with the mechanics; this wires only
// the projection seam.

import { encodeBodyEntityId } from './entity-id.ts';
import { CONTROLLED_FACTION_ID } from '../factions/registry.ts';
import type { FacilityType, PlacedFacility } from '../facilities/types.ts';
import type { Actor, ActionRef, ActorSide } from './types.ts';

// One facility-bearing body's projection input. The caller mints these from the catalog +
// the save: `bodyIdx` is the BODIES index (== DiagramPick.bodyIdx, the anchor key encoded
// into the Actor id); `factionId` is ownerFactionId(bodyId); `facilities` are the body's
// placed facilities (game-state Facility is assignable to PlacedFacility).
export interface BodyActorInput {
  readonly bodyIdx: number;
  readonly factionId: string;
  readonly facilities: readonly PlacedFacility[];
}

// Placeholder facility → command mapping (the bones). A type absent from the map grants no
// command; a body whose facilities grant none is not a commandable actor (omitted from its
// side — it can still be a TARGET, which is a separate candidate-mint concern). Kept here,
// not on FacilityDef, so the action grammar owns the verb set and src/facilities/ stays
// economy-only.
const FACILITY_COMMANDS: Partial<Record<FacilityType, readonly ActionRef[]>> = {
  'mining-base': [{ id: 'mine' }],
  colony: [{ id: 'establish' }],
};

// The distinct commands a body's facilities grant, de-duplicated by id in first-seen order,
// so a body's menu is stable.
function commandsForFacilities(facilities: readonly PlacedFacility[]): readonly ActionRef[] {
  const byId = new Map<string, ActionRef>();
  for (const f of facilities) {
    for (const ref of FACILITY_COMMANDS[f.type] ?? []) {
      if (!byId.has(ref.id)) byId.set(ref.id, ref);
    }
  }
  return [...byId.values()];
}

// One body → one Actor (id in the `body:` namespace so it shares the ship keyspace without
// collision). Commands are facility-gated; a body whose facilities grant none yields an Actor
// with an empty command list (still openable — it offers only the menu-injected Pass).
export function bodyToActor(input: BodyActorInput): Actor {
  return { id: encodeBodyEntityId(input.bodyIdx), commands: commandsForFacilities(input.facilities) };
}

// Facility-bearing bodies → ownership sides. Only bodies that grant at least one command
// become actors (a body with no commandable facilities isn't a menu actor). Sides follow
// first-seen factionId order, mirroring shipsToActors, so the split is deterministic.
export function bodiesToActors(bodies: readonly BodyActorInput[]): readonly ActorSide[] {
  const byFaction = new Map<string, Actor[]>();
  for (const body of bodies) {
    const actor = bodyToActor(body);
    if (actor.commands.length === 0) continue; // not a commandable actor
    let actors = byFaction.get(body.factionId);
    if (!actors) {
      actors = [];
      byFaction.set(body.factionId, actors);
    }
    actors.push(actor);
  }
  return [...byFaction].map(([factionId, actors]) => ({
    factionId,
    controlled: factionId === CONTROLLED_FACTION_ID,
    actors,
  }));
}
