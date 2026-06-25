// Effect vocabulary — the combat analog of the action vocabulary (../../actions/types.ts) and the
// fourth member of the registry family (FacilityDef / ShipClassDef / ActionGrant / EffectDef). A
// provider DECLARES the effects it installs exactly as it declares grants, and the reducer FOLDS
// them with NO per-effect-type branch — dispatch by hook PRESENCE, mirroring how deriveCommands
// folds grants. A pure leaf: its only import is the Pool type from the sibling pool-stack leaf
// (./pools, which itself imports nothing app-side). Only the ActiveEffect INSTANCE is ever
// serialized — replay (seed + intent log) re-mints instances and re-runs the def CODE.

import type { Pool } from '../pools.ts';

// The frozen save-key naming an effect's DEF. An ActiveEffect re-binds to its def by this key the
// way a saved Facility re-binds by {type}, so it is guarded the standard 3 ways (./registry).
export type EffectKey = 'recharge' | 'shield-segment';

// What a per-cycle hook asks the reducer to change — an integer-milli adjustment to ONE key in the
// opaque STAT bag (e.g. energy), optionally clamped. Pool-stack HP is NOT touched this way: a band is
// added/removed via PoolEdit (below) and depleted by the damage cascade, never by a StatDelta. (A
// unified stat-or-pool key lookup is deferred until a DoT/HoT first needs to tick a pool.) Effect
// content, never a formula.
export interface StatDelta {
  readonly statKey: string;
  readonly delta: number;
  readonly clampToMaxKey?: string; // ceil the result at this stat's value (energy ≤ energyMax)
  readonly clampToZero?: boolean; // floor the result at 0
}

// A structural edit to the owner's pool stack — what onInstall / onExpire RETURN (the pool-stack twin
// of StatDelta: a hook describes the change, the fold applies it, so the def stays pure and the
// reducer carries no per-effect branch). `splice` adds a band (the fold stamps its sourceEffectId, so
// the def need not know its own id) directly above the first `aboveKey` band; `drop` removes every
// band this effect spliced. A shield-segment is one `splice` on install + one `drop` on expire — no
// damage hook, because absorb-before-hull is purely the stack order (./pools).
export type PoolEdit =
  | { readonly op: 'splice'; readonly pool: Pool; readonly aboveKey?: string }
  | { readonly op: 'drop' };

// The read-only view a hook gets of the combatant it rides on — the minimum it needs, declared apart
// from ../state so the effect leaf carries no state↔effects dependency (it shares only the neutral
// Pool leaf). A Combatant satisfies it structurally.
export interface EffectTarget {
  readonly stats?: Readonly<Record<string, number>>;
  readonly pools?: readonly Pool[];
}

// The context a per-cycle hook reads — its instance params + its owner. Pure: a hook reads these and
// returns deltas; it never reaches app state.
export interface EffectContext {
  readonly params: Readonly<Record<string, number>>;
  readonly owner: EffectTarget;
}

// An effect's DEF — pure code keyed by a frozen EffectKey, NEVER serialized. A def implements only
// the hooks its mechanic needs (no upfront taxonomy), each PURE and RETURNING its change for the fold
// to apply (never mutating). `onCycleStart` fires at the owner's OWN turn start (recharge / DoT / HoT)
// and returns stat deltas. `onInstall` fires once at mint (a shield splices its band); `onExpire`
// fires on the cycle a timed effect counts out, after that cycle's onCycleStart, before the instance
// drops (a shield pops its band) — both return pool edits.
export interface EffectDef {
  readonly key: EffectKey;
  readonly label: string;
  readonly color: string; // effect-chip hue, literal sRGB (ColorManagement OFF), like ActionGrant.color
  readonly tags?: readonly string[]; // 'buff'|'debuff'|… — what cleanse/dispel will match on (data, not a branch)
  onCycleStart?(ctx: EffectContext): readonly StatDelta[];
  onInstall?(ctx: EffectContext): readonly PoolEdit[];
  onExpire?(ctx: EffectContext): readonly PoolEdit[];
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
  readonly remainingCycles: number; // -1 = PERMANENT; >0 counts down at the owner's own cycle start
  readonly params: Readonly<Record<string, number>>; // integer-milli config: {amount} / {capacity}
}

// A provider's DECLARATION that it installs an effect — the combat twin of an ActionGrant, a
// type-only leaf so ShipComponentDef / FacilityDef import it without breaching the sim/ui walls.
// `ShipComponentDef.installs?` mints PERMANENT effects at encounter build; `installsOnResolve?`
// (keyed by grant key on the same provider def, NOT on the neutral ActionGrant — keeping the action
// leaf pure) mints TIMED effects when that grant's action resolves in the reducer.
export interface EffectInstall {
  readonly effectKey: EffectKey;
  readonly remaining: number; // -1 permanent, else the cycle count
  readonly params: Readonly<Record<string, number>>;
}
