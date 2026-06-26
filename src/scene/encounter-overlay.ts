// CombatOverlay — the minimal pixel-art combat chrome painted OVER the live fleet sprites during an
// encounter (E3). A scene-side, combat-specific Widget (it reads encounter DTOs + faction colors —
// scene may; the generic ui/ toolkit may not): one content-buffer-sized CanvasTexture quad that draws
// each combatant's HP bar anchored to its live slot center, with an active-turn marker and a downed
// dim. Repainted once per settled action (at the end of an EV animation window, §14), not per frame, so
// the full-buffer canvas cost is negligible at combat cadence. The ANIMATED chrome (bolts, number-pops,
// kill bursts) lives in its per-frame sibling CombatTracers (`encounter-tracers.ts`); this overlay is the
// static HP / initiative baseline beneath it.

import { Widget } from '../ui/widget';
import { factionColor } from '../factions/registry';
import { isDown, type Combatant } from '../encounter/state';
import type { FactionType } from '../factions/types';
import type { SlotCenter } from './actions/system-action-menu';

// All env px. The bar rides just above each sprite; the active marker is a bright 1-px frame.
const BAR_W = 26;
const BAR_H = 4;
const BAR_GAP = 6; // gap between the sprite's top edge and the bar
const PLATE = '#000814'; // the surface fill (matches the HUD plate) so the bar reads on any hull
const BORDER = '#1e6fc4'; // dim-blue gauge frame — so a full (light) OR empty bar still reads on black
const DOWN_BORDER = '#3a3a3a'; // a downed slot's frame goes grey ("out")
const ACTIVE = '#ffe98a'; // the active-turn marker (the locked-target yellow)
const SHIELD_FILL = '#5b8dd6'; // shield-band portion (matches the shield effect-chip hue)

// Per-side Press-Turn INITIATIVE readout (§3.8.6) — a corner strip of icon pips per side: a faction
// swatch then one pip per remaining icon, the active side underlined. The fleet's tempo, read at a
// glance. Spent pips ghost so the phase's drain is legible.
const PIP = 4; // one initiative icon
const PIP_GAP = 2;
const SWATCH = 5; // the leading faction-color square that identifies the side's row
const READOUT_PAD = 6; // inset from the top-left corner
const ROW_H = 9; // per-side row pitch
const PIP_SPENT = '#243447'; // a spent/forecast icon (dim) so the cap still reads as the row drains

export class CombatOverlay extends Widget {
  // Paint every combatant's chrome onto one content-buffer canvas. `slotCenterFor` maps a combatant's
  // durable id to its live on-screen slot (the same accessor the action menu anchors through), so the
  // chrome tracks the fleet layout for free.
  paint(
    combatants: readonly Combatant[],
    activeId: number,
    initiative: Readonly<Record<FactionType, number>>,
    phaseSide: FactionType,
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
      // The bar sits above the sprite. Buffer coords are Y-up (origin bottom-left); the canvas is
      // Y-down with flipY mapping canvas-top → quad-top, so a buffer height H converts as y = H - up.
      const topUp = slot.cy + slot.r + BAR_GAP;
      const y = Math.round(bufH - topUp);
      this.paintBar(g, x, y, combatant, combatant.combatId === activeId);
    }
    this.paintInitiative(g, combatants, initiative, phaseSide);
    this.setTexture(canvas, canvas.width, canvas.height);
    this.placeAt(0, 0);
  }

  hide(): void {
    this.setVisible(false);
  }

  // The per-side initiative readout, top-left (canvas-top maps to screen-top via flipY). One row per
  // side present, in first-seen combatId order: a faction swatch + one pip per CURRENT icon, the active
  // side underlined in the turn-marker yellow. The active side's count is exact (its live spend-down
  // pool); an off-phase side's row is its fleet base — a forecast that omits effect bonuses (e.g.
  // tactical-command) and attrition until that side's phase opens and re-folds the pool.
  private paintInitiative(
    g: CanvasRenderingContext2D,
    combatants: readonly Combatant[],
    initiative: Readonly<Record<FactionType, number>>,
    phaseSide: FactionType,
  ): void {
    const sides: FactionType[] = [];
    const seen = new Set<FactionType>();
    for (const c of combatants) {
      if (!seen.has(c.factionId)) {
        seen.add(c.factionId);
        sides.push(c.factionId);
      }
    }
    let rowTop = READOUT_PAD;
    for (const side of sides) {
      const count = Math.max(0, initiative[side] ?? 0);
      const color = factionColor(side);
      g.fillStyle = color;
      g.fillRect(READOUT_PAD, rowTop, SWATCH, SWATCH);
      for (let i = 0; i < count; i++) {
        const px = READOUT_PAD + SWATCH + PIP_GAP + i * (PIP + PIP_GAP);
        g.fillStyle = color;
        g.fillRect(px, rowTop + (SWATCH - PIP), PIP, PIP);
      }
      if (count === 0) {
        // a spent/empty side still shows one ghost pip so the row never collapses to a lone swatch
        g.fillStyle = PIP_SPENT;
        g.fillRect(READOUT_PAD + SWATCH + PIP_GAP, rowTop + (SWATCH - PIP), PIP, PIP);
      }
      if (side === phaseSide) {
        g.fillStyle = ACTIVE;
        const w = SWATCH + PIP_GAP + Math.max(1, count) * (PIP + PIP_GAP);
        g.fillRect(READOUT_PAD, rowTop + SWATCH + 1, w, 1);
      }
      rowTop += ROW_H;
    }
  }

  private paintBar(g: CanvasRenderingContext2D, x: number, y: number, combatant: Combatant, active: boolean): void {
    const down = isDown(combatant);
    const pools = combatant.pools ?? [];
    const max = pools.reduce((s, p) => s + p.max, 0);
    // The hull band (the bottom of the stack) vs everything above it (shields) — drawn as two segments
    // so a raised shield reads as a distinct blue extension, depleting visibly as it absorbs.
    const hull = pools.find((p) => p.key === 'hull')?.current ?? 0;
    const shields = pools.filter((p) => p.key !== 'hull').reduce((s, p) => s + p.current, 0);
    const wOf = (v: number) => (max > 0 ? Math.round(BAR_W * Math.max(0, Math.min(1, v / max))) : 0);

    // A bordered, dark plate — the frame gives the gauge a constant extent so a full (light-faction)
    // bar AND an empty (downed) one both read against the black field. A downed slot's frame goes grey.
    g.fillStyle = down ? DOWN_BORDER : BORDER;
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

    if (active) {
      g.fillStyle = ACTIVE;
      g.fillRect(x - 2, y - 2, BAR_W + 4, 1);
      g.fillRect(x - 2, y + BAR_H + 1, BAR_W + 4, 1);
      g.fillRect(x - 2, y - 2, 1, BAR_H + 4);
      g.fillRect(x + BAR_W + 1, y - 2, 1, BAR_H + 4);
    }
  }
}
