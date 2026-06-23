// FleetLayer — a system's ready ships, parked as TWO opposing formations in the open
// field below the planet row. A ship is never anchored to a planet (planets and ships
// are independently-destroyable peers — decision 6). The ships split by FACTION: the
// player's side (the controlled faction) grids in the left half pointing right, every
// other faction in the right half pointing left, so the two read as a stand-off
// across the battlefield. Both formations derive from the content rect, re-derived on
// a resize for free.
//
// Primitive: one Mesh + PlaneGeometry per sprite on the makeFleetTriangleMaterial
// CPU-integer uCenter/uRadius path — a flat triangle tinted by faction color, facing
// per side via uDir. Same parity-snap discipline as the stars-row disc. Two trip-wires apply:
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
import { CONTROLLED_FACTION_ID, factionColor } from '../../../factions/registry';
import { SHIP_CLASS_BY_TYPE } from '../../../ships/registry';
import { sizes } from '../../../ui/theme';
import { makeFleetTriangleMaterial } from '../../materials';
import { disableCulling } from '../geom/cull';
import { snapPxParity } from '../geom/snap';
import { pickFleetShip, type FleetPickCandidate } from './fleet-pick';
import type { DiagramHit } from '../types';
import {
  FLEET_BASELINE_FRAC,
  FLEET_MINE_CENTER_FRAC,
  FLEET_SPRITE_GAP,
  FLEET_THEIRS_CENTER_FRAC,
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
      const material = makeFleetTriangleMaterial();
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

  // Split the ready ships by side and lay each out as its own formation: the player's
  // (the controlled faction) at left facing right, every other faction at right facing
  // left. The TOTAL is capped first, so the two sides together never exceed the pool.
  private relayout(): void {
    const shown = this.ships.slice(0, MAX_FLEET_SPRITES);
    const mine = shown.filter((s) => s.factionId === CONTROLLED_FACTION_ID);
    const theirs = shown.filter((s) => s.factionId !== CONTROLLED_FACTION_ID);
    this.pickTargets.length = 0; // rebuilt by layoutGroup from the visible sprites

    let next = this.layoutGroup(mine, this.contentW * FLEET_MINE_CENTER_FRAC, 1, 0);
    next = this.layoutGroup(theirs, this.contentW * FLEET_THEIRS_CENTER_FRAC, -1, next);

    // Hide the unused tail of the pool.
    for (let i = next; i < this.sprites.length; i++) this.sprites[i]!.mesh.visible = false;
  }

  // Lay one side's ships out as a centered grid around centerX, rows stacked UP from
  // the baseline, triangle apexes facing `dir` (+1 right / -1 left). Consumes sprites
  // from `start`, returns the next free index. Each side grids within HALF the content
  // width so the two formations can't collide at the center. Every sprite's center is
  // parity-snapped and written to BOTH mesh.position AND uCenter (the shader origin) —
  // the stars-row CPU-integer discipline.
  private layoutGroup(ships: readonly Ship[], centerX: number, dir: number, start: number): number {
    const n = ships.length;
    if (n === 0) return start;
    // Cell size from the first ship's class (v1 has one class, so the grid is uniform;
    // a future mixed fleet would size the cell to the largest class).
    const cellR = this.spriteRadius(ships[0]!);
    const cell = cellR * 2 + FLEET_SPRITE_GAP;
    const avail = this.contentW * 0.5 - 2 * sizes.edgePad; // one side's grid box
    const perRow = Math.max(1, Math.floor(avail / cell));
    const baselineY = this.bufferH * FLEET_BASELINE_FRAC;

    for (let i = 0; i < n; i++) {
      const sprite = this.sprites[start + i]!;
      const ship = ships[i]!;
      const r = this.spriteRadius(ship);
      const d = r * 2;
      this.resizeSprite(sprite, d);
      (sprite.material.uniforms.uColor!.value as Color).set(factionColor(ship.factionId));
      sprite.material.uniforms.uRadius!.value = r;
      sprite.material.uniforms.uDir!.value = dir;

      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const countInRow = Math.min(perRow, n - row * perRow);
      const rowWidth = countInRow * cell - FLEET_SPRITE_GAP;
      const startX = centerX - rowWidth / 2 + r;
      const cx = snapPxParity(startX + col * cell, d);
      const cy = snapPxParity(baselineY + row * cell, d);
      sprite.mesh.position.set(cx, cy, Z_FLEET);
      (sprite.material.uniforms.uCenter!.value as Vector2).set(cx, cy);
      sprite.mesh.visible = true;
      this.pickTargets.push({ cx, cy, r, shipId: ship.id });
    }
    return start + n;
  }

  // Hit-test the formation: the ready ship whose disc covers (x, y), or null. Walks
  // the pick-target list relayout built — cheap, no per-call allocation. Returns a
  // DiagramHit at Z_FLEET for the coordinator's pick contract, though SystemDiagram
  // resolves the fleet ahead of the body z-walk (the fleet is a foreground overlay).
  pickAt(x: number, y: number): DiagramHit | null {
    const shipId = pickFleetShip(this.pickTargets, x, y);
    return shipId === null ? null : { pick: { kind: 'ship', shipId }, z: Z_FLEET };
  }

  // The on-screen slot center (content-buffer px, parity-snapped) of a given ship, or
  // null if it isn't a currently-rendered ready ship — the anchor source for the system
  // action menu. Walks the same pick-target list relayout built, so it tracks resizes for
  // free; a vanished ship (re-selected after a fleet change) returns null and the menu closes.
  slotCenterFor(shipId: string): { cx: number; cy: number; r: number } | null {
    for (const t of this.pickTargets) {
      if (t.shipId === shipId) return { cx: t.cx, cy: t.cy, r: t.r };
    }
    return null;
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
