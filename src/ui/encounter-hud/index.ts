// EncounterHud — the bottom encounter bar (EB, §15): the prominent per-SIDE fleet + INITIATIVE readout
// that supersedes CombatOverlay's old top-left corner pip strip. A generic ui/ HUD band (1-px frames,
// bitmap font, the pixel idiom) — a peer of SystemHud — that reads only encounter DTOs + the faction
// registry (ui/ may import encounter/ + factions/, never scene/). Mirrored: the controlled side musters
// LEFT, the opponent RIGHT, their initiative pips meeting at a center divider and draining toward it as
// each side spends; the acting side is lit. The bar issues no round commands (the anchored menu does that),
// but the controller floats a sibling End Turn button (`end-turn-button.ts`) in the band's center — the one
// interactive element. The controller paints the bar once per settled action (not per frame); its band is
// opaque (a click is absorbed, never falling through to the field), while the End Turn button is a SEPARATE
// widget the controller hit-tests + animates (its gold CTA blink would otherwise force a per-frame repaint).

import { Widget } from '../widget';
import { drawPixelText, measurePixelText } from '../../data/pixel-font';
import { colors, fonts } from '../theme';
import { CONTROLLED_FACTION_ID, factionColor } from '../../factions/registry';
import { baseSideInitiative } from '../../encounter/initiative';
import { isDown, type Combatant } from '../../encounter/state';
import type { FactionType } from '../../factions/types';
import { END_TURN_RESERVE } from './end-turn-button';

export { EndTurnButton, END_TURN_RESERVE } from './end-turn-button';

// Band geometry (env px). Tall enough for a label line + a pip row; kept compact so the in-encounter
// fleet baseline only has to lift by this much (the controller reserves ENCOUNTER_BAR_HEIGHT at the
// bottom of the field).
export const ENCOUNTER_BAR_HEIGHT = 34;
const PAD_X = 10; // label inset from the band's outer edges
const LABEL_Y = 7; // canvas-y (band top is y=0) of the label line
const PIP_Y = 20; // canvas-y of the pip row
const PIP_SIZE = 7;
const PIP_GAP = 3;
// Gap between the center divider and the nearest pip. Widened to clear the End Turn button that sits in
// the band's center during the player's phase (END_TURN_RESERVE), so pips never march under it — and the
// center plaza stays the same width both phases (the button is hidden on the opponent's, the gap holds).
const DIV_GAP = Math.max(9, END_TURN_RESERVE);
// A dark slate band — distinct from the near-black field so the bar reads as a deliberate HUD plate
// (the scene's own `surface` token is ~black, which vanishes over the empty lower field), under a
// bright 1-px top edge that draws the band's line across the full width.
const PLATE = '#06111d';
const TOP_BORDER = colors.borderAccent;
const DIVIDER = '#1e3a55'; // the vertical seam at the band's center the two fleets face across
const PIP_SPENT = '#26384a'; // a spent initiative pip (dim slate)
const ACTIVE = colors.starName; // the acting side's accent (the locked-target yellow)

interface SideView {
  readonly factionId: FactionType;
  readonly controlled: boolean;
  readonly living: number;
  readonly current: number; // remaining initiative icons
  readonly total: number; // pip slots = the base pool (or current, if a buff pushed it higher)
}

export class EncounterHud extends Widget {
  // Paint the band from the live combat state. `initiative` is the per-side remaining pool; `phaseSide`
  // is the acting side (lit). Repainted once per settled action by the controller — not per frame.
  paint(
    combatants: readonly Combatant[],
    initiative: Readonly<Record<FactionType, number>>,
    phaseSide: FactionType,
    contentW: number,
  ): void {
    const w = Math.max(1, contentW);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = ENCOUNTER_BAR_HEIGHT;
    const g = canvas.getContext('2d')!;

    // The band plate + a 1-px top edge, and a dim center seam the two fleets face across.
    g.fillStyle = PLATE;
    g.fillRect(0, 0, w, ENCOUNTER_BAR_HEIGHT);
    g.fillStyle = TOP_BORDER;
    g.fillRect(0, 0, w, 1);
    const center = Math.round(w / 2);
    g.fillStyle = DIVIDER;
    g.fillRect(center, 2, 1, ENCOUNTER_BAR_HEIGHT - 3);

    // Resolve the two sides (controlled = left). FactionType is player|rival today, so there is exactly
    // one of each; a hypothetical extra faction folds into the first-seen non-controlled (right) entry.
    const sides = this.resolveSides(combatants, initiative);
    const left = sides.find((s) => s.controlled);
    const right = sides.find((s) => !s.controlled);
    if (left) this.paintSide(g, left, true, center, w, phaseSide);
    if (right) this.paintSide(g, right, false, center, w, phaseSide);

    this.setTexture(canvas, w, ENCOUNTER_BAR_HEIGHT);
    this.placeAt(0, 0);
  }

  hide(): void {
    this.setVisible(false);
  }

  // Group the combatants by faction into the per-side readout: living-ship count, remaining icons, and
  // the pip total (the phase BASE, so spent icons render as dim pips beyond the bright remaining ones —
  // a fleet-base forecast for an off-phase side, omitting effect bonuses until its phase re-derives).
  private resolveSides(
    combatants: readonly Combatant[],
    initiative: Readonly<Record<FactionType, number>>,
  ): SideView[] {
    const order: FactionType[] = [];
    const byFaction = new Map<FactionType, Combatant[]>();
    for (const c of combatants) {
      let arr = byFaction.get(c.factionId);
      if (!arr) {
        arr = [];
        byFaction.set(c.factionId, arr);
        order.push(c.factionId);
      }
      arr.push(c);
    }
    return order.map((factionId) => {
      const roster = byFaction.get(factionId)!;
      const current = Math.max(0, initiative[factionId] ?? 0);
      return {
        factionId,
        controlled: factionId === CONTROLLED_FACTION_ID,
        living: roster.filter((c) => !isDown(c)).length,
        current,
        total: Math.max(current, baseSideInitiative(roster)),
      };
    });
  }

  // One side: its label + ship count on the outer edge, its initiative pips marching from the center
  // divider outward — the remaining icons bright + nearest the divider, the spent ones dim beyond them,
  // so the meter drains toward the center as the side acts. The acting side is underlined in yellow.
  private paintSide(
    g: CanvasRenderingContext2D, side: SideView, isLeft: boolean, center: number, w: number, phaseSide: FactionType,
  ): void {
    const acting = side.factionId === phaseSide;
    const color = factionColor(side.factionId);
    const label = `${side.controlled ? 'PLAYER' : 'OPPONENT'}  ${side.living} SHIP${side.living === 1 ? '' : 'S'}`;
    const labelColor = acting ? ACTIVE : colors.textKey;
    const labelX = isLeft ? PAD_X : w - PAD_X - measurePixelText(label, fonts.body);
    drawPixelText(g, label, labelX, LABEL_Y, labelColor, fonts.body);

    const step = PIP_SIZE + PIP_GAP;
    let minX = center;
    let maxX = center;
    for (let i = 0; i < side.total; i++) {
      const bright = i < side.current;
      const px = isLeft ? center - DIV_GAP - PIP_SIZE - i * step : center + DIV_GAP + i * step;
      g.fillStyle = bright ? color : PIP_SPENT;
      g.fillRect(px, PIP_Y, PIP_SIZE, PIP_SIZE);
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px + PIP_SIZE);
    }
    if (acting && side.total > 0) {
      g.fillStyle = ACTIVE;
      g.fillRect(minX, PIP_Y + PIP_SIZE + 1, maxX - minX, 1);
    }
  }
}
