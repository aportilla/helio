# `src/encounter/` — the combat encounter

Combat in Helio is a **mode on the live system view**, not a separate screen: acting on an opponent
with an offensive command whose `kind` is `'encounter'` suspends the galaxy turn and runs an
internal round loop *in place* over the same diagram. This package owns the **rules** of that mode —
the combatant contract, the launch spec, and (as they land) the headless reducer. It is the third
state category, alongside the static catalog and the deterministic economy sim: **transient** state
that is born when an encounter starts and dies when it ends, and is **never serialized** into either
save.

## The seam this package rides

Combat reuses the general action grammar rather than reinventing one. A `Combatant` **is an**
[`Actor`](../actions/README.md) — it carries the same `commands` + opaque `stats` + category
palette — so the same anchored `ActionMenu` opens on a combatant with no adapter. The combat
adapters are the **specializations** of the system-view ones:

| System view (`src/actions/`) | Combat (`src/encounter/`) | What combat adds |
|---|---|---|
| `ships-to-actors` | `ships-to-combatants` | `kind`, the `combatId` turn index, the `classId` anchor |
| `bodies-to-actors` | `body-role` *(E5)* | the same, for a planet/moon/belt as a combatant |
| `actorSides` | reuses `groupByFaction` | — (the controlled-side + ordering rule stays in one place) |

This mirror is deliberate: a ship and a body project into combat exactly the way they project into
the menu, so the inverted action model (commands **derived** from a platform's modules, never a
central enum) carries straight into combat with no parallel vocabulary.

## What's a combatant

