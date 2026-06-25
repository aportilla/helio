// Hoisted combat knobs. Mostly empty until the mechanics phase — the bones carry only the two
// placeholder magnitudes the flat effect needs (§3, §12 E2). Integer milli throughout, mirroring
// the economy sim's stockMilli discipline so no float math ever reaches the reducer.

// The placeholder current/max of the `hull` POOL every combatant is seeded with (createEncounterState
// stamps the band; the cascade depletes it). A value, NOT a formula — the real hull is Σ the loadout's
// component hull, deferred with the stat model — so the loop reads as combat with zero committed math.
export const PLACEHOLDER_HULL_MILLI = 100_000;

// The flat hull a placeholder ATTACK removes per target per hit — sized so a few hits down a
// combatant, keeping the bones loop short and legible. No PRNG, no damage formula (§0, §6.4).
export const PLACEHOLDER_DAMAGE_MILLI = 40_000;

// The placeholder energy capacity (energyMax) every combatant starts charged to. A bones value
// standing in for the real energyMax = Σ battery (deferred with the per-weapon cost model); matches
// the canonical triple-missile fixture's energyMax of 9 (§4). The engine's `recharge` effect tops
// energy back toward this each cycle.
export const PLACEHOLDER_ENERGY_MILLI = 9_000;
