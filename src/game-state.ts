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

import { clusterDistanceMilliLy, clusterIndexForSystemId, indexOfBodyId, systemExists, systemIdForBodyId } from './data/stars';
import { FACILITY_BY_TYPE, facilityHasShipbuilding, type FacilityType } from './facilities';
import {
  advanceShipBuilds,
  advanceShipTransits,
  buildingShipAt,
  parseGameState,
  type ArrivalEvent,
  type BodyOwnership,
  type Facility,
  type GameState,
  type Ship,
} from './game-state-codec';
import { CONTROLLED_FACTION_ID, FACTION_DEFS } from './factions/registry';
import type { FactionType } from './factions/types';
import { DEMO_SHIP_LOADOUT, shipWarpRangeMilliLy, warpTravelTurns } from './ships/components/registry';
import type { ShipComponentType } from './ships/components/types';
import { slotKey, readRaw, writeRaw, removeRaw } from './storage';
import { recordsOnBody } from './world-overlay';

// The save SHAPE (Facility / GameState / Ship) and the pure parse/validate-and-merge
// reader live in ./game-state-codec (node-testable, no globals); this module owns
// the live in-memory state, the localStorage I/O, and the mutators. Re-export the
// shape so existing `import type { Facility } from './game-state'` callers hold.
export type { ArrivalEvent, Facility, GameState, Ship } from './game-state-codec';

const STORAGE_KEY = slotKey('game');

