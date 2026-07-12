# src/ships/components/

The neutral **ship-component registry** — one `ShipComponentDef` per component, the ship-side peer of [`src/facilities/`](../../facilities/README.md). A ship is a **platform carrying modules**, the twin of a body carrying facilities ([modular-components plan](../../../plans/4x-modular-ship-components.md) §5): a component **declares the action-menu commands it grants**, and [`ships-to-actors`](../../actions/README.md) collects + merges those grants across a ship's loadout through the **same** `deriveCommands` projection a body runs over its facilities. No central component→command map.

A pure declaration + registry leaf: its app-side imports are **type-only** — the action vocabulary (`ActionGrant`) and the effect vocabulary (`EffectInstall`, the substrate's neutral leaf) — plus the hoisted action accent colors; nothing from the DOM, catalog, sim, or the encounter runtime, mirroring how the facility registry stays sim-free.

## The v1 components

| id | kind | grants / effects |
|---|---|---|
| `small-engine` | `drive` | Grants **no action-menu command** — star-to-star navigation is a galaxy-view modality (galaxy sidebar → destination pick → `orderShipWarp`), not a verb you arm in the menu; and no *combat* action either (still no flee). Installs a permanent `recharge` effect (worked example A); carries the galaxy `warpRangeMilliLy` / `warpSpeedMilliLyPerTurn` drive stats (what makes a ship able to warp at all); contributes no `battery` |
| `small-laser` | `weapon` | ATTACK **Laser** (single enemy) — its on-resolve `damage` carries `damageType: 'energy'`; defensive bands' `resistByType` make energy **strong vs shields, weak vs hull**. Carries its own `battery` (= its salvo `costPerUnit`) |
| `small-cannon` | `weapon` | ATTACK **Cannon** (single enemy) — the kinetic counterpart (`damageType: 'kinetic'`), the INVERSE matchup (**weak vs shields, strong vs hull**). Firing the right weapon at the right defensive state is the dynamic |
| `small-shield` | `defense` | SUPPORT **Raise Shields** (self, immediate) — its `installsOnResolve` mints a 3-cycle `shield-segment` effect (worked example B); registered but **not** on a default loadout |
| `small-shield-generator` | `defense` | **No grant** — an always-on shield. Installs a permanent `shield-generator` effect (worked example E): regenerates each phase at an energy `upkeep`, and **fritzes out** for N phases when stripped, then reboots |
| `tactical-command-module` | `utility` | **No grant.** Installs a permanent `tactical-command` effect whose `phaseStart` folds **+1 Press-Turn initiative** into its side's pool (encounter §3.8) — `stacking: 'presence'`, so it counts once per side however many ships carry it. Standalone (not on a default) |

A ship has **no class** — it carries its own ordered `components` list (persisted in the save). Until a loadout-builder UI exists, the DEV add-ship buttons and the shipyard build flow stamp the shared **`DEMO_SHIP_LOADOUT`** (`['small-engine', 'small-laser', 'small-cannon', 'small-shield-generator']` — the full demo kit, so a spawned/built ship is a real combatant). Build time is **`shipBuildTurns(components)`** = Σ each module's `buildTurns` (a heavier loadout takes longer). Both helpers live in `registry.ts`.

A component's combat contribution is **always a declared effect**, never a bespoke registry key: `tactical-command-module` raises fleet tempo by *installing the `tactical-command` effect*, exactly as `small-engine` recharges by installing `recharge` — there is no `initiative` field on `ShipComponentDef`. New combat behaviours add an `EffectDef` and a lifecycle handler ([the encounter doc](../../encounter/README.md) → "The effect substrate"), not a component key.

## Frozen-key discipline

Mirrors the facility / faction registries exactly: a frozen `ShipComponentType` string-union keyed `DEFS` object, guarded three ways — the `satisfies Record<ShipComponentType, ShipComponentDef>` compile guard, the `FROZEN_COMPONENT_IDS` list + its CI test, and a DEV module-load `def.type === key` assert. A component id is BOTH the **provider half of every action wire id it backs** (`"<componentId>:<grant.key>"`) AND a **save key** — a ship persists its `components` array, so renaming or removing a shipped id breaks old saves (the ship's loadout fails validation and the ship is dropped) as well as the derived action ids; a removed component becomes a retired tombstone, never a deletion. (This is now THE ship save contract — there is no class union.)

## Deferred seams

`ShipComponentDef` carries identity, role (`kind`), `grants`, the **declared-effect** maps `installs` / `installsOnResolve` (the permanent + on-resolve combat effects it installs — the effect-substrate twin of `grants`, consumed by the encounter reducer; see [the encounter doc](../../encounter/README.md)), the **energy** `battery` capacity, the **`buildTurns`** build cost, and (drives only) the galaxy **`warpRangeMilliLy` / `warpSpeedMilliLyPerTurn`** stats. A ship's whole identity now sums from these per-module fields: `energyMax` = Σ `battery`, build time = Σ `buildTurns`, actions = merged `grants`, combat = collected `installs`, warp reach/speed = **MAX** over drives (`shipWarpRangeMilliLy` / `shipWarpSpeedMilliLyPerTurn`, a capability ceiling not a sum; `warpTravelTurns` prices distance into turns). The warp range is pinned equal to the economy's trade reach (`REACH_LY × LY_TO_SIM_UNITS`) by a cross-registry test. Still deferred behind the same thinness seam: D13's **size-class** mass budget and the **render** piece (the organic-fleet sprite assembled from the component list — sprite size is a flat loadout-count derivation today). See the [modular-components plan](../../../plans/4x-modular-ship-components.md) §3–§4.

## Map

| File | What's there |
|---|---|
| `types.ts` | `ShipComponentType` union, `ShipComponentKind`, the `ShipComponentDef` interface |
| `registry.ts` | `DEFS` + the derived lookups (`COMPONENT_BY_TYPE`, `SHIP_COMPONENT_DEFS`), `componentLabel`, the frozen-id list + DEV assert |
| `test/registry.test.ts` | the frozen-id, def-keying, and grant-shape guards (run by `npm run test:ships`) |
