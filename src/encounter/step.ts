// step — the pure combat reducer (the bones core, §3.3, now on the Press-Turn round structure §3.8).
// `createEncounterState` seeds the initial state from a launch spec; `applyCommand` folds one committed
// intent into a new state + the events the renderer animates; `endPhase` ends the active side's phase
// (the fleet-scoped End Round / auto-pass). ZERO gameplay math: a flat placeholder hit stands in for
// the deferred damage model, so the loop reads as combat with no committed formula and no PRNG (§0,
// §6.4) — no float reaches here. The reducer is the single source of truth and the (later) AI/replay
// path; the UI only produces intents and reads state.
//
// The turn model is per-SIDE Press-Turn initiative (§3.8): a side spends one icon per action across any
// of its ships (turn-order's within-side walk) until its pool is spent or it ends its phase, then the
// phase passes to the next side, whose pool is re-derived from its living roster (I5). One full pass is
// a `round`. Initiative (the side's activation budget) is orthogonal to energy (the per-ship salvo
// gate, §3.8.5) — the recharge effect folds at the SIDE's phase start, topping up all its ships at once.

import type { ActionIntent } from '../actions/types.ts';
import { commandFor } from '../actions/derive.ts';
import { CONTROLLED_FACTION_ID } from '../factions/registry.ts';
import type { EncounterSpec } from './encounter-spec.ts';
import type { EncounterEvent, EncounterState, Combatant } from './state.ts';
import { ENERGY_MAX_STAT, ENERGY_STAT, isDown, withPools, withStat } from './state.ts';
import { HULL_POOL, cascadeDamage } from './pools.ts';
import { combatantEnergyMax, combatantInstalls, combatantInstallsOnResolve } from './ships-to-combatants.ts';
import { foldPhaseStart, installEffects, tickTurnStart, type MintRequest } from './effects/fold.ts';
import { firstActableOfSide, firstLivingOfSide, nextActor, nextLivingSide } from './turn-order.ts';
import { baseSideInitiative, zeroInitiative } from './initiative.ts';
import { PLACEHOLDER_DAMAGE_MILLI, PLACEHOLDER_HULL_MILLI } from './tuning.ts';

type StepResult = { readonly state: EncounterState; readonly events: readonly EncounterEvent[] };

// Stamp the combat profile onto a combatant: a single `hull` POOL to deplete (the bottom band of the
// cascade stack — still a placeholder magnitude until the multi-pool HP model lands), and a charged
// energy bar (energy = energyMax) in the opaque stat bag, energyMax now DERIVED as the Σ of the
// loadout's component batteries (combatantEnergyMax). The effect-free adapter ships neither — this is
// what makes the bones loop killable and gives the engine's recharge effect something to top up.
function seedCombatant(combatant: Combatant): Combatant {
  const energyMax = combatantEnergyMax(combatant);
  return {
    ...combatant,
    pools: [{ key: HULL_POOL, current: PLACEHOLDER_HULL_MILLI, max: PLACEHOLDER_HULL_MILLI }],
    stats: {
      ...combatant.stats,
      [ENERGY_STAT]: energyMax, // charged start
      [ENERGY_MAX_STAT]: energyMax,
    },
  };
}

