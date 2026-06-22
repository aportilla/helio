// FleetLayer — the player's built ships, clustered as ONE fleet in the open field
// below the planet row. A ship is never anchored to a planet (planets and ships are
// independently-destroyable peers — decision 6); the whole system's ready ships lay
// out as a single centered formation derived from the content rect, re-derived on a
// resize for free.
//
// Primitive: one Mesh + PlaneGeometry per sprite on the makeStarMeshMaterial
// CPU-integer uCenter/uRadius path — the same disc primitive the stars row uses
// (stars-row.ts), shared with the eventual combat sprites. Two trip-wires apply:
// (b) disableCulling (positions are CPU-rewritten, so the cached bounding sphere
// goes stale) and (c) depthTest:false + a dedicated renderOrder (paint over the
// bodies + cargo). makeStarMeshMaterial is NOT a snapped/registered material, so the
// ctor-seed-uViewport and unregisterSnappedMaterial trip-wires do NOT apply.
//
// Picks via pickAt: a click on a sprite selects that ship (the sidebar shows its card).
// The hit-test geometry is rebuilt on each relayout into a pick-target list and walked
// by the pure fleet-pick.ts; there is no hover rim yet (the material has no outline
// channel — deferred). The pool is hard-capped at MAX_FLEET_SPRITES — ready ships have
// no exit path (no movement / combat), so the rendered count is bounded rather than
// growing without limit.

import { Color, Mesh, PlaneGeometry, Scene, ShaderMaterial, Vector2 } from 'three';
import type { Ship } from '../../../game-state';
import { SHIP_CLASS_BY_TYPE, shipClassColor } from '../../../ships/registry';
import { sizes } from '../../../ui/theme';
import { makeStarMeshMaterial } from '../../materials';
import { disableCulling } from '../geom/cull';
import { snapPxParity } from '../geom/snap';
import { pickFleetShip, type FleetPickCandidate } from './fleet-pick';
import type { DiagramHit } from '../types';
import {
  FLEET_BASELINE_FRAC,
  FLEET_SPRITE_GAP,
  MAX_FLEET_SPRITES,
  RENDER_ORDER_FLEET,
  Z_FLEET,
} from '../layout/constants';

interface FleetSprite {
  readonly mesh: Mesh;
  geometry: PlaneGeometry;
  readonly material: ShaderMaterial;
  // Current built diameter in px — geometry is rebuilt only when it changes (a
  // resize that doesn't change sprite size leaves it intact, like the stars row).
  diam: number;
}

export class FleetLayer {
  private readonly sprites: FleetSprite[] = [];
  // The ready ships to render (caller pre-filters to 'ready') + the content bounds.
  // Both feeders re-derive the formation from these, so a resize or a fleet change
  // each recompute from the same stored state.
  private ships: readonly Ship[] = [];
  private contentW = 1;
  private bufferH = 1;
  // Hit-test targets for pickAt — one entry per visible sprite, rebuilt in relayout
  // (the only place the formation changes). Reused in place so a pick (or a hover,
  // which pickAt also serves) allocates nothing.
  private readonly pickTargets: FleetPickCandidate[] = [];

  constructor(scene: Scene) {
    for (let i = 0; i < MAX_FLEET_SPRITES; i++) {
      const material = makeStarMeshMaterial();
      material.depthTest = false; // trip-wire (c): paint over the bodies + cargo dots
      const geometry = new PlaneGeometry(1, 1); // sized per-ship on the first relayout
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = RENDER_ORDER_FLEET;
      mesh.visible = false; // hidden until a relayout places it (no origin flash)
      disableCulling(mesh); // trip-wire (b): positions are CPU-rewritten
      scene.add(mesh);
      this.sprites.push({ mesh, geometry, material, diam: 1 });
    }
  }

  // The system's READY ships → the rendered fleet. Caps at MAX_FLEET_SPRITES.
  setFleet(ships: readonly Ship[]): void {
    this.ships = ships;
    this.relayout();
  }

  // Re-derive the formation when the content rect changes (resize). Bounds are
  // remembered so setFleet and layout each recompute from the same data.
  layout(contentW: number, bufferH: number): void {
    this.contentW = contentW;
    this.bufferH = bufferH;
    this.relayout();
  }

  // Lay the ready ships out as a centered grid in the lower field: as many per row
  // as the content width fits, rows stacked UP from the baseline. Each sprite's
  // center is parity-snapped and written to BOTH mesh.position AND uCenter (the
  // shader's circle origin) — the stars-row CPU-integer discipline.
  private relayout(): void {
    const n = Math.min(this.ships.length, MAX_FLEET_SPRITES);
    this.pickTargets.length = 0; // rebuilt below from the visible sprites
    // Cell size from the first ship's class (v1 has one class, so the grid is
    // uniform; a future mixed fleet would size the cell to the largest class).
    const cellR = n > 0 ? this.spriteRadius(this.ships[0]!) : 1;
    const cell = cellR * 2 + FLEET_SPRITE_GAP;
    const avail = this.contentW - 2 * sizes.edgePad;
    const perRow = Math.max(1, Math.floor(avail / cell));
    const baselineY = this.bufferH * FLEET_BASELINE_FRAC;

    for (let i = 0; i < this.sprites.length; i++) {
      const sprite = this.sprites[i]!;
      if (i >= n) { sprite.mesh.visible = false; continue; }

      const ship = this.ships[i]!;
      const r = this.spriteRadius(ship);
      const d = r * 2;
      this.resizeSprite(sprite, d);
      (sprite.material.uniforms.uColor!.value as Color).set(shipClassColor(ship.classId));
      sprite.material.uniforms.uRadius!.value = r;

      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const countInRow = Math.min(perRow, n - row * perRow);
      const rowWidth = countInRow * cell - FLEET_SPRITE_GAP;
      const startX = (this.contentW - rowWidth) / 2 + r;
      const cx = snapPxParity(startX + col * cell, d);
      const cy = snapPxParity(baselineY + row * cell, d);
      sprite.mesh.position.set(cx, cy, Z_FLEET);
      (sprite.material.uniforms.uCenter!.value as Vector2).set(cx, cy);
      sprite.mesh.visible = true;
      this.pickTargets.push({ cx, cy, r, shipId: ship.id });
    }
  }

  // Hit-test the formation: the ready ship whose disc covers (x, y), or null. Walks
  // the pick-target list relayout built — cheap, no per-call allocation. Returns a
  // DiagramHit at Z_FLEET for the coordinator's pick contract, though SystemDiagram
  // resolves the fleet ahead of the body z-walk (the fleet is a foreground overlay).
  pickAt(x: number, y: number): DiagramHit | null {
    const shipId = pickFleetShip(this.pickTargets, x, y);
    return shipId === null ? null : { pick: { kind: 'ship', shipId }, z: Z_FLEET };
  }

  private spriteRadius(ship: Ship): number {
    return SHIP_CLASS_BY_TYPE.get(ship.classId)?.spriteSizePx ?? 4;
  }

  private resizeSprite(sprite: FleetSprite, d: number): void {
    if (sprite.diam === d) return;
    sprite.geometry.dispose();
    sprite.geometry = new PlaneGeometry(d, d);
    sprite.mesh.geometry = sprite.geometry;
    sprite.diam = d;
  }

  dispose(): void {
    // makeStarMeshMaterial is not a snapped/registered material, so there is no
    // unregisterSnappedMaterial here — just release each sprite's GPU resources.
    for (const s of this.sprites) {
      s.geometry.dispose();
      s.material.dispose();
    }
  }
}
