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
}

// Cascade a hit top→bottom over the stack: each band absorbs up to its `current`, the remainder spills
// into the next, and overflow past the last band is discarded (the combatant is dead — there is no HP
// there to remove). Returns a NEW pool array (every mutated band is a fresh object; the input is left
// untouched, so the prior state snapshot stays valid for replay) plus `dealt` — the HP actually removed
// = min(rawMilli, Σ current). The damage event reports `dealt`, never the raw, so a renderer never
// animates more HP than existed.
export function cascadeDamage(
  pools: readonly Pool[],
  rawMilli: number,
): { readonly pools: readonly Pool[]; readonly dealt: number } {
  let remaining = rawMilli;
  let dealt = 0;
  const next = pools.map((pool) => {
    if (remaining <= 0) return pool;
    const absorbed = Math.min(pool.current, remaining);
    if (absorbed === 0) return pool;
    remaining -= absorbed;
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