// Seed the initial state from the launch spec: seed every combatant's placeholder profile, then mint
// the PERMANENT effects its components declare (installEffects, the deriveCommands twin) through the one
// monotonic id counter the on-resolve path also draws from — so a later resolve-mint can never collide
// with a build id. The mint's install events are discarded (the opening loadout is not a renderer beat).
// The attacker (`initiator`) opens the first phase (I7/I12): `phaseSide` + `initiatorSide` are its side,
// and `initiative` is seeded from the spec's opening pool. The first actor does NOT tick its cycle-start
// effects (a charged start); every later activation does.
export function createEncounterState(spec: EncounterSpec): EncounterState {
  const seeded = spec.combatants.map(seedCombatant);
  const requests: MintRequest[] = seeded.flatMap((c) =>
    combatantInstalls(c).map((install) => ({ install, ownerId: c.combatId, sourceId: c.combatId })));
  const { slice } = installEffects({ combatants: seeded, effects: [], nextEffectId: 0 }, requests);
  const initiator = slice.combatants.find((c) => c.id === spec.initiator.actorId);
  const activeId = initiator?.combatId ?? 0;
  // The immutable round anchor. Fall back deterministically for a degenerate initiatorless/empty roster
  // (instantly terminal anyway), so the field is always a concrete FactionType.
  const initiatorSide =
    initiator?.factionId ?? slice.combatants[activeId]?.factionId ?? spec.sides[0]?.factionId ?? CONTROLLED_FACTION_ID;
  // Seed every present side's pool to its fleet BASE. The entering side RE-folds on its phase
  // (beginNextPhase), adding effect SideDeltas; so an OFF-phase side's pip row is a fleet-base forecast
  // that omits its effect tier (e.g. a tactical-command +1) and any attrition until its phase opens —
  // the active side's count is always exact.
  const initiative = zeroInitiative();
  for (const side of spec.sides) initiative[side.factionId] = baseSideInitiative(side.combatants);
  const opening: EncounterState = {
    combatants: slice.combatants,
    activeId,
    round: 1,
    effects: slice.effects,
    nextEffectId: slice.nextEffectId,
    initiative,
    phaseSide: initiatorSide,
    initiatorSide,
    damageThisRound: false,
    disengaged: false,
  };
  // Open the initiator's phase: fold its phaseStart effect SideDeltas (e.g. tactical-command) onto its
  // fleet base. The opening fold's beats are discarded (not a renderer beat); the first ACTOR still gets
  // a charged start (no turnStart tick) — phaseStart is the SIDE's phase opening, distinct from a turn.
  return foldPhaseStart(opening, initiatorSide).state;
}

// Fold one committed intent into the next state. The bones read the actor's own resolved command (no
// central lookup): an ATTACK cascades the flat placeholder hit through each named target's pool stack
// (shields absorb before hull, purely by stack order); a command may ALSO install timed effects on
// resolve (a self shield); anything else (a support verb like raise-shields) simply passes the activation
// (there are no navigation actions — no flee). The action spends ONE initiative icon (§3.8.3), then the turn
// advances (advanceTurn): within the side's phase while icons + a living ship remain, else to the next
// side's phase.
export function applyCommand(state: EncounterState, intent: ActionIntent): StepResult {
  const actor = state.combatants.find((c) => c.id === intent.actorId);
  const command = actor ? commandFor(actor, intent.actionId) : undefined;
  if (import.meta.env?.DEV) {
    if (!actor) throw new Error(`[encounter] intent actor ${intent.actorId} is not on the roster`);
    if (actor.combatId !== state.activeId) {
      throw new Error(`[encounter] intent actor ${intent.actorId} is not the active combatant ${state.activeId}`);
    }
    if (!command) throw new Error(`[encounter] actor ${intent.actorId} does not carry action ${intent.actionId}`);
  }
  // A malformed intent (no such actor, or the actor lacks that action) is a strict NO-OP: it must NOT
  // spend an initiative icon or advance the turn. The reducer is the AI/replay source of truth, so a
  // stale/garbage intent silently draining tempo or skipping a phase would be a determinism desync.
  // DEV threw above; prod returns the state untouched.
  if (!actor || !command) return { state, events: [] };

  const events: EncounterEvent[] = [];
  let combatants = state.combatants;
  let effects = state.effects;
  let nextEffectId = state.nextEffectId;
  let dealtDamage = false;

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
      if (dealt > 0) dealtDamage = true; // a real hit keeps the round off the mutual-disengage terminal
      if (isDown(after)) events.push({ kind: 'down', combatId: target.combatId });
    }
  }

  // On-resolve mint — runs UNCONDITIONALLY for the resolved command (a future weapon could both hit AND
  // self-buff). Slice 2 is self-target only: owner === source === the acting combatant, asserted so a
  // non-self install can't silently land on the caster before its ownership threading is built.
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

  // Spend the salvo's energy (§3.8.5): the command's totalCost leaves the ACTING ship's energy bag,
  // clamped at 0 — the per-ship salvo gate. The menu already greys an unaffordable command
  // (energy >= totalCost) and the opponent auto-driver only picks one it can afford, so a committed
  // action is normally affordable; the clamp guards a future non-menu intent, and a 0-cost command (no
  // energy model yet) is a pass-through. Find the actor in the LATEST combatants (a self-effect resolve
  // above may have replaced it), keyed by combatId.
  if (command.totalCost > 0) {
    const aIdx = combatants.findIndex((c) => c.combatId === actor.combatId);
    const acting = combatants[aIdx];
    if (acting) {
      const spent = Math.max(0, (acting.stats?.[ENERGY_STAT] ?? 0) - command.totalCost);
      combatants = combatants.map((c, i) => (i === aIdx ? withStat(acting, ENERGY_STAT, spent) : c));
    }
  }

  // The action spent one initiative icon (§3.8.3) — flat per activation — and its salvo's energy
  // (above). Initiative is the SIDE's tempo budget; energy is the per-ship salvo gate (§3.8.5),
  // recharged at its SIDE's phase start (foldPhaseStart — all the side's ships at once), not here. Orthogonal.
  const initiative = { ...state.initiative, [state.phaseSide]: Math.max(0, state.initiative[state.phaseSide] - 1) };
  const advanced: EncounterState = {
    ...state,
    combatants,
    effects,
    nextEffectId,
    initiative,
    damageThisRound: state.damageThisRound || dealtDamage,
  };
  return advanceTurn(advanced, events);
}

