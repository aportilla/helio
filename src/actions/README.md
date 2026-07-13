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
This README is the as-built source of truth; the combat consumer's
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
*specializes* `bodies-to-actors` (adding a combat stat bag).

## Files

| File | What it owns |
|---|---|
| `types.ts` | The open vocabulary leaf — `ActionGrant` (a provider's declared action) and the merged `ActionCommand` an actor carries, plus `ActionCategory` / `ActionTargeting` / `ActionKind`, the **target-predicate** axis (`TargetCandidate` / `TargetCriteria` / `TargetAllegiance`), and the `Actor` / `ActorSide` / `ActionIntent` shapes. No `ActionType` union — actions are derived. Effect-free: enough to build and run the menu, never what an action *does*. |
| `derive.ts` | The **derive-and-merge projection** — `deriveCommands(providers)` collects each `GrantProvider`'s grants, merges identical ones (by composed id) into one scaled `ActionCommand`, first-seen order; `grantKeyOf(id)` is the inverse the app-side effect handlers key on. The pure heart both adapters share. |
| `registry.ts` | The vocabulary's small central remainder — no `ACTION_DEFS`, since actions are derived: the per-actor-TYPE **category palettes** (`SHIP_CATEGORIES` / `BODY_CATEGORIES`, both Attack + Support + Command today — `command` a reserved, always-greyed placeholder until a module grants it), and the grant-keyed display helpers (`commandLabel`, which suffixes `(xN)` for a merged command; `commandColor`). |
| `menu.ts` | `ActionMenu` — the mechanics-agnostic state machine: a **three-level** stack (category → command → target). `enter` drills (category → command → arm-and-enter-targeting) and, at the target level, **fires**; `back` / `cancel` walk back up. `moveCursor` / `setCursor` pick the category/command and **skip greyed (disabled) rows** — the cursor opens on, arrows onto, and clicks only ever rest on a *drillable* row, so the focus pointer is never parked on a dead option (a no-op when a whole level is greyed); inert once a weapon is armed at the target level. `moveTarget` / `setTargetById` move the lock, live **only at the target level** — the command level exposes no targets, so the bracket appears only after you arm a weapon. The top-level rows come from the actor's **category palette** (`Actor.categories`) or, absent one, are derived from its commands' categories — empties shown greyed-not-hidden (shown, but unreachable by the cursor). Emits one effect-free `ActionIntent` aimed at the locked target. Reads the actor's **resolved commands inline** (no central lookup); availability is the energy check `stats.energy >= command.totalCost` (permissive when no energy stat). Also exports the pure `filterCandidates` matcher (applies a grant's `TargetCriteria` to the controller's minted candidates). |
| `entity-id.ts` | The pure id codec — `parseEntityId` over three frozen namespaces so one resolver/anchor pipeline addresses all: ships (un-prefixed), bodies (`body:<bodyIdx>`), and **systems** (`sys:<slug>` — a galaxy warp destination, `encodeSystemEntityId`, no in-scene anchor). |
| `ships-to-actors.ts` | Projects ready fleet ships into menu `Actor`s split by faction (`ActorSide`, `controlled` flag). Commands are **derived + merged from the ship's component loadout** — its `ShipClassDef.components` (today the corvette's `small-laser` → Laser; its `small-engine` grants no command), each component's inline `grants` run through `deriveCommands`, the same projection the body adapter uses. Pure; the caller scopes ships to a system first. |
| `bodies-to-actors.ts` | Projects facility-bearing bodies into menu `Actor`s split by ownership — the body twin of `ships-to-actors`, ids in the `body:` namespace. Commands are **derived + merged from each facility's own inline grants** (read via `FACILITY_BY_TYPE`; the registry is sim-free, so the adapter stays sim-free) — no central facility→command map; every body carries the **Attack + Support + Command** category palette. The caller resolves each body's `bodyIdx` + owning faction. |
| `sides.ts` | `actorSides(entries)` — the shared faction/ownership split both adapters end on: groups `(factionId, actor)` entries into `ActorSide`s, marks the `controlled` side, preserves first-seen faction order. That rule lives in one place as the platform→actor pattern extends (the encounter's combatant sides reuse it). Each adapter does its own domain filtering first; `actorSides` only groups. |
| `tuning.ts` | Hoisted grant accent colors (and a home for the later timing/availability knobs), imported by the grant authoring sites (the ship **component** + facility registries). |

## The execute dispatch (the fork)

`ActionMenu.confirm()` emits an `ActionIntent`; a dispatcher routes by the action's `kind`,
resolved from the actor's **own resolved command** (`command.grant.kind`) — there is no central
registry to look it up in:

- **`'immediate'`** — mutate the world now (the facility-placement model), then reconcile.
- **`'encounter'`** — build an `EncounterSpec` and enter the encounter modality. Inside an
  encounter the reducer is the confirm sink and `kind` is not consulted — the same menu drives
  combat rounds.

The dispatcher and the anchored scene layer drive the menu live in the system view — see
"The scene layer" below. `src/actions/` itself is the **headless core**, fully covered by `npm
run test:actions`.

### Root-level commands + target spaces (dormant machinery)

A grant can opt out of the category drill. `ActionGrant.rootLevel` surfaces a command as a **direct
row at the top (category) level** — beside Attack/Support/Command, arming straight into targeting
(no command level). Orthogonally, `ActionGrant.targetSpace` (`'local'` default | `'system'`) names
where the target is acquired: a `'system'` command targets a **galaxy system** (`TargetCandidate.kind`
gains `'system'`, ids in the `sys:` namespace), so `canFire`'s empty-candidate greying gives free
pre-grey (nothing reachable ⇒ the row greys). This vocabulary is **generic machinery with no live
consumer today**: star-to-star navigation is a galaxy-view modality (galaxy sidebar → destination
pick → `orderShipWarp`, entirely in `src/scene/` + `src/game-state`), so no grant declares
`rootLevel` / `targetSpace: 'system'`. The headless grammar + the `sys:` codec stay (exercised by
`menu.test.ts` / `entity-id.test.ts`), ready for the next top-level or galaxy-scoped command.

## The scene layer

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
pointer from `SystemScene`'s per-frame `tick`. The box anchors **beside** the actor's sprite (flipping
left/right to fit), **centered on it for the first level then TOP-pinned across the drill** — so a
sub-menu with a different row count grows the box downward rather than recentering it (no vertical
jump); a resize / fleet relayout re-centers on the sprite's new spot. The directional axes change with the level: at the
target level all arrows move the lock; at the command level ↑/↓ pick the weapon and ←/→ are inert;
at the category level ←/→ cycle the actor. On a committed intent the
**execute dispatch** routes by the command's `kind` — `onImmediate` / `onEnterEncounter`, both
filled by `SystemScene`. `onImmediate` routes to an app-side **effect-handler registry**
(`src/scene/actions/effect-handlers.ts`) keyed by **grant key** (`grantKeyOf(actionId)`, so a
verb's effect is one entry regardless of which provider grants it) — today a no-op stub per world
verb (the routing, not the mechanics). The `'encounter'` hand-off is **live**: `onEnterEncounter`
builds an `EncounterSpec` and enters the combat mode on `SystemScene`. And while in
an encounter the menu's confirm folds through a third sink, `onEncounterCommit`, into the reducer —
the `kind` fork is skipped (flipped on via `setEncounterMode`).

The controller also exposes **`focusState()`** — `{ level, actorId, targetId, weaponColor,
weaponComponentId }` read off `menu.view()` — which the scene's `TargetingVisuals` layer
(`src/scene/targeting-visuals.ts`) reads each frame to light the **in-field FX keyed to the menu's
focus DEPTH**: an engine glow on the focused actor, then a weapon-primed glow (on the firing module's
rect, via `FleetLayer.moduleCenterFor`) + a yellow aim line + a target reticle once a weapon is armed.
Escape walking the menu back reverts them by level. It serves combat and the live view alike.

## Status

The menu, its three-level sequential drill, the derived action model, the SoS chrome + sequential
targeting, ships and facility-bearing bodies as even-handed actors/targets, and the encounter
consuming the same menu are all live — described in the prose above. World-verb effects are no-op
stubs (the routing, not the mechanics). What remains ahead:

- **Encounter (`4x-encounter-combat-system.md`; see [src/encounter/README.md](../encounter/README.md)):**
  E5 body combatants, opponent AI, and event animation.
- **Energy model + loadout build flow (`4x-modular-ship-components.md` Phases 2-energy–5):** the
  `battery` / `recharge` / `costPerUnit` energy model, the size-class component budget, component
  rendering, and per-ship loadout serialization — these make components combat-load-bearing.
- **World-verb mechanics:** the `onImmediate` effect stubs gain real behavior.
