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
import { SHIP_COMPONENT_TYPES } from './ships/components/registry.ts';
import type { ShipComponentType } from './ships/components/types.ts';
import { pruneMissingBodies, type BodyKeyed } from './world-overlay.ts';

export interface Facility {
  // Unique within this save (allocated from GameState.seq).
  readonly id: string;
  // The catalog Body.id this facility sits on — stable, serializable.
  readonly bodyId: string;
  readonly type: FacilityType;
}

// Which faction OWNS a body — the gating overlay M3 adds so a body can be enemy-held (an
// enemy colony to bombard) and so the economy fan-in can refuse to feed a body the player
// doesn't control. Rides the BodyKeyed primitives (pruneMissingBodies / recordsOnBody)
// exactly like Facility. Player INTENT (a placed facility) stays SEPARATE from ALLEGIANCE:
// factionId lives here, never on Facility — conflating them would force an economy branch on
// the wrong field. A body with no record reads as controlled-by-player (see
// game-state.ts ownerFactionId), so an old save with no `ownership` key keeps working.
export interface BodyOwnership extends BodyKeyed {
  readonly factionId: FactionType;
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
  // The ship's ORDERED module list — its authoritative configuration (there are no ship CLASSES; a ship
  // IS its modules). Persisted here, never derived from a class. Order is authoring/display order (the
  // eventual silhouette assembly reads it); for combat + the menu it is a multiset (loadout derivation
  // merges identical modules). Validated on load against SHIP_COMPONENT_TYPES — any unknown id drops the
  // whole ship (an unknown loadout has undefined capabilities).
  readonly components: readonly ShipComponentType[];
  // Auto-generated at creation; the ship card reads it.
  readonly name: string;
  readonly status: 'building' | 'ready' | 'transiting';
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
  // Transit fields, required iff 'transiting' — the movement twin of the build-only fields. `systemId`
  // keeps the ORIGIN until arrival (every 'ready' filter already excludes a transiting ship from
  // rosters/menus/combat), so both endpoints of the trip stay known and a stale order can demote cleanly.
  //   - destinationSystemId: the system handle the ship warps to (arrival makes it the new systemId).
  //   - arrivesOnTurn: the absolute turn it flips back to 'ready' at the destination — the same
  //     replay-safe threshold compare as completesOnTurn.
  //   - departedOnTurn: the turn it left; stored from day one so the galaxy transit marker's step-midpoint
  //     position is exact (never recomputed) and a future recall can price the return leg.
  readonly destinationSystemId?: string;
  readonly arrivesOnTurn?: number;
  readonly departedOnTurn?: number;
}

// A ship that completed its warp this turn — emitted by advanceShipTransits for the caller to surface
// (the arrival notification seam + the warp-in FX). Faction-carrying so the rival-mover substrate reuses
// the exact stream with no player assumption; systemId is the destination it arrived at.
export interface ArrivalEvent {
  readonly shipId: string;
  readonly factionId: FactionType;
  readonly systemId: string;
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
  // Per-body ownership overlay (M3). A body with no record reads as controlled-by-player
  // (game-state.ts ownerFactionId), so an old save with no `ownership` key — and any body
  // never explicitly flipped — keeps the single-player economy working untouched.
  ownership: readonly BodyOwnership[];
}

export const DEFAULTS: GameState = { version: 1, turn: 1, seq: 0, facilities: [], ships: [], ownership: [] };

function isValidFacility(f: unknown): f is Facility {
  if (!f || typeof f !== 'object') return false;
  const o = f as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.bodyId === 'string'
    && typeof o.type === 'string' && FACILITY_TYPES.has(o.type);
}

function isValidBodyOwnership(o: unknown): o is BodyOwnership {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  // An unknown factionId is DROPPED rather than defaulted: a dropped record reads as
  // "unowned → player", the same safe single-player default a missing record gives, so
  // there is nothing to merge toward (unlike a ship, which must survive with a defaulted side).
  return typeof r.bodyId === 'string'
    && typeof r.factionId === 'string' && FACTION_TYPES.has(r.factionId);
}

const isCompletionTurn = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1;

