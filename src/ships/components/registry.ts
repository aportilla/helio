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
import { CANNON_ACTION_COLOR, LASER_ACTION_COLOR, SHIELD_ACTION_COLOR } from '../../actions/tuning.ts';

// The registry, keyed by ShipComponentType. `satisfies Record<ShipComponentType, ...>` is the
// compile layer of the frozen-key guard: adding a literal to the union without a def here fails to
// compile, and a key that isn't a ShipComponentType is rejected. The key IS the save id; the DEV
// assert below pins each def's own `type` field to its key.
const DEFS = {
  'small-engine': {
    type: 'small-engine',
    label: 'Small Engine',
    kind: 'drive',
    buildTurns: 1,
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
    buildTurns: 2,
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
    // On resolve the laser mints a one-shot `damage` effect on each target — the same installsOnResolve
    // path the shield uses for a self buff, now landing on an enemy (the reducer's old attack branch is
    // gone; damage is a declared effect, src/encounter/effects). `amount` 40_000 is the placeholder hit; its
    // `damageType` 'energy' is the BEAM type — the cascade scales it by each target band's resistance to
    // energy (shields weak to it, hull resists it; src/encounter/tuning SHIELD_RESIST/HULL_RESIST), so a
    // laser SHREDS shields and glances off hull, the cannon below the mirror. Literals HERE (ships ↛
    // encounter), superseded by the real damage formula. `remaining: 0` = a hit: applied once, never a rider.
    installsOnResolve: { 'laser': [{ effectKey: 'damage', remaining: 0, damageType: 'energy', params: { amount: 40_000 } }] },
  },
  'small-cannon': {
    type: 'small-cannon',
    label: 'Small Cannon',
    kind: 'weapon',
    buildTurns: 2,
    // The KINETIC counterpart to the laser: the same ATTACK shape (single enemy, an energy-gated salvo),
    // but `damageType` 'kinetic' — the INVERSE matchup. Shields RESIST kinetic (it bounces off) and hull is
    // WEAK to it (it craters), per the same band resistances, so a laser strips the shield and a cannon
    // finishes the hull: firing the right weapon at the right defensive state is the dynamic. Literals here
    // (ships ↛ encounter), superseded by the real damage formula.
    battery: 9_000,
    grants: [{ key: 'cannon', label: 'Cannon', color: CANNON_ACTION_COLOR, category: 'attack', targeting: 'single', kind: 'encounter', costPerUnit: 9_000, targets: (c) => c.allegiance === 'enemy' }],
    installsOnResolve: { 'cannon': [{ effectKey: 'damage', remaining: 0, damageType: 'kinetic', params: { amount: 40_000 } }] },
  },
  'small-shield-generator': {
    type: 'small-shield-generator',
    label: 'Small Shield Generator',
    kind: 'defense',
    buildTurns: 2,
    // An ALWAYS-ON shield (grants NO action — unlike small-shield's manually-raised segment): it INSTALLS a
    // permanent `shield-generator` effect (worked example E, src/encounter/effects) whose phaseStart state
    // machine splices a `shields` band above hull, regens it toward `capacity` by `regen` each phase at the
    // cost of `upkeep` energy, and — when a hit fully strips it — drops the band and FRITZES OUT for
    // `fritzPhases` of the owner's phases before rebooting cold. Its own `battery` adds the energy capacity
    // the upkeep draws from (so it isn't purely parasitic on the weapons' bar). All magnitudes literals here.
    battery: 9_000,
    installs: [{ effectKey: 'shield-generator', remaining: -1, params: { capacity: 50_000, regen: 15_000, upkeep: 2_000, fritzPhases: 2 } }],
  },
  'small-shield': {
    type: 'small-shield',
    label: 'Small Shield',
    kind: 'defense',
    buildTurns: 2,
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
    buildTurns: 1,
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
// (typed as a string-set because it validates the arbitrary parsed component lists in a saved ship's
// `components` array — every entry must be a member of this set or the ship is dropped).
export const SHIP_COMPONENT_TYPES: ReadonlySet<string> = new Set(Object.keys(DEFS));

// ── Loadout-level helpers (a ship IS its ordered module list — there is no class) ───────────────────

// The DEFAULT loadout the DEV add-ship buttons and the shipyard build flow stamp on a new ship, until a
// loadout-builder UI lets the player compose one. The full demo kit: a drive (recharge) + BOTH weapons +
// an always-on shield generator, so a spawned/built ship is a real combatant and the dynamic-combat loop
// (laser strips shields → cannon craters hull, shields regen/fritz) is live by default. One shared
// constant so the build flow, both DEV spawns, and tests agree on what "a real ship" is.
export const DEMO_SHIP_LOADOUT: readonly ShipComponentType[] = ['small-engine', 'small-laser', 'small-cannon', 'small-shield-generator'];

// A ship's build time = the Σ of its modules' `buildTurns` (heavier loadout = longer build), the
// per-ship successor to the old per-class buildTurns. Floored at MIN so a sparse/degenerate loadout still
// takes a turn. Unknown ids (shouldn't occur — validated on load) contribute 0.
const MIN_BUILD_TURNS = 1;
export function shipBuildTurns(components: readonly ShipComponentType[]): number {
  const sum = components.reduce((n, type) => n + (COMPONENT_BY_TYPE.get(type)?.buildTurns ?? 0), 0);
  return Math.max(MIN_BUILD_TURNS, sum);
}

// A ship's energy CAPACITY = the Σ of its modules' `battery` (a weapon/shield carries its own charge),
// the energy-model twin of shipBuildTurns. The neutral home for the derivation: combat's
// `combatantEnergyMax` delegates here (a charged combatant's cap), and the system view reads it directly
// to draw a ship's at-rest energy gauge (full = energyMax) — so the at-rest readout never imports the
// encounter package. Unknown ids contribute 0; a loadout with no battery yields 0 (an empty gauge).
export function shipEnergyMax(components: readonly ShipComponentType[]): number {
  return components.reduce((sum, type) => sum + (COMPONENT_BY_TYPE.get(type)?.battery ?? 0), 0);
}

// Single source of a component's display name — build rows + part labels.
export function componentLabel(type: ShipComponentType): string {
  return COMPONENT_BY_TYPE.get(type)?.label ?? type;
}

// The save contract: every component id that has ever shipped. HISTORICAL wire strings,
// deliberately NOT typed as the live ShipComponentType union — so renaming a shipped component
// can't quietly re-green the guard under compiler pressure. The CI test asserts each entry is still
// a live type (SHIP_COMPONENT_TYPES.has), so removing OR renaming a shipped id fails — protecting
// the action ids derived from it (and, from Phase 3, old ship saves) from a compiler-invisible
// "cleanup". Mirrors FROZEN_FACILITY_IDS.
export const FROZEN_COMPONENT_IDS: readonly string[] = ['small-engine', 'small-laser', 'small-cannon', 'small-shield', 'small-shield-generator', 'tactical-command-module'];

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
