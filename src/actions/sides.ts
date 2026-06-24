// actorSides — the shared faction/ownership split both projector adapters end on. Given a sequence
// of (factionId, actor) entries it groups them into ActorSides, marks the controlled side, and
// PRESERVES first-seen factionId order so the split is deterministic. Factored out of
// ships-to-actors + bodies-to-actors (which carried a byte-identical block) so the controlled-side
// rule and the ordering guarantee live in ONE place as the platform→actor pattern extends past
// ships and bodies — the encounter's combatant sides reuse this next. A pure leaf: it imports only
// the action vocabulary + the controlled-faction pointer — no DOM, no catalog, no sim.

import { CONTROLLED_FACTION_ID } from '../factions/registry.ts';
import type { Actor, ActorSide } from './types.ts';

// One actor tagged with the faction that owns it — the minimal pair actorSides groups. Each adapter
// does its OWN domain filtering (a ship's 'ready' status, a body's command-less drop) BEFORE
// handing entries here; actorSides only groups + flags the controlled side, it never filters.
export interface FactionActor {
  readonly factionId: string;
  readonly actor: Actor;
}

export function actorSides(entries: Iterable<FactionActor>): readonly ActorSide[] {
  const byFaction = new Map<string, Actor[]>();
  for (const { factionId, actor } of entries) {
    let actors = byFaction.get(factionId);
    if (!actors) {
      actors = [];
      byFaction.set(factionId, actors);
    }
    actors.push(actor);
  }
  return [...byFaction].map(([factionId, actors]) => ({
    factionId,
    controlled: factionId === CONTROLLED_FACTION_ID,
    actors,
  }));
}
