// Ship-component vocabulary — the contract every module in src/ships/components/ and its
// consumers satisfy. The ship-side twin of FacilityDef: a component is a capability PROVIDER a
// ship's chassis carries, exactly as a facility is one a body carries (plans/4x-modular-ship-
// components.md §5 — ship↔body symmetry). A pure declaration leaf: it imports only the action
// vocabulary (a type-only import of that neutral leaf, the same dependency facilities/types.ts
// takes), nothing else app-side, nothing from the DOM/catalog or the (not-yet-built) encounter.

import type { ActionGrant } from '../../actions/types.ts';

// FROZEN serialized contract. A component id is the PROVIDER half of every action wire id it backs
// (`"<componentId>:<grant.key>"`, ../../actions/derive.ts) and — once the loadout build flow lands
// (Phase 3) — persists per-ship in 'helio.game'. Adding a member is safe; renaming/removing a
// shipped one breaks old saves AND the action ids derived from it — three guards defend it
// (registry FROZEN_COMPONENT_IDS + its CI test, the DEV module-load assert, and this literal union
// forcing every Record over it to update). Mirrors FacilityType / ShipClassType discipline.
export type ShipComponentType = 'small-engine' | 'small-laser';

// A component's structural family (the D13 taxonomy). It drives nothing in the menu today — the
// grants do that — but names the part's ROLE so the deferred consumers can read it: a loadout
// validator (exactly one chassis + one drive, D11), the fleet render layer (which silhouette piece
// to attach), and the energy model. The full union is declared up front so adding a defense/utility
// part later is one def, not a type change.
export type ShipComponentKind = 'chassis' | 'drive' | 'weapon' | 'defense' | 'utility';

// One ship component's static design — the ship-side peer of FacilityDef. Deliberately THIN: just
// identity, role, and the actions it grants, mirroring how a facility grants its body commands.
// The energy model (`battery` / `recharge`, and `costPerUnit` on the grant), D13's size-class mass
// budget, and the render piece are deferred behind the SAME seam FacilityDef defers `battery?`
// behind — each lands with the consumer that reads it (the encounter reducer / the loadout build
// flow / the fleet render), exactly as ShipClassDef stayed thin until its consumers arrived.
export interface ShipComponentDef {
  readonly type: ShipComponentType;   // === its registry key; a DEV assert pins def.type === key
  readonly label: string;             // 'Small Laser' — single source for build rows + part labels
  readonly kind: ShipComponentKind;   // the part's structural role (above)
  // The action-menu commands this component GRANTS its ship — the inverted action model
  // (plans/4x-modular-ship-components.md §2/§5): a component is a capability PROVIDER, and
  // ships-to-actors derives a ship's command list by collecting + merging these across its loadout,
  // the SAME deriveCommands that runs over a body's facilities. ABSENT ⇒ grants none (a chassis
  // grants no actions, D11). A type-only import of the action vocab keeps this leaf sim-/DOM-free.
  readonly grants?: readonly ActionGrant[];
}
