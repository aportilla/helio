# src/ships/components/

The neutral **ship-component registry** — one `ShipComponentDef` per component, the ship-side peer of [`src/facilities/`](../../facilities/README.md). A ship is a **platform carrying modules**, the twin of a body carrying facilities ([modular-components plan](../../../plans/4x-modular-ship-components.md) §5): a component **declares the action-menu commands it grants**, and [`ships-to-actors`](../../actions/README.md) collects + merges those grants across a ship's loadout through the **same** `deriveCommands` projection a body runs over its facilities. No central component→command map.

A pure declaration + registry leaf: its app-side imports are **type-only** — the action vocabulary (`ActionGrant`) and the effect vocabulary (`EffectInstall`, the substrate's neutral leaf) — plus the hoisted action accent colors; nothing from the DOM, catalog, sim, or the encounter runtime, mirroring how the facility registry stays sim-free.

## The v1 components

| id | kind | grants / effects |
|---|---|---|
| `small-engine` | `drive` | **No grant** — there is no flee (an encounter is fought to its terminal, never withdrawn). Installs a permanent `recharge` effect (worked example A) |
| `small-laser` | `weapon` | ATTACK **Laser** (single enemy, enters an encounter) — the enemy-only predicate mirrors the body railgun/missile batteries |
| `small-shield` | `defense` | SUPPORT **Raise Shields** (self, immediate) — its `installsOnResolve` mints a 3-cycle `shield-segment` effect (worked example B of the effect substrate); registered but **not** on the corvette's default loadout |
| `tactical-command-module` | `utility` | **No grant.** Installs a permanent `tactical-command` effect whose `phaseStart` folds **+1 Press-Turn initiative** into its side's pool (encounter §3.8) — `stacking: 'presence'`, so it counts once per side however many ships carry it. Standalone (not on the corvette default) |

Every ship currently flies the corvette's fixed loadout (`['small-engine', 'small-laser']`, declared on its `ShipClassDef`). There is no build UI yet, so this is the basic loadout for the whole fleet.

A component's combat contribution is **always a declared effect**, never a bespoke registry key: `tactical-command-module` raises fleet tempo by *installing the `tactical-command` effect*, exactly as `small-engine` recharges by installing `recharge` — there is no `initiative` field on `ShipComponentDef`. New combat behaviours add an `EffectDef` and a lifecycle handler ([the encounter doc](../../encounter/README.md) → "The effect substrate"), not a component key.

## Frozen-key discipline

Mirrors the facility / ship-class / faction registries exactly: a frozen `ShipComponentType` string-union keyed `DEFS` object, guarded three ways — the `satisfies Record<ShipComponentType, ShipComponentDef>` compile guard, the `FROZEN_COMPONENT_IDS` list + its CI test, and a DEV module-load `def.type === key` assert. A component id is the **provider half of every action wire id it backs** (`"<componentId>:<grant.key>"`) and — once the loadout build flow serializes per-ship `components[]` — a save key, so renaming or removing a shipped id breaks both; a removed component becomes a retired tombstone, never a deletion.

## Deferred seams

`ShipComponentDef` carries identity, role (`kind`), `grants`, and the **declared-effect** maps `installs` / `installsOnResolve` (the permanent + on-resolve combat effects it installs — the effect-substrate twin of `grants`, consumed by the encounter reducer; see [the encounter doc](../../encounter/README.md)). Still deferred behind the same thinness seam: the **energy model** (`battery` / `recharge`, and `costPerUnit` on each grant), D13's **size-class** mass budget, and the **render** piece (the organic-fleet sprite assembled from the component list) — each lands with the consumer that reads it (the loadout build flow / the fleet render), exactly as `FacilityDef` defers its own `battery?`/`recharge?`. See the [modular-components plan](../../../plans/4x-modular-ship-components.md) §3–§4.

## Map

| File | What's there |
|---|---|
| `types.ts` | `ShipComponentType` union, `ShipComponentKind`, the `ShipComponentDef` interface |
| `registry.ts` | `DEFS` + the derived lookups (`COMPONENT_BY_TYPE`, `SHIP_COMPONENT_DEFS`), `componentLabel`, the frozen-id list + DEV assert |
| `test/registry.test.ts` | the frozen-id, def-keying, and grant-shape guards (run by `npm run test:ships`) |
