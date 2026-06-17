// Persisted game state — the first real save in Helio (distinct from
// src/settings.ts, which holds user *preferences*). Same hardening as
// settings: a single namespaced localStorage key, a versioned JSON blob,
// validate-and-merge-over-defaults reads so adding fields later can't
// invalidate an old save, and writes that swallow localStorage failures
// (private browsing, quota) so the session still works, it just won't
// persist.
//
// The save stores player *intent* — "a colony sits on this body" — keyed by
// the stable catalog Body.id (§2 of the first-light plan), plus the current
// turn number, the player's progress through the game. It deliberately
// stores no economic behavior: what a colony produces/consumes is the sim's
// concern, derived later by projecting facilities into the node-contributor
// seam (the standalone sim under sim/), never baked into this blob. So adding
// the economy won't reshape this file.
//
// MULTI-SLOT SEAM: STORAGE_KEY is the single point where the active save's
// storage location is resolved. Multiple save slots (with a new-game /
// load-game splash) become "make the key slot-scoped + add a slot index"
// here — the GameState shape and the API below stay put.

import { indexOfBodyId } from './data/stars';
import { ADD_ORDER, FACILITY_BY_TYPE, FACILITY_TYPES, type FacilityType } from './facilities';

// FacilityType + its validation set now live in the facilities registry (the
// single source of truth for everything about a facility). game-state owns only
// the SAVE shape — what persists in 'helio.game'.

export interface Facility {
  // Unique within this save (allocated from GameState.seq).
  readonly id: string;
  // The catalog Body.id this facility sits on — stable, serializable.
  readonly bodyId: string;
  readonly type: FacilityType;
}

export interface GameState {
  version: 1;
  // The player's current turn, 1-based. Advanced by advanceTurn() and persisted so
  // a reload resumes the same turn. A plain integer — no Math.random/Date (this is
  // not the deterministic sim).
  turn: number;
  // Monotonic counter backing Facility.id allocation — stable across reloads,
  // trivially unique, no Math.random/Date (this isn't the deterministic sim).
  seq: number;
  facilities: readonly Facility[];
}

const STORAGE_KEY = 'helio.game';
const DEFAULTS: GameState = { version: 1, turn: 1, seq: 0, facilities: [] };

function isValidFacility(f: unknown): f is Facility {
  if (!f || typeof f !== 'object') return false;
  const o = f as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.bodyId === 'string'
    && typeof o.type === 'string' && FACILITY_TYPES.has(o.type);
}

function readFromStorage(): GameState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<GameState>;
    const rawFacilities = Array.isArray(parsed.facilities) ? parsed.facilities : [];
    // Skip-on-missing: drop any facility that's malformed or whose body the
    // rebuilt catalog no longer contains (a PROCGEN_VERSION bump / CSV id
    // change). Never fatal — a placeholder colony is not worth crashing a load.
    const facilities = rawFacilities.filter(isValidFacility).filter(f => indexOfBodyId(f.bodyId) >= 0);
    const dropped = rawFacilities.length - facilities.length;
    if (import.meta.env.DEV && dropped > 0) {
      console.warn(`[game-state] dropped ${dropped} facilit${dropped === 1 ? 'y' : 'ies'} with an unknown/invalid body id`);
    }
    const seq = typeof parsed.seq === 'number' && parsed.seq >= 0 ? Math.floor(parsed.seq) : 0;
    // Turns are 1-based; an old save (or a corrupt value) reads as turn 1. Adding
    // this field needs no version bump — reads merge over DEFAULTS (validate-and-merge).
    const turn = typeof parsed.turn === 'number' && parsed.turn >= 1 ? Math.floor(parsed.turn) : 1;
    return { version: 1, turn, seq, facilities };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeToStorage(s: GameState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage disabled or full — state still applies this session, it
    // just won't persist. No recovery; swallow (mirrors settings.ts).
  }
}

let current: GameState = readFromStorage();

export function getGameState(): Readonly<GameState> {
  return current;
}

export function facilitiesOnBody(bodyId: string): readonly Facility[] {
  return current.facilities.filter(f => f.bodyId === bodyId);
}

// Place a facility, or return null if the body is already at the per-(body, type)
// build cap (FacilityDef.maxPerBody). The UI hides the Add button at cap; this is
// the defensive backstop so no path can exceed it (plan §10).
export function addFacility(bodyId: string, type: FacilityType): Facility | null {
  const cap = FACILITY_BY_TYPE.get(type)?.maxPerBody ?? 1;
  const placed = current.facilities.filter((f) => f.bodyId === bodyId && f.type === type).length;
  if (placed >= cap) return null;

  const seq = current.seq + 1;
  const facility: Facility = { id: `f${seq}`, bodyId, type };
  current = { ...current, seq, facilities: [...current.facilities, facility] };
  writeToStorage(current);
  return facility;
}

export function removeFacility(id: string): void {
  if (!current.facilities.some(f => f.id === id)) return;
  current = { ...current, facilities: current.facilities.filter(f => f.id !== id) };
  writeToStorage(current);
}

// Advance the game's turn counter by one and persist. This is the turn-state half
// only — bumping the saved scalar; the economy sim is stepped alongside it in
// AppController.onNextTurn (EconomyBridge.step, then the sidebar re-reads its
// balances). Kept separate so this save's shape and the sim's own save stay
// independent. Returns the new turn.
export function advanceTurn(): number {
  current = { ...current, turn: current.turn + 1 };
  writeToStorage(current);
  return current.turn;
}

// Per-type facility tallies for the galaxy civ summary. Seeded in ADD_ORDER so the
// display order is stable and every buildable type is present (0 when none built).
// This is the only honest civilization-level aggregate today — no economy implied.
export function facilityCounts(): ReadonlyMap<FacilityType, number> {
  const counts = new Map<FacilityType, number>();
  for (const type of ADD_ORDER) counts.set(type, 0);
  for (const f of current.facilities) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  return counts;
}
