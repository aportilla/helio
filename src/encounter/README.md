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

The stat block is an **opaque, effect-free bag** and the command list carries no effect data — the
bones know neither what a stat means nor what a command does. Health (an ordered pool stack) and the
energy gate live behind that seam and arrive with the effect substrate, additively; the combatant
shape stays stable while the mechanics stay fluid.

## Boundary

A combat-**rules** leaf. The DTOs the reducer / HUD read live here (or in `src/actions/` or
`src/ui/`), **never** under `src/scene/**` — a `ui/` surface reading a scene-declared type would
breach the verified `ui/ ↛ scene/` wall. This package imports only the action vocabulary and the
frozen faction / ship key types: no DOM, no catalog, no sim. The combat *renderer* (the encounter
mode on `SystemScene`) is the consumer, in `src/scene/`.

## Status

Built phase-by-phase; combat shares the "build the UX bones first, defer the mechanics" discipline
the rest of the project follows.

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
  clause is moot — the menu has no Pass verb). HP is a single placeholder `hull` *stat* here; the
  real ordered pool stack arrives with the effect substrate below, which is the first real mechanic
  that lands *on top of* this reducer — not before it.
- **The effect substrate (slice 1 shipped).** `effects/` is the fourth registry-family member: a
  provider DECLARES the effects it installs (`ShipComponentDef.installs?`) exactly as it declares
  grants, and the reducer FOLDS them by hook PRESENCE with no per-effect-type branch — `installEffects`
  (`collectInstalls` + `mintEffects`) is the pure twin of `deriveCommands`, and `tickCycleStart` runs
  each combatant's `onCycleStart` effects at its own turn start. Worked example A is live:
  `small-engine` declares a permanent `recharge` effect that tops energy toward `energyMax` each cycle
  — a declared component effect, not a hardcoded reducer step. Stacking is **distinct instances** (two
  of the same effect tick independently; a per-def override is deferred until content needs it).
  *Deferred to slice 2:* HP as an ordered **pool stack** (the absorb-before-hull cascade superseding
  the placeholder `hull` stat) with the `onInstall`/`onExpire` hooks, and worked example B — a timed
  shield via `installsOnResolve`.
- **E3 / E4 — the mode + the wire-up.** `SystemScene.enterEncounter` modality, then un-stubbing the
  `'encounter'` dispatch so a confirmed offensive action builds an `EncounterSpec` and the same
  anchored menu drives the round (its confirm sink swapped to the reducer). The first-playable beat.
- **E5 — body combatants.** The `body-role` producer + appending body-combatants to the spec.

Until ship *movement* exists, opponents are placed by a DEV-only spawn action; the single
`EncounterSpec` contract means combat is authored against the durable `GameState.ships` and won't
diverge from the movement system when it lands.

## Tests

`npm run test:encounter` (co-located in `test/`, run under `node --test`).
