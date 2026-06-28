// fold — the pure effect machinery on the unified lifecycle model (./types). collectInstalls is the
// deriveCommands twin (gather declared installs); installEffects MINTS instances + runs their `install`
// handler; tickTurnStart runs an owner's `turnStart` handlers at its turn start (and counts a timed
// instance down, running `expire` as it drops); foldPhaseStart runs a side's `phaseStart` handlers when
// its Press-Turn phase begins. ALL of them route a handler's returned outcomes through ONE applier
// (applyOutcome) that dispatches by outcome.kind — stat → bag, pool → stack, side → tempo. No per-
// effect-type branch anywhere; a def's `on` map is read by phase PRESENCE, exactly as deriveCommands
// reads grants. Pure: reads the effect registry + the state/pool leaves + the initiative floor.

import { EFFECT_BY_KEY } from './registry.ts';
import type { ActiveEffect, EffectInstall, EffectOutcome, PoolEdit, StatDelta } from './types.ts';
import type { Combatant, EncounterEvent, EncounterState } from '../state.ts';
import { isDown, withPools, withStat } from '../state.ts';
import { cascadeDamage, dropPoolsBySource, restorePoolsBySource, splicePool, type Pool } from '../pools.ts';
import { MIN_INITIATIVE } from '../tuning.ts';

// The pure twin of deriveCommands: flatMap every provider's declared installs. A provider with no
// installs (most components) is a no-op, exactly as a grantless provider is in deriveCommands.
export function collectInstalls(
  providers: readonly { readonly installs?: readonly EffectInstall[] }[],
): readonly EffectInstall[] {
  return providers.flatMap((p) => p.installs ?? []);
}

// One mint request: an install plus WHO owns it and WHO sourced it. A build-time mint is self-sourced
// (owner === source === the combatant carrying the component); an on-resolve mint sources from the
// caster (slice 2's shield is self-targeting, so owner === source === the caster there too — a
// non-self install threads ownerId from the target when that lands).
export interface MintRequest {
  readonly install: EffectInstall;
  readonly ownerId: number;
  readonly sourceId: number;
}

// The slice of EncounterState a mint touches — threaded so the SINGLE monotonic `nextEffectId` counter
// is shared by both mint sites (build + on-resolve) and ids can never collide after a drop.
export interface EffectsSlice {
  readonly combatants: readonly Combatant[];
  readonly effects: readonly ActiveEffect[];
  readonly nextEffectId: number;
}

// What applying ONE outcome produced: the (possibly) updated roster, any side-pool delta it asked for
// (stat/pool outcomes contribute 0; the caller folds these into the right side), and the renderer beat
// a real stat change emits (pool/side changes are beat-less here — install/expire beats are the
// caller's, and the side-pool readout is the observable for tempo).
interface OutcomeResult {
  readonly combatants: readonly Combatant[];
  readonly sideDelta: number;
  readonly event?: EncounterEvent;
}

// Apply one STRUCTURAL PoolEdit to a band stack: 'splice' stamps the owning effect's id onto the new
// band (so its later `expire` can find exactly its own band) and inserts it; 'drop' removes the expiring
// effect's band(s). The 'damage' op is handled in applyOutcome (it needs the cascade's `dealt` to emit
// the hit event), so it never reaches here — the type excludes it.
function applyPoolEdit(pools: readonly Pool[], edit: Exclude<PoolEdit, { op: 'damage' }>, effectId: number): readonly Pool[] {
  switch (edit.op) {
    case 'splice':
      return splicePool(pools, { ...edit.pool, sourceEffectId: effectId }, edit.aboveKey);
    case 'drop':
      return dropPoolsBySource(pools, effectId);
    case 'restore':
      return restorePoolsBySource(pools, effectId, edit.amount);
  }
}

// Apply one StatDelta to a combatant, clamped; returns the updated combatant + the amount ACTUALLY
// applied (0 when a clamp swallowed it — e.g. recharge at full energy), so the caller emits an event
// only on a real change. Integer-milli. statKey resolves ONLY against the opaque stat bag (energy lives
// there); pool-stack HP is changed via PoolEdit + the damage cascade, never here.
function applyDelta(combatant: Combatant, d: StatDelta): { readonly combatant: Combatant; readonly applied: number } {
  const current = combatant.stats?.[d.statKey] ?? 0;
  let next = current + d.delta;
  if (d.clampToMaxKey !== undefined) {
    const max = combatant.stats?.[d.clampToMaxKey];
    if (max !== undefined) next = Math.min(next, max);
  }
  if (d.clampToZero) next = Math.max(0, next);
  const applied = next - current;
  return applied === 0 ? { combatant, applied: 0 } : { combatant: withStat(combatant, d.statKey, next), applied };
}

