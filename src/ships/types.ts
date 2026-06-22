// Ship-class vocabulary — the contract every other module in src/ships/ and its
// consumers satisfy. A pure declaration leaf: it imports nothing app-side, nothing
// from the (not-yet-built) combat package, and nothing from the DOM or catalog.
// Both the ship-build flow and, later, combat read their per-class data from here;
// src/ships/ must never depend on those consumers (it stays a true leaf).

// FROZEN serialized contract. These exact strings persist in 'helio.game' (each
// Ship record stores its `classId`). Adding a member is safe; renaming/removing a
// shipped member breaks old saves — three guards defend it (registry
// FROZEN_SHIP_CLASS_IDS + its CI test, the DEV module-load assert, and this literal
// union forcing every Record over it to update). Mirrors FacilityType's discipline.
export type ShipClassType = 'corvette';

// One ship class's static design — what the build flow offers and the fleet layer
// renders. Deliberately THIN for v1: no combat stat block (hull/energy/speed), no
// cost beyond time, no abilities. Each of those lands with the consumer that reads
// it (combat / the minerals-cost seam), so this stays a leaf with no combat edge.
export interface ShipClassDef {
  readonly type: ShipClassType;  // === its registry key; a DEV assert pins def.type === key
  readonly label: string;        // 'Corvette' — single source for build rows + later fleet labels
  readonly color: string;        // literal sRGB hex; DORMANT — the fleet tints by faction, this is reserved for a later per-class accent
  readonly buildTurns: number;   // the v1 cost: galaxy turns from build start to 'ready'
  readonly spriteSizePx: number; // fleet-sprite radius in content-buffer px (the triangle's half-size)
}
