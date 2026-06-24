// Effect vocabulary — the combat analog of the action vocabulary (../../actions/types.ts) and the
// fourth member of the registry family (FacilityDef / ShipClassDef / ActionGrant / EffectDef). A
// provider DECLARES the effects it installs exactly as it declares grants, and the reducer FOLDS
// them with NO per-effect-type branch — dispatch by hook PRESENCE, mirroring how deriveCommands
// folds grants. A pure leaf: it imports nothing app-side. Only the ActiveEffect INSTANCE is ever
// serialized — replay (seed + intent log) re-mints instances and re-runs the def CODE.

// The frozen save-key naming an effect's DEF. An ActiveEffect re-binds to its def by this key the
// way a saved Facility re-binds by {type}, so it is guarded the standard 3 ways (./registry).
export type EffectKey = 'recharge';

// What a per-cycle hook asks the reducer to change — an integer-milli adjustment to ONE stat key,
// optionally clamped. `statKey` resolves to whichever list owns it (the opaque stat bag today; the
// pool stack once it lands) — a lookup, not a type-branch. Effect content, never a formula.
export interface StatDelta {
  readonly statKey: string;
  readonly delta: number;
  readonly clampToMaxKey?: string; // ceil the result at this stat's value (energy ≤ energyMax)
  readonly clampToZero?: boolean; // floor the result at 0
}

// The read-only view a hook gets of the combatant it rides on — the minimum it needs, declared here
// (not imported from ../state) so the effect leaf carries no state↔effects dependency. A Combatant
// satisfies it structurally.
export interface EffectTarget {
  readonly stats?: Readonly<Record<string, number>>;
}

// The context a per-cycle hook reads — its instance params + its owner. Pure: a hook reads these and
// returns deltas; it never reaches app state.
export interface EffectContext {
  readonly params: Readonly<Record<string, number>>;
  readonly owner: EffectTarget;
}

// An effect's DEF — pure code keyed by a frozen EffectKey, NEVER serialized. A def implements only
// the hooks its mechanic needs (no upfront taxonomy). `onCycleStart` fires at the owner's OWN turn
// start (recharge / DoT / HoT). The `onInstall` (seed derived state) / `onExpire` (terminal beat)
// hooks land with the pool-stack slice; this bones fold dispatches only `onCycleStart`.
export interface EffectDef {
  readonly key: EffectKey;
  readonly label: string;
  readonly color: string; // effect-chip hue, literal sRGB (ColorManagement OFF), like ActionGrant.color
  readonly tags?: readonly string[]; // 'buff'|'debuff'|… — what cleanse/dispel will match on (data, not a branch)
  onCycleStart?(ctx: EffectContext): readonly StatDelta[];
}

// A live effect riding on a combatant — the ONLY serialized half (EncounterState.effects), so replay
// re-mints these and re-runs the def code; no def is ever persisted. Per the 2026-06-24 stacking
// policy each application is its OWN instance: two of the same effect tick independently and dispel
// removes one — there is no merge identity on the instance.
export interface ActiveEffect {
  readonly id: number; // dense install-order int — replay-stable; the cleanse/dispel handle
  readonly key: EffectKey; // re-binds to the def (code, never saved)
  readonly ownerId: number; // the combatId it rides on
  readonly sourceId: number; // who installed it — carried from day one so reflect/charge-up need no later save change
  readonly remainingCycles: number; // -1 = PERMANENT; >0 counts down at the owner's own cycle start
  readonly params: Readonly<Record<string, number>>; // integer-milli config: {amount} / {capacity}
}

// A provider's DECLARATION that it installs an effect — the combat twin of an ActionGrant, a
// type-only leaf so ShipComponentDef / FacilityDef import it without breaching the sim/ui walls.
// `ShipComponentDef.installs?` mints PERMANENT effects at encounter build; the timed
// `ActionGrant.installsOnResolve?` path (minted when an ability resolves) lands with a later slice.
export interface EffectInstall {
  readonly effectKey: EffectKey;
  readonly remaining: number; // -1 permanent, else the cycle count
  readonly params: Readonly<Record<string, number>>;
}
