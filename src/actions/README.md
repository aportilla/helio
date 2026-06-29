# `src/actions/` — the system action menu

The **general interaction grammar of the system view**: select an **actor**, then drill three
**sequential** levels — **category → command (weapon) → target** — and execute. You choose WHAT
to do first (a category, then a command) with no target shown; arming the command scopes into a
**separate target level** where the box hides and the bouncing **focus pointer** moves out onto one
candidate ship in the field (moved by the arrows / hover / click) and **only confirming the target
fires**. `back` / Escape walks the
hierarchy back up one level at a time (target → command → category → close). This is *how you act
on the world* — not combat chrome. Combat is one **consumer** (an offensive action that enters the
encounter modality); non-combat verbs (repair a ship, a sensor sweep) are peers.
This README is the as-built source of truth (the menu shipped through M3); the combat consumer's
forward design lives in `plans/4x-encounter-combat-system.md`.

A neutral **core leaf**, the deliberate twin of [`src/ships/`](../ships/README.md) and
[`src/factions/`](../factions/README.md): the vocabulary (`types`), the central remainder
(`registry`), the menu (`menu`), and the derive-and-merge projection (`derive`) import nothing
app-side, nothing from the DOM/catalog, nothing from the encounter package — so
every consumer can read the action grammar without pulling in a consumer. The two **adapters**
reach sideways into the durable stores they project — but both stay **sim-free**: `ships-to-actors`
into the fleet (an erased `import type { Ship }`) + the ship-class / component registries (to resolve
a ship's loadout and read each component's inline `grants`), `bodies-to-actors` into the facility
registry (`FACILITY_BY_TYPE`) to read each facility's inline `grants`. Those registry imports stay
sim-free because the registries themselves are — a facility's `contribute()` needs only the
`EconResource` ids (a plain const), not the sim-built `ResourceTable` (which lives in
`facilities/resource-table.ts`), and a component carries no economy at all. Both adapters end on the
shared `actorSides` split (`sides.ts`). The whole package stays node-pure; the adapters are where the
grammar meets the world.

## Actions are DERIVED, not enumerated

There is **no central `ActionType` union**. An actor's commands are a **projection** of the
modular providers it carries — a ship's components, a body's facilities — each of which
**declares** the actions it grants (an `ActionGrant`: label / category / targeting / kind /
predicate). `deriveCommands` (`derive.ts`) collects those grants across an actor's providers and
**merges identical ones** into a single scaled command (`Missile (x3)`, `count` 3), preserving
first-seen order. Adding a new capability is **one `ActionGrant` on the provider that grants it** —
no enum, no central registry, no facility→command map to thread it through.

A command's serializable id is composed as **`"<providerId>:<grant.key>"`** (e.g. `railgun-battery:railgun`,
`sensor-network:recon`). A grant `key` names the **capability**, not how it discharges (`railgun` /
`missile`, never a loaded, weapon-shared verb like `fire` — an attack might be a railgun shot, a
missile, or an unleashed swarm). Its **provider half is frozen** — `FacilityType` is guarded by
`FROZEN_FACILITY_IDS` + a CI test (load-bearing today, since facility types persist in `helio.game`
saves), and `ShipComponentDef.id` will be next. The **grant `key` half rests on discipline** for now
(no `FROZEN_GRANT_KEYS` guard yet), and nothing serializes an `ActionIntent` today — so the wire-id
freeze is **forward-looking**: it begins to bite only when a replay / encounter log persists an
`actionId`. The `body:` target namespace (`entity-id.ts`) keeps its own guard. The design is
specified in `plans/4x-modular-ship-components.md` §2 (Phase 1 of the modular-components plan).

## Actors are ships **and** bodies

