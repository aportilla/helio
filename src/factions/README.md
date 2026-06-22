# src/factions/

The neutral **faction registry** — one `FactionDef` per faction, the static design
data the rest of the game reads for *ownership*. A pure leaf: it imports nothing
app-side and nothing from the (not-yet-built) combat package. The ownership write-path
(a ship's `factionId`) and, later, combat consume it; it depends on neither.

It is a deliberate twin of [`src/ships/`](../ships/README.md): a frozen string-union
(`FactionType`) keyed `DEFS` object guarded three ways — the
`satisfies Record<FactionType, FactionDef>` compile guard, the `FROZEN_FACTION_IDS`
list + its CI test, and a DEV module-load `def.id === key` assert. Adding a faction is
one literal in the union plus one object in `DEFS`; every derived lookup
(`FACTION_DEFS`, `FACTION_BY_ID`, `FACTION_TYPES`) flows from that.

## What a faction is — and isn't

A faction is a **side that owns things**, modelled deliberately narrow:

- **Species-agnostic.** A faction carries no species. Species, when it lands, is an
  orthogonal concern that attaches elsewhere and never reshapes this registry.
- **Player-agnostic.** There is no "is-human" flag on a faction. *Which* faction the
  local player commands is a separate pointer, `CONTROLLED_FACTION_ID`, kept out of the
  faction record so the records stay symmetric. Combat reads that pointer as "my side"
  (`factionId === CONTROLLED_FACTION_ID`); it is also the validate-and-merge default
  for any ship saved before factions existed.

The shipped ids (`player`, `rival`) are **placeholders** for a real faction system —
a bootstrap pair so opponent ships can be dropped into any system to exercise the
fleet and the coming encounter-combat layer.

## Why the faction id is frozen

A ship persists its `factionId` in `helio.game` (see [the game save](../../docs/game-systems.md)).
So `FactionType` is a **serialized wire contract**: renaming or removing a shipped
faction breaks old saves. `FROZEN_FACTION_IDS` records every id that has ever shipped,
and the CI guard asserts each is still live — the same discipline `FROZEN_SHIP_CLASS_IDS`
and `FROZEN_FACILITY_IDS` enforce. A removed faction becomes a retired tombstone, never
a deletion.

## Deliberately thin

A `FactionDef` carries only `{ id, label, color }`. Diplomacy, AI, per-faction bonuses,
and a real name model are **not** here yet — each lands with the consumer that reads
it, so the leaf keeps zero dependency on combat or a player model. Tunables (the render
colors) live in `tuning.ts` and are referenced by symbol, never baked into prose.

## Map

| File | What's there |
|---|---|
| `types.ts` | `FactionType` union + the `FactionDef` interface |
| `registry.ts` | `DEFS` + the derived lookups, the `factionLabel`/`factionColor` accessors, the `CONTROLLED_FACTION_ID` pointer, the frozen-id list + DEV assert |
| `tuning.ts` | hoisted per-faction render colors |
| `test/registry.test.ts` | the frozen-id + color + pointer guards (`npm run test:factions`) |
