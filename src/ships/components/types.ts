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
// forcing every Record over it to update). Mirrors FacilityType discipline.
export type ShipComponentType =
  | 'small-engine'
  | 'small-laser'
  | 'small-cannon'
  | 'small-shield'
  | 'small-shield-generator'
  | 'tactical-command-module';

// A component's structural family (the D13 taxonomy). It drives nothing in the menu today — the
// grants do that — but names the part's ROLE so its consumers can read it: a loadout validator
// (exactly one chassis + one drive, D11), the fleet render layer (which tints each module's rect by
// kind — shipped, FleetLayer), and the energy model. The full union is declared up front so adding a
// defense/utility part later is one def, not a type change.
export type ShipComponentKind = 'chassis' | 'drive' | 'weapon' | 'defense' | 'utility';

// One ship component's static design — the ship-side peer of FacilityDef. Deliberately THIN: just
// identity, role, the actions it grants, the per-cycle/passive effects it installs in combat, and
// the energy capacity it contributes. The salvo `costPerUnit` rides on the grant; D13's size-class
// mass budget and the render piece are still deferred behind the SAME seam — each lands with the
// consumer that reads it (the loadout build flow / the fleet render), exactly as ShipClassDef stayed
// thin until its consumers arrived.
export interface ShipComponentDef {
  readonly type: ShipComponentType;   // === its registry key; a DEV assert pins def.type === key
  readonly label: string;             // 'Small Laser' — single source for build rows + part labels
  readonly kind: ShipComponentKind;   // the part's structural role (above)
  // Galaxy turns this module adds to a ship's build. A ship has no class to carry a single build cost
  // anymore — it IS its modules — so build time is the Σ of its components' `buildTurns` (shipBuildTurns,
  // ../components/registry), heavier loadouts taking longer. Integer ≥ 0.
  readonly buildTurns: number;
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
  // The combat energy CAPACITY (energy-milli) this component contributes to its ship's salvo budget.
  // A combatant's `energyMax` is the Σ of this across its loadout (combatantEnergyMax, the energy-model
  // twin of `installs`), seeded by createEncounterState. D3 — a weapon carries its OWN battery, so its
  // grant's `costPerUnit` and this value match: a single-laser ship fires exactly one salvo, then the
  // drive's recharge refills it. ABSENT ⇒ contributes none (a chassis/drive holds no charge of its own).
  readonly battery?: number;
}
