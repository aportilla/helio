// FleetLayer — a system's ready ships, drawn up as TWO opposing JRPG battle lines in the
// open field below the planet row. A ship is never anchored to a planet (planets and
// ships are independently-destroyable peers — decision 6). The ships split by FACTION:
// the player's side (the controlled faction) musters in the left half pointing right,
// every other faction in the right half pointing left, so the two read as a stand-off
// across the battlefield. Each side forms a vertical ARC (a JRPG party row): ships spread
// evenly down the band height (the centered equal-gap idiom), then bow into a crescent
// that CUPS AWAY from the enemy — flanks forward, middle hanging back — so the two sides
// read as `( )` and no friendly hull screens another's line of fire. A single arc is the
// rule; only when the count would overcrowd one column does the fleet fan into a few
// side-by-side arcs (FLEET_ARC_MIN_PITCH_FACTOR sets the threshold). Those columns SQUEEZE
// horizontally to stay inside the side's half — the twin of the vertical spread — instead
// of marching off-screen at a fixed pitch; FLEET_ARC_COLUMN_GAP is the gap they prefer and
// compress below. The formation is centered in its muster box (the reserved BAND below the
// dome crossed with its half of the width), which derives from the content rect + the
// dome baseline, re-derived on a resize for free.
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
  FLEET_ARC_COLUMN_GAP,
  FLEET_ARC_DEPTH_FRAC,
  FLEET_ARC_MIN_PITCH_FACTOR,
  FLEET_AREA_BOTTOM_PAD,
  FLEET_AREA_TOP_GAP,
  FLEET_CENTER_GUTTER,
  MAX_FLEET_SPRITES,
  RENDER_ORDER_FLEET,
  Z_FLEET,
} from '../layout/constants';
import { domeBaselineY } from '../layout/row';

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
  // Extra space reserved at the BOTTOM of the muster band (env-px), raised during an encounter so the
  // formation clears the bottom encounter bar (EB, §15); 0 outside combat.
  private bottomReserve = 0;
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

  // Reserve extra space at the BOTTOM of the muster band (env-px) so the formation clears the bottom
  // encounter bar during combat (EB, §15). Idempotent; relayouts only on a real change. 0 = normal.
  setBottomReserve(px: number): void {
    if (this.bottomReserve === px) return;
    this.bottomReserve = px;
    this.relayout();
  }

  // Split the ready ships by side and spread each across its muster box: the player's
  // (the controlled faction) in the left half facing right, every other faction in the
  // right half facing left. The TOTAL is capped first, so the two sides together never
  // exceed the pool. The shared RESERVED BAND — the open field between the dome's lowest
  // planet (domeBaselineY − FLEET_AREA_TOP_GAP) and a pad above the content bottom — is
  // crossed with each side's half of the width (split by an open gutter at center) to
  // give the two muster boxes.
  private relayout(): void {
    const shown = this.ships.slice(0, MAX_FLEET_SPRITES);
    const mine = shown.filter((s) => s.factionId === CONTROLLED_FACTION_ID);
    const theirs = shown.filter((s) => s.factionId !== CONTROLLED_FACTION_ID);
    this.pickTargets.length = 0; // rebuilt by layoutGroup from the visible sprites

    // The reserved band's vertical extent. Top tracks the lowest planet so the fleet
    // sits just under the dome on any viewport; bottom is a pad above the content edge.
    const yTop = domeBaselineY(this.contentW, this.bufferH) - FLEET_AREA_TOP_GAP;
    const yBottom = FLEET_AREA_BOTTOM_PAD + this.bottomReserve;
    const center = this.contentW / 2;

    let next = this.layoutGroup(mine, sizes.edgePad, center - FLEET_CENTER_GUTTER, yBottom, yTop, 1, 0);
    next = this.layoutGroup(theirs, center + FLEET_CENTER_GUTTER, this.contentW - sizes.edgePad, yBottom, yTop, -1, next);

    // Hide the unused tail of the pool.
    for (let i = next; i < this.sprites.length; i++) this.sprites[i]!.mesh.visible = false;
  }

  // Draw one side up as a vertical ARC (a JRPG party row) in its muster box — the
  // rectangle [x0,x1] × [yBottom,yTop] — facing the enemy via `dir` (+1 right / −1 left).
  // Ships spread evenly down the band height (the centered equal-gap idiom — margins
  // equal the inter-ship gaps and expand together), then each is pushed along the facing
  // axis by a parabola of its position in the column: the flanks lead toward the enemy,
  // the middle hangs back, so the column CUPS AWAY from the foe (`( )`) and no hull
  // screens another's line of fire. A single column is the rule; only when the count
  // would overcrowd one (pitch below FLEET_ARC_MIN_PITCH_FACTOR · the sprite size) does
  // the fleet fan into several side-by-side arcs, split as evenly as possible. Those
  // columns center in the box at FLEET_ARC_COLUMN_GAP but SQUEEZE below it (the horizontal
  // twin of the vertical spread) so they never overrun the box edge; the actual gap caps
  // each bow so the outermost crescent stays in and neighbours never cross. Every center
  // is parity-snapped and written to BOTH mesh.position AND uCenter (the shader origin) —
  // the stars-row CPU-integer discipline. Consumes sprites from `start`, returns the next
  // free index.
  private layoutGroup(
    ships: readonly Ship[], x0: number, x1: number, yBottom: number, yTop: number, dir: number, start: number,
  ): number {
    const n = ships.length;
    if (n === 0) return start;

    // Uniform sprite size from the first ship's class (v1 has one class; a mixed fleet
    // would size to the largest).
    const r = this.spriteRadius(ships[0]!);
    const d = r * 2;
    const boxW = x1 - x0;
    const boxH = yTop - yBottom;

    // One column holds as many ships as fit at a comfortable pitch; past that the fleet
    // fans into evenly-split side-by-side arcs (the first n%cols columns carry one extra).
    const perArc = Math.max(1, Math.floor(boxH / (d * FLEET_ARC_MIN_PITCH_FACTOR)));
    const cols = Math.max(1, Math.ceil(n / perArc));

    // Horizontal spacing SQUEEZES to fit the box, the twin of the vertical spread: the
    // columns sit at the preferred gap but compress below it (equal-gap idiom, cols+1
    // gaps) when they'd otherwise overrun the box edge, and the whole block is centered.
    // The chosen gap also caps each column's bow so the outermost crescent stays in the
    // box and neighbours never cross (a single arc keeps its full bow — Infinity = no cap).
    const gapX = Math.min((boxW - cols * d) / (cols + 1), FLEET_ARC_COLUMN_GAP);
    const offsetX = (boxW - (cols * d + (cols + 1) * gapX)) / 2;
    const bowCap = cols > 1 ? Math.max(gapX, 0) : Infinity;

    let placed = 0;
    for (let c = 0; c < cols; c++) {
      const count = Math.floor(n / cols) + (c < n % cols ? 1 : 0);
      const colX = x0 + offsetX + gapX * (c + 1) + d * (c + 0.5);

      // Even-gap centered vertical spread (fills the band height; margins == gaps).
      const gapY = (boxH - count * d) / (count + 1);
      const pitchY = d + gapY;
      const firstY = yBottom + gapY + d / 2;
      const span = (count - 1) * pitchY; // top-ship to bottom-ship center distance
      const yMid = firstY + span / 2;
      // Cup depth from the column's own span, clamped to the (squeezed) column gap.
      const amp = Math.max(-bowCap, Math.min(span * FLEET_ARC_DEPTH_FRAC, bowCap));

      for (let k = 0; k < count; k++, placed++) {
        const sprite = this.sprites[start + placed]!;
        const ship = ships[placed]!;
        this.resizeSprite(sprite, d);
        (sprite.material.uniforms.uColor!.value as Color).set(factionColor(ship.factionId));
        sprite.material.uniforms.uRadius!.value = r;
        sprite.material.uniforms.uDir!.value = dir;

        const y = firstY + k * pitchY;
        const u = span > 0 ? (y - yMid) / (span / 2) : 0; // −1 (top) … +1 (bottom)
        // Concave toward the enemy: flanks (|u|→1) lead by +½·amp, the middle (u→0)
        // trails by −½·amp; `dir` aims that "forward" axis at the foe.
        const bow = amp * (u * u - 0.5);
        const cx = snapPxParity(colX + dir * bow, d);
        const cy = snapPxParity(y, d);
        sprite.mesh.position.set(cx, cy, Z_FLEET);
        (sprite.material.uniforms.uCenter!.value as Vector2).set(cx, cy);
        sprite.mesh.visible = true;
        this.pickTargets.push({ cx, cy, r, shipId: ship.id });
      }
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

