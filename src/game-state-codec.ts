// Pure parse/validate-and-merge for the helio.game save, extracted from
// game-state.ts so the reader logic — skip-on-missing facilities and ships, turn/seq
// flooring, corrupt-blob fallback — plus the pure ship-build kernels
// (advanceShipBuilds / buildingShipAt) are node-testable without localStorage or the
// catalog. The caller injects the raw string and body- and system-existence
// predicates; this module touches no globals. (Imports the registries' frozen type
// sets directly, not the barrels, so it loads under `node --test`.)

import { FACILITY_TYPES } from './facilities/registry.ts';
import type { FacilityType } from './facilities/types.ts';
import { CONTROLLED_FACTION_ID, FACTION_TYPES } from './factions/registry.ts';
import type { FactionType } from './factions/types.ts';
import { SHIP_CLASS_TYPES } from './ships/registry.ts';
import type { ShipClassType } from './ships/types.ts';
import { pruneMissingBodies } from './world-overlay.ts';

export interface Facility {
  // Unique within this save (allocated from GameState.seq).
  readonly id: string;
  // The catalog Body.id this facility sits on — stable, serializable.
  readonly bodyId: string;
  readonly type: FacilityType;
}

// A built or in-progress ship. Durable player intent, like Facility — but keyed to
// its SYSTEM, never a planet (planets and ships are independently-destroyable peers
// in combat). `systemId` (the cluster primary's stable slug) is where the ship lives
// and what skip-on-missing validates.
export interface Ship {
  // Unique within this save (allocated from the shared GameState.seq, 's'-prefixed).
  readonly id: string;
  // The stable system handle = STARS[cluster.primary].id. Survives any planet's death.
  readonly systemId: string;
  // Whose ship — the side that owns it. A pre-faction save (every ship built before
  // ownership existed) reads as CONTROLLED_FACTION_ID via validate-and-merge.
  readonly factionId: FactionType;
  readonly classId: ShipClassType;
  // Auto-generated at creation; the ship card reads it.
  readonly name: string;
  readonly status: 'building' | 'ready';
  // Build-only fields, present iff 'building'. A 'ready' ship omits both — a finished
  // build no longer needs them, and a ship that NEVER built (a bootstrapped opponent
  // dropped straight into a system) never had them.
  //   - shipyardBodyId: the building yard's catalog Body.id — drives the in-progress
  //     readout, the one-build-per-yard cap, and yard-removal reaping.
  //   - completesOnTurn: the absolute turn the build flips to 'ready' — a replay-safe
  //     threshold compare, not a per-turn decrement (a skipped/double-fired turn can't
  //     desync two stored ints).
  readonly shipyardBodyId?: string;
  readonly completesOnTurn?: number;
}

// The on-disk ship shape after STRUCTURAL validation but before factionId is
// normalized — factionId is validate-and-merged (defaulted), never gated, so a
// pre-faction or corrupt value can't drop an otherwise-valid ship.
type ParsedShip = Omit<Ship, 'factionId'> & { readonly factionId?: unknown };

export interface GameState {
  version: 1;
  // The player's current turn, 1-based.
  turn: number;
  // Monotonic counter backing Facility.id AND Ship.id allocation — one shared
  // counter; the 'f'/'s' prefix disambiguates. Stable, trivially unique.
  seq: number;
  facilities: readonly Facility[];
  ships: readonly Ship[];
}

export const DEFAULTS: GameState = { version: 1, turn: 1, seq: 0, facilities: [], ships: [] };

function isValidFacility(f: unknown): f is Facility {
  if (!f || typeof f !== 'object') return false;
  const o = f as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.bodyId === 'string'
    && typeof o.type === 'string' && FACILITY_TYPES.has(o.type);
}

const isCompletionTurn = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1;

function isValidShip(s: unknown): s is ParsedShip {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o.id !== 'string') return false;
  if (typeof o.systemId !== 'string') return false;
  if (typeof o.classId !== 'string' || !SHIP_CLASS_TYPES.has(o.classId)) return false;
  if (typeof o.name !== 'string') return false;
  if (o.status !== 'building' && o.status !== 'ready') return false;
  // Build-only fields: a 'building' ship MUST carry a well-formed shipyard + completion
  // turn (the in-progress machinery depends on both); a 'ready' ship MAY omit them, but
  // a present value still has to be well-formed.
  if (o.status === 'building') {
    if (typeof o.shipyardBodyId !== 'string') return false;
    if (!isCompletionTurn(o.completesOnTurn)) return false;
  } else {
    if (o.shipyardBodyId !== undefined && typeof o.shipyardBodyId !== 'string') return false;
    if (o.completesOnTurn !== undefined && !isCompletionTurn(o.completesOnTurn)) return false;
  }
  // factionId is validate-and-merged (defaulted) by the caller, never gated here.
  return true;
}

