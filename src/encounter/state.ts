// Combatant — the in-encounter actor contract, born here (E1) so the reducer (E2) imports it.
// Per the §0 re-scope the stat block is an opaque, extensible bag and the command list is
// effect-free: the bones do not know what a stat means or what a command does. A Combatant is
// therefore an `Actor` (the menu doc's shape — `commands` + opaque `stats` + category palette),
// EXTENDED with the combat identity the system view doesn't need (`combatId`, `factionId`, the
// per-kind anchor). Because it conforms to Actor, the SAME anchored `ActionMenu` opens on a
// combatant with no adapter — the seam that lets one menu drive both system-view selection and
// combat rounds. The combatant model stays stable while the mechanics stay fluid.
//
// A combat-rules leaf (mirrors the src/diagram-pick.ts hoist): the DTOs the reducer/HUD read live
// under src/encounter/, NEVER under src/scene/** (a ui/ surface reading a scene-declared type would
// breach the verified ui/ ↛ scene/ wall). It imports only the action vocabulary + the frozen
// faction/ship key types — no DOM, no catalog, no sim.

import type { FactionType } from '../factions/types.ts';
import type { ShipComponentType } from '../ships/components/types.ts';
import type { Actor } from '../actions/types.ts';
import type { ActiveEffect } from './effects/types.ts';
import type { Pool } from './pools.ts';

// The combat identity every combatant carries on top of being an Actor.
interface CombatantBase extends Actor {
  // A dense integer index into the spec's combatant array (combatId === index), assigned at
  // EncounterSpec build — ships first, body-combatants appended (E5). It is the turn-order
  // tiebreak (§3.2): `id` is the durable domain handle (a ship's save id), but `combatId` alone
  // breaks ties, so replay / AI ordering is deterministic and independent of the id strings.
  readonly combatId: number;
  // The owning side. "My side" is `factionId === CONTROLLED_FACTION_ID`; the JRPG party-vs-enemies
  // split and a command's target allegiance both derive from this, never a baked player flag.
  readonly factionId: FactionType;
  // Combat HP is an ordered POOL STACK (./pools): a hit cascades top→bottom, so a shield is just a
  // band spliced above `hull` (absorb-before-hull is a stack-order fact, not shield-specific code).
  // `pools` is ABSENT on the effect-free adapter output; createEncounterState seeds the `hull` band,
  // and a declared effect's `install` handler splices more. The energy gate lives separately in the opaque
  // `stats` bag (where `energy`/`energyMax` sit, gating the menu) — the accepted axis split: a hit
  // hits pools, a recharge tops a stat, and a StatDelta never crosses into a pool.
  readonly pools?: readonly Pool[];
}

// A fleet ship in combat. Carries the ship's OWN ordered module list (there are no classes) — the source
// of its installs + Σ-battery energyMax (combatantInstalls / combatantEnergyMax read it directly); the
// durable selection handle is `id` (the ship's save id).
export interface ShipCombatant extends CombatantBase {
  readonly kind: 'ship';
  readonly components: readonly ShipComponentType[];
}

// A planet / moon / belt in combat — stationary, anchored to its on-screen disc. Declared now so
// the union is the complete contract E2 folds over; its PRODUCER (`combatRoleFor`, the combat
// specialization of bodies-to-actors) and its passive turn role land in E5. `bodyId` is the catalog
// Body.id — the durable anchor write-back keys on (a destroyed body → facility removal, §8).
export interface BodyCombatant extends CombatantBase {
  readonly kind: 'body';
  readonly bodyId: string;
}

// Discriminated by `kind` — the renderer anchors the two differently, but the reducer folds them
// uniformly (both are Actors with commands).
export type Combatant = ShipCombatant | BodyCombatant;

// One faction's combatants in an encounter — the combat twin of ActorSide. The faction structure
// the renderer (left/right split) and targeting (allegiance) read; the reducer reads the flat,
// combatId-indexed projection on EncounterSpec instead (./encounter-spec).
export interface CombatantSide {
  readonly factionId: FactionType;
  readonly controlled: boolean;
  readonly combatants: readonly Combatant[];
}

// ── Encounter state (E2 bones) ───────────────────────────────────────────────

// The energy stat + its cap. Per the accepted axis split (§7.5), energy stays in the opaque stat bag
// (NOT a pool) so the shipped menu availability gate `energy >= totalCost` reads it unchanged. The
// `recharge` effect tops energy up toward energyMax each cycle; createEncounterState seeds a
// placeholder energyMax (the real one is Σ battery — deferred with the cost model) and a charged
// start (energy = energyMax).
export const ENERGY_STAT = 'energy';
export const ENERGY_MAX_STAT = 'energyMax';

// A combatant with one stat key overwritten — the immutable update the recharge fold makes (a NEW
// combatant, never a mutation). Spreading the union preserves the `kind` discriminant; an absent
// `stats` bag becomes a one-key bag. Its pool-stack twin is withPools.
export function withStat(combatant: Combatant, key: string, value: number): Combatant {
  return { ...combatant, stats: { ...combatant.stats, [key]: value } };
}

// A combatant with its pool stack replaced — the immutable update the damage cascade and the
// `install`/`expire` pool edits make (a NEW combatant). The stat-bag twin is withStat.
export function withPools(combatant: Combatant, pools: readonly Pool[]): Combatant {
  return { ...combatant, pools };
}

