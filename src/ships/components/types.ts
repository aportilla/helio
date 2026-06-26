// Ship-component vocabulary — the contract every module in src/ships/components/ and its
// consumers satisfy. The ship-side twin of FacilityDef: a component is a capability PROVIDER a
// ship's chassis carries, exactly as a facility is one a body carries (plans/4x-modular-ship-
// components.md §5 — ship↔body symmetry). A pure declaration leaf: its only app-side imports are
// TYPE-ONLY — the action vocabulary (ActionGrant) and the effect vocabulary (EffectInstall, the
// substrate's neutral leaf), the same kind of dependency facilities/types.ts takes; nothing from
// the DOM/catalog and nothing from the encounter RUNTIME (it stays a leaf the reducer reads).

import type { ActionGrant } from '../../actions/types.ts';
import type { EffectInstall } from '../../encounter/effects/types.ts';

// FROZEN serialized contract. A component id is the PROVIDER half of every action wire id it backs
// (`"<componentId>:<grant.key>"`, ../../actions/derive.ts) and — once the loadout build flow lands
// (Phase 3) — persists per-ship in 'helio.game'. Adding a member is safe; renaming/removing a
// shipped one breaks old saves AND the action ids derived from it — three guards defend it
// (registry FROZEN_COMPONENT_IDS + its CI test, the DEV module-load assert, and this literal union
// forcing every Record over it to update). Mirrors FacilityType / ShipClassType discipline.
export type ShipComponentType = 'small-engine' | 'small-laser' | 'small-shield' | 'tactical-command-module';

// A component's structural family (the D13 taxonomy). It drives nothing in the menu today — the
// grants do that — but names the part's ROLE so the deferred consumers can read it: a loadout
// validator (exactly one chassis + one drive, D11), the fleet render layer (which silhouette piece
// to attach), and the energy model. The full union is declared up front so adding a defense/utility
// part later is one def, not a type change.
export type ShipComponentKind = 'chassis' | 'drive' | 'weapon' | 'defense' | 'utility';

// One ship component's static design — the ship-side peer of FacilityDef. Deliberately THIN: just
// identity, role, the actions it grants, and the per-cycle/passive effects it installs in combat.
// The energy COST model (`battery` capacity, and `costPerUnit` on the grant), D13's size-class mass
// budget, and the render piece are deferred behind the SAME seam FacilityDef defers `battery?`
// behind — each lands with the consumer that reads it (the loadout build flow / the fleet render),
// exactly as ShipClassDef stayed thin until its consumers arrived.
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
  // The combat effects this component INSTALLS on its ship — the effect-substrate twin of `grants`
  // (4x-encounter-combat-system §7.5). PERMANENT effects, minted at encounter build by installEffects
  // (the deriveCommands twin) and folded by the reducer with no per-effect-type branch. This is how a
  // drive declares its per-cycle energy recharge as a DECLARED effect rather than a hardcoded step.
  // ABSENT ⇒ installs none. A type-only import keeps this leaf sim-/DOM-free.
  readonly installs?: readonly EffectInstall[];
  // The TIMED effects this component installs when one of its GRANTS resolves in an encounter, keyed by
  // grant key — the on-resolve twin of build-time `installs`. Declared HERE (not on the neutral
  // ActionGrant) so the action vocabulary stays a pure leaf with no encounter import; the reducer mints
  // `installsOnResolve[grantKeyOf(actionId)]` when that action fires. A defense part's `raise-shields`
  // grant maps to a timed `shield-segment` here. ABSENT ⇒ installs none on resolve.
  readonly installsOnResolve?: Readonly<Record<string, readonly EffectInstall[]>>;
}