// End the active side's phase: the fleet-scoped End Round (§3.8.3), or an auto-pass when the side is
// stranded (icons left but no action it can/will take — never a soft-lock). Its remaining icons are
// FORFEITED (lost, no banking, I6) by zeroing the pool, so the phase passes via the same advanceTurn
// path an action's last icon takes. The forfeited count is observable as `state.initiative[phaseSide]`
// at call time — the reserved seam (§3.8.4) for a future "forfeit → energy" component. NOT a per-ship
// Pass: it's a side-level move that does not act with any ship.
export function endPhase(state: EncounterState): StepResult {
  const advanced: EncounterState = { ...state, initiative: { ...state.initiative, [state.phaseSide]: 0 } };
  return advanceTurn(advanced, []);
}

// Re-point the active cursor to a chosen living combatant on the CURRENT phase side — the player's free
// in-phase actor choice (§3.8): you spend your initiative across whichever of YOUR actors you pick, in any
// order, not a forced round-robin. A pure CURSOR move — it spends NO icon and ticks NO turn-start effect
// (selection is not an activation; recharge is decoupled from activation — it folds at the SIDE's phase
// start for ALL its ships (foldPhaseStart, §3.8.5), so free in-phase actor choice never changes who or
// when recharges). An
// illegal pick (out of range, an enemy, or a downed ship) returns the state UNCHANGED by reference, so a
// stale/garbage selection can't desync the reducer (the AI/replay source of truth). Energy + action
// availability still gate each ACTION (applyCommand / the menu's greyed rows) — selecting a tapped-out
// ship is allowed; acting with it is not.
export function selectActor(state: EncounterState, combatId: number): EncounterState {
  if (combatId === state.activeId) return state;
  const c = state.combatants[combatId];
  if (!c || c.factionId !== state.phaseSide || isDown(c)) return state;
  return { ...state, activeId: combatId };
}

