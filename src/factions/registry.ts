// FACTION_DEFS — the single source of truth for every faction. Adding a faction is
// one object here plus one literal in the FactionType union: its save-key (factionId),
// display label, and fleet color all flow from that one edit. Mirrors
// src/ships/registry.ts exactly, deliberately, so the frozen-key discipline reads
// identically across both registries.

import type { FactionDef, FactionType } from './types.ts';
import { PLAYER_FACTION_COLOR, RIVAL_FACTION_COLOR } from './tuning.ts';

// The registry, keyed by FactionType. `satisfies Record<FactionType, ...>` is the
// compile layer of the frozen-key guard: adding a literal to the union without a def
// here fails to compile, and a key that isn't a FactionType is rejected. The key IS
// the save id; the DEV assert below pins each def's `id` to its key.
const DEFS = {
  player: {
    id: 'player',
    label: 'Player',
    color: PLAYER_FACTION_COLOR,
  },
  rival: {
    id: 'rival',
    label: 'Rival',
    color: RIVAL_FACTION_COLOR,
  },
} satisfies Record<FactionType, FactionDef>;

export const FACTION_DEFS: readonly FactionDef[] = Object.values(DEFS);

export const FACTION_BY_ID: ReadonlyMap<FactionType, FactionDef> = new Map(
  Object.entries(DEFS) as Array<[FactionType, FactionDef]>,
);

// The persistence validation set, derived from the registry so it can never drift
// from the union (game-state-codec.ts reads this to default an unknown saved
// factionId). Typed as a string-set because it validates arbitrary parsed JSON.
export const FACTION_TYPES: ReadonlySet<string> = new Set(Object.keys(DEFS));

// WHICH faction the local player commands — the pointer that fills the role an
// "is-human" flag would, kept OUT of the faction record so factions stay
// player-agnostic. A constant for now; becomes a GameState field when control can
// change hands. Combat reads it as "my side": factionId === CONTROLLED_FACTION_ID.
// It is also the validate-and-merge default for a pre-faction saved ship (every ship
// built before factions existed was the player's).
export const CONTROLLED_FACTION_ID: FactionType = 'player';

// Single source of a faction's display name — the ship card now, civ UI later.
export function factionLabel(id: FactionType): string {
  return FACTION_BY_ID.get(id)?.label ?? id;
}

// Single source of a faction's display COLOR — the fleet sprite tint (and the ship
// card's faction line). A literal sRGB hex; with ColorManagement OFF it renders
// verbatim through both the canvas painter and the scene shaders. White fallback only
// guards a future retired tombstone (color is required on a live def).
export function factionColor(id: FactionType): string {
  return FACTION_BY_ID.get(id)?.color ?? '#ffffff';
}

// The localStorage save contract: every factionId that has ever shipped. HISTORICAL
// wire strings, deliberately NOT typed as the live FactionType union — so renaming a
// shipped faction can't quietly re-green the guard under compiler pressure. The CI
// test (test/registry.test.ts) asserts each entry is still a live type
// (FACTION_TYPES.has), so removing OR renaming a shipped id fails, protecting old
// saves from a compiler-invisible "cleanup".
export const FROZEN_FACTION_IDS: readonly string[] = ['player', 'rival'];

// DEV-only module-load invariant: each def's `id` equals its registry key, and every
// frozen id is still a live type. Mirrors the ships + facilities + catalog drift
// checks — loud in dev, stripped in prod, irrelevant under node tests (which assert
// the same facts explicitly). import.meta.env is undefined outside Vite, hence the
// optional chain.
if (import.meta.env?.DEV) {
  for (const [key, def] of Object.entries(DEFS)) {
    if (def.id !== key) {
      throw new Error(`[factions] def keyed '${key}' declares id '${def.id}'`);
    }
  }
  for (const id of FROZEN_FACTION_IDS) {
    if (!FACTION_TYPES.has(id)) {
      throw new Error(`[factions] frozen id '${id}' is no longer a live type — old saves would break`);
    }
  }
}
