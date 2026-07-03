// FleetLayer — a system's fleet, drawn up as TWO opposing JRPG battle lines in the open field below the
// planet row. A ship is never anchored to a planet (planets and ships are independently-destroyable peers
// — decision 6). The ships split by FACTION: the player's side (the controlled faction) musters in the left
// half pointing right, every other faction in the right half pointing left, so the two read as a stand-off
// across the battlefield. Each side forms a vertical ARC (a JRPG party row): berths spread evenly down the
// band height (the centered equal-gap idiom), then bow into a crescent that CUPS AWAY from the enemy —
// flanks forward, middle hanging back — so the two sides read as `( )` and no friendly hull screens
// another's line of fire. A single arc is the rule; only when the count would overcrowd one column does the
// fleet fan into a few side-by-side arcs (FLEET_ARC_MIN_PITCH_FACTOR sets the threshold). Those columns
// SQUEEZE horizontally to stay inside the side's half; FLEET_ARC_COLUMN_GAP is the gap they prefer and
// compress below. The formation is centered in its muster box (the reserved BAND below the dome crossed
// with its half of the width), re-derived on a resize for free.
//
// BERTHS + WARP. The layer lays out a stable roster of BERTHS, not just the present ships: a ready ship
// DRAWS a sprite, while an INBOUND ship (warping toward this system) reserves an empty GAP it will warp into
// and an OUTBOUND ship (departed, still in transit) keeps a vacated GAP. Membership only changes on a real
// arrival/departure ELSEWHERE — a warp in/out merely re-categorizes a ship (ready↔transiting) WITHOUT
// changing the roster, so the OTHER berths never move: departing leaves a gap with no back-fill, and
// arriving drops into its pre-reserved spot, with NO reflow. A stable id order pins each berth's position.
// The warp ANIMATION moves the REAL sprite: startWarpOut/In register a per-ship timeline that update(now)
// advances, sliding the actual muster Mesh off the facing edge (out, accelerating) or in from off-screen
// onto its berth (in, decelerating) — no overlay, no copy. onWarpComplete fires when a timeline ends so the
// scene re-reads the roster (an out-ship becomes a clean gap; an in-ship a settled sprite).
//
// Primitive: one Mesh + PlaneGeometry per drawn berth, textured with a per-ship CanvasTexture — a ship
// renders as its ORDERED MODULE LIST (a ship has no class; it IS its modules) via the shared paintShipHull:
// a segmented hull of small kind-colored rects framed in the faction color, so the loadout reads at a glance
// and the two fleets read by their border color. The row is mirrored by facing side. The canvas is repainted
// only on relayout (a fleet change / resize / warp start), NearestFilter + parity-snapped so it stays
// pixel-crisp. Two trip-wires still apply: (b) disableCulling (positions are CPU-rewritten, so the cached
// bounding sphere goes stale) and (c) depthTest:false + a dedicated renderOrder (paint over bodies + cargo).
//
// Each drawn module's on-screen rect center is published via moduleCenterFor — the anchor the targeting-
// visuals layer hangs the weapon-primed glow on. Picks via pickAt select a settled ready ship (gaps + ships
// mid-warp are not pickable). The pool is hard-capped at MAX_FLEET_SPRITES.

import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, Scene } from 'three';
import { CONTROLLED_FACTION_ID } from '../../../factions/registry';
import type { FactionType } from '../../../factions/types';
import type { ShipComponentType } from '../../../ships/components/types';
import { sizes } from '../../../ui/theme';
import { paintToTexture } from '../../../ui/widget';
import { paintShipHull } from '../../ship-hull';
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

// Fleet-sprite radius derives from loadout heft (no ship classes): base hull + per-module increment.
// Tuned so a 2-module ship ≈ 25 and a 4-module full kit ≈ 28 — the old corvette/gunship spread.
const FLEET_SPRITE_BASE_PX = 22;
const FLEET_SPRITE_PER_MODULE_PX = 1.5;

// Warp fly-off / fly-in animation (moving the REAL sprite). All ms / buffer px.
const WARP_MS = 460;      // quick — the ship blinks off/in, not a leisurely glide
const WARP_MARGIN = 26;   // px past the content edge the sprite center travels to before it's fully gone

interface FleetSprite {
  readonly mesh: Mesh;
  geometry: PlaneGeometry;
  readonly material: MeshBasicMaterial;
  // Per-ship canvas + its texture — repainted (module row) only on relayout, NOT per frame.
  readonly canvas: HTMLCanvasElement;
  readonly tex: CanvasTexture;
  // Current built diameter in px — geometry + canvas are rebuilt only when it changes.
  diam: number;
}

