// Hoisted ship-class tunables. Kept in one place so balance passes never hunt
// through def bodies — and so docs reference them by NAME, never by value (a number
// in prose rots the instant it's tuned).
//
// PROVISIONAL: v1 ships a single class; these values are an early interpretation
// made before Helio's fleet is finalized. Re-tuning is non-breaking — the only
// serialized ship contract is the classId wire string, never these numbers.

// — Corvette: the v1 starter ship. A small hull built in a handful of galaxy turns.
export const CORVETTE_BUILD_TURNS = 3;

// Fleet-sprite radius in content-buffer px (HALF the triangle's edge — the sprite is a
// d×d quad, d = 2·radius). 25 → a 50-px-wide hull: a readable ship parked in the field
// below the planets, not a stand-in icon. The fleet draws Mesh quads on the
// makeFleetTriangleMaterial path — the same parity-snapped per-pixel SDF discipline the
// system view's star disc uses, shared with the eventual combat sprites — not GL_POINTS.
export const CORVETTE_SPRITE_SIZE_PX = 25;
