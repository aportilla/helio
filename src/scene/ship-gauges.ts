// ShipGaugesOverlay — the per-sprite HP + energy gauges painted ABOVE each fleet ship, a PERSISTENT
// part of the system view's ship rendering (not just combat chrome): one content-buffer-sized
// CanvasTexture quad drawing, anchored above each ship's live slot, its HP bar (hull + shield bands)
// plus a thinner amber energy gauge (the salvo gate), with an active-turn marker and a downed dim.
//
// Generic + combat-agnostic by design: it reads a flat ShipGauge DTO (current/max + a faction color +
// the two combat flags), never an encounter type. That lets ONE renderer serve BOTH paths — at rest
// SystemScene feeds it each ready ship's FULL hull + charge (derived from the loadout); during an
// encounter the EncounterController feeds it the live combatant values (depleted hull, raised shields,
// the active-turn marker). It owns its own ortho Scene + camera (the TargetingVisuals precedent) so
// SystemScene composites it in the content scissor right after the diagram — over the ships, under the
// combat tracers + targeting FX. Repainted only on a real change (a fleet relayout / resize, or a
// settled combat action), never per frame, so the full-buffer canvas cost stays negligible.

import { OrthographicCamera, Scene, type WebGLRenderer } from 'three';
import { Widget } from '../ui/widget';
import type { SlotCenter } from './actions/system-action-menu';

// One ship's vitals as the renderer reads them — flat data, no combat knowledge. `hull`/`shields`/`max`
// share one unit (only the ratio to `max` matters: at rest hull===max for a full bar); `energyMax` 0 ⇒
// an empty (frame-only) energy gauge. `active`/`down` are the combat-only marks (false at rest).
export interface ShipGauge {
  readonly id: string;        // entity id → slot lookup (a ship id today; a body id once E5 lands)
  readonly hull: number;      // hull-band fill, relative to `max`
  readonly shields: number;   // shield HP stacked above hull, relative to `max` (0 at rest)
  readonly max: number;       // the HP bar's denominator (Σ pool max)
  readonly energy: number;    // energy-gauge fill, relative to `energyMax`
  readonly energyMax: number; // the energy gauge's denominator; 0 ⇒ frame only, no fill
  readonly hullColor: string; // hull-band fill (the owning faction's color)
  readonly active: boolean;   // the active-turn marker (combat only)
  readonly down: boolean;     // the downed dim (combat only)
}

// All env px. The HP bar rides above each sprite with the energy gauge stacked just beneath it (both
// clear of the sprite top); the active marker is a bright 1-px frame around the pair.
const BAR_W = 26;
const BAR_H = 4;
const BAR_GAP = 6; // gap between the sprite's top edge and the lowest gauge (the energy bar)
const EBAR_H = 2; // the energy gauge is thinner than the HP bar — a secondary readout
const EBAR_GAP = 2; // gap between the HP bar and the energy gauge below it
const PLATE = '#000814'; // the surface fill (matches the HUD plate) so a bar reads on any hull
const BORDER = '#1e6fc4'; // dim-blue gauge frame — so a full (light) OR empty bar still reads on black
const DOWN_BORDER = '#3a3a3a'; // a downed slot's frame goes grey ("out")
const ACTIVE = '#ffe98a'; // the active-turn marker (the locked-target yellow)
const SHIELD_FILL = '#5b8dd6'; // shield-band portion (matches the shield effect-chip hue)
const ENERGY_FILL = '#f0a830'; // amber energy — distinct from the faction-color hull + blue shield

// Over the diagram (the fleet sits at RENDER_ORDER_FLEET) but under the combat tracers + targeting FX,
// which SystemScene composites in LATER render passes (so pass order, not this, decides those).
const RENDER_ORDER = 80;

