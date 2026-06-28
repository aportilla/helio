// Effect vocabulary — the combat analog of the action vocabulary (../../actions/types.ts) and the
// fourth member of the registry family (FacilityDef / ShipClassDef / ActionGrant / EffectDef). A
// provider DECLARES the effects it installs exactly as it declares grants, and the reducer FOLDS
// them with NO per-effect-type branch. A pure leaf: its only import is the Pool type from the sibling
// pool-stack leaf (./pools, which itself imports nothing app-side). Only the ActiveEffect INSTANCE is
// ever serialized — replay (seed + intent log) re-mints instances and re-runs the def CODE.
//
// The model is a UNIFIED LIFECYCLE: an effect subscribes to named lifecycle PHASES (when), and each
// handler returns typed OUTCOMES (what) that the reducer routes through ONE dispatch. This decouples
// "when an effect fires" from "what it changes": a turn-start handler may edit a stat OR a pool OR the
// side's tempo, and so may a phase-start one. Adding a NOVEL effect — even one that touches a new
// aspect under a unique condition — is a new def with handlers, never a new registry key or a new
// reducer branch. (A genuinely new lifecycle MOMENT is the only thing that touches the substrate: one
// LifecyclePhase member + one reducer raise-site.)

import type { Pool } from '../pools.ts';

// The frozen save-key naming an effect's DEF. An ActiveEffect re-binds to its def by this key the
// way a saved Facility re-binds by {type}, so it is guarded the standard 3 ways (./registry).
export type EffectKey = 'recharge' | 'shield-segment' | 'tactical-command' | 'damage' | 'shield-generator';

// ── Lifecycle phases (WHEN an effect fires) ──────────────────────────────────────────────────────
// The named moments the reducer raises. An effect implements a handler per phase it cares about
// (EffectDef.on), dispatched by PRESENCE — no per-effect branch. LIVE phases are below; a reserved
// moment (roundStart / damageDealt / damageTaken / resolve …) becomes live by adding one member here
// plus one reducer raise-site — a localized substrate change, NOT a per-effect one.
//   - 'install'    — once, when the instance is minted (a shield splices its band).
//   - 'expire'     — once, on the cycle a timed instance counts out, before it drops (a shield pops).
//   - 'turnStart'  — at the OWNER combatant's own activation/turn start (recharge; later DoT / HoT).
//   - 'phaseStart' — when the owner's SIDE begins a Press-Turn phase (§3.8): tactical-command tempo,
//                    later Rally / Disruption. The side-aggregated phase from which SideDeltas fold.
export type LifecyclePhase = 'install' | 'expire' | 'turnStart' | 'phaseStart';

// ── Outcomes (WHAT a handler changes) — one discriminated channel the fold routes uniformly ───────

// Adjust ONE key in the opaque STAT bag (e.g. energy), optionally clamped. Integer-milli. Effect
// content, never a formula.
export interface StatDelta {
  readonly kind: 'stat';
  readonly statKey: string;
  readonly delta: number;
  readonly clampToMaxKey?: string; // ceil the result at this stat's value (energy ≤ energyMax)
  readonly clampToZero?: boolean; // floor the result at 0
}

// An edit to the owner's pool STACK — the same channel for the four things a stack edit can be.
// `splice` adds a band (the fold stamps its sourceEffectId, so the def need not know its own id) directly
// above the first `aboveKey` band; `drop` removes every band this effect spliced; `restore` tops this
// effect's band(s) toward max by `amount` (a regenerating shield each phase — the heal-twin of `damage`);
// `damage` cascades a hit top→bottom through the bands (./pools cascadeDamage), depleting shields before
// hull purely by stack order, scaled per band by the weapon's `effByKey` effectiveness (permille by band
// key — how a laser shreds shields and a cannon caves hull, as DATA not a per-type branch). A shield is one
// `splice` on install + one `drop` on expire; a hit is one `damage` — and because damage is just another
// stack edit, there is no attack-specific reducer branch. Only `damage` surfaces a beat (the `damage`
// event, with the source — emitted by the fold's applyOutcome); splice/drop/restore are silent structural
// edits whose chip beats (if any) the runner emits.
export type PoolEdit =
  | { readonly kind: 'pool'; readonly op: 'splice'; readonly pool: Pool; readonly aboveKey?: string }
  | { readonly kind: 'pool'; readonly op: 'drop' }
  | { readonly kind: 'pool'; readonly op: 'restore'; readonly amount: number }
  | { readonly kind: 'pool'; readonly op: 'damage'; readonly amount: number; readonly effByKey?: Readonly<Record<string, number>> };

