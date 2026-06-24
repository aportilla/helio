// Hoisted combat knobs. Mostly empty until the mechanics phase — the bones carry only the two
// placeholder magnitudes the flat effect needs (§3, §12 E2). Integer milli throughout, mirroring
// the economy sim's stockMilli discipline so no float math ever reaches the reducer.

// The bones placeholder HP every combatant starts the encounter with (createEncounterState stamps
// it). A value, NOT a formula — it stands in for the real ordered pool-stack HP that lands with the
// effect substrate, so the loop reads as combat with zero committed math.
export const PLACEHOLDER_HULL_MILLI = 100_000;

// The flat hull a placeholder ATTACK removes per target per hit — sized so a few hits down a
// combatant, keeping the bones loop short and legible. No PRNG, no damage formula (§0, §6.4).
export const PLACEHOLDER_DAMAGE_MILLI = 40_000;
