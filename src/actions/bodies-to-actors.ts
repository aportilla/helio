// bodiesToActors — projects facility-bearing catalog bodies into menu Actors, split by
// ownership into sides. The body twin of ships-to-actors.ts: the same ActorSide shape and
// controlled-faction split, so the system action menu opens on a planet / moon / belt
// exactly as it opens on a ship. M3 makes bodies even-handed ACTORS (and, separately,
// targets); the encounter's later ship-to-planet phase SPECIALIZES this (adding a combatId +
// a stat bag), it does not re-invent a body→actor path.
//
// Pure and node-testable, and SIM-FREE: it reads a body's grants off the facility defs
// (FACILITY_BY_TYPE), and the facility registry is itself sim-free (its contribute() needs only
// the EconResource ids, not the sim-built table), so importing it here drags no economy core.
// It imports only the FacilityType/PlacedFacility types (erased), the entity-id codec, the
// controlled-faction pointer, the facility registry, and the action vocabulary — no catalog,
// no save, no DOM, no sim. The CALLER resolves the two things only it can know and hands them in
// per body: the BODIES index (the scene anchor key the entity id encodes) and the owning
// factionId (ownerFactionId(bodyId)).
//
// Commands are DERIVED, not enumerated: each facility DECLARES the actions it grants inline on its
// FacilityDef (`grants`), and deriveCommands collects + merges them across the body's facilities
// (plans/4x-modular-ship-components.md §2) — the same projection ships-to-actors runs over a
// ship's components. No central facility→command map in the action vocabulary.

import { encodeBodyEntityId } from './entity-id.ts';
import { CONTROLLED_FACTION_ID } from '../factions/registry.ts';
import { FACILITY_BY_TYPE } from '../facilities/registry.ts';
import type { PlacedFacility } from '../facilities/types.ts';
import type { Actor, ActorSide } from './types.ts';
import { BODY_CATEGORIES } from './registry.ts';
import { deriveCommands, type GrantProvider } from './derive.ts';

// A body always presents the Attack + Support category palette (BODY_CATEGORIES), greyed when no
// facility grants a command in one, so the menu's shape reads the same on every body (a body
// never navigates, so Navigation is absent). The menu honors this palette (Actor.categories).

// One facility-bearing body's projection input. The caller mints these from the catalog +
// the save: `bodyIdx` is the BODIES index (== DiagramPick.bodyIdx, the anchor key encoded
// into the Actor id); `factionId` is ownerFactionId(bodyId); `facilities` are the body's
// placed facilities (game-state Facility is assignable to PlacedFacility).
export interface BodyActorInput {
  readonly bodyIdx: number;
  readonly factionId: string;
  readonly facilities: readonly PlacedFacility[];
}

// A body's facilities as grant-providers: each placed facility is one provider whose id is its
// type and whose grants are the FacilityDef's declared grants. Two facilities of the same type
// (when a cap rises above 1) merge their grant into one scaled command, exactly as identical ship
// components do — today maxPerBody=1, so stacking is moot, but the rule is uniform.
function bodyProviders(facilities: readonly PlacedFacility[]): readonly GrantProvider[] {
  return facilities.map((f) => ({ id: f.type, grants: FACILITY_BY_TYPE.get(f.type)?.grants }));
}

// One body → one Actor (id in the `body:` namespace so it shares the ship keyspace without
// collision). Commands are derived from its facilities' grants; a body whose facilities grant
// none yields an Actor with an empty command list (still openable — it offers only the
// menu-injected Pass).
export function bodyToActor(input: BodyActorInput): Actor {
  return {
    id: encodeBodyEntityId(input.bodyIdx),
    commands: deriveCommands(bodyProviders(input.facilities)),
    categories: BODY_CATEGORIES,
  };
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
