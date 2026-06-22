// Faction vocabulary — whose a ship (and, later, a planet) is. A pure declaration
// leaf, the deliberate twin of src/ships/types.ts: it imports nothing app-side,
// nothing from the (not-yet-built) combat package, and nothing from the DOM or
// catalog. Both the ownership write-path and, later, combat read their per-faction
// data from here; src/factions/ must never depend on those consumers (it stays a
// true leaf).
//
// A faction is a SIDE that owns things — modelled deliberately NARROW:
//   - species-agnostic: a faction carries no species; species, when it lands, is an
//     orthogonal concern that attaches elsewhere and never reshapes this.
//   - player-agnostic: there is no "is-human" flag. WHICH faction the local player
//     commands is a separate pointer (CONTROLLED_FACTION_ID in ./registry), never a
//     property of the faction record itself.

// FROZEN serialized contract. These exact strings persist in 'helio.game' (each Ship
// stores its `factionId`). Adding a member is safe; renaming/removing a shipped member
// breaks old saves — three guards defend it (registry FROZEN_FACTION_IDS + its CI
// test, the DEV module-load assert, and this literal union forcing every Record over
// it to update). Mirrors ShipClassType / FacilityType discipline. The ids are
// placeholders for a real faction system: 'player' is the slot the local player
// currently commands, 'rival' an opposing side — purely a bootstrap pair.
export type FactionType = 'player' | 'rival';

// One faction's static design — what the fleet layer tints by and the ship card
// names. Deliberately THIN: an id, a display label, and a render color. No species,
// no diplomacy, no AI — each of those lands with the consumer that reads it, so this
// stays a leaf with no edge into combat or a player model.
export interface FactionDef {
  readonly id: FactionType;  // === its registry key; a DEV assert pins def.id === key
  readonly label: string;    // display name in the ship card (and later civ UI)
  readonly color: string;    // literal sRGB hex, rendered verbatim end-to-end (ColorManagement is OFF)
}
