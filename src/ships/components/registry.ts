// SHIP_COMPONENT_DEFS — the single source of truth for every ship component. Adding a component is
// one object here plus one literal in the ShipComponentType union: its save-key (component id),
// build/part label, structural role, and the action-menu commands it grants all flow from that one
// edit. Mirrors src/facilities/registry.ts and src/ships/registry.ts exactly, deliberately, so the
// frozen-key discipline reads identically across all three registries.
//
// A component's `grants` are declared INLINE here, the same way a facility declares its on
// FacilityDef — ships-to-actors collects + merges them across a ship's loadout (deriveCommands).
// No central component→command map. A grant `key` names the CAPABILITY, not how it discharges
// ('laser', never a loaded shared verb like 'fire'). Importing the action accent colors from
// ../../actions/tuning.ts mirrors the facility registry's import of the same hoisted palette.

import type { ShipComponentDef, ShipComponentType } from './types.ts';
import { LASER_ACTION_COLOR, SHIELD_ACTION_COLOR } from '../../actions/tuning.ts';

// The registry, keyed by ShipComponentType. `satisfies Record<ShipComponentType, ...>` is the
// compile layer of the frozen-key guard: adding a literal to the union without a def here fails to
// compile, and a key that isn't a ShipComponentType is rejected. The key IS the save id; the DEV
// assert below pins each def's own `type` field to its key.
const DEFS = {
  'small-engine': {
    type: 'small-engine',
    label: 'Small Engine',
    kind: 'drive',
    // The drive grants NO action — there is no flee (an encounter is fought to its terminal, never
    // withdrawn). Its whole job is the per-cycle energy recharge it DECLARES as an effect (worked example
    // A, 4x-encounter-combat-system §7.5) — not a hardcoded reducer step. `amount` is energy-milli restored
    // at the ship's own turn start, clamped to energyMax. A second power component would install its own
    // `recharge`; the instances simply sum in the one fold, no merge logic.
    installs: [{ effectKey: 'recharge', remaining: -1, params: { amount: 3_000 } }],
  },
  'small-laser': {
    type: 'small-laser',
    label: 'Small Laser',
    kind: 'weapon',
    // A weapon grants an ATTACK that enters an encounter against a single enemy. The enemy-only
    // predicate keeps the target bracket on opposing ships/bodies, exactly as the body railgun /
    // missile batteries do — the same grant shape on the ship side of the symmetry. D3 — a weapon
    // carries its OWN battery: `battery` is the energy capacity it adds to the ship's Σ-battery
    // energyMax (combatantEnergyMax), and `costPerUnit` is the salvo's cost. They MATCH at 9_000 by
    // design, not coincidence — a single-laser ship's full charge fires exactly ONE salvo, then the
    // engine's 3_000/turn recharge refills it over ~3 turns (the all-or-nothing-salvo cadence); a
    // second laser would add its own 9_000 of capacity AND cost, so two lasers fire together off a
    // doubled bar. Both values live HERE (not imported from the encounter package) to keep ships ↛
    // encounter.
    battery: 9_000,
    grants: [{ key: 'laser', label: 'Laser', color: LASER_ACTION_COLOR, category: 'attack', targeting: 'single', kind: 'encounter', costPerUnit: 9_000, targets: (c) => c.allegiance === 'enemy' }],
  },
  'small-shield': {
    type: 'small-shield',
    label: 'Small Shield',
    kind: 'defense',
    // A defense part grants a SUPPORT verb that raises a temporary shield on the ship ITSELF. `kind`
    // is the live-view dispatch fork only (immediate outside combat); inside an encounter the reducer
    // folds it regardless of `kind`. On resolve it installs a 3-cycle `shield-segment` (worked example
    // B, 4x-encounter-combat-system §7.5): its `install` handler splices a `shields` band above hull, the
    // damage cascade absorbs into it first, `expire` pops it. `capacity` is shield-HP-milli; a re-cast stacks
    // a second independent band (distinct-instances). The on-resolve install is keyed by grant key so a
    // multi-grant component installs per verb.
    grants: [{ key: 'raise-shields', label: 'Raise Shields', color: SHIELD_ACTION_COLOR, category: 'support', targeting: 'self', kind: 'immediate' }],
    installsOnResolve: { 'raise-shields': [{ effectKey: 'shield-segment', remaining: 3, params: { capacity: 50_000 } }] },
  },
  'tactical-command-module': {
    type: 'tactical-command-module',
    label: 'Tactical Command Module',
    kind: 'utility',
    // A utility part that grants NO action — its whole job is to raise its SIDE's Press-Turn tempo. It
    // does so the generic way: it INSTALLS a permanent `tactical-command` effect (encounter
    // §3.8.2/§3.8.6) whose phaseStart handler folds a +1 SideDelta into the side's pool each phase. The
    // effect's `stacking: 'presence'` makes it count ONCE per side however many ships carry it — so the
    // presence-not-count rule lives in the effect, not a static `initiative` registry key. Standalone
    // like small-shield (not on the corvette default loadout) — opted into by a tested fixture.
    installs: [{ effectKey: 'tactical-command', remaining: -1, params: { initiative: 1 } }],
  },
} satisfies Record<ShipComponentType, ShipComponentDef>;

export const SHIP_COMPONENT_DEFS: readonly ShipComponentDef[] = Object.values(DEFS);

export const COMPONENT_BY_TYPE: ReadonlyMap<ShipComponentType, ShipComponentDef> = new Map(
  Object.entries(DEFS) as Array<[ShipComponentType, ShipComponentDef]>,
);

// The persistence validation set, derived from the registry so it can never drift from the union
// (typed as a string-set because it validates arbitrary parsed save JSON once Phase 3 serializes
// per-ship components).
export const SHIP_COMPONENT_TYPES: ReadonlySet<string> = new Set(Object.keys(DEFS));

// Single source of a component's display name — build rows + part labels.
export function componentLabel(type: ShipComponentType): string {
  return COMPONENT_BY_TYPE.get(type)?.label ?? type;
}

// The save contract: every component id that has ever shipped. HISTORICAL wire strings,
// deliberately NOT typed as the live ShipComponentType union — so renaming a shipped component
// can't quietly re-green the guard under compiler pressure. The CI test asserts each entry is still
// a live type (SHIP_COMPONENT_TYPES.has), so removing OR renaming a shipped id fails — protecting
// the action ids derived from it (and, from Phase 3, old ship saves) from a compiler-invisible
// "cleanup". Mirrors FROZEN_FACILITY_IDS / FROZEN_SHIP_CLASS_IDS.
export const FROZEN_COMPONENT_IDS: readonly string[] = ['small-engine', 'small-laser', 'small-shield', 'tactical-command-module'];

// DEV-only module-load invariant: each def's `type` equals its registry key, and every frozen id is
// still a live type. Mirrors the facilities + ships drift checks — loud in dev, stripped in prod,
// irrelevant under node tests (which assert the same facts explicitly). import.meta.env is
// undefined outside Vite, hence the optional chain.
if (import.meta.env?.DEV) {
  for (const [key, def] of Object.entries(DEFS)) {
    if (def.type !== key) {
      throw new Error(`[ship-components] def keyed '${key}' declares type '${def.type}'`);
    }
  }
  for (const id of FROZEN_COMPONENT_IDS) {
    if (!SHIP_COMPONENT_TYPES.has(id)) {
      throw new Error(`[ship-components] frozen id '${id}' is no longer a live type — old saves would break`);
    }
  }
}
