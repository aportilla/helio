// pools — the ordered HP POOL STACK and its pure operators (§7.5). A combatant's health is not one
// number but a top-to-bottom stack of pools: a hit cascades through them, absorbed band by band, and
// only overflow past the LAST pool is lethal. "Absorb before hull" is therefore purely a STACK-ORDER
// fact — a temp shield is just a pool spliced above `hull`, and the cascade needs zero shield-specific
// code. A pure leaf (mirrors src/diagram-pick.ts): it imports nothing app-side, so the effect fold and
// the reducer both build on it. Integer-milli throughout — no float reaches the cascade.

// The canonical bottom-of-stack pool key: the body itself. A combatant is always seeded with a `hull`
// pool (step.ts); shields and other absorbers splice ABOVE it. It has no `sourceEffectId`, so the
// effect fold's drop-on-expiry never removes it.
export const HULL_POOL = 'hull';

// One band of the stack. `current`/`max` are integer-milli; `current` falls as the band absorbs and is
// never negative. `sourceEffectId` ties a TEMPORARY band to the ActiveEffect that spliced it, so that
// effect's `expire` handler pops exactly its own band(s); a permanent body pool carries none.
export interface Pool {
  readonly key: string;
  readonly current: number;
  readonly max: number;
  readonly sourceEffectId?: number;
  // This band's RESISTANCE to each damage TYPE (permille, 1000 = full effect; >1000 = weak to it, <1000 =
  // resistant). The cascade reads `resistByType[weapon.damageType]` for the band it's chewing — so a
  // laser shreds a shield band that is weak to 'energy', a cannon craters hull weak to 'kinetic', with the
  // numbers living on the DEFENCE. ABSENT (or an unprofiled type) ⇒ 1000 ⇒ a flat, type-agnostic hit.
  readonly resistByType?: Readonly<Record<string, number>>;
}

// Cascade a hit top→bottom over the stack: each band absorbs up to its `current`, the remainder spills
// into the next, and overflow past the last band is discarded (the combatant is dead — there is no HP
// there to remove). Returns a NEW pool array (every mutated band is a fresh object; the input is left
// untouched, so the prior state snapshot stays valid for replay) plus `dealt` — the HP actually removed
// = min(effective hit, Σ current). The damage event reports `dealt`, never the raw, so a renderer never
// animates more HP than existed.
//
// `damageType` is the hit's type (e.g. 'energy' / 'kinetic'); the per-band multiplier `m` is that band's
// `resistByType[damageType]` (permille, 1000 = 100%) — so a laser ('energy') shreds a shield weak to energy
// (>1000) while glancing off hull resistant to it (<1000), and a cannon ('kinetic') does the inverse, with
// NO per-weapon-type branch: the cascade just reads a number off the band. ABSENT `damageType`, or a band
// with no `resistByType`, or an unprofiled type ⇒ 1000 ⇒ byte-identical to a flat cascade (so the untyped
// call site and every flat test are unchanged). Each band converts the running RAW budget into its own
// currency (effective = raw × m / 1000), absorbs what it can, then debits the raw budget by what that
// absorption COST in raw (consumed = absorbed × 1000 / m) — so a weak-to-this-type (>100%) band drains
// faster AND spills more budget, and a resistant (<100%) one the opposite. Integer-milli / permille
// throughout, multiply-then-divide (divide-last) so no float and no PRNG reaches the reducer; `ceil` on the
// raw debit guards against a >100% multiplier over-spilling.
export function cascadeDamage(
  pools: readonly Pool[],
  rawMilli: number,
  damageType?: string,
): { readonly pools: readonly Pool[]; readonly dealt: number } {
  let remaining = rawMilli;
  let dealt = 0;
  const next = pools.map((pool) => {
    if (remaining <= 0) return pool;
    const m = (damageType !== undefined ? pool.resistByType?.[damageType] : undefined) ?? 1000;
    if (m <= 0) return pool; // a band fully immune to this damage type absorbs nothing, costs no budget
    const effective = Math.floor((remaining * m) / 1000);
    const absorbed = Math.min(pool.current, effective);
    if (absorbed === 0) return pool;
    remaining -= Math.ceil((absorbed * 1000) / m);
    dealt += absorbed;
    return { ...pool, current: pool.current - absorbed };
  });
  return { pools: next, dealt };
}

// Insert `pool` directly ABOVE the first band whose key === aboveKey (so a shield with aboveKey 'hull'
// lands on top of hull and absorbs first). When aboveKey is absent or not found, insert at the TOP
// (index 0) — the most-protective position. Returns a NEW array; never mutates the input.
export function splicePool(pools: readonly Pool[], pool: Pool, aboveKey?: string): readonly Pool[] {
  const found = aboveKey === undefined ? -1 : pools.findIndex((p) => p.key === aboveKey);
  const at = found < 0 ? 0 : found;
  return [...pools.slice(0, at), pool, ...pools.slice(at)];
}

// Drop every band an expiring effect spliced (matched by sourceEffectId). The permanent hull/body pool
// has no sourceEffectId, so it is never removed; a multi-band effect drops all its bands at once.
// Returns a NEW array; never mutates the input.
export function dropPoolsBySource(pools: readonly Pool[], effectId: number): readonly Pool[] {
  return pools.filter((p) => p.sourceEffectId !== effectId);
}

// Top up every band a given effect sourced, toward its `max`, by `amount` — the heal-twin of
// cascadeDamage and the band-edit a regenerating shield uses each phase. Matched by sourceEffectId (the
// fold supplies the effect's own id), so it only restores THIS effect's band(s), never the permanent hull
// (which carries no sourceEffectId). Clamped at `max`; integer-milli; returns a NEW array, never mutates.
export function restorePoolsBySource(pools: readonly Pool[], effectId: number, amount: number): readonly Pool[] {
  if (amount <= 0) return pools;
  return pools.map((p) =>
    p.sourceEffectId === effectId ? { ...p, current: Math.min(p.max, p.current + amount) } : p);
}