// A combatant's total remaining HP (Σ the pool stack's currents), or +∞ when it has NO pool stack —
// both `pools` absent AND an EMPTY array mean "unpooled" (the effect-free adapter output, before
// createEncounterState seeds the hull band), which can't be downed. The distinction matters: `[]`
// reduces to 0, which would read as DEAD, so the empty case is treated as unpooled, not depleted.
// A real combatant always retains its permanent `hull` band (the cascade depletes its `current` to 0
// but never removes the band, and the drop-on-expiry only touches sourced bands), so a dead one sums
// to 0 and is down.
export function remainingHp(combatant: Combatant): number {
  const pools = combatant.pools;
  if (pools === undefined || pools.length === 0) return Infinity;
  return pools.reduce((sum, pool) => sum + pool.current, 0);
}

// Down = HP depleted. A downed combatant is MARKED, not removed (§3.3): it keeps its combatId slot so
// the renderer can compact it and replay stays index-stable; it just offers no commands and the turn
// cursor skips it.
export function isDown(combatant: Combatant): boolean {
  return remainingHp(combatant) <= 0;
}

// One thing the reducer did that the renderer animates (§3.1) — a typed union dispatched by `kind`.
// `source`/`target`/`combatId` are combatIds (the render anchor); `amount`/`delta` are integer-milli.
// `damage`'s amount is HP ACTUALLY removed (cascaded across the pool stack), never the raw hit, so a
// renderer never animates more than existed. `effect` is one applied per-cycle StatDelta (recharge,
// later DoT/HoT), emitted only when it actually changed a stat. `install`/`expire` are the chip-up /
// chip-down beats when a declared effect is minted (e.g. a shield raised) or counts out. The mechanics
// phase adds {lockBroken}, {manaScattered}, … .
export type EncounterEvent =
  | { readonly kind: 'damage'; readonly source: number; readonly target: number; readonly amount: number }
  | { readonly kind: 'down'; readonly combatId: number }
  | { readonly kind: 'effect'; readonly combatId: number; readonly effectKey: string; readonly statKey: string; readonly delta: number }
  | { readonly kind: 'install'; readonly combatId: number; readonly effectKey: string; readonly effectId: number }
  | { readonly kind: 'expire'; readonly combatId: number; readonly effectKey: string; readonly effectId: number };

// The transient, stepped combat state — the third state category, born from an EncounterSpec and
// dead at encounter exit, NEVER serialized into either save (§6.1). The bones carry only the
// skeleton: the live combatants (their mutated stats), whose turn it is, and the round counter. The
// mana counts, lock rows, combo points, and PRNG words are deferred state the mechanics phase adds.
export interface EncounterState {
  // combatId === index, preserved from the spec. A combatant's stats mutate across steps (its hull
  // falls), so the reducer replaces this array each step rather than mutating in place — it stays pure.
  readonly combatants: readonly Combatant[];
  // The combatId whose turn it is — the turn cursor (./turn-order) advances it WITHIN the active
  // side's phase; the renderer anchors the active-turn marker on it.
  readonly activeId: number;
  // 1-based; bumps when a full ROUND completes — all sides have taken a phase, i.e. the phase wraps
  // back to the initiator's side (§3.8.1). The event-driven round — an idle player burns none.
  readonly round: number;
  // ── Press-Turn initiative (§3.8) — the per-SIDE tempo economy ──────────────────────────────────
  // The spent-down pool of whole-integer icons per side. Only `initiative[phaseSide]` is being spent
  // right now; an off-phase side holds the pool it last refilled to (a tempo readout). Re-derived
  // (refilled) when a side's phase begins (I5). Transient, immutable-replaced each step, NEVER
  // serialized (§6.1) — like `round`.
  readonly initiative: Readonly<Record<FactionType, number>>;
  // Whose phase is live — the side currently spending icons (§3.8.1). The attacker (`initiator`)
  // opens; phases alternate side-by-side until each has acted (one round), then repeat.
  readonly phaseSide: FactionType;
  // The side that opened the encounter (the attacker, `EncounterSpec.initiator`'s side) — the immutable
  // round anchor: `round` bumps whenever a phase transition lands back on THIS side (a full pass
  // completed, §3.8.1). Set once at create; never changes.
  readonly initiatorSide: FactionType;
  // Did ANY damage-dealing action land since the current round began? Accumulates across both sides'
  // phases and resets at the round boundary. Drives the mutual-disengage terminal (./terminal, §8.4):
  // a full round with no damage from either side ends the encounter.
  readonly damageThisRound: boolean;
  // Latched once a full round completed with `damageThisRound === false` — the mutual-disengage
  // terminal (§8.4 / §3.8.3), the "all pass a round" exit now that a phase is voluntarily endable
  // (End Round, ./step `endPhase`). isTerminal reads it alongside side-elimination.
  readonly disengaged: boolean;
  // The live effects riding on the combatants — the only serialized half of the effect substrate
  // (./effects), minted at build from provider declarations and folded at each combatant's turn
  // start. Each is its own instance (distinct-instances stacking).
  readonly effects: readonly ActiveEffect[];
  // The next ActiveEffect.id to mint — a MONOTONIC counter, never the effects-array length: an
  // on-resolve mint after a timed effect expired would otherwise reuse a freed id and collide with a
  // live one, breaking the replay-stable cleanse/dispel handle. Both mint sites (build + on-resolve)
  // draw from this one counter.
  readonly nextEffectId: number;
}
