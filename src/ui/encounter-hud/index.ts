// EncounterHud — the bottom encounter bar (EB, §15): the per-SIDE INITIATIVE readout that supersedes
// the old top-left corner pip strip (the per-sprite HP / energy bars now live in the persistent
// ShipGaugesOverlay, src/scene/ship-gauges.ts). A generic ui/ HUD band (1-px frames, the pixel idiom)
// — a peer of SystemHud — that reads only encounter DTOs + the faction registry (ui/ may import
// encounter/ + factions/, never scene/). Mirrored: the controlled side musters LEFT, the opponent
// RIGHT, their initiative pips — right-leaning parallelogram slashes, vertically centered in the band —
// draining toward center as each side spends. The bar carries no labels or counts, just the markers.
// The acting side's frontier pip (the icon about to be spent) is LEFT OUT of this static paint: the
// controller floats a sibling ActivePip widget (`active-pip.ts`) in that slot and wiggles it along its
// slant, so the current initiative shimmers. The bar issues no round commands (the anchored menu does
// that), but the controller also floats a sibling End Turn button (`end-turn-button.ts`) in the band's
// center — the one interactive element. The controller paints the bar once per settled action (not per
// frame); its band is opaque (a click is absorbed), while the ActivePip + End Turn button are SEPARATE
// widgets the controller places + animates each frame.

import { Widget } from '../widget';
import { colors } from '../theme';
import { CONTROLLED_FACTION_ID, factionColor } from '../../factions/registry';
import { baseSideInitiative } from '../../encounter/initiative';
import type { Combatant } from '../../encounter/state';
import type { FactionType } from '../../factions/types';
import { END_TURN_RESERVE } from './end-turn-button';
import { PIP_W, PIP_H, PIP_SHEAR, paintPip } from './pip';

export { EndTurnButton, END_TURN_RESERVE } from './end-turn-button';
export { ActivePip } from './active-pip';

// Band geometry (env px). Kept compact so the in-encounter fleet baseline only has to lift by this much
// (the controller reserves ENCOUNTER_BAR_HEIGHT at the bottom of the field).
export const ENCOUNTER_BAR_HEIGHT = 34;
const PIP_GAP = 3;
const PIP_ADVANCE = PIP_W + PIP_GAP; // per-pip horizontal step (bottom-left to bottom-left)
const PIP_TOP_Y = Math.round((ENCOUNTER_BAR_HEIGHT - PIP_H) / 2); // pip row centered in the band
// Gap between the band's center and the nearest pip. Widened to clear the End Turn button that sits in
// the band's center during the player's phase (END_TURN_RESERVE), so pips never march under it — and the
// center plaza stays the same width both phases (the button is hidden on the opponent's, the gap holds).
const DIV_GAP = Math.max(9, END_TURN_RESERVE);
// A dark slate band — distinct from the near-black field so the bar reads as a deliberate HUD plate
// (the scene's own `surface` token is ~black, which vanishes over the empty lower field), under a
// bright 1-px top edge that draws the band's line across the full width.
const PLATE = '#06111d';
const TOP_BORDER = colors.borderAccent;
const PIP_SPENT = '#26384a'; // a spent initiative pip (dim slate)

// The buffer-x of pip `i`'s bottom-left corner on a side, marching from the center plaza outward.
function pipBaseX(i: number, isLeft: boolean, center: number): number {
  return isLeft
    ? center - DIV_GAP - PIP_SHEAR - PIP_W - i * PIP_ADVANCE
    : center + DIV_GAP + i * PIP_ADVANCE;
}

interface SideView {
  readonly factionId: FactionType;
  readonly controlled: boolean;
  readonly current: number; // remaining initiative icons
  readonly total: number; // pip slots = the base pool (or current, if a buff pushed it higher)
}

export class EncounterHud extends Widget {
  // Paint the band from the live combat state. `initiative` is the per-side remaining pool; `phaseSide`
  // is the acting side — its frontier pip is skipped (the sibling ActivePip widget draws + wiggles it).
  // Repainted once per settled action by the controller — not per frame.
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

    // The band plate + a 1-px top edge (no center divider — the two sides simply face across the plaza).
    g.fillStyle = PLATE;
    g.fillRect(0, 0, w, ENCOUNTER_BAR_HEIGHT);
    g.fillStyle = TOP_BORDER;
    g.fillRect(0, 0, w, 1);
    const center = Math.round(w / 2);

    // Resolve the two sides (controlled = left). FactionType is player|rival today, so there is exactly
    // one of each; a hypothetical extra faction folds into the first-seen non-controlled (right) entry.
    const sides = this.resolveSides(combatants, initiative);
    const left = sides.find((s) => s.controlled);
    const right = sides.find((s) => !s.controlled);
    if (left) this.paintSide(g, left, true, center, left.factionId === phaseSide ? left.current - 1 : -1);
    if (right) this.paintSide(g, right, false, center, right.factionId === phaseSide ? right.current - 1 : -1);

    this.setTexture(canvas, w, ENCOUNTER_BAR_HEIGHT);
    this.placeAt(0, 0);
  }

  // The home bottom-left (HUD buffer px, Y-up) of the acting side's frontier pip — the slot the bar left
  // empty for the ActivePip widget. Null when the acting side holds no initiative (nothing to lift).
  activePipHome(
    combatants: readonly Combatant[],
    initiative: Readonly<Record<FactionType, number>>,
    phaseSide: FactionType,
    contentW: number,
  ): { left: number; bottom: number } | null {
    const center = Math.round(Math.max(1, contentW) / 2);
    const side = this.resolveSides(combatants, initiative).find((s) => s.factionId === phaseSide);
    if (!side || side.current <= 0) return null;
    return {
      left: pipBaseX(side.current - 1, side.controlled, center),
      bottom: ENCOUNTER_BAR_HEIGHT - PIP_TOP_Y - PIP_H,
    };
  }

  hide(): void {
    this.setVisible(false);
  }

  // Group the combatants by faction into the per-side readout: remaining icons + the pip total (the phase
  // BASE, so spent icons render as dim pips beyond the bright remaining ones — a fleet-base forecast for
  // an off-phase side, omitting effect bonuses until its phase re-derives).
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
        current,
        total: Math.max(current, baseSideInitiative(roster)),
      };
    });
  }

  // One side's initiative pips, marching from the center plaza outward — the remaining icons bright +
  // nearest the plaza, the spent ones dim beyond them, so the meter drains toward the center as the side
  // acts. `skipIdx` (the acting side's frontier pip, else -1) is omitted for the ActivePip widget to fill.
  private paintSide(
    g: CanvasRenderingContext2D, side: SideView, isLeft: boolean, center: number, skipIdx: number,
  ): void {
    const color = factionColor(side.factionId);
    for (let i = 0; i < side.total; i++) {
      if (i === skipIdx) continue;
      paintPip(g, pipBaseX(i, isLeft, center), PIP_TOP_Y, i < side.current ? color : PIP_SPENT);
    }
  }
}