// Advance off the (possibly mutated) roster. Stay in the active side's phase while it holds an icon AND
// a living ship to offer (nextActor); otherwise hand the phase to the next living side (beginNextPhase).
// The combatant we land on ticks its own turn-start effects (timed-effect countdown — recharge now folds
// per-SIDE at phase start (§3.8.5), NOT per activation), so a just-downed combatant is never offered, and
// a re-activated ship does not re-recharge mid-phase. When no other side can act the
// encounter is terminal (./terminal) — hold the cursor and skip the tick. Shared by applyCommand/endPhase.
function advanceTurn(state: EncounterState, events: readonly EncounterEvent[]): StepResult {
  const next = nextActor(state);
  if (next !== undefined) {
    const ticked = tickTurnStart({ ...state, activeId: next }, next);
    return { state: ticked.state, events: [...events, ...ticked.events] };
  }
  const phase = beginNextPhase(state);
  if (phase === null) {
    return { state, events };
  }
  // The phase transition's own beats (a phaseStart regen/chip) come before the opening combatant's
  // turn-start beats — the side's phase opens, then its first ship's turn does.
  const ticked = tickTurnStart(phase.state, phase.state.activeId);
  return { state: ticked.state, events: [...events, ...phase.events, ...ticked.events] };
}

// Open the next living side's phase: re-derive its icon pool from its LIVING roster (I5 — attrition
// lowers tempo), open on its lowest-combatId living ship, and bump `round` when the phase wraps back to
// the initiator's side (a full pass completed, §3.8.1). At that wrap, latch the mutual-disengage
// terminal if the round that just ended dealt no damage (§8.4), and reset the per-round accumulator
// either way. Returns null when no other side can act — side-elimination, the encounter is terminal.
//
// ROUND ANCHOR — assumes ≤2 living sides (true today: FactionType is 'player'|'rival', and in a 2-side
// fight the initiator's elimination IS side-elimination, so the wrap-on-`initiatorSide` cadence always
// resolves). For a 3+ side fight where the initiator is eliminated mid-fight, `nextSide` would never
// again equal `initiatorSide`, freezing `round`/`damageThisRound`/`disengaged`. When a third faction is
// added, anchor the round on an "every living side has taken a phase" set rather than the fixed
// initiator, and add an N-side test.
function beginNextPhase(state: EncounterState): StepResult | null {
  const nextSide = nextLivingSide(state);
  if (nextSide === undefined) return null;
  // Provisional opener — only confirms the side fields a living ship before we recharge; the FINAL opener
  // is re-picked below, after foldPhaseStart tops energy up.
  const opener = firstLivingOfSide(state.combatants, nextSide);
  if (opener === undefined) return null;
  const base = baseSideInitiative(state.combatants.filter((c) => c.factionId === nextSide));
  const wrapped = nextSide === state.initiatorSide;
  const opened: EncounterState = {
    ...state,
    phaseSide: nextSide,
    activeId: opener,
    initiative: { ...state.initiative, [nextSide]: base },
    round: state.round + (wrapped ? 1 : 0),
    disengaged: state.disengaged || (wrapped && !state.damageThisRound),
    damageThisRound: wrapped ? false : state.damageThisRound,
  };
  // Fold the entering side's phaseStart effect SideDeltas onto its fleet base (tactical-command, future
  // buffs/debuffs), re-derived from the LIVING roster (I5) — the dynamic, lifecycle-driven pool. Recharge
  // also lands here (small-engine's phaseStart energy), so it must run BEFORE we choose the opener.
  const folded = foldPhaseStart(opened, nextSide);
  // OPEN the phase on the lowest same-side ship that can actually act (afford a command) given the just-
  // recharged energy — so the cursor never lands on a drained ship while a charged one waits (§3.8). A
  // fully-spent side has no actable ship: fall back to the provisional opener (the phase is a forfeit).
  const activeId = firstActableOfSide(folded.state.combatants, nextSide) ?? opener;
  return { state: { ...folded.state, activeId }, events: folded.events };
}
