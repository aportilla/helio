// groupByFaction / actorSides — the shared faction/ownership split every platform→actor projector
// ends on. Given a sequence of (factionId, item) entries it groups them by faction, marks the
// controlled side, and PRESERVES first-seen factionId order so the split is deterministic.
// The controlled-side rule and the ordering guarantee live HERE, in ONE place, so the pattern
// extends past ships and bodies without re-deriving them — the encounter's `ships-to-combatants`
// groups its Combatants through the same `groupByFaction` core (its items are Combatants, not bare
// Actors, hence the generic). A pure leaf: it imports only the action vocabulary + the
// controlled-faction pointer — no DOM, no catalog, no sim.

import { CONTROLLED_FACTION_ID } from '../factions/registry.ts';
import type { Actor, ActorSide } from './types.ts';

// One item tagged with the faction that owns it — the minimal pair groupByFaction groups. Each
// adapter does its OWN domain filtering (a ship's 'ready' status, a body's command-less drop)
// BEFORE handing entries here; groupByFaction only groups + flags the controlled side, never filters.
export interface FactionTagged<T> {
  readonly factionId: string;
  readonly item: T;
}

// One faction's items, controlled-flagged — the generic shape both ActorSide (item = Actor) and the
// encounter's CombatantSide (item = Combatant) specialize. `F` carries the caller's factionId type
// (a bare `string` for actors, the frozen `FactionType` for combatants) through unchanged.
export interface FactionGroup<F extends string, T> {
  readonly factionId: F;
  readonly controlled: boolean;
  readonly items: readonly T[];
}

export function groupByFaction<F extends string, T>(
  entries: Iterable<{ readonly factionId: F; readonly item: T }>,
): readonly FactionGroup<F, T>[] {
  const byFaction = new Map<F, T[]>();
  for (const { factionId, item } of entries) {
    let items = byFaction.get(factionId);
    if (!items) {
      items = [];
      byFaction.set(factionId, items);
    }
    items.push(item);
  }
  return [...byFaction].map(([factionId, items]) => ({
    factionId,
    controlled: factionId === CONTROLLED_FACTION_ID,
    items,
  }));
}

// One actor tagged with the faction that owns it — the pair both system-view adapters
// (ships-to-actors, bodies-to-actors) hand to actorSides. Kept with its own `actor` field (rather
// than the generic `item`) so those call sites read unchanged after groupByFaction was generalized
// for the encounter; actorSides maps it onto the generic core below.
export interface FactionActor {
  readonly factionId: string;
  readonly actor: Actor;
}

export function actorSides(entries: Iterable<FactionActor>): readonly ActorSide[] {
  return groupByFaction([...entries].map(({ factionId, actor }) => ({ factionId, item: actor })))
    .map(({ factionId, controlled, items }) => ({ factionId, controlled, actors: items }));
}