// THE dispatch — route one outcome to its applier by `kind`. The single place the substrate fans a
// declared change out to the right tier: a stat-bag write (emitting an `effect` beat on a real change),
// a pool-stack edit, or a side-pool delta (returned for the caller to fold into the owner's side). Every
// lifecycle runner calls this, so adding an outcome kind is one case here, not a change at each site.
function applyOutcome(
  combatants: readonly Combatant[],
  ownerId: number,
  sourceId: number,
  outcome: EffectOutcome,
  effectKey: string,
  effectId: number,
): OutcomeResult {
  const owner = combatants[ownerId];
  if (!owner) return { combatants, sideDelta: 0 };
  switch (outcome.kind) {
    case 'stat': {
      const { combatant, applied } = applyDelta(owner, outcome);
      if (applied === 0) return { combatants, sideDelta: 0 };
      return {
        combatants: combatants.map((c, i) => (i === ownerId ? combatant : c)),
        sideDelta: 0,
        event: { kind: 'effect', combatId: ownerId, effectKey, statKey: outcome.statKey, delta: applied },
      };
    }
    case 'pool': {
      if (outcome.op === 'damage') {
        // Cascade the hit top→bottom (./pools): shields absorb before hull purely by stack order. `dealt`
        // is HP ACTUALLY removed (≤ Σ current), so the event never reports more than existed and an
        // unpooled/already-0 target takes a visible 0-damage hit (the reducer stays total). The attacker
        // is the effect's `sourceId` (the damage event's `source`, anchoring the tracer source→target);
        // carried for the same reason ActiveEffect.sourceId is — reflect/lifesteal need no later change.
        const { pools, dealt } = cascadeDamage(owner.pools ?? [], outcome.amount, outcome.effByKey);
        return {
          combatants: combatants.map((c, i) => (i === ownerId ? withPools(owner, pools) : c)),
          sideDelta: 0,
          event: { kind: 'damage', source: sourceId, target: ownerId, amount: dealt },
        };
      }
      const pools = applyPoolEdit(owner.pools ?? [], outcome, effectId);
      return { combatants: combatants.map((c, i) => (i === ownerId ? withPools(owner, pools) : c)), sideDelta: 0 };
    }
    case 'side':
      return { combatants, sideDelta: outcome.initiative };
  }
}

// Mint each request, run its `install` handler outcomes against the owner, and emit the resulting beats.
// Both mint sites call this — createEncounterState's build pass (which discards events) and applyCommand's
// on-resolve pass (which keeps them). A request that PERSISTS (remaining ≠ 0) becomes an ActiveEffect with
// a MONOTONIC id and emits an `install` chip-up beat; a ONE-SHOT (remaining 0, a hit) applies its outcomes
// but is never registered and gets no chip-up beat (its own beat — the `damage` event — is the beat), so it
// draws no id. A SideDelta at install is ignored: a side buff folds at the SIDE's phase start (phaseStart),
// not at the instant a permanent carrier is registered. The `down` beat is the state-transition consequence
// of a hit (only a damage outcome can cross a combatant to 0 HP) — emitted here, uniform whether the hit
// came from an on-resolve weapon or a future DoT install. Pure; returns the updated slice + the events.
export function installEffects(
  slice: EffectsSlice,
  requests: readonly MintRequest[],
): { readonly slice: EffectsSlice; readonly events: readonly EncounterEvent[] } {
  let combatants = slice.combatants;
  const effects = [...slice.effects];
  const events: EncounterEvent[] = [];
  let nextEffectId = slice.nextEffectId;
  for (const { install, ownerId, sourceId } of requests) {
    const persists = install.remaining !== 0; // a one-shot hit (0) never rides on, so draws no id
    const id = persists ? nextEffectId++ : -1;
    const before = combatants[ownerId];
    const wasUp = before !== undefined && !isDown(before);
    if (persists) {
      effects.push({ id, key: install.effectKey, ownerId, sourceId, remainingCycles: install.remaining, params: install.params });
    }
    const handler = EFFECT_BY_KEY.get(install.effectKey)?.on?.install;
    if (handler && combatants[ownerId]) {
      for (const outcome of handler({ params: install.params, owner: combatants[ownerId]! })) {
        const r = applyOutcome(combatants, ownerId, sourceId, outcome, install.effectKey, id);
        combatants = r.combatants;
        if (r.event) events.push(r.event); // the damage / stat-change beat, uniform across runners
      }
    }
    if (persists) events.push({ kind: 'install', combatId: ownerId, effectKey: install.effectKey, effectId: id });
    const after = combatants[ownerId];
    if (wasUp && after !== undefined && isDown(after)) events.push({ kind: 'down', combatId: ownerId });
  }
  return { slice: { combatants, effects, nextEffectId }, events };
}

