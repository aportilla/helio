// shipsToActors — projects the durable fleet into menu Actors, split by faction into
// sides. The general adapter the system action menu opens on; the encounter's
// ships-to-combatants (E1) is its combat specialization (it adds combatId, anchoring, and
// per-loadout commands). Pure and node-testable: it imports the erased Ship type, the
// controlled-faction pointer, the action vocabulary, the derive-and-merge projection, and the
// hoisted accent palette — no DOM/catalog/global state, and (unlike the body adapter) no sim.
//
// System scoping is the CALLER's job — pass ships already narrowed to the focused system
// (shipsInSystem). This only filters out 'building' ships (not yet in the field) and
// groups by factionId, preserving first-seen faction order so the split is deterministic.

import type { Ship } from '../game-state-codec.ts';
import { CONTROLLED_FACTION_ID } from '../factions/registry.ts';
import type { ActionCommand, ActionGrant, Actor, ActorSide } from './types.ts';
import { SHIP_CATEGORIES } from './registry.ts';
import { deriveCommands, type GrantProvider } from './derive.ts';
import { ATTACK_ACTION_COLOR, FLEE_ACTION_COLOR } from './tuning.ts';

// STUB ship loadout until ShipComponentDef lands (Phase 2). Two synthetic providers run through
// the SAME deriveCommands the real components will: a weapon granting ATTACK (enters an encounter
// against an enemy) and the drive granting NAVIGATION flee (D9: every ship has a drive, so every
// ship can flee). Only the providers are placeholder — the projection and the derived command
// shape are the real, shipped ones, so the encounter consumes a good shape from day one.
const ATTACK_GRANT: ActionGrant = {
  key: 'attack',
  label: 'Attack',
  color: ATTACK_ACTION_COLOR,
  category: 'attack',
  targeting: 'single',
  kind: 'encounter',
  // Enemy-only: the controller mints ALL system entities as candidates (ships AND bodies), so
  // this predicate keeps Attack pointed at opposing-faction targets — and, for free, brackets an
  // enemy-held BODY, not just enemy ships.
  targets: (c) => c.allegiance === 'enemy',
};
const FLEE_GRANT: ActionGrant = {
  key: 'flee',
  label: 'Flee',
  color: FLEE_ACTION_COLOR,
  category: 'navigation',
  targeting: 'self',
  kind: 'immediate',
};
const STUB_SHIP_PROVIDERS: readonly GrantProvider[] = [
  { id: 'stub-weapon', grants: [ATTACK_GRANT] },
  { id: 'stub-drive', grants: [FLEE_GRANT] },
];

// The bones loadout every ship gets: the derived attack + flee commands (Pass is menu-injected,
// not a command). Content — the encounter (E1) / the build flow (Phase 3) derive the real loadout
// from each ship's components; until then every ship offers this same placeholder pair.
export const STUB_SHIP_COMMANDS: readonly ActionCommand[] = deriveCommands(STUB_SHIP_PROVIDERS);

// One ship → one Actor. `commands` defaults to the bones loadout; a caller (the encounter) passes
// a per-ship set. Ship stats stay opaque/empty here — the stat bag is content the combat profile
// fills, not something the live-view menu needs.
export function shipToActor(ship: Ship, commands: readonly ActionCommand[] = STUB_SHIP_COMMANDS): Actor {
  return { id: ship.id, commands, categories: SHIP_CATEGORIES };
}

// Ready ships → faction sides. `commandsFor` lets a consumer vary the loadout per ship
// (default: the bones pair); the order of sides follows first-seen factionId in `ships`.
export function shipsToActors(
  ships: readonly Ship[],
  commandsFor: (ship: Ship) => readonly ActionCommand[] = () => STUB_SHIP_COMMANDS,
): readonly ActorSide[] {
  const byFaction = new Map<string, Actor[]>();
  for (const ship of ships) {
    if (ship.status !== 'ready') continue; // 'building' ships aren't in the field yet
    let actors = byFaction.get(ship.factionId);
    if (!actors) {
      actors = [];
      byFaction.set(ship.factionId, actors);
    }
    actors.push(shipToActor(ship, commandsFor(ship)));
  }
  return [...byFaction].map(([factionId, actors]) => ({
    factionId,
    controlled: factionId === CONTROLLED_FACTION_ID,
    actors,
  }));
}
