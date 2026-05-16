// Cross-layer types shared between SystemDiagram (index.ts) and the
// individual layers under layers/. Lives in its own file to avoid
// circular imports — index.ts imports layers, layers import types.

// Picker result. Discriminated by `kind`: star vs. body (planet / moon /
// belt / ring). Returned by SystemDiagram.pickAt and consumed by
// setHovered + the HUD body info card. starIdx indexes STARS; bodyIdx
// indexes BODIES.
export type BodyPick =
  | { readonly kind: 'star'; readonly starIdx: number }
  | { readonly kind: 'planet' | 'moon' | 'belt' | 'ring'; readonly bodyIdx: number };

export function picksEqual(a: BodyPick | null, b: BodyPick | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'star' && b.kind === 'star') return a.starIdx === b.starIdx;
  if (a.kind !== 'star' && b.kind !== 'star') return a.bodyIdx === b.bodyIdx;
  return false;
}

// PlanetsLayer publishes one entry per planet after its layout pass;
// MoonsLayer + IceRingsLayer + DebrisRingsLayer consume it to position
// elements relative to their host planets. Map key is the planet's
// bodyIdx (so consumers can look up by host without an indexOf scan).
export interface PlanetCenter {
  cx: number;
  cy: number;
  rowIdx: number;
}
export type PlanetCenterIndex = ReadonlyMap<number, PlanetCenter>;
