// Hoisted action tunables — the menu-row accent colors, and a home for the timing /
// availability knobs the mechanics phase will add. Kept in one place so a palette pass
// never hunts through def bodies, and so docs reference them by NAME, never by value (a
// hex in prose rots the instant it's re-tuned). Re-tuning is non-breaking — the only
// serialized action contract is the ActionType wire string, never these colors.
//
// PROVISIONAL: the bones ship a placeholder combat triad; these accents are an early
// interpretation, distinct hues so a menu row reads at a glance. The fleet sprite tints by
// FACTION, never by these — the action color is reserved for the menu row / later pill.

// — Attack: offensive. A warm red-orange, hostile against the cyan/steel palette.
export const ATTACK_ACTION_COLOR = '#e0644e';

// — Flee: evasive navigation. An amber distinct from the attack red and the cyan UI.
export const FLEE_ACTION_COLOR = '#c9b46b';

// — Pass: decline to act. A muted slate grey — present but recessive, the SoS dimmed verb.
export const PASS_ACTION_COLOR = '#8a93a0';
