// The system-diagram pick contract — what SystemDiagram.pickAt returns,
// shared between the producer (scene/system-diagram) and the consumer
// (ui/system-hud's BodyInfoCard). It lives at the repo root rather than under
// scene/ so the ui HUD can depend on it downward: scene and ui are peers, and
// ui must not reach up into scene (scene already depends on ui for its HUD
// widgets, so the pick type can't live in scene without forming a cycle).

// Discriminated by `kind`: star vs. body (planet / moon / belt / ring).
// starIdx indexes STARS; bodyIdx indexes BODIES.
export type DiagramPick =
  | { readonly kind: 'star'; readonly starIdx: number }
  | { readonly kind: 'planet' | 'moon' | 'belt' | 'ring'; readonly bodyIdx: number };

export function picksEqual(a: DiagramPick | null, b: DiagramPick | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'star' && b.kind === 'star') return a.starIdx === b.starIdx;
  if (a.kind !== 'star' && b.kind !== 'star') return a.bodyIdx === b.bodyIdx;
  return false;
}
