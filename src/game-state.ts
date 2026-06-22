// Persisted game state — the first real save in Helio (distinct from
// src/settings.ts, which holds user *preferences*). Same hardening as
// settings: a single namespaced localStorage key, a versioned JSON blob,
// validate-and-merge-over-defaults reads so adding fields later can't
// invalidate an old save, and writes that swallow localStorage failures
// (private browsing, quota) so the session still works, it just won't
// persist.
//
// The save stores player *intent* — a facility sits on this body, a ship belongs
// to this system — each keyed by a stable catalog anchor: facilities by Body.id,
// ships by their system handle (the cluster-primary slug), because a ship is a peer
// of planets, not an appendage. Plus the current turn number, the player's progress
// through the game. It deliberately stores no economic behavior: what a colony
// produces/consumes is the sim's concern, derived later by projecting facilities
// into the node-contributor seam (the standalone sim under sim/), never baked into
// this blob. So adding the economy won't reshape this file.
//
// MULTI-SLOT SEAM: the active save's storage location resolves through
// storage.slotKey('game'). Multiple save slots (with a new-game / load-game
// splash) become slotKey('game', activeSlot) — the GameState shape and the API
// below stay put. The game + sim saves cross-reference by Body.id, so a slot
// switch scopes both from that one resolver (see ./storage).

import { indexOfBodyId, systemExists, systemIdForBodyId } from './data/stars';
import { ADD_ORDER, FACILITY_BY_TYPE, facilityHasShipbuilding, type FacilityType } from './facilities';
import {
  advanceShipBuilds,
  buildingShipAt,
  parseGameState,
  type Facility,
  type GameState,
  type Ship,
} from './game-state-codec';
import { shipClassLabel } from './ships/registry';
import type { ShipClassType } from './ships/types';
import { slotKey, readRaw, writeRaw } from './storage';
import { recordsOnBody } from './world-overlay';

// The save SHAPE (Facility / GameState / Ship) and the pure parse/validate-and-merge
// reader live in ./game-state-codec (node-testable, no globals); this module owns
// the live in-memory state, the localStorage I/O, and the mutators. Re-export the
// shape so existing `import type { Facility } from './game-state'` callers hold.
export type { Facility, GameState, Ship } from './game-state-codec';

const STORAGE_KEY = slotKey('game');

function readFromStorage(): GameState {
  // parseGameState handles a null raw (absent key / disabled storage) → defaults,
  // and applies the skip-on-missing gate: a facility whose body a catalog rebuild
  // (PROCGEN_VERSION bump / CSV id change) no longer contains is dropped, never fatal.
  const { state, droppedFacilities, droppedShips } = parseGameState(
    readRaw(STORAGE_KEY),
    (id) => indexOfBodyId(id) >= 0,
    (id) => systemExists(id),
  );
  if (import.meta.env.DEV && droppedFacilities > 0) {
    console.warn(`[game-state] dropped ${droppedFacilities} facilit${droppedFacilities === 1 ? 'y' : 'ies'} with an unknown/invalid body id`);
  }
  if (import.meta.env.DEV && droppedShips > 0) {
    console.warn(`[game-state] dropped ${droppedShips} ship${droppedShips === 1 ? '' : 's'} with a missing system or shipyard`);
  }
  return state;
}

function writeToStorage(s: GameState): void {
  writeRaw(STORAGE_KEY, JSON.stringify(s));
}

let current: GameState = readFromStorage();

export function getGameState(): Readonly<GameState> {
  return current;
}

export function facilitiesOnBody(bodyId: string): readonly Facility[] {
  return recordsOnBody(current.facilities, bodyId);
}

// Place a facility, or return null if the body is already at the per-(body, type)
// build cap (FacilityDef.maxPerBody). The UI hides the Add button at cap; this is
// the defensive backstop so no path can exceed it.
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
  const removed = current.facilities.find((f) => f.id === id);
  if (!removed) return;
  const facilities = current.facilities.filter((f) => f.id !== id);
  // If that was the body's LAST shipyard, reap its in-flight builds — a 'building'
  // ship anchored to a yard that no longer exists is a zombie. A 'ready' ship is
  // independent of its birth yard and survives. Ask the registry (the capability
  // flag), never an inline 'shipyard' check.
  const wasShipyard = FACILITY_BY_TYPE.get(removed.type)?.enablesShipbuilding === true;
  const yardRemains = facilityHasShipbuilding(facilities.filter((f) => f.bodyId === removed.bodyId));
  const ships = wasShipyard && !yardRemains
    ? current.ships.filter((s) => !(s.status === 'building' && s.shipyardBodyId === removed.bodyId))
    : current.ships;
  current = { ...current, facilities, ships };
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

// =============================================================================
// Ships — durable fleet records. Same mutator discipline as facilities: read-fresh
// from `current`, rebuild immutably, write through once. Ship.id draws from the SAME
// seq counter as Facility.id (the 's'/'f' prefix disambiguates).
// =============================================================================

// Start a time-only build at a shipyard. Returns the new 'building' ship, or null if
// the yard already has a build in flight (the one-build-per-yard cap) or the body is
// no longer in the catalog. `completesOnTurn` is computed by the caller
// (getGameState().turn + buildTurns(classId)). The ship is keyed to its SYSTEM, not
// the shipyard's planet, so it outlives that planet.
export function startShipBuild(
  shipyardBodyId: string,
  classId: ShipClassType,
  completesOnTurn: number,
): Ship | null {
  if (buildingShipAt(current.ships, shipyardBodyId)) return null;
  const systemId = systemIdForBodyId(shipyardBodyId);
  if (systemId === null) return null;

  const seq = current.seq + 1;
  const ship: Ship = {
    id: `s${seq}`,
    systemId,
    shipyardBodyId,
    classId,
    name: `${shipClassLabel(classId)} ${seq}`,
    status: 'building',
    completesOnTurn,
  };
  current = { ...current, seq, ships: [...current.ships, ship] };
  writeToStorage(current);
  return ship;
}

// Destroy a ship record — the write-back for a user-initiated build cancel (cost is
// time-only, so there is nothing to refund). No-op (no spurious write) if absent.
export function removeShip(id: string): void {
  if (!current.ships.some((s) => s.id === id)) return;
  current = { ...current, ships: current.ships.filter((s) => s.id !== id) };
  writeToStorage(current);
}

// Every ship in a system (both 'building' and 'ready') — the fleet read; the caller
// filters to 'ready' for the render layer. Keyed by the stable system slug.
export function shipsInSystem(systemId: string): readonly Ship[] {
  return current.ships.filter((s) => s.systemId === systemId);
}

// The in-flight build at a yard, if any — drives the sidebar's in-progress readout
// (class + turns-remaining) and the one-build-per-yard gate.
export function buildingShipAtYard(bodyId: string): Ship | undefined {
  return buildingShipAt(current.ships, bodyId);
}

// The build turn-phase: flip every 'building' ship that has reached completesOnTurn
// to 'ready', persisting once. Attaches in AppController.nextTurn after advanceTurn.
// A no-op write is skipped (advanceShipBuilds returns the same ref when none flip).
export function stepShipBuilds(turn: number): void {
  const ships = advanceShipBuilds(current.ships, turn);
  if (ships === current.ships) return;
  current = { ...current, ships };
  writeToStorage(current);
}