export class ShipGaugesOverlay extends Widget {
  readonly scene = new Scene();
  // Content-buffer ortho (1 unit = 1 px, Y-up), sized in resize() — the same space the fleet slot
  // anchors live in, so a drawn bar lands exactly above its ship.
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);
  private contentW = 1;
  private bufH = 1;

  constructor() {
    super(RENDER_ORDER);
    this.addTo(this.scene);
  }

  // (Re)aim the camera at the content buffer (the diagram's slot-anchor space). The texture is rebuilt
  // per paint(), so a resize alone changes no pixels — SystemScene repaints right after.
  resize(contentBufferW: number, bufferH: number): void {
    this.contentW = Math.max(1, contentBufferW);
    this.bufH = Math.max(1, bufferH);
    this.camera.right = this.contentW;
    this.camera.top = this.bufH;
    this.camera.updateProjectionMatrix();
  }

  // Paint every gauge onto one content-buffer canvas. `slotCenterFor` maps a gauge's durable id to its
  // live on-screen slot (the same accessor the action menu + combat chrome anchor through), so the
  // gauges track the fleet layout for free. An empty list — or one whose ids resolve to no live slot —
  // hides the quad rather than uploading a blank texture.
  paint(gauges: readonly ShipGauge[], slotCenterFor: (id: string) => SlotCenter | null): void {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, this.contentW);
    canvas.height = Math.max(1, this.bufH);
    const g = canvas.getContext('2d')!;
    let painted = false;
    for (const gauge of gauges) {
      const slot = slotCenterFor(gauge.id);
      if (!slot) continue; // a gauge with no live slot (gone / off-layout) draws nothing
      const x = Math.round(slot.cx - BAR_W / 2);
      // The HP bar's TOP, raised to leave room for the energy gauge stacked beneath it AND the BAR_GAP
      // above the sprite. Buffer coords are Y-up (origin bottom-left); the canvas is Y-down with flipY
      // mapping canvas-top → quad-top, so a buffer height H converts as y = H - up.
      const topUp = slot.cy + slot.r + BAR_GAP + EBAR_H + EBAR_GAP + BAR_H;
      const y = Math.round(this.bufH - topUp);
      this.paintBar(g, x, y, gauge);
      painted = true;
    }
    if (!painted) {
      this.hide();
      return;
    }
    this.setTexture(canvas, canvas.width, canvas.height);
    this.placeAt(0, 0);
  }

  hide(): void {
    this.setVisible(false);
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  // Paint one ship's stacked gauges at HP-bar top-left (x, y): the HP bar (hull + shield bands) on top,
  // a thinner amber energy gauge (the salvo gate) directly beneath it, and a bright 1-px active-turn
  // marker enclosing BOTH when it's this ship's combat turn. A downed slot greys its frames and empties.
  private paintBar(g: CanvasRenderingContext2D, x: number, y: number, gauge: ShipGauge): void {
    const down = gauge.down;
    const frame = down ? DOWN_BORDER : BORDER;
    const max = gauge.max;
    const wOf = (v: number) => (max > 0 ? Math.round(BAR_W * Math.max(0, Math.min(1, v / max))) : 0);

    // A bordered, dark plate — the frame gives the gauge a constant extent so a full (light-faction) bar
    // AND an empty (downed) one both read against the black field. A downed slot's frame goes grey.
    g.fillStyle = frame;
    g.fillRect(x - 1, y - 1, BAR_W + 2, BAR_H + 2);
    g.fillStyle = PLATE;
    g.fillRect(x, y, BAR_W, BAR_H);
    if (!down) {
      // The hull band (bottom of the cascade) vs the shields stacked above it — two segments so a raised
      // shield reads as a distinct blue extension, depleting visibly as it absorbs.
      const hullW = wOf(gauge.hull);
      g.fillStyle = gauge.hullColor;
      g.fillRect(x, y, hullW, BAR_H);
      const shieldW = Math.min(BAR_W - hullW, wOf(gauge.shields));
      if (shieldW > 0) {
        g.fillStyle = SHIELD_FILL;
        g.fillRect(x + hullW, y, shieldW, BAR_H);
      }
    }

    // Energy gauge, beneath the HP bar: the per-ship salvo gate (energy / energyMax). Amber and thinner,
    // framed the same way, so HP and energy read as a stacked pair, never confused for one bar.
    const ey = y + BAR_H + EBAR_GAP;
    g.fillStyle = frame;
    g.fillRect(x - 1, ey - 1, BAR_W + 2, EBAR_H + 2);
    g.fillStyle = PLATE;
    g.fillRect(x, ey, BAR_W, EBAR_H);
    if (!down && gauge.energyMax > 0) {
      const ew = Math.round(BAR_W * Math.max(0, Math.min(1, gauge.energy / gauge.energyMax)));
      g.fillStyle = ENERGY_FILL;
      g.fillRect(x, ey, ew, EBAR_H);
    }

    // Active-turn marker: a 1-px yellow frame enclosing BOTH gauges (the locked-target colour).
    if (gauge.active) {
      const top = y - 2;
      const bottom = ey + EBAR_H + 1; // the energy gauge's frame bottom row
      const h = bottom - top + 1;
      g.fillStyle = ACTIVE;
      g.fillRect(x - 2, top, BAR_W + 4, 1);
      g.fillRect(x - 2, bottom, BAR_W + 4, 1);
      g.fillRect(x - 2, top, 1, h);
      g.fillRect(x + BAR_W + 1, top, 1, h);
    }
  }
}
