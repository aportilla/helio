# src/ships/

The neutral **ship-class registry** — one `ShipClassDef` per class, the static design data the rest of the game reads. A near-pure leaf: its only app-side dependency is a **type-only** import of the action vocabulary (via the component loadout — see below), the same dependency `src/facilities/` takes; it pulls in nothing from the DOM/catalog and nothing from the combat package. Both the ship-build flow and combat consume it; it depends on neither.

It is a deliberate twin of [`src/facilities/`](../facilities/README.md): a frozen string-union (`ShipClassType`) keyed `DEFS` object guarded three ways — the `satisfies Record<ShipClassType, ShipClassDef>` compile guard, the `FROZEN_SHIP_CLASS_IDS` list + its CI test, and a DEV module-load `def.type === key` assert. Adding a class is one literal in the union plus one object in `DEFS`; every derived lookup (`SHIP_CLASS_DEFS`, `SHIP_CLASS_BY_TYPE`, `SHIP_CLASS_TYPES`) flows from that.

## Why the class id is frozen

A built ship persists its `classId` in `helio.game` (see [the game save](../../docs/game-systems.md)). So `ShipClassType` is a **serialized wire contract**: renaming or removing a shipped class breaks old saves. `FROZEN_SHIP_CLASS_IDS` records every id that has ever shipped, and the CI guard asserts each is still live — the same discipline `FROZEN_FACILITY_IDS` enforces. A removed class becomes a retired tombstone, never a deletion.

## Deliberately thin

A `ShipClassDef` stays thin — identity + display fields, a build time, a sprite budget, and a **default component loadout** (the source of its menu actions, see below). Still **not** here: an inline combat stat block (hull / energy / speed) or a minerals cost — the stat block derives from the components (the energy model, a later phase), and each remaining concern lands with the consumer that reads it, so the leaf keeps zero dependency on combat. Tunables live in `tuning.ts` and are referenced by symbol, never baked into prose.

## Components & loadout (`components/`)

A ship is a **platform carrying modules**, the ship-side twin of a body carrying facilities ([modular-components plan](../../plans/4x-modular-ship-components.md) §5). [`components/`](components/README.md) is the **`ShipComponentDef` registry** — one def per component, each declaring the `ActionGrant`s it provides (a drive grants none), the combat `installs` it brings, and its `battery` capacity, exactly as a `FacilityDef` does. Today's set: `small-engine` (recharge effect, no action); the two **weapons** `small-laser` (ATTACK, `damageType: 'energy'`, strong vs shields) and `small-cannon` (ATTACK, `damageType: 'kinetic'`, strong vs hull) — their asymmetry is a damage-typing model: the weapon declares a type, defensive bands carry per-type resistances; `small-shield` (a manually-raised timed shield) and `small-shield-generator` (an always-on regenerating shield that fritzes when stripped); and `tactical-command-module`. The weapon-vs-defense dynamic + the shield are documented in [the encounter doc](../encounter/README.md) (effectiveness cascade + worked example E). A class's `components` array is its default loadout; [`ships-to-actors`](../actions/README.md) derives a ship's menu commands from those components' grants through the **same** `deriveCommands` projection a body runs over its facilities. There is no ship builder yet, so every ship of a class shares its class preset (per-ship `components[]` serialization is a later phase). Classes today: the `corvette` (engine + laser) and the `gunship` — the dynamic-combat demo hull fitting both weapons + the shield generator.

## Map

| File | What's there |
|---|---|
| `types.ts` | `ShipClassType` union + the `ShipClassDef` interface (incl. the default `components` loadout) |
| `registry.ts` | `DEFS` + the derived lookups, the `shipClassLabel`/`shipClassColor`/`buildTurns` accessors, the frozen-id list + DEV assert |
| `tuning.ts` | hoisted per-class numbers (build time, sprite budget) |
| `components/` | the `ShipComponentDef` registry — a ship's modules + the actions they grant ([README](components/README.md)) |
| `test/` + `components/test/` | the frozen-id + color + accessor + grant-shape guards (`npm run test:ships` sweeps both) |
