// Cross-layer types shared between SystemDiagram (index.ts) and the
// individual layers under layers/. Lives in its own file to avoid
// circular imports — index.ts imports layers, layers import types.

// The pick contract — DiagramPick + picksEqual — lives at the repo root
// (src/diagram-pick.ts) so the ui HUD can consume it without importing scene.
// Re-exported here so the diagram's own layers still import everything they
// need from this one local module.
import type { DiagramPick } from '../../diagram-pick';
export type { DiagramPick };
export { picksEqual } from '../../diagram-pick';

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

// A body's on-screen anchor in content-buffer-pixel coords. The unified
// lookup the ships layer consumes: SystemDiagram.layout merges the per-kind
// centers (planets publish the richer PlanetCenter; moons + belts publish
// this) into one bodyIdx → {cx,cy} map, so a cargo dot can spawn at / aim for
// any body kind, not just planets.
export interface BodyCenter {
  cx: number;
  cy: number;
}
export type BodyCenterIndex = ReadonlyMap<number, BodyCenter>;

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
