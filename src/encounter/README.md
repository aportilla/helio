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

> **Branch:** the E1 / E2 / effect-substrate commits live on `encounter-e1-combatant-contract`, not
> yet merged to `main` — check that branch out before picking this up.
>
> **Next:** **E3/E4** (the scene wiring below). The headless reducer and the full effect substrate
> (pool-stack HP + the declared shield) are in and test-guarded, so E3/E4 renders the real pool HP
> from the start instead of a placeholder. (E5 body combatants can interleave.)

- **E1 — the contract (shipped).** `state.ts` (the `Combatant` union + `CombatantSide`),
  `encounter-spec.ts` (`EncounterSpec` + `buildEncounterSpec`), and `ships-to-combatants.ts` (the
  combat specialization of the fleet adapter). Pure and node-tested; nothing renders yet.
- **E2 — the headless reducer (shipped).** `state.ts` adds the stepped `EncounterState` + the
  `EncounterEvent` union; `step.ts` is the pure core — `createEncounterState(spec)` then
  `applyCommand(state, intent) → { state, events }` — with `turn-order.ts` (`nextActor`,
  round-robin by `combatId`), `terminal.ts` (`isTerminal`), and `tuning.ts` (placeholder magnitudes).
  Zero gameplay math: a **flat placeholder effect** subtracts a fixed `hull` amount and emits a
  `damage`/`down` event, so the loop reads as combat with no committed formula and no PRNG. The
  terminal is **side elimination** (a downed combatant offers no commands; the plan's "mutual-pass"
  clause is moot — the menu has no Pass verb). The attack path cascades the **pool stack** the effect
  substrate (below) added on top of this reducer — `createEncounterState` seeds each combatant a
  placeholder `hull` band; `dealt` (HP actually removed) drives the `damage` event.
- **The effect substrate (shipped).** `effects/` is the fourth registry-family member: a provider
  DECLARES the effects it installs exactly as it declares grants, and the reducer FOLDS them by hook
  PRESENCE with no per-effect-type branch — `installEffects` (`collectInstalls` + mint) is the pure
  twin of `deriveCommands`, and `tickCycleStart` runs each combatant's `onCycleStart` effects at its
  own turn start. HP is an ordered **pool stack** (`pools.ts`): a hit cascades top→bottom, so a shield
  is just a band spliced above `hull` and absorb-before-hull is pure stack order — no shield-specific
  reducer code. Two worked examples are live: **A** — `small-engine` declares a permanent `recharge`
  that tops energy toward `energyMax` each cycle (a declared component effect, not a hardcoded step);
  **B** — `small-shield` grants `raise-shields`, whose **`installsOnResolve`** (declared on the
  component def keyed by grant key — NOT on the neutral `ActionGrant`, which stays a pure leaf) mints a
  3-cycle `shield-segment`: its `onInstall` splices the band, the cascade absorbs into it first, its
  `onExpire` pops it. Both hooks RETURN a pool edit the fold applies (the `StatDelta` twin, never a
  void mutation), and effect ids are a **monotonic counter** so an on-resolve mint never reuses a
  freed id. Stacking is **distinct instances** (a re-cast is a second independent band).
- **E3 / E4 — the mode + the wire-up.** `SystemScene.enterEncounter` modality, then un-stubbing the
  `'encounter'` dispatch so a confirmed offensive action builds an `EncounterSpec` and the same
  anchored menu drives the round. The first-playable beat. Seams: the dispatch STUB is
  `onEnterEncounter` in `src/scene/system-scene.ts` (a DEV `console.debug`); the `grant.kind` fork is
  `dispatch()` in `src/scene/actions/system-action-menu.ts`. Two items are real NEW work, not config
  flips — `Screen.freezesTurn` is `readonly` (back it with a mode-flag getter), and there is no
  swappable confirm sink (the fork is hardwired to `onImmediate`/`onEnterEncounter`, so E4 must ADD a
  seam routing an in-encounter commit to `applyCommand`). Build the spec via
  `buildEncounterSpec(shipsToCombatants(readyShips()), intent)`; the combat menu opens on the SEEDED
  `EncounterState` combatant (it carries `energy`/`energyMax`, so the menu gate works) and reopens on
  each new `activeId`. Note `applyCommand` DEV-asserts the intent's actor is the active combatant.
- **E5 — body combatants.** The `body-role` producer + appending body-combatants to the spec.

Until ship *movement* exists, opponents are placed by a DEV-only spawn action; the single
`EncounterSpec` contract means combat is authored against the durable `GameState.ships` and won't
diverge from the movement system when it lands.

## Tests

`npm run test:encounter` (co-located in `test/`, run under `node --test`).
