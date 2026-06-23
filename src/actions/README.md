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
orbital-railgun, a colony's "establish"). The menu, registry, and dispatch never assume a ship.
Both adapters ship as neutral leaves: `ships-to-actors.ts` (the fleet) and `bodies-to-actors.ts`
(facility-bearing bodies, facility-gated commands). They share one keyspace — `entity-id.ts`
mints `body:<bodyIdx>` ids while ship ids stay un-prefixed — so one resolver, one anchor lookup,
and one `ActionIntent` route both kinds. The encounter's later ship-to-planet phase
*specializes* `bodies-to-actors` (adding a combat stat bag), it does not re-invent a body→actor
path.

## Files

| File | What it owns |
|---|---|
| `types.ts` | The vocabulary leaf — `ActionType` (frozen), `ActionCategory`, `ActionTargeting`, `ActionKind`, the **target-predicate** axis (`TargetCandidate` / `TargetCriteria` / `TargetAllegiance`), and the `ActionDef` / `ActionRef` / `Actor` / `ActorSide` / `ActionIntent` shapes. Effect-free: enough to build and run the menu, never what an action *does*. |
| `registry.ts` | `ACTION_DEFS` — one frozen-key object per action (the `satisfies Record` + `FROZEN_ACTION_IDS` + DEV-assert guard, mirroring the other registries). Content: combat-first `attack` (enters an encounter), `flee`, the menu-injected `pass`, and the non-combat **world verbs** `mine` / `establish` / `bombard` (additive `'immediate'` members). |
| `menu.ts` | `ActionMenu` — the mechanics-agnostic state machine: a **two-level** stack (category → command) with an orthogonal **target lock** on the command level (`moveCursor` = vertical/command, `moveTarget` / `setTargetById` = horizontal/target), `enter` / `back` / `cancel` / `confirm`, categories derived from the actor's commands, greyed-not-hidden empties, an always-present Pass, emitting one effect-free `ActionIntent` aimed at the locked target. Also exports the pure `filterCandidates` matcher (applies a def's `TargetCriteria` to the controller's minted candidates). |
| `entity-id.ts` | The pure id codec — `encodeBodyEntityId` / `parseEntityId` over the frozen `body:` namespace, so ships (un-prefixed) and bodies (`body:<bodyIdx>`) share one keyspace without collision. |
| `ships-to-actors.ts` | Projects ready fleet ships into menu `Actor`s split by faction (`ActorSide`, `controlled` flag). Pure; the caller scopes ships to a system first. |
| `bodies-to-actors.ts` | Projects facility-bearing bodies into menu `Actor`s split by ownership — the body twin of `ships-to-actors`, ids in the `body:` namespace, placeholder facility-gated commands. Pure; the caller resolves each body's `bodyIdx` + owning faction. |
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
**execute dispatch** routes by `ActionDef.kind` — `onImmediate` / `onEnterEncounter`, both
filled by `SystemScene`. `onImmediate` routes to an app-side **effect-handler registry**
(`src/scene/actions/effect-handlers.ts`) keyed by `actionId` — today a no-op stub per world
verb (the routing, not the mechanics); the `'encounter'` hand-off stays a DEV stub, the seam the
encounter modality (E-phases) claims.

## Status

- **M1 (shipped):** the registry + `ActionMenu` + the ship adapter, headless-tested.
- **M2 (shipped):** the menu anchored live in the system view — select a fleet ship → drill
  category → command while a target bracket rides an enemy in the field (←/→ / click to move it)
  → confirm fires at the locked target, mouse + keyboard parity (incl. WASD), the dispatch seam
  wired (placeholder effects, encounter hand-off stubbed). The de-risking milestone: the hardest
  UX, validated outside the combat turn loop.
- **M2c (shipped):** the nested focus hierarchy. Actor selection is an **outer focus** mirroring
  the inner target focus — at the category level ←/→ cycle the active **actor** (your commandable
  ships, the menu re-opening on each); at the command level ←/→ cycle the **target**. A directional
  tap from idle focuses the first actor (keyboard-first), and Esc ascends one level (target →
  category → idle). A SystemScene/controller concern (`onCycleActor` + the actor ring); the headless
  `ActionMenu` is unchanged.
- **M3a (shipped):** bodies as even-handed actors/targets, headless. The `body:` entity-id codec
  (`entity-id.ts`); the `TargetCriteria` predicate seam on `ActionDef` (+ the pure `filterCandidates`
  matcher); the non-combat world verbs `mine` / `establish` / `bombard` routed to app-side no-op
  effect stubs; the `BodyOwnership` overlay + `ownerFactionId` + DEBUG `addOpponentBody` (with the
  economy fan-in ownership-gated so an enemy body can't feed the player); the neutral
  `bodies-to-actors.ts` projector. All pure/node-tested; no scene wiring yet.
- **M3b (shipped):** bodies as **live** actors/targets in the scene. `SystemDiagram.bodyCenter(bodyIdx)`
  (the body anchor twin of `fleetSlotCenter`); the `syncActionMenu` rewrite (opens on a controlled
  facility-bearing body, mints one flat ship+body candidate list with per-actor allegiance + tags,
  namespace-dispatches the anchor); the actor ring broadened to ships-then-bodies. The combat `attack`
  (and `bombard`) gained an enemy `targets` predicate; `mine`/`establish` are self-targeted bones. A
  DEV "+ opponent body" pill flips the selected body so the body-as-target path is exercisable. Select
  your colony/belt → its menu opens; select a ship → Attack now brackets enemy ships **and** enemy bodies.
- **Next:** the encounter consumes the menu (`4x-encounter-combat-system.md` E1–E5) over this
  already-even-handed substrate; the world verbs' effect stubs gain real mechanics behind their seams.