An `Actor` is a minimal, **body-agnostic** handle — an id plus the commands its loadout grants (with optional stats / category palette). A fleet **ship**, and a
**planet / moon / belt that carries player facilities**, are both actors: each opens the same
anchored menu and offers the commands its loadout grants (a ship's weapons; a body's
orbital-railgun or sensor sweep). The menu, registry, and dispatch never assume a ship.
Both adapters ship as neutral, sim-free leaves: `ships-to-actors.ts` (the fleet, commands derived from each
ship's component loadout) and `bodies-to-actors.ts` (facility-bearing bodies, commands derived from each
facility's grants) — one `deriveCommands` projection over both. They share one keyspace — `entity-id.ts`
mints `body:<bodyIdx>` ids while ship ids stay un-prefixed — so one resolver, one anchor lookup,
and one `ActionIntent` route both kinds. The encounter's later ship-to-planet phase
*specializes* `bodies-to-actors` (adding a combat stat bag), it does not re-invent a body→actor
path.

## Files

| File | What it owns |
|---|---|
| `types.ts` | The open vocabulary leaf — `ActionGrant` (a provider's declared action) and the merged `ActionCommand` an actor carries, plus `ActionCategory` / `ActionTargeting` / `ActionKind`, the **target-predicate** axis (`TargetCandidate` / `TargetCriteria` / `TargetAllegiance`), and the `Actor` / `ActorSide` / `ActionIntent` shapes. No `ActionType` union — actions are derived. Effect-free: enough to build and run the menu, never what an action *does*. |
| `derive.ts` | The **derive-and-merge projection** — `deriveCommands(providers)` collects each `GrantProvider`'s grants, merges identical ones (by composed id) into one scaled `ActionCommand`, first-seen order; `grantKeyOf(id)` is the inverse the app-side effect handlers key on. The pure heart both adapters share. |
| `registry.ts` | The vocabulary's small central remainder after the inversion (no `ACTION_DEFS`): the per-actor-TYPE **category palettes** (`SHIP_CATEGORIES` Attack+Navigation / `BODY_CATEGORIES` Attack+Support), and the grant-keyed display helpers (`commandLabel`, which suffixes `(xN)` for a merged command; `commandColor`). |
| `menu.ts` | `ActionMenu` — the mechanics-agnostic state machine: a **three-level** stack (category → command → target). `enter` drills (category → command → arm-and-enter-targeting) and, at the target level, **fires**; `back` / `cancel` walk back up. `moveCursor` / `setCursor` pick the category/command (inert once a weapon is armed at the target level); `moveTarget` / `setTargetById` move the lock, live **only at the target level** — the command level exposes no targets, so the bracket appears only after you arm a weapon. The top-level rows come from the actor's **category palette** (`Actor.categories`) or, absent one, are derived from its commands' categories — empties shown greyed-not-hidden. Emits one effect-free `ActionIntent` aimed at the locked target. Reads the actor's **resolved commands inline** (no central lookup); availability is the energy check `stats.energy >= command.totalCost` (permissive when no energy stat). Also exports the pure `filterCandidates` matcher (applies a grant's `TargetCriteria` to the controller's minted candidates). |
| `entity-id.ts` | The pure id codec — `encodeBodyEntityId` / `parseEntityId` over the frozen `body:` namespace, so ships (un-prefixed) and bodies (`body:<bodyIdx>`) share one keyspace without collision. |
| `ships-to-actors.ts` | Projects ready fleet ships into menu `Actor`s split by faction (`ActorSide`, `controlled` flag). Commands are **derived + merged from the ship's component loadout** — its `ShipClassDef.components` (today the corvette's `small-laser` → Laser; its `small-engine` grants no command), each component's inline `grants` run through `deriveCommands`, the same projection the body adapter uses. Pure; the caller scopes ships to a system first. |
| `bodies-to-actors.ts` | Projects facility-bearing bodies into menu `Actor`s split by ownership — the body twin of `ships-to-actors`, ids in the `body:` namespace. Commands are **derived + merged from each facility's own inline grants** (read via `FACILITY_BY_TYPE`; the registry is sim-free, so the adapter stays sim-free) — no central facility→command map; every body carries the **Attack + Support** category palette. The caller resolves each body's `bodyIdx` + owning faction. |
| `sides.ts` | `actorSides(entries)` — the shared faction/ownership split both adapters end on: groups `(factionId, actor)` entries into `ActorSide`s, marks the `controlled` side, preserves first-seen faction order. Extracted so that rule lives in one place as the platform→actor pattern extends (the encounter's combatant sides reuse it). Each adapter does its own domain filtering first; `actorSides` only groups. |
| `tuning.ts` | Hoisted grant accent colors (and a home for the later timing/availability knobs), imported by the grant authoring sites (the ship **component** + facility registries). |

## The execute dispatch (the fork)

`ActionMenu.confirm()` emits an `ActionIntent`; a dispatcher routes by the action's `kind`,
resolved from the actor's **own resolved command** (`command.grant.kind`) — there is no central
registry to look it up in:

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
through the `ActionMenuPanel` ([`src/ui/action-menu.ts`](../ui/action-menu.ts)). The panel wears
the **Sea-of-Stars chrome**: the actor's name floats above a tight box of two-state rows, a
bouncing `MenuPointer` (not a row highlight) is the **single focus mark**, and — at the **category**
level, when more than one actor is commandable — `ActorArrow`s flank the box as the actor-switch
affordance (clicking one cycles the focus, the keyboard ←/→ twin). At the **target level the box
hides** and the focus pointer moves out onto the locked **target ship** in the field (the arrows /
hover / a click move it; a target click — or Enter — fires); there is no separate bracket, the
bouncing pointer *is* the target indicator. The controller owns these adornments and bobs the
pointer from `SystemScene`'s per-frame `tick`. The directional axes change with the level: at the
target level all arrows move the lock; at the command level ↑/↓ pick the weapon and ←/→ are inert;
at the category level ←/→ cycle the actor. On a committed intent the
**execute dispatch** routes by the command's `kind` — `onImmediate` / `onEnterEncounter`, both
filled by `SystemScene`. `onImmediate` routes to an app-side **effect-handler registry**
(`src/scene/actions/effect-handlers.ts`) keyed by **grant key** (`grantKeyOf(actionId)`, so a
verb's effect is one entry regardless of which provider grants it) — today a no-op stub per world
verb (the routing, not the mechanics). The `'encounter'` hand-off is **live**: `onEnterEncounter`
builds an `EncounterSpec` and enters the combat mode on `SystemScene` (E3/E4 shipped). And while in
an encounter the menu's confirm folds through a third sink, `onEncounterCommit`, into the reducer —
the `kind` fork is skipped (flipped on via `setEncounterMode`).

The controller also exposes **`focusState()`** — `{ level, actorId, targetId, weaponColor,
weaponComponentId }` read off `menu.view()` — which the scene's `TargetingVisuals` layer
(`src/scene/targeting-visuals.ts`) reads each frame to light the **in-field FX keyed to the menu's
focus DEPTH**: an engine glow on the focused actor, then a weapon-primed glow (on the firing module's
rect, via `FleetLayer.moduleCenterFor`) + a yellow aim line + a target reticle once a weapon is armed.
Escape walking the menu back reverts them by level. It serves combat and the live view alike.

## Status

- **M1 (shipped):** the registry + `ActionMenu` + the ship adapter, headless-tested.
- **M2 (shipped):** the menu anchored live in the system view — select a fleet ship → drill into a
  command, target an enemy in the field, confirm to fire — mouse + keyboard parity (incl. WASD), the
  dispatch seam wired (placeholder effects, encounter hand-off stubbed). The de-risking milestone:
  the hardest UX, validated outside the combat turn loop. (The flow later split into three levels —
  see the intro + scene-layer above.)
- **M2c (shipped):** the nested focus hierarchy. Actor selection is an **outer focus** alongside
  the inner target focus — at the category level ←/→ cycle the active **actor** (your commandable
  ships, the menu re-opening on each); the **target** is moved at the (later, separate) target
  level. A directional tap from idle focuses the first actor (keyboard-first), and Esc ascends one
  level (target → command → category → idle). A SystemScene/controller concern (`onCycleActor` +
  the actor ring).
- **M3a (shipped):** bodies as even-handed actors/targets, headless. The `body:` entity-id codec
  (`entity-id.ts`); the `TargetCriteria` predicate seam (now on each `ActionGrant`) plus the pure `filterCandidates`
  matcher; the app-side effect-handler routing seam (keyed by grant key), today holding only the
  reserved/dormant `bombard` stub; the
  `BodyOwnership` overlay + `ownerFactionId` + DEBUG `addOpponentBody` (with the
  economy fan-in ownership-gated so an enemy body can't feed the player); the neutral
  `bodies-to-actors.ts` projector. All pure/node-tested; no scene wiring yet.
- **M3b (shipped):** bodies as **live** actors/targets in the scene. `SystemDiagram.bodyCenter(bodyIdx)`
  (the body anchor twin of `fleetSlotCenter`); the `syncActionMenu` rewrite (opens on a controlled
  facility-bearing body, mints one flat ship+body candidate list with per-actor allegiance + tags,
  namespace-dispatches the anchor); the actor ring broadened to ships-then-bodies. The combat `attack`
  (and `bombard`) gained an enemy `targets` predicate. A
  DEV "+ opponent colony" pill places an opponent colony on the selected body (a facility + an ownership
  flip — the facility claims it) so the body-as-target path is exercisable. Select your colony/belt → its
  menu opens; select a ship → Attack now targets enemy ships **and** enemy bodies.
- **Body loadouts + always-shown categories (shipped):** bodies now field a real two-category
  menu. New facilities (`railgun-battery`, `missile-battery`, `sensor-network` — economy-inert,
  like the shipyard) each **declare one action grant**: **Attack** weapons Railgun / Missile
  Launcher (enemy-only, `'encounter'` kind) and **Support** verbs Repair (ally/self ship) /
  Tactical Data (self) — the shipyard also now grants Repair. The menu honors an actor's
  **category palette** (`Actor.categories`): a body always shows Attack + Support, a ship Attack +
  Navigation, each empty category greyed-but-shown rather than hidden. Effects remain no-op stubs.
- **Action-model inversion (shipped — Phase 1 of `4x-modular-ship-components.md`):** the central
  `ActionType` union + `ACTION_DEFS` registry + `FACILITY_COMMANDS` / `DEFAULT_SHIP_COMMANDS` maps
  are gone. Providers (facilities now, ship components next) **declare** their `ActionGrant`s; an
  actor's commands are **derived and merged** (`derive.ts`) from whatever it carries; the frozen
  wire contract moved onto the providers + grant keys (composed id `"<providerId>:<grant.key>"`).
  `isAvailable` became an energy check, `costPerUnit` rides each grant (absent ⇒ 0) ahead of the
  Phase-2 energy model. Pure refactor — behavior unchanged (every suite green).
- **Ship component loadouts (shipped — Phase 2 of `4x-modular-ship-components.md`, action side):**
  the ship **stub loadout is gone**. [`src/ships/components/`](../ships/README.md) is now a real
  `ShipComponentDef` registry (`small-engine` → no action / recharge only, `small-laser` → Laser); a ship's commands
  derive from its class's `components` loadout through the same `deriveCommands` as a body's
  facilities. The byte-identical faction-split both adapters carried was extracted to `sides.ts`
  (`actorSides`). **Deferred:** the energy model (`battery`/`recharge`/`costPerUnit`), size-class
  budget, component rendering, and per-ship loadout serialization (Phases 2-energy→4).
- **Sea-of-Stars chrome + sequential targeting (shipped):** the panel is a tight box with the
  actor name floating above it and two-state rows (selection is not a row state); a single bouncing
  **focus pointer** marks the cursor row, and ◄ ► **actor arrows** flank the box at the category
  level when more than one actor is commandable. The flow split into **three sequential levels**
  (category → command → target): arming a weapon enters a distinct target mode where **the box
  hides** and the focus pointer moves out onto the locked **target ship** in the field (no separate
  bracket); only confirming the target fires, and Esc walks back up one level at a time. A command
  with no admissible target is **greyed** (can't be armed into a dead end), mirroring the energy gate.
- **Next:** the encounter **consumes the menu — first-playable** (`4x-encounter-combat-system.md`
  E1–E4 + the effect substrate shipped; see [src/encounter/README.md](../encounter/README.md)) over this
  even-handed, **derived** substrate; E5 body combatants, opponent AI, and event animation remain. The
  energy model + loadout build flow (`4x-modular-ship-components.md` Phases 2-energy–5) make components
  combat-load-bearing; the world verbs' effect stubs gain real mechanics.