function readFromStorage(): GameState {
  // parseGameState handles a null raw (absent key / disabled storage) → defaults,
  // and applies the skip-on-missing gate: a facility whose body a catalog rebuild
  // (PROCGEN_VERSION bump / CSV id change) no longer contains is dropped, never fatal.
  const { state, droppedFacilities, droppedShips, droppedOwnership, demotedTransits } = parseGameState(
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
  if (import.meta.env.DEV && droppedOwnership > 0) {
    console.warn(`[game-state] dropped ${droppedOwnership} body-ownership record${droppedOwnership === 1 ? '' : 's'} with an unknown body/faction`);
  }
  if (import.meta.env.DEV && demotedTransits > 0) {
    console.warn(`[game-state] demoted ${demotedTransits} transiting ship${demotedTransits === 1 ? '' : 's'} whose destination is gone (order dropped, ship kept at origin)`);
  }
  return state;
}

function writeToStorage(s: GameState): void {
  writeRaw(STORAGE_KEY, JSON.stringify(s));
}

// Delete the persisted game save (turn / facilities / ships / ownership) — the game-state half of a full
// reset. Does NOT touch the live in-memory `current`; the caller reloads the page so boot re-reads the
// now-absent key and parseGameState falls back to DEFAULTS (a fresh game). The sim save (`helio.sim`) is a
// separate key cleared by its own owner (economy-bridge `clearSimSave`); user settings are a third key,
// deliberately kept (a reset wipes the GAME, not your display preferences).
export function clearGameSave(): void {
  removeRaw(STORAGE_KEY);
}

let current: GameState = readFromStorage();

export function getGameState(): Readonly<GameState> {
  return current;
}

export function facilitiesOnBody(bodyId: string): readonly Facility[] {
  return recordsOnBody(current.facilities, bodyId);
}

// Which faction owns a body. A body with NO ownership record reads as the CONTROLLED
// faction (the single-player default): every facility-bearing body the player has built is
// theirs unless an explicit record flips it, so the economy fan-in keeps working and only an
// addOpponentBody (or a later capture) marks a body enemy-held. Mirrors the ship side, where
// a pre-faction ship defaults to the controlled faction.
export function ownerFactionId(bodyId: string): FactionType {
  return recordsOnBody(current.ownership, bodyId)[0]?.factionId ?? CONTROLLED_FACTION_ID;
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

// =============================================================================
// Ships — durable fleet records. Same mutator discipline as facilities: read-fresh
// from `current`, rebuild immutably, write through once. Ship.id draws from the SAME
// seq counter as Facility.id (the 's'/'f' prefix disambiguates).
// =============================================================================

// Start a time-only build at a shipyard. Returns the new 'building' ship, or null if
// the yard already has a build in flight (the one-build-per-yard cap) or the body is
// no longer in the catalog. `completesOnTurn` is computed by the caller
// (getGameState().turn + shipBuildTurns(components)). The ship carries its OWN module
// loadout (there are no classes) and is keyed to its SYSTEM, not the shipyard's planet,
// so it outlives that planet.
export function startShipBuild(
  shipyardBodyId: string,
  components: readonly ShipComponentType[],
  completesOnTurn: number,
): Ship | null {
  if (buildingShipAt(current.ships, shipyardBodyId)) return null;
  const systemId = systemIdForBodyId(shipyardBodyId);
  if (systemId === null) return null;

  const seq = current.seq + 1;
  const ship: Ship = {
    id: `s${seq}`,
    systemId,
    factionId: CONTROLLED_FACTION_ID, // the player builds the player's ships
    shipyardBodyId,
    components,
    name: `Ship ${seq}`,
    status: 'building',
    completesOnTurn,
  };
  current = { ...current, seq, ships: [...current.ships, ship] };
  writeToStorage(current);
  return ship;
}

// DEBUG ONLY — drop a 'ready' opponent ship straight into a system, bypassing the
// build flow, to populate the fleet for encounter-combat testing. Generic across any
// system (a ship keys to its system handle); the caller is DEV-gated. The ship spawns
// into the first non-controlled faction and never had a shipyard, so it carries
// neither shipyardBodyId nor completesOnTurn (both build-only). The opponent-side pick
// lives HERE, in the debug path — the faction registry stays free of any "opponent"
// concept. Returns the new ship, or null if the system is unknown. Teardown reuses
// removeShip.
export function addOpponentShip(systemId: string, components: readonly ShipComponentType[] = DEMO_SHIP_LOADOUT): Ship | null {
  if (!systemExists(systemId)) return null;
  const factionId = FACTION_DEFS.find((f) => f.id !== CONTROLLED_FACTION_ID)?.id ?? CONTROLLED_FACTION_ID;
  const seq = current.seq + 1;
  const ship: Ship = {
    id: `s${seq}`,
    systemId,
    factionId,
    components,
    name: `Ship ${seq}`,
    status: 'ready',
  };
  current = { ...current, seq, ships: [...current.ships, ship] };
  writeToStorage(current);
  return ship;
}

// DEBUG ONLY — drop a READY ship for the CONTROLLED faction into a system: the friendly twin of
// addOpponentShip, so a DEV demo can stage a two-side fight (the player has no starting fleet). Same
// build-free ready ship (no shipyard / completesOnTurn); DEV-gated caller. Returns the new ship, or
// null if the system is unknown.
export function addFriendlyShip(systemId: string, components: readonly ShipComponentType[] = DEMO_SHIP_LOADOUT): Ship | null {
  if (!systemExists(systemId)) return null;
  const seq = current.seq + 1;
  const ship: Ship = {
    id: `s${seq}`,
    systemId,
    factionId: CONTROLLED_FACTION_ID,
    components,
    name: `Ship ${seq}`,
    status: 'ready',
  };
  current = { ...current, seq, ships: [...current.ships, ship] };
  writeToStorage(current);
  return ship;
}

// DEBUG ONLY — mark a body as enemy-owned (the first non-controlled faction): the OWNERSHIP
// half of an opponent claim, the body twin of addOpponentShip. It does NOT add a facility —
// the DEV caller composes it with addFacility('colony') to produce a real enemy colony.
// Bypasses any claim/capture flow; the caller is DEV-gated. The opponent-side pick lives HERE
// in the debug path — the faction registry stays free of any "opponent" concept. Replaces any
// existing record for the body (idempotent re-flip). Returns the record, or null if the body
// is unknown to the catalog. NOTE: this writes the overlay ONLY — it does not reproject the
// economy. The ownership gate runs at EconomyBridge.build() time, so a caller that wants a flip
// reflected in the live/preview economy must also trigger the facility-edit reconcile
// (bridge.syncFacilities), exactly as a facility add/remove does.
export function addOpponentBody(bodyId: string): BodyOwnership | null {
  if (indexOfBodyId(bodyId) < 0) return null;
  const factionId = FACTION_DEFS.find((f) => f.id !== CONTROLLED_FACTION_ID)?.id ?? CONTROLLED_FACTION_ID;
  const record: BodyOwnership = { bodyId, factionId };
  const ownership = [...current.ownership.filter((o) => o.bodyId !== bodyId), record];
  current = { ...current, ownership };
  writeToStorage(current);
  return record;
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

// =============================================================================
// Ship movement — galaxy warp. A 'ready' ship warps from its system to another within its drive's
// range, arriving after a distance-priced transit. Same mutator discipline as the build path;
// faction-agnostic (never reads CONTROLLED_FACTION_ID) so a future rival mover drives this exact API.
// =============================================================================

// Order a CONVOY warp: flip every eligible 'ready' ship in `shipIds` to 'transiting' toward
// destinationSystemId, all sharing ONE arrival turn so they travel together — the convoy arrives on the
// SLOWEST member's ETA (max over members of warpTravelTurns), never piecemeal. A member failing the re-check
// (unknown, not 'ready', self-destination, or a destination beyond THAT ship's range — the belt-and-
// suspenders gate the departure pick already applied) is silently skipped, matching startShipBuild's
// defensive null. Mutates existing ships (no seq), stamping departedOnTurn/arrivesOnTurn HERE so the caller
// passes only the destination. Persists once; returns the updated ships (empty ⇒ nothing warped).
export function orderGroupWarp(shipIds: readonly string[], destinationSystemId: string): readonly Ship[] {
  if (!systemExists(destinationSystemId)) return [];
  const destIdx = clusterIndexForSystemId(destinationSystemId);
  if (destIdx < 0) return [];
  const turn = current.turn;
  // Eligible members + each one's OWN transit time to the destination (dist is per-member origin).
  const orders: Array<{ idx: number; eta: number }> = [];
  for (const id of shipIds) {
    const idx = current.ships.findIndex((s) => s.id === id);
    if (idx < 0) continue;
    const s = current.ships[idx]!;
    if (s.status !== 'ready' || destinationSystemId === s.systemId) continue; // not ready / warp-to-self
    const originIdx = clusterIndexForSystemId(s.systemId);
    if (originIdx < 0) continue;
    const dist = clusterDistanceMilliLy(originIdx, destIdx);
    if (dist > shipWarpRangeMilliLy(s.components)) continue; // beyond this ship's range
    orders.push({ idx, eta: warpTravelTurns(dist, s.components) });
  }
  if (orders.length === 0) return [];
  // Convoy arrival: the slowest member sets the shared arrival turn (they arrive together).
  const arrivesOnTurn = turn + Math.max(...orders.map((o) => o.eta));
  const stamp = new Set(orders.map((o) => o.idx));
  const updated: Ship[] = [];
  const ships = current.ships.map((s, i) => {
    if (!stamp.has(i)) return s;
    const u: Ship = { ...s, status: 'transiting', destinationSystemId, arrivesOnTurn, departedOnTurn: turn };
    updated.push(u);
    return u;
  });
  current = { ...current, ships };
  writeToStorage(current);
  return updated;
}

// Single-ship warp — a convoy of one. The whole gate + stamp lives in orderGroupWarp (a one-ship group's
// ETA is just that ship's), so warp order dispatch stays one code path.
export function orderShipWarp(shipId: string, destinationSystemId: string): Ship | null {
  return orderGroupWarp([shipId], destinationSystemId)[0] ?? null;
}

// The transits touching a system, for the sidebar TRANSITS block: OUTBOUND ships (leaving this system —
// their origin systemId is this one) and INBOUND ships (arriving here — their destinationSystemId is
// this one). A transiting ship's systemId stays the origin until arrival, so the two lists never overlap.
export function transitsFor(systemId: string): { outbound: readonly Ship[]; inbound: readonly Ship[] } {
  const outbound = current.ships.filter((s) => s.status === 'transiting' && s.systemId === systemId);
  const inbound = current.ships.filter((s) => s.status === 'transiting' && s.destinationSystemId === systemId);
  return { outbound, inbound };
}

// The transit turn-phase: flip every 'transiting' ship that reached arrivesOnTurn to 'ready' at its
// destination, persisting once, and RETURN the arrivals (unlike stepShipBuilds' void) so the caller can
// seed the arrival notification / warp-in FX. Attaches in AppController.nextTurn right after
// stepShipBuilds. A no-op write is skipped (advanceShipTransits returns the same ref when none arrive).
export function stepShipTransits(turn: number): readonly ArrivalEvent[] {
  const { ships, arrivals } = advanceShipTransits(current.ships, turn);
  if (ships === current.ships) return arrivals; // [] — nothing arrived, no write
  current = { ...current, ships };
  writeToStorage(current);
  return arrivals;
}
