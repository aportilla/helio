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
> frontier: beats for the non-`damage` events (heal / shield juice — step 4's tail) and **E5** (body
> combatants — the `body-role` producer appends planet/moon/belt combatants). A first-slice opponent **AI**
> shipped (`ai.ts`, §3.7): a deterministic, fleet-aware focus-fire policy — it fires any same-side ship that
> can afford a salvo at the weakest living enemy; richer valuation (timing, combos) layers on with P-Experiment.

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
  is one `round`; the attacker (`initiator`) opens. Zero gameplay math and **no behaviour fork** —
  `applyCommand` runs every action through ONE path, the on-resolve effect mint (substrate below): a
  weapon's grant installs a one-shot `damage` effect on each target that cascades a flat placeholder hit
  through its **pool stack** (`dealt` = HP actually removed drives the `damage`/`down` events), a defense
  grant installs a self shield, anything else just passes the activation. The terminal (`terminal.ts`) is
  **side elimination** OR **mutual disengage** (a full round with no damage from either side).
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
  so a shield is just a band spliced above `hull` (absorb-before-hull is pure stack order), and the cascade
  scales each band's bite by the weapon's **effectiveness** (`effByKey`, permille by band key — how a laser
  shreds shields while a cannon craters hull, read as a per-band number, NOT a per-type branch; absent ⇒
  100% ⇒ a flat hit). `PoolEdit` has four ops on that stack — `splice` (add a band) / `drop` (remove a
  sourced band) / `restore` (regen a sourced band toward max) / `damage` (cascade a typed hit). Worked
  examples live: **A** — `small-engine` installs a permanent `recharge` (`phaseStart` → a clamped energy
  `StatDelta`); **B** — `small-shield`'s `raise-shields` mints (via `installsOnResolve`, keyed by grant
  key on the component def, NOT the neutral `ActionGrant`) a 3-cycle `shield-segment` (`install` splices
  the band, `expire` drops it — both `PoolEdit`s); **C** — `tactical-command-module` installs a permanent
  `tactical-command` (`phaseStart` → a `+1` `SideDelta`) with **`stacking: 'presence'`**, so a side's
  Press-Turn tempo bonus counts once however many ships carry it (presence-not-count is the effect's
  DATA, not a static `initiative` registry key); **D** — a weapon's `installsOnResolve` mints a one-shot
  `damage` (`remaining: 0` — applied on `install`, never a rider, no chip beat) whose handler cascades a
  `damage` `PoolEdit` through the target's stack: the cut that retired the reducer's LAST attack branch,
  so an enemy debuff / DoT / the Disruption-Virus initiative swing is now just another `EffectDef`, not a
  reducer fork; **E** — `small-shield-generator` installs a permanent `shield-generator` whose `phaseStart`
  is a **4-state machine** reading only its owner's pools + stats: it splices a full `shields` band, regens
  it toward cap each phase at the cost of `upkeep` energy, and when a hit strips it to 0 **drops it and
  fritzes out** for `fritzPhases` of the owner's phases (a plain `shieldCooldown` stat counts down; the
  band's absence is the rest of the memory) before rebooting to full — a crisp reactive-feeling lockout
  with NO new lifecycle moment and NO mutable-state bag, the substrate flexing without growing. Effect ids
  are a **monotonic counter** (an on-resolve mint never reuses a freed id; a
  one-shot draws none); stacking is **distinct instances** (a re-cast is a second band).
- **Dynamic-combat demo (shipped) — the first real mechanics on the substrate.** A `gunship` class
  (`src/ships/`) fits BOTH weapons + the shield generator, so the loop is playable on one platform: a
  **laser** (`eff:shields` 150% / `eff:hull` 60%) strips a shield fast but glances off hull; a **cannon**
  (`eff:shields` 50% / `eff:hull` 140%) is the inverse. So firing the right weapon at the right defensive
  state is the decision — strip a shield with the laser (which **fritzes** it down for two phases), then
  crater the exposed hull with the cannon; cannon-first wastes shots on the shield. Every magnitude is a
  literal on the component (ships ↛ encounter); the asymmetry is the per-band `effByKey` effectiveness and
  the shield is worked example **E** above. End-to-end in `test/dynamic-combat.test.ts`. The damage
  numbers are still PLACEHOLDER (no formula, no PRNG) — this proves the *mechanic shape*, the real damage
  formula (timing / typing / boost) is the P-Experiment phase. Design: `plans/4x-encounter-combat-system.md`.
- **E3 — the mode (shipped).** Combat runs as a MODE on `SystemScene`, in place over the same diagram
  (no second scene — combat is an extra render PASS). `EncounterController` (`src/scene/encounter-
  controller.ts`) owns the transient `EncounterState` + its own overlay scene; `CombatOverlay`
  (`encounter-overlay.ts`) paints a bordered HP bar (hull + shield bands), an active-turn marker, and
  a downed dim over each combatant, anchored to the live fleet slots via `slotCenterForEntity`. The
  galaxy turn freezes on BOTH paths — a `freezesTurn` getter backed by an `inEncounter` flag (since
  `Screen.freezesTurn` is `readonly`) for the programmatic `nextTurn()`, and `setNextTurnEnabled(false)`
  for the user click. The system-view **back button** greys out too (`SystemHud.setBackEnabled(false)`) —
  combat runs to its terminal, so neither Next Turn nor Back leaves the view mid-fight. `onEnterEncounter`
  is un-stubbed: a confirmed `'encounter'`-kind action builds
  the spec via `buildEncounterSpec(shipsToCombatants(readyShips()), intent)` and enters — `enter` then
  **fires that launching `intent`** (`spec.initiator`) as the initiator's opening move, so entering combat
  and the first shot are ONE beat: the attack that triggered the encounter also lands (with its animation +
  effects), not a no-op that merely opens the mode. A DEV
  spectator auto-play drives the reducer to side-elimination; the terminal exits and unfreezes (there is
  no flee — combat runs to its resolution). A DEV `?demo-encounter` boot path makes the chrome
  reproducibly screenshot-able.