// Parse a stored helio.game blob into a validated GameState, merging over
// DEFAULTS so adding fields later can't invalidate an old save. `bodyExists` and
// `systemExists` are the skip-on-missing gates: a record whose catalog anchor a
// rebuild (PROCGEN_VERSION bump / CSV id change) no longer contains is dropped —
// never fatal. Returns the merged state plus how many facilities and ships were
// dropped (so the caller can DEV-warn). A null/empty or corrupt blob yields fresh
// DEFAULTS.
export function parseGameState(
  raw: string | null,
  bodyExists: (bodyId: string) => boolean,
  systemExists: (systemId: string) => boolean,
): { state: GameState; droppedFacilities: number; droppedShips: number } {
  if (!raw) return { state: { ...DEFAULTS }, droppedFacilities: 0, droppedShips: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<GameState>;
    const rawFacilities = Array.isArray(parsed.facilities) ? parsed.facilities : [];
    // First the facility-shape gate, then the generic skip-on-missing prune; the
    // dropped count covers BOTH (malformed + unknown-body).
    const facilities = pruneMissingBodies(rawFacilities.filter(isValidFacility), bodyExists);
    const droppedFacilities = rawFacilities.length - facilities.length;
    // Ships use a BESPOKE prune, not pruneMissingBodies — a ship carries a system
    // dimension the BodyKeyed helper can't model: drop on a missing SYSTEM; drop a
    // still-'building' ship whose shipyard body is gone (its yard vanished mid-build
    // — a zombie build); KEEP a 'ready' ship even when its birth yard is gone (a
    // ready ship is independent of the planet that built it). factionId is normalized
    // here (validate-and-merge): a missing or unknown side defaults to the controlled
    // faction, so adding ownership can't drop a pre-faction ship. droppedShips, like
    // droppedFacilities, counts malformed + pruned together.
    const rawShips = Array.isArray(parsed.ships) ? parsed.ships : [];
    const ships = rawShips
      .filter(isValidShip)
      .map((s): Ship => ({
        ...s,
        factionId: typeof s.factionId === 'string' && FACTION_TYPES.has(s.factionId)
          ? (s.factionId as FactionType)
          : CONTROLLED_FACTION_ID,
      }))
      .filter((s) => systemExists(s.systemId)
        && (s.status !== 'building' || (s.shipyardBodyId !== undefined && bodyExists(s.shipyardBodyId))));
    const droppedShips = rawShips.length - ships.length;
    // Turns are 1-based; seq is a non-negative counter. A corrupt/missing value
    // reads as the default (validate-and-merge), so an old save lacking a field
    // is fine.
    const seq = typeof parsed.seq === 'number' && parsed.seq >= 0 ? Math.floor(parsed.seq) : 0;
    const turn = typeof parsed.turn === 'number' && parsed.turn >= 1 ? Math.floor(parsed.turn) : 1;
    return { state: { version: 1, turn, seq, facilities, ships }, droppedFacilities, droppedShips };
  } catch {
    return { state: { ...DEFAULTS }, droppedFacilities: 0, droppedShips: 0 };
  }
}

// Pure build-stepper kernel: flip every 'building' ship that has reached its
// completesOnTurn to 'ready'. A pure function over the array (no globals) so the
// turn-phase logic is node-testable the way parseGameState is. Returns the SAME
// array reference when nothing flips, so the caller can skip a redundant write.
// Completion is the threshold compare `turn >= completesOnTurn`, never a decrement
// — idempotent under a double-fired or skipped turn (cross-cutting determinism).
export function advanceShipBuilds(ships: readonly Ship[], turn: number): readonly Ship[] {
  let changed = false;
  const next = ships.map((s) => {
    // completesOnTurn is always present on a 'building' ship (the validator + every
    // construction site enforce it); the undefined guard only satisfies the optional
    // type — a building ship without one simply never completes, never throws.
    if (s.status === 'building' && s.completesOnTurn !== undefined && turn >= s.completesOnTurn) {
      changed = true;
      return { ...s, status: 'ready' as const };
    }
    return s;
  });
  return changed ? next : ships;
}

// The in-flight build at a yard, if any — the pure kernel behind both the
// one-build-per-yard cap (startShipBuild refuses when this is set) and the sidebar's
// in-progress readout. Pure over the array so the cap is node-testable.
export function buildingShipAt(ships: readonly Ship[], shipyardBodyId: string): Ship | undefined {
  return ships.find((s) => s.status === 'building' && s.shipyardBodyId === shipyardBodyId);
}
