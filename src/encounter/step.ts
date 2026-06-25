// step — the pure combat reducer (the bones core, §3.3). `createEncounterState` seeds the initial
// state from a launch spec; `applyCommand` folds one committed intent into a new state + the events
// the renderer animates. ZERO gameplay math: a flat placeholder hit (a fixed amount cascaded through
// the target's pool stack) stands in for the deferred damage model, so the loop reads as combat with
// no committed formula and no PRNG (§0, §6.4) — no float reaches here. The reducer is the single source
// of truth and the (later) AI/replay path; the UI only produces intents and reads state.

import type { ActionIntent } from '../actions/types.ts';
import { commandFor } from '../actions/derive.ts';
import type { EncounterSpec } from './encounter-spec.ts';
import type { Combatant, EncounterEvent, EncounterState } from './state.ts';
import { ENERGY_MAX_STAT, ENERGY_STAT, isDown, withPools } from './state.ts';
import { HULL_POOL, cascadeDamage } from './pools.ts';
import { combatantInstalls, combatantInstallsOnResolve } from './ships-to-combatants.ts';
import { installEffects, tickCycleStart, type MintRequest } from './effects/fold.ts';
import { nextActor } from './turn-order.ts';
import { PLACEHOLDER_DAMAGE_MILLI, PLACEHOLDER_ENERGY_MILLI, PLACEHOLDER_HULL_MILLI } from './tuning.ts';

// Stamp the bones placeholder profile onto a combatant: a single `hull` POOL to deplete (the bottom
// band of the cascade stack), and a charged energy bar (energy = energyMax) in the opaque stat bag.
// The effect-free adapter ships neither — this is what makes the bones loop killable and gives the
// engine's recharge effect something to top up. Real multi-pool HP + Σ-battery energyMax supersede
// these placeholders when those models land.
function seedCombatant(combatant: Combatant): Combatant {
  return {
    ...combatant,
    pools: [{ key: HULL_POOL, current: PLACEHOLDER_HULL_MILLI, max: PLACEHOLDER_HULL_MILLI }],
    stats: {
      ...combatant.stats,
      [ENERGY_STAT]: PLACEHOLDER_ENERGY_MILLI,
      [ENERGY_MAX_STAT]: PLACEHOLDER_ENERGY_MILLI,
    },
  };
}

// Seed the initial state from the launch spec: seed every combatant's placeholder profile, then mint
// the PERMANENT effects its components declare (installEffects, the deriveCommands twin) through the one
// monotonic id counter the on-resolve path also draws from — so a later resolve-mint can never collide
// with a build id. The mint's install events are discarded (the opening loadout is not a renderer beat).
// Open on the initiator (the attacker that launched the encounter) when resolvable, else combatId 0 —
// deterministic either way. The first actor does NOT tick its cycle-start effects (a charged start);
// every later turn does.
export function createEncounterState(spec: EncounterSpec): EncounterState {
  const seeded = spec.combatants.map(seedCombatant);
  const requests: MintRequest[] = seeded.flatMap((c) =>
    combatantInstalls(c).map((install) => ({ install, ownerId: c.combatId, sourceId: c.combatId })));
  const { slice } = installEffects({ combatants: seeded, effects: [], nextEffectId: 0 }, requests);
  const initiator = slice.combatants.find((c) => c.id === spec.initiator.actorId);
  return {
    combatants: slice.combatants,
    activeId: initiator?.combatId ?? 0,
    round: 1,
    effects: slice.effects,
    nextEffectId: slice.nextEffectId,
  };
}

// Fold one committed intent into the next state. The bones read the actor's own resolved command (no
// central lookup): an ATTACK cascades the flat placeholder hit through each named target's pool stack
// (shields absorb before hull, purely by stack order); a command may ALSO install timed effects on
// resolve (a self shield); anything else (navigation/support) simply passes the turn (flee-to-exit is
// the §5.5 escape, wired at E4). The turn then advances off the post-effect roster, and the combatant
// it lands on ticks its per-cycle effects (its turn start) — so a just-downed combatant is skipped and
// a cursor wrap bumps the round.
export function applyCommand(
  state: EncounterState,
  intent: ActionIntent,
): { readonly state: EncounterState; readonly events: readonly EncounterEvent[] } {
  const actor = state.combatants.find((c) => c.id === intent.actorId);
  if (import.meta.env?.DEV && actor && actor.combatId !== state.activeId) {
    throw new Error(`[encounter] intent actor ${intent.actorId} is not the active combatant ${state.activeId}`);
  }

  const events: EncounterEvent[] = [];
  let combatants = state.combatants;
  let effects = state.effects;
  let nextEffectId = state.nextEffectId;
  const command = actor ? commandFor(actor, intent.actionId) : undefined;

  if (actor && command) {
    if (command.grant.category === 'attack') {
      for (const targetId of intent.targetIds) {
        const idx = combatants.findIndex((c) => c.id === targetId);
        const target = combatants[idx];
        if (!target || isDown(target)) continue; // can't hit a missing or already-downed combatant
        // Cascade the hit top→bottom; `dealt` is HP actually removed (min of the hit and the stack's
        // total), so the event never reports more than existed and a no-pool target takes a visible
        // 0-damage hit and is never downed — the reducer stays total.
        const { pools, dealt } = cascadeDamage(target.pools ?? [], PLACEHOLDER_DAMAGE_MILLI);
        const after = withPools(target, pools);
        combatants = combatants.map((c, i) => (i === idx ? after : c));
        events.push({ kind: 'damage', source: actor.combatId, target: target.combatId, amount: dealt });
        if (isDown(after)) events.push({ kind: 'down', combatId: target.combatId });
      }
    }

    // On-resolve mint — runs UNCONDITIONALLY for the resolved command (a future weapon could both hit
    // AND self-buff), but only because commandFor confirmed the actor carries it. Slice 2 is self-target
    // only: owner === source === the acting combatant, asserted so a non-self install can't silently
    // land on the caster before its ownership threading is built.
    const onResolve = combatantInstallsOnResolve(actor, intent.actionId);
    if (onResolve.length > 0) {
      if (import.meta.env?.DEV && command.grant.targeting !== 'self') {
        throw new Error(`[encounter] installsOnResolve on non-self grant ${intent.actionId} not yet supported`);
      }
      const minted = installEffects(
        { combatants, effects, nextEffectId },
        onResolve.map((install) => ({ install, ownerId: actor.combatId, sourceId: actor.combatId })),
      );
      combatants = minted.slice.combatants;
      effects = minted.slice.effects;
      nextEffectId = minted.slice.nextEffectId;
      events.push(...minted.events);
    }
  }

  // Advance the turn off the (possibly mutated) roster. nextActor returns undefined only when no OTHER
  // combatant can act (the encounter is terminal) — then hold the cursor and skip the tick; otherwise a
  // wrap to a lower combatId means a new round, and the combatant we land on ticks its own per-cycle
  // effects (its turn start). (next can never equal activeId — the cursor excludes the active combatant
  // — so `<` alone detects the wrap.)
  const advanced: EncounterState = { combatants, activeId: state.activeId, round: state.round, effects, nextEffectId };
  const next = nextActor(advanced);
  if (next === undefined) {
    return { state: advanced, events };
  }
  const round = state.round + (next < state.activeId ? 1 : 0);
  const ticked = tickCycleStart({ combatants, activeId: next, round, effects, nextEffectId }, next);
  return { state: ticked.state, events: [...events, ...ticked.events] };
}