// One module's published on-screen rect, rebuilt each relayout — the targeting weapon-glow anchor. `cx,cy`
// is the rect center in content-buffer px (Y-up), `r` a glow-sizing half-extent.
interface ModuleAnchor {
  readonly shipId: string;
  readonly componentId: ShipComponentType;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

// One formation BERTH — a ship's stable slot in the roster. `render` is true for a present ready ship (draw
// its sprite) and false for a reserved/vacated GAP (an inbound or outbound transiting ship). `components`/
// `factionId` paint the hull + pick the side (a gap still belongs to a side + reserves geometry).
export interface FleetBerth {
  readonly shipId: string;
  readonly factionId: FactionType;
  readonly components: readonly ShipComponentType[];
  readonly render: boolean;
}

type SlotCenter = { readonly cx: number; readonly cy: number; readonly r: number };

export class FleetLayer {
  private readonly sprites: FleetSprite[] = [];
  // The formation roster (caller-built: ready + reserved + vacated berths). Both feeders re-derive the
  // formation from these, so a resize or a roster change recompute from the same stored state.
  private berths: readonly FleetBerth[] = [];
  private contentW = 1;
  private bufferH = 1;
  // Extra space reserved at the BOTTOM of the muster band (env-px) for the encounter bar (EB, §15), held
  // permanently so entering/leaving combat never reflows the formation.
  private bottomReserve = 0;
  // Hit-test targets for pickAt — one entry per SETTLED ready sprite (a gap or a ship mid-warp is not
  // pickable). Rebuilt in relayout; reused in place so a pick/hover allocates nothing.
  private readonly pickTargets: FleetPickCandidate[] = [];
  // Per-module on-screen rects for the SETTLED ready sprites — the weapon-glow anchor source.
  private readonly moduleAnchors: ModuleAnchor[] = [];
  // Every berth's on-screen center (gaps included) — the warp animation's berth target + the slot seam.
  private readonly slotById = new Map<string, SlotCenter>();
  // The drawn sprite for a ship id (settled OR mid-warp) — the handle update() moves during a warp.
  private readonly spriteByShipId = new Map<string, FleetSprite>();
  // Active warp timelines, keyed by ship id. Advanced by update(now); an entry is removed when it ends.
  private readonly warps = new Map<string, { kind: 'in' | 'out'; startMs: number }>();

  // Fired when a warp timeline ends (an out-ship is now gone / an in-ship has settled), so the scene can
  // re-read the roster + repaint gauges. Set by SystemScene.
  onWarpComplete: () => void = () => {};

  constructor(scene: Scene) {
    for (let i = 0; i < MAX_FLEET_SPRITES; i++) {
      const canvas = document.createElement('canvas');
      const tex = paintToTexture(canvas);
      const material = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
      material.depthTest = false; // trip-wire (c): paint over the bodies + cargo dots
      const geometry = new PlaneGeometry(1, 1); // sized per-ship on the first relayout
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = RENDER_ORDER_FLEET;
      mesh.visible = false; // hidden until a relayout places it (no origin flash)
      disableCulling(mesh); // trip-wire (b): positions are CPU-rewritten
      scene.add(mesh);
      this.sprites.push({ mesh, geometry, material, canvas, tex, diam: 1 });
    }
  }

  // The system's formation roster → the rendered fleet. Caps at MAX_FLEET_SPRITES berths.
  setFleet(berths: readonly FleetBerth[]): void {
    this.berths = berths;
    this.relayout();
  }

  // Re-derive the formation when the content rect changes (resize).
  layout(contentW: number, bufferH: number): void {
    this.contentW = contentW;
    this.bufferH = bufferH;
    this.relayout();
  }

  // Reserve extra space at the BOTTOM of the muster band (env-px) so the formation clears the encounter bar.
  // Idempotent; relayouts only on a real change.
  setBottomReserve(px: number): void {
    if (this.bottomReserve === px) return;
    this.bottomReserve = px;
    this.relayout();
  }

  // -- warp (moving the REAL sprite) ------------------------------------

  // Begin a ship's warp-OUT: it accelerates off the facing edge, then vanishes (its berth stays a gap). The
  // ship must be a current berth (a vacated outbound gap in real play, or a ready sprite in the DEV demo);
  // relayout draws its sprite even if the berth is a gap so update() has something to move.
  startWarpOut(shipId: string, now: number): void {
    if (!this.slotById.has(shipId)) return; // not a berth — nothing to fly
    this.warps.set(shipId, { kind: 'out', startMs: now });
    this.relayout();
  }

  // Begin a ship's warp-IN: it flies in from off the facing edge and settles onto its reserved berth.
  startWarpIn(shipId: string, now: number): void {
    if (!this.slotById.has(shipId)) return;
    this.warps.set(shipId, { kind: 'in', startMs: now });
    this.relayout();
  }

  isWarping(shipId: string): boolean {
    return this.warps.has(shipId);
  }

