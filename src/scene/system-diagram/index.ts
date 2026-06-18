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
import { MoonsLayer } from './layers/moons';
import { PlanetsLayer } from './layers/planets';
import { RingsLayer } from './layers/rings';
import { ShipsLayer } from './layers/ships';
import { StarsRowLayer } from './layers/stars-row';
import { buildRowSlots, layoutRow, type RowSlot } from './layout/row';
import { type BodyCenter, type BodyCenterIndex, type DiagramHit, type DiagramPick, type PlanetCenterIndex, picksEqual } from './types';
import type { ShipLane } from '../../facilities/economy-bridge';

export type { DiagramPick } from './types';

export class SystemDiagram {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferH = 1;
  // Layout + ortho width = the content rect (full buffer minus the reserved
  // sidebar strip). The diagram's scene renders into the content viewport (1 unit
  // = 1 content-buffer px), so the pixel-snapped body materials' uViewport (also
  // the content width) lines up and the strip on the right stays empty.
  private contentW = 1;

  private readonly rowSlots: RowSlot[];

  private readonly stars:   StarsRowLayer;
  private readonly planets: PlanetsLayer;
  private readonly belts:   BeltsLayer;
  private readonly moons:   MoonsLayer;
  private readonly rings:   RingsLayer;
  // Cargo-ship overlay — the one time-driven layer; fed lanes by SystemScene.
  private readonly ships:   ShipsLayer;

  // Two independent outline channels that share one visual (the 1-px rim):
  // the transient hover follows the cursor, the persistent selection is set by
  // a click and survives pointer movement. A body is lit when it is hovered OR
  // selected, so moving the cursor off the selected body never clears its rim.
  private hoveredPick: DiagramPick | null = null;
  private selectedPick: DiagramPick | null = null;

  constructor(clusterIdx: number) {
    const cluster = STAR_CLUSTERS[clusterIdx]!;
    this.rowSlots = buildRowSlots(cluster);

    this.stars   = new StarsRowLayer(this.scene, cluster);
    this.planets = new PlanetsLayer(this.scene, this.rowSlots);
    this.belts   = new BeltsLayer(this.scene, this.rowSlots);
    this.moons   = new MoonsLayer(this.scene, this.rowSlots);
    this.rings   = new RingsLayer(this.scene, this.rowSlots);
    this.ships   = new ShipsLayer(this.scene);
  }

  resize(contentW: number, bufferH: number): void {
    this.bufferH = bufferH;
    this.contentW = contentW;
    this.camera.left = 0; this.camera.right = contentW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.layout();
  }

  private layout(): void {
    // Row layout writes cx/cy into rowSlots; subsequent passes read it. Width is
    // the content rect so the diagram centers in the visible area, not under the
    // sidebar.
    this.stars.layout(this.contentW, this.bufferH);
    layoutRow(this.rowSlots, this.contentW, this.bufferH);
    // Star positions are finalized — publish them to the body lighting
    // pass. Pulls from stars (post-layout) and pushes to every body
    // material; no per-tick update needed (the diagram is a static
    // screen layout, so lighting only changes on resize). Set before the
    // ring layout below, which reads the lights to resolve each ring's
    // dominant-star shadow direction.
    const lights = this.stars.getLightSources();
    this.planets.setLightSources(lights);
    this.moons.setLightSources(lights);
    this.belts.setLightSources(lights);
    this.rings.setLightSources(lights);
    // PlanetsLayer publishes the center index that moons + rings consume.
    this.planets.layout(this.rowSlots);
    this.belts.layout(this.rowSlots);
    const centers = this.planets.getCenterIndex();
    this.moons.layout(centers);
    this.rings.layout(centers);

    // Publish the unified body-anchor index (planets + moons + belts) plus the
    // content-rect bounds to the ships layer, so cargo dots spawn/aim at any
    // body kind and re-track across a resize.
    this.ships.setLayout(this.buildBodyCenters(centers), this.contentW, this.bufferH);

    // Layout rebuilds the per-body outline attributes, so re-stamp the
    // persistent selection (hover re-applies itself on the next pointer move).
    if (this.selectedPick) this.writeOutline(this.selectedPick, 1);
  }

