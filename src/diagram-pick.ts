// The system-diagram pick contract — what SystemDiagram.pickAt returns,
// shared between the producer (scene/system-diagram) and the consumer
// (ui/system-hud's BodyInfoCard). It lives at the repo root rather than under
// scene/ so the ui HUD can depend on it downward: scene and ui are peers, and
// ui must not reach up into scene (scene already depends on ui for its HUD
// widgets, so the pick type can't live in scene without forming a cycle).

// Discriminated by `kind`: star vs. body (planet / moon / belt / ring) vs. a built
// ship in the fleet overlay. starIdx indexes STARS; bodyIdx indexes BODIES; shipId is
// a game-state Ship.id (ships are save-state actors, not catalog entries).
export type DiagramPick =
  | { readonly kind: 'star'; readonly starIdx: number }
  | { readonly kind: 'planet' | 'moon' | 'belt' | 'ring'; readonly bodyIdx: number }
  | { readonly kind: 'ship'; readonly shipId: string };

// The catalog-backed subset — everything the hover info card can describe. The 'ship'
// pick is excluded on purpose: a ship is a game-state actor with no catalog row, so the
// card (and its body-rows projection) never receives one — SystemHud filters it out at
// the boundary, keeping body-rows coupled only to the catalog vocabulary.
export type BodyOrStarPick = Exclude<DiagramPick, { kind: 'ship' }>;

export function picksEqual(a: DiagramPick | null, b: DiagramPick | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'star' && b.kind === 'star') return a.starIdx === b.starIdx;
  if (a.kind === 'ship' && b.kind === 'ship') return a.shipId === b.shipId;
  // Both are body kinds here (same kind, neither star nor ship) — compare catalog index.
  if (a.kind !== 'star' && a.kind !== 'ship' && b.kind !== 'star' && b.kind !== 'ship') {
    return a.bodyIdx === b.bodyIdx;
  }
  return false;
}
