// TargetingVisuals — the action-menu's in-field targeting FX, keyed to the menu's focus DEPTH. A
// transient overlay that lights up the actor + its target as you drill the anchored action menu:
//
//   menu open on an actor (category / command level)  ->  ENGINE GLOW behind the actor's rear
//   weapon armed, target level                        ->  + WEAPON-PRIMED glow on the actor,
//                                                          a yellow TARGET LINE actor->target,
//                                                          and a RETICLE on the locked target
//
// Escape walking the menu back up a level reverts the states for free: it flows through the
// controller's refresh(), so each frame SystemScene re-reads SystemActionMenu.focusState() and the
// level alone decides what paints (target id gone -> no line/reticle; menu closed -> nothing).
//
// A SIBLING of CombatTracers in the SAME content-buffer CanvasTexture idiom (a Widget whose canvas
// is redrawn each frame and re-uploaded via needsUpdate), owning its own ortho scene/camera so
// SystemScene composites it in the content scissor right after the diagram + combat chrome — over
// the ships, under the HUD/menu/sidebar. Positions re-resolve through the same `slotCenterFor`
// accessor every frame, so a body target (E5) or a resize needs no new path, and the FX track the
// live fleet layout. It is driven by menu focus (not combat events), so it serves BOTH the live
// system view and an encounter (the one shared menu drives both). Render-only: nothing here reaches
// the reducer.
//
// Pixel-crisp discipline (the committed identity): the two glows are Bayer-DITHERED additive
// stipples — the star-halo idiom (a thresholded radial falloff, never a sampled alpha gradient) —
// and the line + reticle are pixel-snapped 1-px fillRect runs. No AA, no smooth gradients, no
// sub-pixel positioning. The "final art" is deliberately basic; the SEAMS (weaponAnchor, the per-FX
// draw calls) are where a richer look — or per-module anchoring once ships render as their modules —
// slots in.

import { OrthographicCamera, Scene, type CanvasTexture, type WebGLRenderer } from 'three';
import { paintToTexture, Widget } from '../ui/widget';
import type { SlotCenter, TargetingFocus } from './actions/system-action-menu';

// 4x4 ordered (Bayer) threshold matrix, normalized to (0,1). A glow pixel paints iff its radial
// density exceeds the matrix cell for its (x,y) — so the falloff reads as a stipple that thins
// outward, never a smooth ramp (the star-halo / disc-fringe technique).
const BAYER4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
].map((v) => (v + 0.5) / 16);

// All buffer px. Render-only sizing — never reaches the reducer.
const ENGINE_COLOR = '#4bb6ff';   // cyan ion-drive bloom — sits in the HUD's cyan palette, distinct from a weapon accent
const ENGINE_RADIUS = 15;         // stipple reach of the engine plume
const ENGINE_STRETCH = 1.7;       // plume is longer than wide along the rear axis
const ENGINE_PULSE_MS = 360;      // slow idle shimmer
const ENGINE_PULSE_LO = 0.6;      // density floor..ceil of the pulse (keeps it always lit)
const ENGINE_PULSE_HI = 1.0;

const WEAPON_RADIUS = 11;         // weapon-primed charge bloom
const WEAPON_PULSE_MS = 120;      // faster, urgent "charging" pulse
const WEAPON_PULSE_LO = 0.45;
const WEAPON_PULSE_HI = 1.0;
const WEAPON_ANCHOR_FRAC = 0.45;  // how far from center toward the nose the charge sits (0 = center, 1 = nose)
const WEAPON_RING_MS = 700;       // a charge ring contracts inward on this loop
const WEAPON_RING_GAP = 5;        // ring's max radius beyond the bloom

const LINE_COLOR = '#ffe98a';     // the locked-target yellow (matches the combat active-turn marker)
const LINE_DOT_STEP = 4;          // px between the line's 1-px dots
const LINE_FLOW_MS = 70;          // dash flow: ms per px of crawl toward the target
const RETICLE_COLOR = '#ffe98a';
const RETICLE_PAD = 5;            // gap (px) between the target sprite edge and the reticle frame
const RETICLE_ARM = 5;           // length (px) of each corner-bracket arm
const RETICLE_PULSE_MS = 220;    // reticle breathes a touch
const RETICLE_PULSE_PX = 2;      // ..by this many px

const RENDER_ORDER = 90; // under the menu/HUD (which render in a later pass anyway); over the diagram

export class TargetingVisuals extends Widget {
  readonly scene = new Scene();
  // Content-buffer ortho (1 unit = 1 px, Y-up), sized in resize() — the same space the fleet slot
  // anchors live in, so a drawn point lands exactly on its ship.
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private tex: CanvasTexture | null = null;
  private contentW = 1;
  private bufH = 1;
  private focus: TargetingFocus | null = null;
  // True once the canvas has been cleared for an empty focus — so a closed menu costs nothing per
  // frame (mirrors SystemActionMenu.tick's no-op-while-closed guard).
  private cleared = true;

