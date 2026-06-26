// CombatOverlay — the minimal pixel-art combat chrome painted OVER the live fleet sprites during an
// encounter (E3/EB). A scene-side, combat-specific Widget (it reads encounter DTOs + faction colors —
// scene may; the generic ui/ toolkit may not): one content-buffer-sized CanvasTexture quad that draws,
// anchored above each combatant's live slot, its HP bar (hull + shield bands) PLUS a thinner energy
// gauge (the per-ship salvo gate), with an active-turn marker and a downed dim. Repainted once per
// settled action (at the end of an EV animation window, §14), not per frame, so the full-buffer canvas
// cost is negligible at combat cadence. The per-SIDE INITIATIVE readout is NOT here — it moved to the
// bottom encounter bar (src/ui/encounter-hud/, §15); this overlay is purely per-sprite. The ANIMATED
// chrome (bolts, number-pops, kill bursts) lives in its per-frame sibling CombatTracers
// (encounter-tracers.ts); this overlay is the static HP / energy baseline beneath it.

import { Widget } from '../ui/widget';
import { factionColor } from '../factions/registry';
import { ENERGY_MAX_STAT, ENERGY_STAT, isDown, type Combatant } from '../encounter/state';
import type { SlotCenter } from './actions/system-action-menu';

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

export class CombatOverlay extends Widget {
  // Paint every combatant's chrome onto one content-buffer canvas. `slotCenterFor` maps a combatant's
  // durable id to its live on-screen slot (the same accessor the action menu anchors through), so the
  // chrome tracks the fleet layout for free. The per-side initiative readout lives in the encounter bar
  // (§15), so this takes no initiative/phaseSide.
  paint(
    combatants: readonly Combatant[],
    activeId: number,
    slotCenterFor: (id: string) => SlotCenter | null,
    contentW: number,
    bufH: number,
  ): void {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, contentW);
    canvas.height = Math.max(1, bufH);
    const g = canvas.getContext('2d')!;
    for (const combatant of combatants) {
      const slot = slotCenterFor(combatant.id);
      if (!slot) continue; // a combatant with no live slot (gone / off-layout) draws nothing
      const x = Math.round(slot.cx - BAR_W / 2);
      // The HP bar's TOP, raised to leave room for the energy gauge stacked beneath it AND the BAR_GAP
      // above the sprite. Buffer coords are Y-up (origin bottom-left); the canvas is Y-down with flipY
      // mapping canvas-top → quad-top, so a buffer height H converts as y = H - up.
      const topUp = slot.cy + slot.r + BAR_GAP + EBAR_H + EBAR_GAP + BAR_H;
      const y = Math.round(bufH - topUp);
      this.paintBar(g, x, y, combatant, combatant.combatId === activeId);
    }
    this.setTexture(canvas, canvas.width, canvas.height);
    this.placeAt(0, 0);
  }

  hide(): void {
    this.setVisible(false);
  }

  // Paint one combatant's stacked gauges at HP-bar top-left (x, y): the HP bar (hull + shield bands) on
  // top, a thinner amber energy gauge (the salvo gate) directly beneath it, and a bright 1-px active-turn
  // marker enclosing BOTH when it's this combatant's turn. A downed slot greys its frames and empties.
  private paintBar(g: CanvasRenderingContext2D, x: number, y: number, combatant: Combatant, active: boolean): void {
    const down = isDown(combatant);
    const frame = down ? DOWN_BORDER : BORDER;

    // HP bar: the hull band (bottom of the stack) vs everything above it (shields) — drawn as two
    // segments so a raised shield reads as a distinct blue extension, depleting visibly as it absorbs.
    const pools = combatant.pools ?? [];
    const max = pools.reduce((s, p) => s + p.max, 0);
    const hull = pools.find((p) => p.key === 'hull')?.current ?? 0;
    const shields = pools.filter((p) => p.key !== 'hull').reduce((s, p) => s + p.current, 0);
    const wOf = (v: number) => (max > 0 ? Math.round(BAR_W * Math.max(0, Math.min(1, v / max))) : 0);

    // A bordered, dark plate — the frame gives the gauge a constant extent so a full (light-faction) bar
    // AND an empty (downed) one both read against the black field. A downed slot's frame goes grey.
    g.fillStyle = frame;
    g.fillRect(x - 1, y - 1, BAR_W + 2, BAR_H + 2);
    g.fillStyle = PLATE;
    g.fillRect(x, y, BAR_W, BAR_H);
    if (!down) {
      const hullW = wOf(hull);
      g.fillStyle = factionColor(combatant.factionId);
      g.fillRect(x, y, hullW, BAR_H);
      const shieldW = Math.min(BAR_W - hullW, wOf(shields));
      if (shieldW > 0) {
        g.fillStyle = SHIELD_FILL;
        g.fillRect(x + hullW, y, shieldW, BAR_H);
      }
    }

    // Energy gauge, beneath the HP bar: the per-ship salvo gate (stats.energy / energyMax). Amber and
    // thinner, framed the same way, so HP and energy read as a stacked pair, never confused for one bar.
    const ey = y + BAR_H + EBAR_GAP;
    const energy = combatant.stats?.[ENERGY_STAT] ?? 0;
    const energyMax = combatant.stats?.[ENERGY_MAX_STAT] ?? 0;
    g.fillStyle = frame;
    g.fillRect(x - 1, ey - 1, BAR_W + 2, EBAR_H + 2);
    g.fillStyle = PLATE;
    g.fillRect(x, ey, BAR_W, EBAR_H);
    if (!down && energyMax > 0) {
      const ew = Math.round(BAR_W * Math.max(0, Math.min(1, energy / energyMax)));
      g.fillStyle = ENERGY_FILL;
      g.fillRect(x, ey, ew, EBAR_H);
    }

    // Active-turn marker: a 1-px yellow frame enclosing BOTH gauges (the locked-target colour).
    if (active) {
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