function isValidShip(s: unknown): s is ParsedShip {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o.id !== 'string') return false;
  if (typeof o.systemId !== 'string') return false;
  // Components: a NON-EMPTY array of known module ids. All-or-nothing — drop the whole ship on any unknown
  // id rather than filter, since a ship with a tampered/corrupt loadout has undefined capabilities
  // (energyMax, actions) and is safer absent than silently de-fanged. Empty is rejected: no authoring path
  // produces it, so it can only be corruption, and the encounter assumes every ready ship is a real actor.
  if (!Array.isArray(o.components) || o.components.length === 0) return false;
  if (!o.components.every((c) => typeof c === 'string' && SHIP_COMPONENT_TYPES.has(c))) return false;
  if (typeof o.name !== 'string') return false;
  if (o.status !== 'building' && o.status !== 'ready' && o.status !== 'transiting') return false;
  // Build-only fields: a 'building' ship MUST carry a well-formed shipyard + completion
  // turn (the in-progress machinery depends on both); a non-building ship MAY omit them, but
  // a present value still has to be well-formed.
  if (o.status === 'building') {
    if (typeof o.shipyardBodyId !== 'string') return false;
    if (!isCompletionTurn(o.completesOnTurn)) return false;
  } else {
    if (o.shipyardBodyId !== undefined && typeof o.shipyardBodyId !== 'string') return false;
    if (o.completesOnTurn !== undefined && !isCompletionTurn(o.completesOnTurn)) return false;
  }
  // Transit fields: a 'transiting' ship MUST carry a well-formed destination + arrival turn (the
  // movement twin of the build-only invariant); a non-transiting ship MAY omit them, but a present
  // value still has to be well-formed. departedOnTurn is optional even while transiting (an older
  // in-flight order predating the field must still load).
  if (o.status === 'transiting') {
    if (typeof o.destinationSystemId !== 'string') return false;
    if (!isCompletionTurn(o.arrivesOnTurn)) return false;
    if (o.departedOnTurn !== undefined && !isCompletionTurn(o.departedOnTurn)) return false;
  } else {
    if (o.destinationSystemId !== undefined && typeof o.destinationSystemId !== 'string') return false;
    if (o.arrivesOnTurn !== undefined && !isCompletionTurn(o.arrivesOnTurn)) return false;
    if (o.departedOnTurn !== undefined && !isCompletionTurn(o.departedOnTurn)) return false;
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
): { state: GameState; droppedFacilities: number; droppedShips: number; droppedOwnership: number; demotedTransits: number } {
  if (!raw) return { state: { ...DEFAULTS }, droppedFacilities: 0, droppedShips: 0, droppedOwnership: 0, demotedTransits: 0 };
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
    // A transiting ship whose DESTINATION the rebuilt catalog no longer carries demotes to
    // ready-at-origin (the ship is intact — only the order is stale), unlike a building ship whose
    // vanished yard reaps it: the destination is a target, not a home, so losing it costs the order,
    // not the ship. Counted separately so the caller can DEV-warn the way it does for drops.
    let demotedTransits = 0;
    const ships = rawShips
      .filter(isValidShip)
      .map((s): Ship => {
        const factionId = typeof s.factionId === 'string' && FACTION_TYPES.has(s.factionId)
          ? (s.factionId as FactionType)
          : CONTROLLED_FACTION_ID;
        if (s.status === 'transiting' && s.destinationSystemId !== undefined && !systemExists(s.destinationSystemId)) {
          demotedTransits++;
          // A clean ready ship at the origin — no transit residue. systemId already holds the origin,
          // which the filter below re-checks.
          return { id: s.id, systemId: s.systemId, factionId, components: s.components, name: s.name, status: 'ready' };
        }
        return { ...s, factionId };
      })
      .filter((s) => systemExists(s.systemId)
        && (s.status !== 'building' || (s.shipyardBodyId !== undefined && bodyExists(s.shipyardBodyId))));
    const droppedShips = rawShips.length - ships.length;
    // Body ownership: the same shape gate + skip-on-missing prune as facilities (a missing
    // `ownership` key reads as the empty overlay → every body player-owned). droppedOwnership
    // counts malformed + unknown-faction + unknown-body together.
    const rawOwnership = Array.isArray(parsed.ownership) ? parsed.ownership : [];
    const ownership = pruneMissingBodies(rawOwnership.filter(isValidBodyOwnership), bodyExists);
    const droppedOwnership = rawOwnership.length - ownership.length;
    // Turns are 1-based; seq is a non-negative counter. A corrupt/missing value
    // reads as the default (validate-and-merge), so an old save lacking a field
    // is fine.
    const seq = typeof parsed.seq === 'number' && parsed.seq >= 0 ? Math.floor(parsed.seq) : 0;
    const turn = typeof parsed.turn === 'number' && parsed.turn >= 1 ? Math.floor(parsed.turn) : 1;
    return { state: { version: 1, turn, seq, facilities, ships, ownership }, droppedFacilities, droppedShips, droppedOwnership, demotedTransits };
  } catch {
    return { state: { ...DEFAULTS }, droppedFacilities: 0, droppedShips: 0, droppedOwnership: 0, demotedTransits: 0 };
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

// Pure transit-stepper kernel: flip every 'transiting' ship that has reached its arrivesOnTurn to
// 'ready' at its destination, dropping the transit fields, and emit an ArrivalEvent per flip. The pure
// sibling of advanceShipBuilds — same threshold compare (turn >= arrivesOnTurn, never a decrement, so a
// skipped/double-fired turn can't desync) and same-ref skip. Returns the SAME array reference (and an
// empty arrivals list) when nothing is due, so the caller skips a redundant write. An arrived ship is
// rebuilt as a clean 'ready' record (no transit/build residue) at its destination system.
export function advanceShipTransits(
  ships: readonly Ship[],
  turn: number,
): { ships: readonly Ship[]; arrivals: readonly ArrivalEvent[] } {
  let changed = false;
  const arrivals: ArrivalEvent[] = [];
  const next = ships.map((s) => {
    // destinationSystemId/arrivesOnTurn are always present on a 'transiting' ship (the validator + every
    // order site enforce it); the undefined guards only satisfy the optional type.
    if (
      s.status === 'transiting'
      && s.destinationSystemId !== undefined
      && s.arrivesOnTurn !== undefined
      && turn >= s.arrivesOnTurn
    ) {
      changed = true;
      arrivals.push({ shipId: s.id, factionId: s.factionId, systemId: s.destinationSystemId });
      return { id: s.id, systemId: s.destinationSystemId, factionId: s.factionId, components: s.components, name: s.name, status: 'ready' as const };
    }
    return s;
  });
  return { ships: changed ? next : ships, arrivals };
}

// The in-flight build at a yard, if any — the pure kernel behind both the
// one-build-per-yard cap (startShipBuild refuses when this is set) and the sidebar's
// in-progress readout. Pure over the array so the cap is node-testable.
export function buildingShipAt(ships: readonly Ship[], shipyardBodyId: string): Ship | undefined {
  return ships.find((s) => s.status === 'building' && s.shipyardBodyId === shipyardBodyId);
}