  constructor(
    private readonly slotCenterFor: (id: string) => SlotCenter | null,
    // Resolves an actor + its armed weapon's provider id to that MODULE's on-screen rect (the modular
    // fleet render). Returns null off a ship / when the module isn't rendered — the glow then falls
    // back to the hull front.
    private readonly moduleCenterFor: (id: string, componentId: string) => SlotCenter | null,
  ) {
    super(RENDER_ORDER);
    this.g = this.canvas.getContext('2d')!;
    this.addTo(this.scene);
  }

  // (Re)size the canvas + its persistent texture to the content buffer (the diagram's slot-anchor
  // space) and aim the camera there. Mirrors CombatTracers.resize.
  resize(contentBufferW: number, bufferH: number): void {
    this.contentW = Math.max(1, contentBufferW);
    this.bufH = Math.max(1, bufferH);
    this.canvas.width = this.contentW;
    this.canvas.height = this.bufH;
    if (this.tex) this.tex.dispose();
    this.tex = paintToTexture(this.canvas);
    this.material.map = this.tex;
    this.material.needsUpdate = true;
    this.setSize(this.contentW, this.bufH);
    this.placeAt(0, 0);
    this.camera.right = this.contentW;
    this.camera.top = this.bufH;
    this.camera.updateProjectionMatrix();
    this.setVisible(false);
    this.cleared = true;
  }