  // Merge the per-kind center indices into one bodyIdx → BodyCenter lookup for
  // the ships layer. Keys are unique across kinds (each body has one catalog
  // index), so merge order is irrelevant; entries are shared by reference (the
  // ships layer only reads cx/cy and never retains them), and the planet index
  // is the one already laid out this pass.
  private buildBodyCenters(planetCenters: PlanetCenterIndex): BodyCenterIndex {
    const m = new Map<number, BodyCenter>();
    for (const [b, c] of planetCenters) m.set(b, c);
    for (const [b, c] of this.moons.getCenterIndex()) m.set(b, c);
    for (const [b, c] of this.belts.getCenterIndex()) m.set(b, c);
    return m;
  }

  // Advance the cargo-ship overlay one frame. The system view's only per-frame
  // path, threaded from SystemScene.tick.
  update(now: number): void {
    this.ships.update(now);
  }

  // Hand the ships layer this cluster's cargo lanes for the current turn.
  setFlows(lanes: readonly ShipLane[]): void {
    this.ships.setFlows(lanes);
  }

  // Hit-test the rendered discs at (x, y) in buffer-pixel coords and
  // return the topmost body — the one the depth test would have left
  // visible at that pixel, so the cursor and the eye always agree.
  //
  // Each row item (planet/belt + its moons/rings) draws in its own z
  // band (rowIdx · Z_STRIDE, see geom/snap.ts:bandZ), so a body in a
  // higher band fully occludes a lower band's whole stack regardless of
  // sublayer. A flat layer-priority walk gets this wrong across bands —
  // e.g. a left planet's front moon would out-rank a right planet's
  // disc even though the disc renders on top. So we collect every hit
  // with the world z it was drawn at and keep the largest z (the
  // depth-test winner). The query order below is the tiebreaker for the
  // equal-z case (one row item's own stack: front moon → front ring →
  // disc → back ring → belt → back moon → star), mirroring the
  // back-to-front render order within a band.
  pickAt(x: number, y: number): DiagramPick | null {
    const centers = this.planets.getCenterIndex();
    const hits: (DiagramHit | null)[] = [
      this.moons.pickFront(x, y),
      this.rings.pickFront(x, y, centers),
      this.planets.pickAt(x, y),
      this.rings.pickBack(x, y, centers),
      this.belts.pickAt(x, y),
      this.moons.pickBack(x, y),
      this.stars.pickAt(x, y),
    ];
    let best: DiagramHit | null = null;
    // Strict `>` keeps the earlier (higher-priority) hit on a z tie.
    for (const hit of hits) {
      if (hit && (best === null || hit.z > best.z)) best = hit;
    }
    return best?.pick ?? null;
  }

  // Stamp the 1-px outline onto the hovered disc, clearing the previous
  // one if any. No-op when the pick is unchanged so continuous pointer
  // movement within the same disc doesn't churn the GPU upload. The previous
  // body is only cleared if it isn't also the selected one.
  setHovered(pick: DiagramPick | null): void {
    if (picksEqual(pick, this.hoveredPick)) return;
    const prev = this.hoveredPick;
    this.hoveredPick = pick;
    if (prev && !picksEqual(prev, this.selectedPick)) this.writeOutline(prev, 0);
    if (pick) this.writeOutline(pick, 1);
  }

  // Stamp the persistent selection outline. Same rim as hover; the previous
  // selection is only cleared if the cursor isn't still hovering it.
  setSelected(pick: DiagramPick | null): void {
    if (picksEqual(pick, this.selectedPick)) return;
    const prev = this.selectedPick;
    this.selectedPick = pick;
    if (prev && !picksEqual(prev, this.hoveredPick)) this.writeOutline(prev, 0);
    if (pick) this.writeOutline(pick, 1);
  }

  // Dispatch to the layer that owns the picked kind. Each layer's
  // setHovered writes its own outline convention (per-vertex aHazeColor.w
  // on planets/moons, per-vertex aHovered on belts, a uHovered uniform
  // on stars/rings). The `satisfies never` default makes a newly-added
  // DiagramPick.kind fail to compile here until it's wired.
  private writeOutline(pick: DiagramPick | null, value: 0 | 1): void {
    if (!pick) return;
    switch (pick.kind) {
      case 'star':   this.stars.setHovered(pick, value); return;
      case 'planet': this.planets.setHovered(pick, value); return;
      case 'belt':   this.belts.setHovered(pick, value); return;
      case 'moon':   this.moons.setHovered(pick, value); return;
      case 'ring':   this.rings.setHovered(pick, value); return;
      default:       pick satisfies never;
    }
  }

  dispose(): void {
    this.stars.dispose();
    this.planets.dispose();
    this.belts.dispose();
    this.moons.dispose();
    this.rings.dispose();
    this.ships.dispose();
  }
}
