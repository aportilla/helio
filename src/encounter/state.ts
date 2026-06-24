// Combatant — the in-encounter actor contract, born here (E1) so the reducer (E2) imports it.
// Per the §0 re-scope the stat block is an opaque, extensible bag and the command list is
// effect-free: the bones do not know what a stat means or what a command does. A Combatant is
// therefore an `Actor` (the menu doc's shape — `commands` + opaque `stats` + category palette),
// EXTENDED with the combat identity the system view doesn't need (`combatId`, `factionId`, the
// per-kind anchor). Because it conforms to Actor, the SAME anchored `ActionMenu` opens on a
// combatant with no adapter — the seam that lets one menu drive both system-view selection and
// combat rounds. The combatant model stays stable while the mechanics stay fluid.
//
// A combat-rules leaf (mirrors the src/diagram-pick.ts hoist): the DTOs the reducer/HUD read live
// under src/encounter/, NEVER under src/scene/** (a ui/ surface reading a scene-declared type would
// breach the verified ui/ ↛ scene/ wall). It imports only the action vocabulary + the frozen
// faction/ship key types — no DOM, no catalog, no sim.

import type { FactionType } from '../factions/types.ts';
import type { ShipClassType } from '../ships/types.ts';
import type { Actor } from '../actions/types.ts';

// The combat identity every combatant carries on top of being an Actor.
interface CombatantBase extends Actor {
  // A dense integer index into the spec's combatant array (combatId === index), assigned at
  // EncounterSpec build — ships first, body-combatants appended (E5). It is the turn-order
  // tiebreak (§3.2): `id` is the durable domain handle (a ship's save id), but `combatId` alone
  // breaks ties, so replay / AI ordering is deterministic and independent of the id strings.
  readonly combatId: number;
  // The owning side. "My side" is `factionId === CONTROLLED_FACTION_ID`; the JRPG party-vs-enemies
  // split and a command's target allegiance both derive from this, never a baked player flag.
  readonly factionId: FactionType;
  // The HP pool stack and the energy stat bag are combat-PROFILE content the effect substrate
  // (§7.5) fills — the bones carry neither. `stats` (where `energy` lives, gating the menu) and a
  // future `pools` field (hull/shields, the absorb-before-hull cascade target) attach behind this
  // same seam, additively, when that phase lands; E1 is the effect-free contract only.
}

// A fleet ship in combat. `classId` anchors both the combat profile (later) and the fleet sprite
// the encounter renderer reuses (E3/E4); the durable selection handle is `id` (the ship's save id).
export interface ShipCombatant extends CombatantBase {
  readonly kind: 'ship';
  readonly classId: ShipClassType;
}

// A planet / moon / belt in combat — stationary, anchored to its on-screen disc. Declared now so
// the union is the complete contract E2 folds over; its PRODUCER (`combatRoleFor`, the combat
// specialization of bodies-to-actors) and its passive turn role land in E5. `bodyId` is the catalog
// Body.id — the durable anchor write-back keys on (a destroyed body → facility removal, §8).
export interface BodyCombatant extends CombatantBase {
  readonly kind: 'body';
  readonly bodyId: string;
}

// Discriminated by `kind` — the renderer anchors the two differently, but the reducer folds them
// uniformly (both are Actors with commands).
export type Combatant = ShipCombatant | BodyCombatant;

// One faction's combatants in an encounter — the combat twin of ActorSide. The faction structure
// the renderer (left/right split) and targeting (allegiance) read; the reducer reads the flat,
// combatId-indexed projection on EncounterSpec instead (./encounter-spec).
export interface CombatantSide {
  readonly factionId: FactionType;
  readonly controlled: boolean;
  readonly combatants: readonly Combatant[];
}
