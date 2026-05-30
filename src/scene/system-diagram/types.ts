// Cross-layer types shared between SystemDiagram (index.ts) and the
// individual layers under layers/. Lives in its own file to avoid
// circular imports — index.ts imports layers, layers import types.

// Picker result. Discriminated by `kind`: star vs. body (planet / moon /
// belt / ring). Returned by SystemDiagram.pickAt and consumed by
// setHovered + the HUD body info card. starIdx indexes STARS; bodyIdx
// indexes BODIES.
export type DiagramPick =
  | { readonly kind: 'star'; readonly starIdx: number }
  | { readonly kind: 'planet' | 'moon' | 'belt' | 'ring'; readonly bodyIdx: number };

// A pick paired with the world-z it was rendered at (bandZ — see
// geom/snap.ts). The diagram's depth test resolves overlaps by largest
// world z, so the picker carries z out of each layer and returns the
// topmost hit, keeping cursor and eye in agreement across row bands.
// Internal to the pick pass — SystemDiagram.pickAt unwraps it to a
// bare DiagramPick for consumers.
export interface DiagramHit {
  readonly pick: DiagramPick;
  readonly z: number;
}

export function picksEqual(a: DiagramPick | null, b: DiagramPick | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'star' && b.kind === 'star') return a.starIdx === b.starIdx;
  if (a.kind !== 'star' && b.kind !== 'star') return a.bodyIdx === b.bodyIdx;
  return false;
}

// PlanetsLayer publishes one entry per planet after its layout pass;
// MoonsLayer + RingsLayer consume it to position elements relative to
// their host planets. Map key is the planet's bodyIdx (so consumers
// can look up by host without an indexOf scan).
export interface PlanetCenter {
  cx: number;
  cy: number;
  rowIdx: number;
}
export type PlanetCenterIndex = ReadonlyMap<number, PlanetCenter>;

// StarsRowLayer publishes one entry per cluster member after its layout
// pass; PlanetsLayer + MoonsLayer consume it to drive per-fragment
// lighting on the body discs. Position is in buffer-pixel coords
// (cy lands above the viewport top by STAR_OFFSCREEN_FRAC × radius — see
// stars-row.ts), color is the system-view-tuned class color, intensity
// is normalized within the cluster so the brightest member = 1.0.
// Frozen tuple-style: every consumer reads, none mutates.
export interface StarLightSource {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
}
