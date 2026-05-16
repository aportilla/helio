// SystemDiagram — flat 2D screen diagram of one star cluster.
//
// Coordinator only: owns the Three.js Scene + OrthographicCamera, holds
// the layer objects, and threads layout / pick / hover through them in
// the right order. The renderable content lives entirely in the layers
// under ./layers; the math primitives they share live in ./geom and
// ./layout.
//
// Layer ordering at construction is significant only insofar as scene
// adds happen in this order — the actual draw order is governed by
// per-row-item z banding (see layout/constants.ts) plus renderOrder
// tiebreakers.

import { OrthographicCamera, Scene } from 'three';
import { STAR_CLUSTERS } from '../../data/stars';
import { BeltsLayer } from './layers/belts';
import { DebrisRingsLayer } from './layers/debris-rings';
import { IceRingsLayer } from './layers/ice-rings';
import { MoonsLayer } from './layers/moons';
import { PlanetsLayer } from './layers/planets';
import { StarsRowLayer } from './layers/stars-row';
import { buildRowItems, layoutRow, type RowItem } from './layout/row';
import { type BodyPick, picksEqual } from './types';

export type { BodyPick } from './types';

export class SystemDiagram {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  private readonly rowItems: RowItem[];

  private readonly stars:        StarsRowLayer;
  private readonly planets:      PlanetsLayer;
  private readonly belts:        BeltsLayer;
  private readonly moons:        MoonsLayer;
  private readonly iceRings:     IceRingsLayer;
  private readonly debrisRings:  DebrisRingsLayer;

  // Currently-outlined body. setHovered() diffs against this to skip
  // no-op repaints (cursor moving within the same disc) and to clear the
  // previous outline before stamping the new one.
  private hoveredPick: BodyPick | null = null;

  constructor(clusterIdx: number) {
    const cluster = STAR_CLUSTERS[clusterIdx];
    this.rowItems = buildRowItems(cluster);

    this.stars       = new StarsRowLayer(this.scene, cluster);
    this.planets     = new PlanetsLayer(this.scene, this.rowItems);
    this.belts       = new BeltsLayer(this.scene, this.rowItems);
    this.moons       = new MoonsLayer(this.scene, this.rowItems);
    this.iceRings    = new IceRingsLayer(this.scene, this.rowItems);
    this.debrisRings = new DebrisRingsLayer(this.scene, this.rowItems);
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.layout();
  }

  private layout(): void {
    // Row layout writes cx/cy into rowItems; subsequent passes read it.
    this.stars.layout(this.bufferW, this.bufferH);
    layoutRow(this.rowItems, this.bufferW, this.bufferH);
    // PlanetsLayer publishes the center index that moons + rings consume.
    this.planets.layout(this.rowItems);
    this.belts.layout(this.rowItems);
    const centers = this.planets.getCenterIndex();
    this.moons.layout(centers);
    this.iceRings.layout(centers);
    this.debrisRings.layout(centers);
  }

  // Hit-test the rendered discs at (x, y) in buffer-pixel coords. Walk
  // layers in render-order priority (later-rendered wins, so the eye
  // and the cursor agree): front moons → front rings → planets →
  // back rings → belts → back moons → stars. The first matching slot
  // wins, with no smaller-radius tiebreaker (so a moon overlapping its
  // parent's rim always wins because the moon pool draws after the
  // planet pool).
  pickAt(x: number, y: number): BodyPick | null {
    const centers = this.planets.getCenterIndex();
    return this.moons.pickFront(x, y)
        ?? this.iceRings.pickFront(x, y, centers)
        ?? this.debrisRings.pickFront(x, y, centers)
        ?? this.planets.pickAt(x, y)
        ?? this.iceRings.pickBack(x, y, centers)
        ?? this.debrisRings.pickBack(x, y, centers)
        ?? this.belts.pickAt(x, y, this.rowItems)
        ?? this.moons.pickBack(x, y)
        ?? this.stars.pickAt(x, y);
  }

  // Stamp the 1-px outline onto the picked disc, clearing the previous
  // one if any. No-op when the pick is unchanged so continuous pointer
  // movement within the same disc doesn't churn the GPU upload.
  setHovered(pick: BodyPick | null): void {
    if (picksEqual(pick, this.hoveredPick)) return;
    this.writeHover(this.hoveredPick, 0);
    this.writeHover(pick, 1);
    this.hoveredPick = pick;
  }

  // Dispatch to the layer that owns the picked kind. Rings are split
  // across two layer types (ice + debris); try ice first, fall back to
  // debris if the pick isn't an ice ring.
  private writeHover(pick: BodyPick | null, value: 0 | 1): void {
    if (!pick) return;
    switch (pick.kind) {
      case 'star':   this.stars.setHovered(pick, value); return;
      case 'planet': this.planets.setHovered(pick, value); return;
      case 'belt':   this.belts.setHovered(pick, value); return;
      case 'moon':   this.moons.setHovered(pick, value); return;
      case 'ring':
        if (!this.iceRings.setHovered(pick, value)) {
          this.debrisRings.setHovered(pick, value);
        }
        return;
    }
  }

  dispose(): void {
    this.stars.dispose();
    this.planets.dispose();
    this.belts.dispose();
    this.moons.dispose();
    this.iceRings.dispose();
    this.debrisRings.dispose();
  }
}