A tagged union discriminated by `kind` (`'ship'` | `'body'`), differing only in how the renderer
anchors it. Beyond being an `Actor` it carries a **`combatId`** — a dense integer index into the
spec's combatant array, assigned at spec build, ships first and body-combatants appended. `combatId`
is the turn-order tiebreak: the durable `id` (a ship's save handle) names *who*, but `combatId`
alone orders the round, so replay / AI ordering is deterministic and independent of the id strings.

The command list carries no effect data — the bones know neither what a command does. Combat HP is an
ordered **pool stack** (`pools`, with the damage cascade in `pools.ts`); the energy gate lives in the
opaque `stats` bag. Both attach to the combatant additively (an effect-free adapter ships neither —
`createEncounterState` seeds them), so the shape stays stable while the mechanics stay fluid.

## Boundary

A combat-**rules** leaf. The DTOs the reducer / HUD read live here (or in `src/actions/` or
`src/ui/`), **never** under `src/scene/**` — a `ui/` surface reading a scene-declared type would
breach the verified `ui/ ↛ scene/` wall. This package imports only the action vocabulary and the
frozen faction / ship key types: no DOM, no catalog, no sim. The combat *renderer* (the encounter
mode on `SystemScene`) is the consumer, in `src/scene/`.

## Status

Built phase-by-phase; combat shares the "build the UX bones first, defer the mechanics" discipline
the rest of the project follows.

> **Next:** combat is **first-playable** (E1–E4) on the **Press-Turn** turn model (§3.8), and the
> **event-animation lifecycle is shipped** (EV steps 1–6, plan §14): an action animates as a **beat** —
> the firing weapon's `count` fans into that many bolts (in the weapon's colour) travelling source→target,
> then an impact flash (a burst on a kill) + a damage-number pop — held by an async **playback window** in
> the controller (the reducer stays synchronous; the HP drop lands at the beat's end). The remaining
> frontier: beats for the non-`damage` events (heal / shield juice — step 4's tail), a real opponent **AI**
> (§3.7 — a placeholder auto-attacks then ends its phase now), and **E5** (body combatants — the
> `body-role` producer appends planet/moon/belt combatants).

- **E1 — the contract (shipped).** `state.ts` (the `Combatant` union + `CombatantSide`),
  `encounter-spec.ts` (`EncounterSpec` + `buildEncounterSpec`), and `ships-to-combatants.ts` (the
  combat specialization of the fleet adapter). Pure and node-tested; nothing renders yet.
- **E2 — the headless reducer (shipped), on the Press-Turn turn model (§3.8).** `state.ts` adds the
  stepped `EncounterState` + the `EncounterEvent` union; `step.ts` is the pure core —
  `createEncounterState(spec)`, `applyCommand(state, intent) → { state, events }`, and `endPhase(state)`
  (the fleet-scoped End Round / auto-pass) — with `turn-order.ts`, `terminal.ts`, `initiative.ts`, and
  `tuning.ts`. **Turn structure is per-SIDE initiative:** a side holds a whole-integer pool of icons
  (`EncounterState.initiative`, the live one keyed by `phaseSide`), spends ONE per action across any of
  its ships (`turn-order.nextActor` round-robins *within* the side, re-offering a lone ship — a ship may
  act again while icons remain), and when the pool is spent / End-Round'd the phase passes to the next
  living side, whose pool is **re-derived from its living roster each phase** (`baseSideInitiative` =
  `floor(ships × ratio)` clamped to a floor, plus effect `SideDelta`s, I5). A full pass over the sides
  is one `round`; the attacker (`initiator`) opens. Zero gameplay math: a **flat placeholder effect**
  subtracts a fixed `hull` amount and emits a `damage`/`down` event. The terminal (`terminal.ts`) is
  **side elimination** OR **mutual disengage** (a full round with no damage from either side). The
  attack path cascades the **pool stack** the effect substrate (below) layered on this reducer; `dealt`
  (HP actually removed) drives the `damage` event.
- **The effect substrate (shipped) — a unified lifecycle/delta model.** `effects/` is the fourth
  registry-family member: a provider DECLARES the effects it installs exactly as it declares grants, and
  an effect subscribes to named **lifecycle phases** (`EffectDef.on`: `install` / `expire` / `turnStart`
  / `phaseStart`) whose handlers return typed **outcomes** (`StatDelta` → the stat bag, `PoolEdit` → the
  pool stack, `SideDelta` → the side's initiative pool). ONE applier (`fold.applyOutcome`) routes every
  outcome by `kind`, so a handler from ANY phase may touch ANY tier — adding a novel effect (even one
  that touches a new aspect under a unique condition) is a new def with handlers, never a new registry
  key or a reducer branch. The runners: `installEffects` (`collectInstalls` + mint, the `deriveCommands`
  twin) runs `install`; `tickTurnStart` runs an owner's `turnStart` at its turn start (and counts a
  timed instance down, running `expire` as it drops); `foldPhaseStart` runs a side's `phaseStart` when
  its Press-Turn phase begins. HP is an ordered **pool stack** (`pools.ts`): a hit cascades top→bottom,
  so a shield is just a band spliced above `hull` (absorb-before-hull is pure stack order). Worked
  examples live: **A** — `small-engine` installs a permanent `recharge` (`turnStart` → a clamped energy
  `StatDelta`); **B** — `small-shield`'s `raise-shields` mints (via `installsOnResolve`, keyed by grant
  key on the component def, NOT the neutral `ActionGrant`) a 3-cycle `shield-segment` (`install` splices
  the band, `expire` drops it — both `PoolEdit`s); **C** — `tactical-command-module` installs a permanent
  `tactical-command` (`phaseStart` → a `+1` `SideDelta`) with **`stacking: 'presence'`**, so a side's
  Press-Turn tempo bonus counts once however many ships carry it (presence-not-count is the effect's
  DATA, not a static `initiative` registry key). Effect ids are a **monotonic counter** (an on-resolve
  mint never reuses a freed id); stacking is **distinct instances** (a re-cast is a second band).
- **E3 — the mode (shipped).** Combat runs as a MODE on `SystemScene`, in place over the same diagram
  (no second scene — combat is an extra render PASS). `EncounterController` (`src/scene/encounter-
  controller.ts`) owns the transient `EncounterState` + its own overlay scene; `CombatOverlay`
  (`encounter-overlay.ts`) paints a bordered HP bar (hull + shield bands), an active-turn marker, and
  a downed dim over each combatant, anchored to the live fleet slots via `slotCenterForEntity`. The
  galaxy turn freezes on BOTH paths — a `freezesTurn` getter backed by an `inEncounter` flag (since
  `Screen.freezesTurn` is `readonly`) for the programmatic `nextTurn()`, and `setNextTurnEnabled(false)`
  for the user click. `onEnterEncounter` is un-stubbed: a confirmed `'encounter'`-kind action builds
  the spec via `buildEncounterSpec(shipsToCombatants(readyShips()), intent)` and enters. A DEV
  spectator auto-play drives the reducer to side-elimination; Esc flees, terminal exits — both
  unfreeze. A DEV `?demo-encounter` boot path makes the chrome reproducibly screenshot-able.
- **E4 — the interactive loop (shipped), Press-Turn.** The same `SystemActionMenu` drives the round: an
  `onEncounterCommit` sink + `setEncounterMode` flip its `dispatch()` from the live-view kind fork into
  the reducer. `EncounterController` opens the menu on the active **CONTROLLED** combatant (its derived
  loadout + seeded `energy`/`energyMax` gate, anchored by durable id), folds a confirm through
  `applyCommand`, and REOPENS on the new `activeId`. Because the reducer keeps `activeId` on the
  controlled side until its icons are spent, the menu **stays on your side across multiple activations**
  within the phase; pressing **`R`** is the fleet-scoped **End Round** (`endPhase`, forfeit + pass).
  `CombatOverlay` paints a per-side **initiative pip readout** (icons remaining, active side underlined)
  beside the HP bars. You command only your side — an opponent's phase opens no menu and is auto-driven
  (a placeholder for the deferred AI, §3.7): the driver **loops one activation per interval until its
  pool is spent**, ending its phase if stranded. A NAVIGATION command is flee-to-exit; side-elimination
  / mutual-disengage auto-exit.
- **Free in-phase actor choice (shipped), §3.8.** You spend your initiative across **any** of your living
  same-side actors, in any order — not a forced round-robin. `selectActor(state, combatId)` (`step.ts`) is
  a pure cursor move (no icon spent, no turn-start tick — recharge stays tied to `advanceTurn`'s landing
  cadence; energy + availability still gate each ACTION via the menu's greyed rows); `neighborActor`
  (`turn-order.ts`) is the ◄ ► ring. `EncounterController.cycleActor` / `selectActorByEntityId` re-anchor
  the menu + the active-turn marker onto the chosen actor — **both ◄ ► (category-level) and a click on a
  friendly combatant** work, routed from `SystemScene` (`onCycleActor` → `cycleActor`; the in-encounter
  pointer path). The round-robin (`nextActor`) is now just the post-action DEFAULT and the opponent
  auto-driver's path; the player overrides it freely.
- **EV — event-animation lifecycle (shipped: steps 1–6), plan §14.** A confirmed action no longer reopens
  the menu in the same call stack: `commit` applies the reducer, then opens an **animation window** held by
  the controller's per-frame `tick`, and only `settle`s (repaint to the post-action truth — the HP drop —
  then reopen the menu on the new active) when it elapses. The reducer stays **synchronous** (no float
  reaches it, §6.4); the window's duration is **derived** to fit the beat, and the menu / opponent
  auto-driver wait behind it. `CombatTracers` (`src/scene/encounter-tracers.ts`) draws it: per `damage`
  event the firing weapon's **`count`** (recovered render-side via `commandFor`, §14.4) fans into that many
  **bolts** — staggered in launch time + offset in position — travelling source→target (via `slotCenterFor`,
  bodies for free) in the **weapon's colour** (`vfxForCommand`, §14.5); the last bolt pops the total
  `drawPixelText` damage number, and a `down` turns its impact into a destruction burst. A no-beat action (a
  pass, a self-effect) opens no window and settles at once. *Forward (step 4's tail):* beats for the
  `effect` / `install` / `expire` events (heal / shield juice).
- **E5 — body combatants.** The `body-role` producer + appending body-combatants to the spec.

Until ship *movement* exists, opponents are placed by a DEV-only spawn action; the single
`EncounterSpec` contract means combat is authored against the durable `GameState.ships` and won't
diverge from the movement system when it lands.

## Tests

`npm run test:encounter` (co-located in `test/`, run under `node --test`).