  // Publish the menu's current focus (from SystemActionMenu.focusState()). Null = nothing focused.
  // Cheap — the redraw happens in tick() so the glows can pulse.
  setFocus(focus: TargetingFocus | null): void {
    this.focus = focus;
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  // Per-frame: repaint the FX for the current focus at time `now` (the glows pulse, the line
  // crawls). A closed menu (null focus) clears once then early-returns, so it's free while idle.
  tick(now: number): void {
    if (!this.tex) return;
    if (!this.focus) {
      if (!this.cleared) this.clear();
      return;
    }
    const actor = this.slotCenterFor(this.focus.actorId);
    if (!actor) {
      if (!this.cleared) this.clear();
      return;
    }
    const g = this.g;
    g.clearRect(0, 0, this.contentW, this.bufH);

    // The actor is the controlled side, which musters facing the enemy (player left -> faces right).
    // Derive the facing from which half it sits in rather than baking a side, so it stays correct if
    // the formation sides ever flip: +1 => nose points +x, rear at -x; -1 => mirrored.
    const dir = actor.cx < this.contentW / 2 ? 1 : -1;

    // Engine glow — always while focused (the menu is open on this ship). Stipple sits just behind
    // the rear (the flat base, opposite the nose) and plumes further out along -dir.
    const enginePulse = ENGINE_PULSE_LO + (ENGINE_PULSE_HI - ENGINE_PULSE_LO) * wave(now, ENGINE_PULSE_MS);
    const rearX = actor.cx - dir * (actor.r + ENGINE_RADIUS * 0.4);
    this.stipple(rearX, actor.cy, ENGINE_RADIUS, ENGINE_STRETCH, ENGINE_COLOR, enginePulse);

    // Target-level extras: the weapon is armed, so light the charge + draw the aim.
    if (this.focus.level === 'target') {
      const weaponColor = this.focus.weaponColor ?? LINE_COLOR;
      // Weapon-primed glow — a charge bloom that emanates from the FIRING module's rect (modular fleet
      // render). Falls back to a point forward of center (toward the business end) when the module
      // can't be resolved (a body weapon, or the rect isn't laid out).
      const mod = this.focus.weaponComponentId
        ? this.moduleCenterFor(this.focus.actorId, this.focus.weaponComponentId)
        : null;
      const wx = mod ? mod.cx : actor.cx + dir * actor.r * WEAPON_ANCHOR_FRAC;
      const wy = mod ? mod.cy : actor.cy;
      const weaponPulse = WEAPON_PULSE_LO + (WEAPON_PULSE_HI - WEAPON_PULSE_LO) * wave(now, WEAPON_PULSE_MS);
      this.stipple(wx, wy, WEAPON_RADIUS, 1, weaponColor, weaponPulse);
      this.chargeRing(wx, wy, now, weaponColor);

      // Aim: line from the actor's nose to the locked target, + a reticle on the target.
      const target = this.focus.targetId ? this.slotCenterFor(this.focus.targetId) : null;
      if (target) {
        const noseX = actor.cx + dir * actor.r;
        this.targetLine(noseX, actor.cy, target, now);
        this.reticle(target, now);
      }
    }

    this.tex.needsUpdate = true;
    this.setVisible(true);
    this.cleared = false;
  }

  override dispose(): void {
    if (this.tex) {
      this.tex.dispose();
      this.tex = null;
    }
    super.dispose();
  }

  // -- primitives (all buffer-px in; the canvas is Y-down so flip once per draw) ----------------

  // Y-flip: buffer space is Y-up (origin bottom-left); the canvas is Y-down.
  private cy(yUp: number): number {
    return this.bufH - yUp;
  }

  private clear(): void {
    this.g.clearRect(0, 0, this.contentW, this.bufH);
    if (this.tex) this.tex.needsUpdate = true;
    this.setVisible(false);
    this.cleared = true;
  }

  // A Bayer-dithered additive stipple centered at (cx, cy): for each pixel in the bounding box, a
  // radial density (quadratic falloff, scaled by `intensity`, stretched by `stretch` along the
  // facing axis for a plume) is thresholded against the ordered matrix, painting a 1-px square where
  // it passes. 'lighter' composite makes overlaps brighten like the additive star halo.
  private stipple(cx: number, cy: number, radius: number, stretch: number, color: string, intensity: number): void {
    const g = this.g;
    const cyc = this.cy(cy);
    const rx = radius * stretch; // along the facing axis (the plume length)
    const x0 = Math.round(cx - rx);
    const x1 = Math.round(cx + rx);
    const y0 = Math.round(cyc - radius);
    const y1 = Math.round(cyc + radius);
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = color;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        // Normalized elliptical distance: the x (facing) axis is scaled by `stretch` so the bloom
        // plumes along the hull's axis; the center is already placed behind the rear, so a symmetric
        // ellipse here reads as a tail trailing off the engine.
        const nx = (px - cx) / rx;
        const ny = (py - cyc) / radius;
        const d2 = nx * nx + ny * ny;
        if (d2 >= 1) continue;
        const f = 1 - Math.sqrt(d2);
        const density = f * f * intensity;
        if (density > BAYER4[(py & 3) * 4 + (px & 3)]!) g.fillRect(px, py, 1, 1);
      }
    }
    g.restore();
  }

  // A single charge ring that contracts toward the weapon anchor on a loop — a cheap "spinning up"
  // read. Drawn as a thin dithered ring (1-px squares around the circle), additive.
  private chargeRing(cx: number, cy: number, now: number, color: string): void {
    const phase = wave(now, WEAPON_RING_MS); // 0..1..0
    const ringR = WEAPON_RADIUS + WEAPON_RING_GAP - (WEAPON_RADIUS + WEAPON_RING_GAP) * phase * 0.55;
    const cyc = this.cy(cy);
    const g = this.g;
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = color;
    const steps = Math.max(8, Math.round(ringR * 2));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const px = Math.round(cx + Math.cos(a) * ringR);
      const py = Math.round(cyc + Math.sin(a) * ringR);
      if (BAYER4[(py & 3) * 4 + (px & 3)]! < 0.5) g.fillRect(px, py, 1, 1);
    }
    g.restore();
  }

  // The yellow aim line: 1-px dots stepping from the actor's nose to the target's center, the dash
  // phase crawling toward the target over time. The run stops at the reticle so it doesn't clutter
  // the target. Pixel-snapped — never a stroked line.
  private targetLine(ax: number, ay: number, target: SlotCenter, now: number): void {
    const bx = target.cx;
    const by = target.cy;
    const ayc = this.cy(ay);
    const byc = this.cy(by);
    const dx = bx - ax;
    const dy = byc - ayc;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len;
    const uy = dy / len;
    const stop = Math.max(0, len - (target.r + RETICLE_PAD)); // don't draw into the reticle
    const flow = (now / LINE_FLOW_MS) % LINE_DOT_STEP; // dash crawl toward the target
    const g = this.g;
    g.fillStyle = LINE_COLOR;
    for (let d = flow; d < stop; d += LINE_DOT_STEP) {
      g.fillRect(Math.round(ax + ux * d), Math.round(ayc + uy * d), 1, 1);
    }
  }

  // Four corner brackets framing the target (a reticle, not a full box), breathing a couple px. Each
  // arm is a 1-px fillRect run — the active-turn-marker idiom in the locked-target yellow.
  private reticle(target: SlotCenter, now: number): void {
    const breathe = Math.round(RETICLE_PULSE_PX * wave(now, RETICLE_PULSE_MS));
    const half = Math.round(target.r + RETICLE_PAD + breathe);
    const cx = Math.round(target.cx);
    const cyc = Math.round(this.cy(target.cy));
    const g = this.g;
    g.fillStyle = RETICLE_COLOR;
    const arm = RETICLE_ARM;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const x = cx + sx * half;
        const y = cyc + sy * half;
        // horizontal arm (toward center) + vertical arm (toward center)
        g.fillRect(sx < 0 ? x : x - arm + 1, y, arm, 1);
        g.fillRect(x, sy < 0 ? y : y - arm + 1, 1, arm);
      }
    }
  }
}

// A 0..1..0 triangle/sine wave for the FX pulses — sin mapped to [0,1].
function wave(now: number, periodMs: number): number {
  return (Math.sin((now / periodMs) * Math.PI * 2) + 1) / 2;
}
