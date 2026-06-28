# src/ships/

The neutral **ship vocabulary** — what a ship is *made of*. A ship has **no class**: it carries its own ordered list of **modules** (`components: ShipComponentType[]`, persisted in the save), and everything about it — its menu actions, its combat installs, its energy capacity, its build time, its sprite size — **derives from those modules**. So this directory is now just the **component registry** ([`components/`](components/README.md)) plus the loadout-level helpers built on it. A near-pure leaf: its only app-side dependency is a **type-only** import of the action vocabulary (a component's grants), the same dependency `src/facilities/` takes; nothing from the DOM/catalog or the combat package.

## Ships are module lists, not classes

A built or spawned ship persists its `components` array in `helio.game` (see [the game save](../../docs/game-systems.md)) — the authoritative, per-ship configuration. There is no `ShipClassDef`, no `classId`: a "corvette" is just `['small-engine', 'small-laser']` and a heavier ship is a longer list. Order is authoring/display order (the eventual silhouette assembly reads it); for combat + the menu it's a multiset (loadout derivation merges identical modules). On load, each `components` entry is validated against `SHIP_COMPONENT_TYPES` — an unknown id drops the whole ship (an unknown loadout has undefined capabilities). The save contract is therefore the **component** ids (`FROZEN_COMPONENT_IDS`), not a class union.

## Everything derives from the modules

| Concern | How it's derived |
|---|---|
| menu **actions** | `ships-to-actors` `shipLoadout` merges each component's `grants` (the same `deriveCommands` a body runs over its facilities) |
| combat **installs** + **energyMax** | `ships-to-combatants` reads the ship's `components` directly — Σ each module's `installs` / `battery` |
| **build time** | `shipBuildTurns(components)` = Σ each module's `buildTurns` (floored at 1) — a heavier loadout takes longer |
| **sprite size** | the fleet layer derives a radius from loadout heft (base + per-module step), so a bigger ship reads bigger |
| **name** | a generic `Ship N` at creation (no class to name it; player-editable later) |

`DEMO_SHIP_LOADOUT` (in `components/registry.ts`) is the shared default kit the DEV add-ship buttons and the shipyard build flow stamp on a new ship until a loadout-builder UI exists — the full kit (engine + laser + cannon + shield generator) so a spawned/built ship is a real combatant and the dynamic-combat loop is live.

## Components (`components/`)

A ship is a **platform carrying modules**, the ship-side twin of a body carrying facilities ([modular-components plan](../../plans/4x-modular-ship-components.md) §5). [`components/`](components/README.md) is the **`ShipComponentDef` registry** — one def per component, each declaring the `ActionGrant`s it provides (a drive grants none), the combat `installs` it brings, its `battery` capacity, and its `buildTurns`, exactly as a `FacilityDef` would. Today's set: `small-engine` (recharge, no action); the two **weapons** `small-laser` (`damageType: 'energy'`, strong vs shields) and `small-cannon` (`damageType: 'kinetic'`, strong vs hull) — their asymmetry is a damage-typing model (the weapon declares a type, defensive bands carry per-type resistances); `small-shield` (a manually-raised timed shield) and `small-shield-generator` (an always-on regenerating shield that fritzes when stripped); and `tactical-command-module`. The weapon-vs-defence dynamic + the shield are documented in [the encounter doc](../encounter/README.md) (effectiveness cascade + worked example E).

## Map

| File | What's there |
|---|---|
| `components/` | the `ShipComponentDef` registry (a ship's modules + the grants/installs/battery/buildTurns each carries) + the loadout helpers `DEMO_SHIP_LOADOUT` / `shipBuildTurns` ([README](components/README.md)) |
| `components/test/` | the frozen-id + def-keying + grant-shape guards (`npm run test:ships`) |