  // Per-frame: advance every active warp, sliding its real sprite along the facing axis. A finished out-ship
  // hides (becomes a clean gap on the next roster read); a finished in-ship snaps to its berth. Fires
  // onWarpComplete once if any ended, so the scene re-reads the roster + gauges. No-op (and no alloc) idle.
  update(now: number): void {
    if (this.warps.size === 0) return;
    let anyEnded = false;
    for (const [shipId, w] of this.warps) {
      const sprite = this.spriteByShipId.get(shipId);
      const berth = this.slotById.get(shipId);
      if (!sprite || !berth) { this.warps.delete(shipId); anyEnded = true; continue; }
      const t = (now - w.startMs) / WARP_MS;
      if (t >= 1) {
        this.warps.delete(shipId);
        anyEnded = true;
        if (w.kind === 'out') sprite.mesh.visible = false;             // gone
        else sprite.mesh.position.set(berth.cx, berth.cy, Z_FLEET);    // settled on its berth
        continue;
      }
      const dir = berth.cx < this.contentW / 2 ? 1 : -1; // +1 nose points +x (player) / −1 mirrored
      const off = dir > 0 ? this.contentW + berth.r + WARP_MARGIN : -berth.r - WARP_MARGIN;
      const x = w.kind === 'out'
        ? lerp(berth.cx, off, t * t)                    // accelerate off the facing edge
        : lerp(off, berth.cx, 1 - (1 - t) * (1 - t));   // decelerate in onto the berth
      sprite.mesh.position.set(snapPxParity(x, berth.r * 2), berth.cy, Z_FLEET);
    }
    if (anyEnded) this.onWarpComplete();
  }

  // -- layout -----------------------------------------------------------

  // Split the berths by side and spread each across its muster box, laying out ALL berths (gaps included) so
  // positions stay stable when a ship warps in/out. A berth draws a sprite when it's a present ready ship OR
  // currently mid-warp (so update has something to move); a reserved/vacated gap draws nothing but still
  // reserves its slot.
  private relayout(): void {
    const shown = this.berths.slice(0, MAX_FLEET_SPRITES);
    const mine = shown.filter((b) => b.factionId === CONTROLLED_FACTION_ID);
    const theirs = shown.filter((b) => b.factionId !== CONTROLLED_FACTION_ID);
    this.slotById.clear();
    this.spriteByShipId.clear();
    this.pickTargets.length = 0;
    this.moduleAnchors.length = 0;

    const yTop = domeBaselineY(this.contentW, this.bufferH) - FLEET_AREA_TOP_GAP;
    const yBottom = FLEET_AREA_BOTTOM_PAD + this.bottomReserve;
    const center = this.contentW / 2;

    let next = this.layoutGroup(mine, sizes.edgePad, center - FLEET_CENTER_GUTTER, yBottom, yTop, 1, 0);
    next = this.layoutGroup(theirs, center + FLEET_CENTER_GUTTER, this.contentW - sizes.edgePad, yBottom, yTop, -1, next);

    for (let i = next; i < this.sprites.length; i++) this.sprites[i]!.mesh.visible = false;
  }

  // Draw one side up as a vertical ARC in its muster box [x0,x1] × [yBottom,yTop], facing the enemy via `dir`
  // (+1 right / −1 left). Every berth gets a stable position (recorded in slotById); a berth that draws
  // (present ready OR mid-warp) consumes the next sprite. Consumes sprites from `spriteStart`, returns the
  // next free index.
  private layoutGroup(
    berths: readonly FleetBerth[], x0: number, x1: number, yBottom: number, yTop: number, dir: number, spriteStart: number,
  ): number {
    const n = berths.length;
    if (n === 0) return spriteStart;

    // Uniform sprite size from the first berth's loadout (a mixed fleet would size to the largest).
    const r = this.spriteRadius(berths[0]!);
    const d = r * 2;
    const boxW = x1 - x0;
    const boxH = yTop - yBottom;

    const perArc = Math.max(1, Math.floor(boxH / (d * FLEET_ARC_MIN_PITCH_FACTOR)));
    const cols = Math.max(1, Math.ceil(n / perArc));
    const gapX = Math.min((boxW - cols * d) / (cols + 1), FLEET_ARC_COLUMN_GAP);
    const offsetX = (boxW - (cols * d + (cols + 1) * gapX)) / 2;
    const bowCap = cols > 1 ? Math.max(gapX, 0) : Infinity;

    let spriteCursor = spriteStart;
    let placed = 0;
    for (let c = 0; c < cols; c++) {
      const count = Math.floor(n / cols) + (c < n % cols ? 1 : 0);
      const colX = x0 + offsetX + gapX * (c + 1) + d * (c + 0.5);

      const gapY = (boxH - count * d) / (count + 1);
      const pitchY = d + gapY;
      const firstY = yBottom + gapY + d / 2;
      const span = (count - 1) * pitchY;
      const yMid = firstY + span / 2;
      const amp = Math.max(-bowCap, Math.min(span * FLEET_ARC_DEPTH_FRAC, bowCap));

      for (let k = 0; k < count; k++, placed++) {
        const berth = berths[placed]!;
        const y = firstY + k * pitchY;
        const u = span > 0 ? (y - yMid) / (span / 2) : 0;
        const bow = amp * (u * u - 0.5);
        const cx = snapPxParity(colX + dir * bow, d);
        const cy = snapPxParity(y, d);
        this.slotById.set(berth.shipId, { cx, cy, r });

        // Draw a sprite for a present ready ship OR a ship mid-warp; a reserved/vacated gap draws nothing.
        // Only a SETTLED ready ship is pickable + publishes weapon-glow anchors (a warping hull is moving).
        const warping = this.warps.has(berth.shipId);
        if (!berth.render && !warping) continue;
        const sprite = this.sprites[spriteCursor++]!;
        this.resizeSprite(sprite, d);
        sprite.mesh.position.set(cx, cy, Z_FLEET);
        sprite.mesh.visible = true;
        const pickable = berth.render && !warping;
        this.paintSprite(sprite, berth, cx, cy, r, dir, pickable);
        this.spriteByShipId.set(berth.shipId, sprite);
        if (pickable) this.pickTargets.push({ cx, cy, r, shipId: berth.shipId });
      }
    }
    return spriteCursor;
  }