// Add/remove whole Press-Turn initiative icons from the owner's SIDE pool (§3.8.4) — the per-SIDE tier
// neither StatDelta (per-combatant stat) nor PoolEdit (per-combatant HP) can reach. The fold resolves
// the owner to its side and folds these at the relevant phase; `initiative` is whole icons (gain +,
// debuff −). Whom it lands on is the lifecycle: a phaseStart SideDelta sets the side's pool for the
// phase (tactical-command); a future on-resolve debuff would target the victim side.
export interface SideDelta {
  readonly kind: 'side';
  readonly initiative: number;
}

// The single typed channel every handler returns — the fold routes each by `kind` to its applier
// (stat→bag, pool→stack, side→pool), so a handler can return ANY mix from ANY phase. This is the seam
// that makes "novel effects that touch different aspects" need zero substrate change.
export type EffectOutcome = StatDelta | PoolEdit | SideDelta;

// The read-only view a handler gets of the combatant it rides on — the minimum it needs, declared apart
// from ../state so the effect leaf carries no state↔effects dependency (it shares only the neutral
// Pool leaf). A Combatant satisfies it structurally.
export interface EffectTarget {
  readonly stats?: Readonly<Record<string, number>>;
  readonly pools?: readonly Pool[];
}

// The context a handler reads — its instance params + its owner. Pure: a handler reads these and
// returns outcomes; it never reaches app state. Richer per-event context (a hit amount, an attacker
// id) lands as optional fields here with the event that first needs them.
export interface EffectContext {
  readonly params: Readonly<Record<string, number>>;
  readonly owner: EffectTarget;
}

// One lifecycle handler — the UNIFORM shape for every phase: read context, return typed outcomes.
export type EffectHandler = (ctx: EffectContext) => readonly EffectOutcome[];

// How multiple live INSTANCES of this effect on ONE SIDE aggregate when their SideDeltas fold at a
// side phase (§3.8.2). 'sum' (default) = every living carrier contributes (instances add). 'presence'
// = the effect counts ONCE per side however many carriers hold it ("+1 no matter how many tactical-
// command ships") — the generic expression of presence-not-count, a DATA property, not a hardcoded
// cap. Per-combatant outcomes (stat/pool, e.g. recharge) are unaffected: they always apply per owner.
export type EffectStacking = 'sum' | 'presence';

// An effect's DEF — pure code keyed by a frozen EffectKey, NEVER serialized. It declares only the
// lifecycle handlers its mechanic needs (no upfront taxonomy), each PURE and RETURNING its outcomes for
// the fold to apply (never mutating). Dispatch is by handler PRESENCE in `on`, mirroring how
// deriveCommands folds grants — no per-key branch in the reducer.
export interface EffectDef {
  readonly key: EffectKey;
  readonly label: string;
  readonly color: string; // effect-chip hue, literal sRGB (ColorManagement OFF), like ActionGrant.color
  readonly tags?: readonly string[]; // 'buff'|'debuff'|… — what cleanse/dispel will match on (data, not a branch)
  readonly stacking?: EffectStacking; // side-fold aggregation (above); ABSENT ⇒ 'sum'
  readonly on?: Partial<Record<LifecyclePhase, EffectHandler>>; // lifecycle subscriptions; ABSENT phase ⇒ no-op
}

// A live effect riding on a combatant — the ONLY serialized half (EncounterState.effects), so replay
// re-mints these and re-runs the def code; no def is ever persisted. Per the 2026-06-24 stacking
// policy each application is its OWN instance: two of the same effect tick independently and dispel
// removes one — there is no merge identity on the instance.
export interface ActiveEffect {
  readonly id: number; // MONOTONIC install-order int (gaps after a drop) — replay-stable; the cleanse/dispel handle
  readonly key: EffectKey; // re-binds to the def (code, never saved)
  readonly ownerId: number; // the combatId it rides on
  readonly sourceId: number; // who installed it — carried from day one so reflect/charge-up need no later save change
  readonly remainingCycles: number; // -1 = PERMANENT; >0 counts down at the owner's own turn start
  readonly params: Readonly<Record<string, number>>; // integer-milli config: {amount} / {capacity} / {initiative}
}

// A provider's DECLARATION that it installs an effect — the combat twin of an ActionGrant, a
// type-only leaf so ShipComponentDef / FacilityDef import it without breaching the sim/ui walls.
// `ShipComponentDef.installs?` mints PERMANENT effects at encounter build; `installsOnResolve?`
// (keyed by grant key on the same provider def, NOT on the neutral ActionGrant — keeping the action
// leaf pure) mints TIMED effects when that grant's action resolves in the reducer.
export interface EffectInstall {
  readonly effectKey: EffectKey;
  // -1 = PERMANENT; >0 = a TIMED rider (the cycle count, counted down at the owner's turn start); 0 = a
  // ONE-SHOT (a hit) — its `install` outcomes apply once, but it is never persisted as an ActiveEffect
  // and emits no chip-up beat (its outcome's own beat is the beat). A `damage` install uses 0.
  readonly remaining: number;
  readonly params: Readonly<Record<string, number>>;
}
