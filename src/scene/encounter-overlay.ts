// CombatOverlay — the minimal pixel-art combat chrome painted OVER the live fleet sprites during an
// encounter (E3). A scene-side, combat-specific Widget (it reads encounter DTOs + faction colors —
// scene may; the generic ui/ toolkit may not): one content-buffer-sized CanvasTexture quad that draws
// each combatant's HP bar anchored to its live slot center, with an active-turn marker and a downed
// dim. Repainted only when the EncounterState changes (once per applyCommand), so the full-buffer
// canvas cost is negligible at combat cadence. Richer chrome (tracers, number-pops, shield chips) lands
// with the deferred event animation; this is the readable static-state baseline.

import { Widget } from '../ui/widget';
import { factionColor } from '../factions/registry';
import { isDown, type Combatant } from '../encounter/state';
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

export class CombatOverlay extends Widget {
  // Paint every combatant's chrome onto one content-buffer canvas. `slotCenterFor` maps a combatant's
  // durable id to its live on-screen slot (the same accessor the action menu anchors through), so the
  // chrome tracks the fleet layout for free.
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
      // The bar sits above the sprite. Buffer coords are Y-up (origin bottom-left); the canvas is
      // Y-down with flipY mapping canvas-top → quad-top, so a buffer height H converts as y = H - up.
      const topUp = slot.cy + slot.r + BAR_GAP;
      const y = Math.round(bufH - topUp);
      this.paintBar(g, x, y, combatant, combatant.combatId === activeId);
    }
    this.setTexture(canvas, canvas.width, canvas.height);
    this.placeAt(0, 0);
  }

  hide(): void {
    this.setVisible(false);
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
