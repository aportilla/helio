// Pure parse/validate-and-merge for the helio.game save, extracted from
// game-state.ts so the reader logic — skip-on-missing facilities, turn/seq
// flooring, corrupt-blob fallback — is node-testable without localStorage or the
// catalog. The caller injects the raw string and a body-existence predicate; this
// module touches no globals. (Imports the registry's frozen type set directly,
// not the barrel, so it loads under `node --test`.)

import { FACILITY_TYPES } from './facilities/registry.ts';
import type { FacilityType } from './facilities/types.ts';
import { pruneMissingBodies } from './world-overlay.ts';

export interface Facility {
  // Unique within this save (allocated from GameState.seq).
  readonly id: string;
  // The catalog Body.id this facility sits on — stable, serializable.
  readonly bodyId: string;
  readonly type: FacilityType;
}

export interface GameState {
  version: 1;
  // The player's current turn, 1-based.
  turn: number;
  // Monotonic counter backing Facility.id allocation — stable, trivially unique.
  seq: number;
  facilities: readonly Facility[];
}

export const DEFAULTS: GameState = { version: 1, turn: 1, seq: 0, facilities: [] };

function isValidFacility(f: unknown): f is Facility {
  if (!f || typeof f !== 'object') return false;
  const o = f as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.bodyId === 'string'
    && typeof o.type === 'string' && FACILITY_TYPES.has(o.type);
}

// Parse a stored helio.game blob into a validated GameState, merging over
// DEFAULTS so adding fields later can't invalidate an old save. `bodyExists` is
// the skip-on-missing gate: a facility whose body the rebuilt catalog no longer
// contains (a PROCGEN_VERSION bump / CSV id change) is dropped — never fatal.
// Returns the merged state plus how many facilities were dropped (so the caller
// can DEV-warn). A null/empty or corrupt blob yields fresh DEFAULTS.
export function parseGameState(
  raw: string | null,
  bodyExists: (bodyId: string) => boolean,
): { state: GameState; droppedFacilities: number } {
  if (!raw) return { state: { ...DEFAULTS }, droppedFacilities: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<GameState>;
    const rawFacilities = Array.isArray(parsed.facilities) ? parsed.facilities : [];
    // First the facility-shape gate, then the generic skip-on-missing prune; the
    // dropped count covers BOTH (malformed + unknown-body).
    const facilities = pruneMissingBodies(rawFacilities.filter(isValidFacility), bodyExists);
    const droppedFacilities = rawFacilities.length - facilities.length;
    // Turns are 1-based; seq is a non-negative counter. A corrupt/missing value
    // reads as the default (validate-and-merge), so an old save lacking a field
    // is fine.
    const seq = typeof parsed.seq === 'number' && parsed.seq >= 0 ? Math.floor(parsed.seq) : 0;
    const turn = typeof parsed.turn === 'number' && parsed.turn >= 1 ? Math.floor(parsed.turn) : 1;
    return { state: { version: 1, turn, seq, facilities }, droppedFacilities };
  } catch {
    return { state: { ...DEFAULTS }, droppedFacilities: 0 };
  }
}
