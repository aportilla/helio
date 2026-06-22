// Hoisted faction tunables — the render colors. Kept in one place so a palette pass
// never hunts through def bodies, and so docs reference them by NAME, never by value
// (a hex in prose rots the instant it's re-tuned). Re-tuning is non-breaking — the
// only serialized faction contract is the factionId wire string, never these colors.

// — Player: the slot the local player commands. Steel grey-blue, deliberately the
// same hull tone the corvette shipped with, so the player's own fleet looks unchanged.
export const PLAYER_FACTION_COLOR = '#b9c4d0';

// — Rival: an opposing side. A warm red, foreign against the cyan/steel palette so an
// enemy sprite reads as hostile at a glance. Distinct from the economy deficit red
// (a softer salmon in the sidebar), which never lands on a fleet sprite.
export const RIVAL_FACTION_COLOR = '#cf5240';
