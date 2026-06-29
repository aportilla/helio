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
import { FacilitiesLayer } from './layers/facilities';
import { FleetLayer } from './layers/fleet';
import { MoonsLayer } from './layers/moons';
import { PlanetsLayer } from './layers/planets';
import { RingsLayer } from './layers/rings';
import { ShipsLayer } from './layers/ships';
import { StarsRowLayer } from './layers/stars-row';
import { buildRowSlots, layoutRow, type RowSlot } from './layout/row';
import { type BodyCenter, type BodyCenterIndex, type DiagramHit, type DiagramPick, type PlanetCenterIndex, picksEqual } from './types';
import type { ShipLane } from '../../facilities/economy-bridge';
import type { Ship } from '../../game-state';

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
  // On-body facility chips — a static overlay re-read from game-state each layout.
  private readonly facilities: FacilitiesLayer;
  // The system's ready ships — two faction-split formations in the lower field, fed
  // this system's ready ships by SystemScene. Pickable: a ship hit wins over the bodies
  // beneath it (see pickAt), driving the sidebar's ship card.
  private readonly fleet: FleetLayer;

  // The retained bodyIdx → on-screen center index from the last layout — the source for
  // bodyCenter() (the action menu's body anchor / target bracket) and laidOutBodyIndices()
  // (the candidate/actor body universe). Rebuilt each layout + syncFacilities pass (the
  // same centers; a facility edit doesn't move bodies).
  private bodyCenters: BodyCenterIndex = new Map();

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
    this.facilities = new FacilitiesLayer(this.scene);
    this.fleet   = new FleetLayer(this.scene);
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
    // body kind and re-track across a resize. The facility chips anchor to the
    // same centers (a body's top rim / belt center), re-read from game-state.
    this.bodyCenters = this.buildBodyCenters(centers);
    this.ships.setLayout(this.bodyCenters, this.contentW, this.bufferH);
    this.facilities.layout(this.bodyCenters);
    // The fleet isn't body-anchored — it formations off the content rect only.
    this.fleet.layout(this.contentW, this.bufferH);

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

  // Drive the cargo-ship overlay — the system view's only per-frame path, threaded
  // from SystemScene.tick. Called every frame; the dots redraw each frame but their
  // motion steps on a fixed cadence (see ShipsLayer.update).
  update(now: number): void {
    this.ships.update(now);
  }

  // Hand the ships layer this cluster's cargo lanes for the current turn.
  setFlows(lanes: readonly ShipLane[]): void {
    this.ships.setFlows(lanes);
  }

  // Repaint the on-body facility chips after an add/remove edit. The body layout
  // is untouched, so only the facilities layer re-runs (against the centers the
  // last layout published) — no full diagram relayout.
  syncFacilities(): void {
    this.bodyCenters = this.buildBodyCenters(this.planets.getCenterIndex());
    this.facilities.layout(this.bodyCenters);
  }

  // Hand the fleet layer this system's READY ships (the caller pre-filters). A pure
  // pass-through; the layer re-derives the two formations from the bounds it already has.
  syncFleet(ships: readonly Ship[]): void {
    this.fleet.setFleet(ships);
  }

  // Reserve extra bottom space in the fleet muster band so the formation clears the encounter bar
  // during combat (EB, §15). SystemScene raises it on enter, drops it to 0 on exit. Pass-through.
  setFleetBottomReserve(px: number): void {
    this.fleet.setBottomReserve(px);
  }

  // The on-screen slot center of a ready ship (content-buffer px), or null if it isn't
  // currently rendered — the anchor the system action menu pins to. Pass-through to the
  // fleet layer, which owns the laid-out per-ship centers.
  fleetSlotCenter(shipId: string): { cx: number; cy: number; r: number } | null {
    return this.fleet.slotCenterFor(shipId);
  }

  // The on-screen center of a ship's MODULE (content-buffer px) — the firing weapon's rect, the
  // anchor the targeting-visuals weapon glow emanates from. Pass-through to the fleet layer.
  fleetModuleCenter(shipId: string, componentId: string): { cx: number; cy: number; r: number } | null {
    return this.fleet.moduleCenterFor(shipId, componentId);
  }

  // The on-screen center of a body (content-buffer px), or null if it isn't laid out — the
  // body twin of fleetSlotCenter. The anchor the action menu pins to (a body actor) and the
  // target bracket rides (a body target); shape-identical to a fleet slot center, so the
  // chrome's slotCenterFor seam dispatches to either by id namespace.
  bodyCenter(bodyIdx: number): { cx: number; cy: number; r: number } | null {
    return this.bodyCenters.get(bodyIdx) ?? null;
  }

  // Every body laid out in this cluster, by catalog index (planets + moons + belts — the
  // facility-eligible kinds; never stars/rings). The candidate/actor body universe the
  // controller filters by ownership + facilities. Empty until the first layout.
  laidOutBodyIndices(): readonly number[] {
    return [...this.bodyCenters.keys()];
  }

  // Open the cargo overlay already at steady state (one-shot). Call once, after the
  // layout + lanes have resolved and before the first frame — see ShipsLayer.prime.
  prime(): void {
    this.ships.prime();
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
    // The fleet is a foreground overlay (depthTest:false, top RENDER_ORDER_FLEET) that
    // sits alone in the lower field, sharing neither the bodies' row-band z scheme nor
    // their region — so a hit on a ship sprite wins outright and is resolved before the
    // z-banded body walk rather than folded into it.
    const ship = this.fleet.pickAt(x, y);
    if (ship) return ship.pick;

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
      // The fleet material has no outline channel yet, so a selected/hovered ship draws
      // no rim — its selection feedback is the sidebar ship card. Deferred, not missed.
      case 'ship':   return;
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
    this.facilities.dispose();
    this.fleet.dispose();
  }
}