// Tick the active combatant's `turnStart` handlers (its OWN turn start, §3.2/§3.8.5): run each in install
// order through applyOutcome (a recharge tops a stat; a future DoT could also pool/side), then count
// down timed instances. On the cycle a timed instance reaches 0 it ticks its turnStart FIRST (the final
// tick), then runs `expire` against the evolving owner and is dropped; permanent effects ride on. Any
// SideDelta a turnStart returns folds into the OWNER'S side pool (clamped at the floor). Pure — returns
// the next state + the events the renderer animates.
export function tickTurnStart(
  state: EncounterState,
  actorId: number,
): { readonly state: EncounterState; readonly events: readonly EncounterEvent[] } {
  const events: EncounterEvent[] = [];
  let combatants = state.combatants;
  let sideDelta = 0;
  const surviving: ActiveEffect[] = [];
  for (const effect of state.effects) {
    if (effect.ownerId !== actorId) {
      surviving.push(effect); // someone else's effect — untouched this tick
      continue;
    }
    const def = EFFECT_BY_KEY.get(effect.key);
    const turn = def?.on?.turnStart;
    if (turn && combatants[actorId]) {
      for (const outcome of turn({ params: effect.params, owner: combatants[actorId]! })) {
        const r = applyOutcome(combatants, actorId, effect.sourceId, outcome, effect.key, effect.id);
        combatants = r.combatants;
        sideDelta += r.sideDelta;
        if (r.event) events.push(r.event);
      }
    }
    // Count down a timed instance; a permanent one (−1) rides on unchanged.
    if (effect.remainingCycles > 0) {
      const remainingCycles = effect.remainingCycles - 1;
      if (remainingCycles > 0) {
        surviving.push({ ...effect, remainingCycles }); // still ticking
      } else {
        // Expiring THIS cycle (after its final turnStart): run `expire` against the OWNER as the tick has
        // left it (so a same-tick recharge change isn't clobbered), emit the chip-down beat, then drop.
        const expire = def?.on?.expire;
        if (expire && combatants[actorId]) {
          for (const outcome of expire({ params: effect.params, owner: combatants[actorId]! })) {
            ({ combatants } = applyOutcome(combatants, actorId, effect.sourceId, outcome, effect.key, effect.id));
          }
        }
        events.push({ kind: 'expire', combatId: actorId, effectKey: effect.key, effectId: effect.id });
      }
    } else {
      surviving.push(effect); // permanent
    }
  }
  let initiative = state.initiative;
  if (sideDelta !== 0) {
    const side = combatants[actorId]?.factionId;
    // Clamp the LIVE spend-down pool at 0, NOT at MIN_INITIATIVE: a mid-phase turnStart SideDelta must
    // not resurrect a spent pool (a negative debuff should be able to drive a side to 0). The
    // MIN_INITIATIVE floor is a phase-OPENING guarantee and lives only in foldPhaseStart's base derive.
    if (side) initiative = { ...initiative, [side]: Math.max(0, state.initiative[side] + sideDelta) };
  }
  return { state: { ...state, combatants, effects: surviving, initiative }, events };
}

// Fold a side's `phaseStart` handlers when its Press-Turn phase begins (§3.8.2): run every LIVING
// same-side carrier's phaseStart outcomes through applyOutcome — SideDeltas sum into the side's pool
// (the tempo contribution, e.g. tactical-command), and any stat/pool outcomes apply per owner. PRESENCE
// stacking counts a presence-effect ONCE per side however many carriers hold it (presence-not-count);
// 'sum' effects contribute per instance. The pool is set to max(MIN_INITIATIVE, currentBase + Σ
// SideDeltas) — the caller seeds `initiative[side]` to the fleet base first, this adds the effect tier.
export function foldPhaseStart(
  state: EncounterState,
  side: EncounterState['phaseSide'],
): { readonly state: EncounterState; readonly events: readonly EncounterEvent[] } {
  let combatants = state.combatants;
  const events: EncounterEvent[] = [];
  let sideDelta = 0;
  const countedPresence = new Set<string>();
  for (const effect of state.effects) {
    const owner = combatants[effect.ownerId];
    if (!owner || owner.factionId !== side || isDown(owner)) continue; // living same-side carriers only
    const def = EFFECT_BY_KEY.get(effect.key);
    const handler = def?.on?.phaseStart;
    if (!handler) continue;
    // presence-not-count gates ONLY the side-aggregate channel: a 'presence' effect's SideDelta counts
    // once per key per side, but its per-OWNER outcomes (stat/pool) still apply for every living carrier
    // (the EffectStacking contract). So we run the handler for every carrier and only suppress the
    // SideDelta on the 2nd+ presence carrier.
    const presence = def?.stacking === 'presence';
    const countSide = !presence || !countedPresence.has(effect.key);
    if (presence) countedPresence.add(effect.key);
    for (const outcome of handler({ params: effect.params, owner })) {
      const r = applyOutcome(combatants, effect.ownerId, effect.sourceId, outcome, effect.key, effect.id);
      combatants = r.combatants;
      if (countSide) sideDelta += r.sideDelta;
      if (r.event) events.push(r.event);
    }
  }
  const pool = Math.max(MIN_INITIATIVE, state.initiative[side] + sideDelta);
  return { state: { ...state, combatants, initiative: { ...state.initiative, [side]: pool } }, events };
}
