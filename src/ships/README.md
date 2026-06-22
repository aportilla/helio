# src/ships/

The neutral **ship-class registry** — one `ShipClassDef` per class, the static design data the rest of the game reads. A pure leaf: it imports nothing app-side and nothing from the (not-yet-built) combat package. Both the ship-build flow and, later, combat consume it; it depends on neither.

It is a deliberate twin of [`src/facilities/`](../facilities/README.md): a frozen string-union (`ShipClassType`) keyed `DEFS` object guarded three ways — the `satisfies Record<ShipClassType, ShipClassDef>` compile guard, the `FROZEN_SHIP_CLASS_IDS` list + its CI test, and a DEV module-load `def.type === key` assert. Adding a class is one literal in the union plus one object in `DEFS`; every derived lookup (`SHIP_CLASS_DEFS`, `SHIP_CLASS_BY_TYPE`, `SHIP_CLASS_TYPES`) flows from that.

## Why the class id is frozen

A built ship persists its `classId` in `helio.game` (see [the game save](../../docs/game-systems.md)). So `ShipClassType` is a **serialized wire contract**: renaming or removing a shipped class breaks old saves. `FROZEN_SHIP_CLASS_IDS` records every id that has ever shipped, and the CI guard asserts each is still live — the same discipline `FROZEN_FACILITY_IDS` enforces. A removed class becomes a retired tombstone, never a deletion.

## Deliberately thin (v1)

A v1 `ShipClassDef` carries only `{ type, label, color, buildTurns, spriteSizePx }`. The combat stat block (hull / energy / speed), a minerals cost, and abilities are **not** here yet — each lands with the consumer that reads it, so the leaf keeps zero dependency on combat. Tunables live in `tuning.ts` and are referenced by symbol, never baked into prose.

## Map

| File | What's there |
|---|---|
| `types.ts` | `ShipClassType` union + the `ShipClassDef` interface |
| `registry.ts` | `DEFS` + the derived lookups, the `shipClassLabel`/`shipClassColor`/`buildTurns` accessors, the frozen-id list + DEV assert |
| `tuning.ts` | hoisted per-class numbers (build time, sprite budget) |
| `test/registry.test.ts` | the frozen-id + color + accessor guards (`npm run test:ships`) |
