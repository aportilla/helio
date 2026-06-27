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

// ── Initiative knobs (COMMITTED, §3.8) — load-bearing, NOT placeholders ───────
// The Press-Turn round structure (state.ts/turn-order.ts/step.ts). These are real game tuning,
// hoisted per Appendix B. The fleet→icons ratio is the ONLY fractional step (floored before play,
// §3.8.2); everything in the loop is whole icons.

// The fleet→icons ratio (milli, so 500 ≈ ½): a side's base pool is floor(livingShips × ratio).
// At ½ a 12-ship fleet derives 6 icons — a deliberate tempo throttle (you don't act with EVERY ship
// each phase). RESERVED seam: this may become a concave diminishing-returns curve so huge fleets
// don't get enormous phases — the symbol is the lever, the curve is tuning, not structure (I4).
export const INITIATIVE_PER_SHIP_MILLI = 500;

// The per-side floor so any side with a living ship always gets at least one action — fixes the
// floor(½ × 1) = 0 lone-ship dead state (a lone scout still fights, I4/I5). The side pool is clamped to
// this minimum AFTER the fleet base AND after any effect SideDelta folds (foldPhaseStart), so a
// focus-fired debuff can never zero a side. Presence-not-count for a component's tempo contribution is
// NOT a knob here — it's an effect property (`stacking: 'presence'` on the tactical-command def).
export const MIN_INITIATIVE = 1;
