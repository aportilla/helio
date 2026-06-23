# `src/actions/` — the system action menu

The **general interaction grammar of the system view**: select an **actor**, drill into a
**category → command**, and execute. The target is **not a menu tier** — scoping into a
command list *is* the target-selection modality (the Sea-of-Stars idiom): you move vertically
through the commands while a **'select' bracket** rides one target in the field, moved
horizontally (←/→ / A/D / click), and confirming a command fires it at the locked target. This
is *how you act on the world* — not combat chrome. Combat is one **consumer** (an offensive
action that enters the encounter modality); non-combat verbs (establish-colony, move) are peers.
Design + roadmap: `plans/4x-system-action-menu.md`.

A neutral **leaf**, the deliberate twin of [`src/ships/`](../ships/README.md) and
[`src/factions/`](../factions/README.md): the vocabulary, registry, and menu import nothing
app-side, nothing from the DOM/catalog, nothing from the (not-yet-built) encounter package —
so every consumer can read the action grammar without pulling in a consumer. Only the
ship adapter reaches sideways, and only for an **erased type** (`import type { Ship }`), so it
stays node-pure.

## Actors are ships **and** bodies

An `Actor` is `{ id, commands, stats? }` — deliberately body-agnostic. A fleet **ship**, and a
**planet / moon / belt that carries player facilities**, are both actors: each opens the same
anchored menu and offers the commands its loadout grants (a ship's weapons; a body's
orbital-railgun, a colony ship's "establish colony"). The menu, registry, and dispatch never
assume a ship. v1 ships the **ship** adapter (`ships-to-actors.ts`); the **body** projector
(`combatRoleFor`, facilities → actor) lands with the encounter's ship-to-planet phase
(`4x-encounter-combat-system.md` E5).

## Files

| File | What it owns |
|---|---|
| `types.ts` | The vocabulary leaf — `ActionType` (frozen), `ActionCategory`, `ActionTargeting`, `ActionKind`, and the `ActionDef` / `ActionRef` / `Actor` / `ActionIntent` shapes. Effect-free: enough to build and run the menu, never what an action *does*. |
| `registry.ts` | `ACTION_DEFS` — one frozen-key object per action (the `satisfies Record` + `FROZEN_ACTION_IDS` + DEV-assert guard, mirroring the other registries). v1 content is combat-first: `attack` (enters an encounter), `flee`, and the menu-injected `pass`. |
| `menu.ts` | `ActionMenu` — the mechanics-agnostic state machine: a **two-level** stack (category → command) with an orthogonal **target lock** on the command level (`moveCursor` = vertical/command, `moveTarget` / `setTargetById` = horizontal/target), `enter` / `back` / `cancel` / `confirm`, categories derived from the actor's commands, greyed-not-hidden empties, an always-present Pass, emitting one effect-free `ActionIntent` aimed at the locked target. |
| `ships-to-actors.ts` | Projects ready fleet ships into menu `Actor`s split by faction (`ActorSide`, `controlled` flag). Pure; the caller scopes ships to a system first. |
| `tuning.ts` | Hoisted menu-row accent colors (and a home for the later timing/availability knobs). |

## The execute dispatch (the fork)

`ActionMenu.confirm()` emits an `ActionIntent`; a dispatcher routes by `ActionDef.kind`:

- **`'immediate'`** — mutate the world now (the facility-placement model), then reconcile.
- **`'encounter'`** — build an `EncounterSpec` and enter the encounter modality. Inside an
  encounter the reducer is the confirm sink and `kind` is not consulted — the same menu drives
  combat rounds.

The dispatcher and the anchored scene layer are **M2** (the menu live in the system view) — see
"The scene layer" below. `src/actions/` itself is the **headless core**, fully covered by `npm
run test:actions`.

## The scene layer (M2)

The menu is driven live in the system view by `src/scene/actions/system-action-menu.ts` — a
**SystemScene-owned chrome layer** (its own ortho scene, a sibling of `SystemHud`, NOT inside
the sealed `SystemDiagram`). Selecting a fleet ship opens it anchored to that ship's slot; it
routes pointer + keyboard through the same chrome chain the sidebar/HUD use (`handleClick` /
`handlePointerMove` / `hitTest` / `handleKey`), drives the `ActionMenu` state machine, and paints
through the `ActionMenuPanel` + the in-field `TargetBracket`
([`src/ui/action-menu.ts`](../ui/action-menu.ts)) — the bracket rides the locked target while
you choose a command, and a click on (or ←/→ over) an enemy moves it. On a committed intent the
**execute dispatch** routes by `ActionDef.kind` — `onImmediate` /
`onEnterEncounter` — both filled by `SystemScene` (today: deferred placeholders; the
`'encounter'` hand-off is the seam the encounter modality, E-phases, claims).

## Status

- **M1 (shipped):** the registry + `ActionMenu` + the ship adapter, headless-tested.
- **M2 (shipped):** the menu anchored live in the system view — select a fleet ship → drill
  category → command while a target bracket rides an enemy in the field (←/→ / click to move it)
  → confirm fires at the locked target, mouse + keyboard parity (incl. WASD), the dispatch seam
  wired (placeholder effects, encounter hand-off stubbed). The de-risking milestone: the hardest
  UX, validated outside the combat turn loop.
- **Next:** the encounter consumes both (`4x-encounter-combat-system.md` E1–E5) — and non-combat
  `'immediate'` verbs (establish-colony, move) land as additive `ActionDef` content.
