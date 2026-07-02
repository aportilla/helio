// Hoisted combat knobs. Mostly empty until the mechanics phase — the bones carry only the two
// placeholder magnitudes the flat effect needs (§3, §12 E2). Integer milli throughout, mirroring
// the economy sim's stockMilli discipline so no float math ever reaches the reducer.

// The placeholder current/max of the `hull` POOL every combatant is seeded with (createEncounterState
// stamps the band; the cascade depletes it). A value, NOT a formula — the real hull is Σ the loadout's
// component hull, deferred with the stat model — so the loop reads as combat with zero committed math.
// (The placeholder HIT magnitude that depletes it lives on the weapon now — small-laser's on-resolve
// `damage` install — not here, since damage is a declared effect rather than a reducer constant.)
export const PLACEHOLDER_HULL_MILLI = 100_000;

// ── Damage typing — the deterministic formula's `typeMatchMult` (resistances) ──────────────────────
// A defensive band's RESISTANCE to each damage TYPE, permille (1000 = 100% = no resist; >1000 = weak to
// that type, the band takes MORE; <1000 = resistant, takes LESS). The cascade reads
// `band.resistByType[weapon.damageType]` per band, so effectiveness is a property of the DEFENCE (a new
// armour layer authors its own row) crossed with the weapon's type — pure data, no per-weapon/per-type
// reducer branch. An absent type or band defaults to 1000 (full effect). Types today: 'energy' (beams) /
// 'kinetic' (slugs); a third is one key here + one `damageType` on a weapon, no code. Placeholder values
// until the real stat model — they reproduce the demo: a laser (energy) shreds shields, a cannon (kinetic)
// craters hull. Keys must match the weapons' `damageType` strings (src/ships/components/registry.ts).
export const SHIELD_RESIST: Readonly<Record<string, number>> = { energy: 1_500, kinetic: 500 };
export const HULL_RESIST: Readonly<Record<string, number>> = { energy: 600, kinetic: 1_400 };

// ── Initiative knobs (COMMITTED, §3.8) — load-bearing, NOT placeholders ───────
// The Press-Turn round structure (state.ts/turn-order.ts/step.ts). These are real game tuning,
// hoisted per Appendix B. The fleet→icons ratio is the ONLY fractional step (floored before play,
// §3.8.2); everything in the loop is whole icons.

// The actor→icons ratio (milli, so 500 ≈ ½): a side's base pool is floor(livingActors × ratio), where an
// ACTOR is a living ship OR a living body that can act — one whose loadout grants a command (an armed /
// sensor emplacement, the M3 actor rule); a bombard-only body target adds none. At ½ a 12-actor side
// derives 6 icons — a deliberate tempo throttle (you don't act with EVERY hull each phase). RESERVED seam:
// this may become a concave diminishing-returns curve so huge fleets don't get enormous phases — the
// symbol is the lever, the curve is tuning, not structure (I4).
export const INITIATIVE_PER_ACTOR_MILLI = 500;

// The per-side floor so any side with a living ship always gets at least one action — fixes the
// floor(½ × 1) = 0 lone-ship dead state (a lone scout still fights, I4/I5). The side pool is clamped to
// this minimum AFTER the fleet base AND after any effect SideDelta folds (foldPhaseStart), so a
// focus-fired debuff can never zero a side. Presence-not-count for a component's tempo contribution is
// NOT a knob here — it's an effect property (`stacking: 'presence'` on the tactical-command def).
export const MIN_INITIATIVE = 1;