  // Hit-test the formation: the settled ready ship whose disc covers (x, y), or null.
  pickAt(x: number, y: number): DiagramHit | null {
    const shipId = pickFleetShip(this.pickTargets, x, y);
    return shipId === null ? null : { pick: { kind: 'ship', shipId }, z: Z_FLEET };
  }

  // The on-screen slot center of a given ship (content-buffer px), or null if it isn't a berth — the anchor
  // source for the action menu / combat chrome / gauges. Returns a berth position even for a gap or a ship
  // mid-warp (consumers that must not address those filter by renderedShipIds()).
  slotCenterFor(shipId: string): SlotCenter | null {
    return this.slotById.get(shipId) ?? null;
  }

  // The ids of the SETTLED ready ships actually laid out (pickable). The commandable-actor ring + the
  // target-candidate mint filter to this — a gap, an overflow ship, or a ship mid-warp must never be lockable.
  renderedShipIds(): readonly string[] {
    return this.pickTargets.map((t) => t.shipId);
  }

  // The on-screen center of a settled ship's module — the FIRST module whose component id matches, or null.
  moduleCenterFor(shipId: string, componentId: string): SlotCenter | null {
    for (const m of this.moduleAnchors) {
      if (m.shipId === shipId && m.componentId === componentId) return { cx: m.cx, cy: m.cy, r: m.r };
    }
    return null;
  }

  // Fleet-sprite radius (content-buffer px): base hull + a per-module increment, so a heavier ship reads bigger.
  private spriteRadius(berth: FleetBerth): number {
    return FLEET_SPRITE_BASE_PX + berth.components.length * FLEET_SPRITE_PER_MODULE_PX;
  }

  private resizeSprite(sprite: FleetSprite, d: number): void {
    if (sprite.diam === d) return;
    sprite.geometry.dispose();
    sprite.geometry = new PlaneGeometry(d, d);
    sprite.mesh.geometry = sprite.geometry;
    sprite.canvas.width = Math.max(1, Math.round(d));
    sprite.canvas.height = sprite.canvas.width;
    sprite.diam = d;
  }

  // Paint one berth's ORDERED modules as a segmented hull onto its sprite canvas via the shared painter, and
  // (when pickable) record each module's on-screen rect center into moduleAnchors. The canvas maps [0,d]→
  // [cx−r, cx+r] in content space and the band sits on the ship's mid-line (cy), so a module's local
  // center-x maps to cx−r+localX.
  private paintSprite(sprite: FleetSprite, berth: FleetBerth, cx: number, cy: number, r: number, dir: number, recordAnchors: boolean): void {
    const d = Math.max(1, Math.round(r * 2));
    const g = sprite.canvas.getContext('2d')!;
    g.clearRect(0, 0, d, d);
    paintShipHull(
      g, d / 2, d / 2, d, berth.components, berth.factionId, dir,
      recordAnchors
        ? (componentId, localCenterX, glowR) => this.moduleAnchors.push({
            shipId: berth.shipId, componentId, cx: Math.round(cx - r + localCenterX), cy: Math.round(cy), r: glowR,
          })
        : undefined,
    );
    sprite.tex.needsUpdate = true;
  }

  dispose(): void {
    for (const s of this.sprites) {
      s.geometry.dispose();
      s.material.dispose();
      s.tex.dispose();
    }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