- **E4 — the interactive loop (shipped), Press-Turn.** The same `SystemActionMenu` drives the round: an
  `onEncounterCommit` sink + `setEncounterMode` flip its `dispatch()` from the live-view kind fork into
  the reducer. `EncounterController` opens the menu on the active **CONTROLLED** combatant (its derived
  loadout + seeded `energy`/`energyMax` gate, anchored by durable id), folds a confirm through
  `applyCommand`, and REOPENS on the new `activeId`. Because the reducer keeps `activeId` on the
  controlled side until its icons are spent, the menu **stays on your side across multiple activations**
  within the phase; the fleet-scoped **End Round** (`endPhase`, forfeit + pass) fires from **`R`** OR the
  bar's **End Turn** button (EB). A phase **opens on a ship that can act** — `beginNextPhase` picks the
  lowest same-side ship that can afford an action (`firstActableOfSide`, run AFTER the phase-start
  recharge), falling back to the first living ship, so the cursor never lands on a drained ship while a
  charged same-side ship still waits.
  `CombatOverlay` paints each combatant's **HP + energy gauges** (hull/shield bands + the amber salvo
  bar) and the active-turn marker; the per-side **initiative readout** lives in the bottom **encounter
  bar** (EB, below). You command only your side — an opponent's phase opens no menu and is auto-driven by
  the **AI policy** (`ai.ts`, §3.7 — a fleet-aware focus-fire driver): it **loops one activation per interval
  until its pool is spent**, each interval firing whichever same-side ship can afford a salvo at the weakest
  living enemy, and ending its phase if stranded. There is **no flee** — once in, ships fight to the
  terminal: side-elimination / mutual-disengage auto-exit (no menu action or key withdraws).
- **Free in-phase actor choice (shipped), §3.8.** You spend your initiative across **any** of your living
  same-side actors, in any order — not a forced round-robin. `selectActor(state, combatId)` (`step.ts`) is
  a pure cursor move (no icon spent, no turn-start tick — recharge folds per-SIDE at phase start, decoupled
  from which actor you pick; energy + availability still gate each ACTION via the menu's greyed rows); `neighborActor`
  (`turn-order.ts`) is the ◄ ► ring. `EncounterController.cycleActor` / `selectActorByEntityId` re-anchor
  the menu + the active-turn marker onto the chosen actor — **both ◄ ► (category-level) and a click on a
  friendly combatant** work, routed from `SystemScene` (`onCycleActor` → `cycleActor`; the in-encounter
  pointer path). The round-robin (`nextActor`) is now just the reducer's post-action DEFAULT cursor; both the
  player and the opponent AI override it (via the same `selectActor`) to choose which same-side ship acts.
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
- **EB — the encounter bar + energy (shipped), §15.** The PROMINENT per-side readout: a bottom
  **encounter bar** (`src/ui/encounter-hud/`, a `ui/` HUD reading `encounter/` DTOs — controlled side
  LEFT, opponent RIGHT, their initiative pips meeting at a center divider and dimming as spent, the
  acting side lit + ship counts). It **supersedes** `CombatOverlay`'s old top-left corner pip strip
  (removed); the overlay keeps the per-sprite gauges, now HP **plus a NEW energy bar** (amber,
  `stats.energy/energyMax`). The **energy slice** makes that gauge live: `small-laser` carries a real
  `costPerUnit` matched to its own `battery`, and a combatant's `energyMax` is DERIVED as the Σ of its
  loadout's component batteries (`combatantEnergyMax`, seeded by `createEncounterState` as both the cap
  and a charged start) — so a single-laser ship's full charge fires exactly ONE salvo. `applyCommand`
  deducts the cost, and the opponent auto-driver only fires what it can afford — so a shot drains the bar and
  the engine's `recharge` refills it ~⅓ at each of its side's phase starts. The fleet baseline lifts in-encounter (`setBottomReserve`)
  to clear the band. The bar carries ONE interactive element — a centered **End Turn** button
  (`end-turn-button.ts`, the click-twin of `R`'s End Round, shown only on the controlled side's phase) that
  **blinks gold** when no living controlled ship has an affordable, target-having action
  (`controlledHasAnyAction`) — the suggested move; the rest of the band stays display-only (`hitTest`
  opaque). Owned + repainted by the controller; the blink is a cheap per-frame texture swap (not a bar
  repaint), and the bar reserves a center plaza so pips never run under the button.
- **E5 — body combatants.** The `body-role` producer + appending body-combatants to the spec.

Until ship *movement* exists, opponents are placed by a DEV-only spawn action; the single
`EncounterSpec` contract means combat is authored against the durable `GameState.ships` and won't
diverge from the movement system when it lands.

## Tests

`npm run test:encounter` (co-located in `test/`, run under `node --test`).
