// Ship-class vocabulary — the contract every other module in src/ships/ and its
// consumers satisfy. A pure declaration leaf: its only app-side dependency is a
// type-only import of the neutral action vocabulary (via ShipComponentType, for the
// default loadout) — the same dependency facilities/types.ts takes; nothing from the
// combat package, nothing from the DOM or catalog. Both the ship-build
// flow and combat read their per-class data from here; src/ships/ must never
// depend on those consumers (it stays a true leaf).

import type { ShipComponentType } from './components/types.ts';

// FROZEN serialized contract. These exact strings persist in 'helio.game' (each
// Ship record stores its `classId`). Adding a member is safe; renaming/removing a
// shipped member breaks old saves — three guards defend it (registry
// FROZEN_SHIP_CLASS_IDS + its CI test, the DEV module-load assert, and this literal
// union forcing every Record over it to update). Mirrors FacilityType's discipline.
export type ShipClassType = 'corvette';

// One ship class's static design — what the build flow offers and the fleet layer
// renders. Deliberately THIN: it carries a default component loadout (the source of
// its menu actions — see `components`) but still NO inline combat stat block
// (hull/energy/speed) and no cost beyond time. Those derive from the components or
// land with the consumer that reads them (combat / the minerals-cost seam), so this
// stays a leaf with no combat edge.
export interface ShipClassDef {
  readonly type: ShipClassType;  // === its registry key; a DEV assert pins def.type === key
  readonly label: string;        // 'Corvette' — single source for build rows + later fleet labels
  readonly color: string;        // literal sRGB hex; DORMANT — the fleet tints by faction, this is reserved for a later per-class accent
  readonly buildTurns: number;   // the v1 cost: galaxy turns from build start to 'ready'
  readonly spriteSizePx: number; // fleet-sprite radius in content-buffer px (the triangle's half-size)
  // The default LOADOUT every ship of this class is fitted with — an ordered list of components
  // (its chassis IS this class for now; the modules hang off it). ships-to-actors derives the
  // ship's menu commands from these (each component's grants, merged), the SAME projection a body
  // runs over its facilities. This is the "default loadout" sense of a class
  // (plans/4x-modular-ship-components.md §3.3/§3.4): NON-authoritative — a ship's capabilities ARE
  // its components — and a stopgap until the loadout build flow (Phase 3) serializes per-ship
  // `components[]`, at which point every ship of a class no longer need share one preset.
  readonly components: readonly ShipComponentType[];
}
