// paintShipHull — the single source of truth for drawing a ship as its ORDERED MODULE LIST: a segmented
// hull of kind-colored rects framed + divided in the faction color, drawn rear→nose along the facing axis.
// FleetLayer paints it into each ship's muster sprite; WarpVisuals paints the SAME hull moving off/onto the
// slot during a warp; the galaxy sidebar's ship tiles paint it as each ship's icon — one function, no drift,
// so a ship reads identically wherever it appears.
//
// Draws in the target 2D context's own coords (canvas Y-down), centred at (cx, cy), spanning `diam` px,
// facing `dir` (+1 rear-at-left / −1 mirrored). The hull band is vertically symmetric about cy, so a caller
// whose canvas is Y-flipped can pass a flipped cy without the band caring. `onModule` (optional) reports each
// module's rect: its LOCAL center-x + a glow half-extent — the anchor FleetLayer maps to content space for
// the targeting weapon glow; WarpVisuals ignores it.

import { COMPONENT_BY_TYPE } from '../ships/components/registry';
import { factionColor } from '../factions/registry';
import type { FactionType } from '../factions/types';
import type { ShipComponentKind, ShipComponentType } from '../ships/components/types';

// Module fill by structural KIND (the part's role) — muted pixel tones, distinct enough to read the loadout
// at a glance; the faction color frames + divides them. A kind with no entry falls back to chassis grey.
// Deliberately not faction hues, so fill = role and border = side stay separable.
export const KIND_COLOR: Record<ShipComponentKind, string> = {
  chassis: '#4a5360', // grey hull
  drive:   '#2f6f7a', // teal ion-drive
  weapon:  '#9a4b3b', // rust red
  defense: '#3b5a9a', // steel blue
  utility: '#7a6a3b', // olive
};

// The segmented hull occupies a central horizontal BAND of the square sprite (a slim ship, not a full
// square), inset from the sides. Env px / fractions of diameter.
export const HULL_BAND_FRAC = 0.5; // hull band height as a fraction of the sprite diameter
export const HULL_PAD_X = 2;       // horizontal inset (px) at each end of the row
export const HULL_MIN_BAND = 6;    // floor on the band height so a tiny sprite still reads

export function paintShipHull(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  diam: number,
  components: readonly ShipComponentType[],
  factionId: FactionType,
  dir: number,
  onModule?: (componentId: ShipComponentType, localCenterX: number, glowR: number) => void,
): void {
  const n = components.length;
  if (n === 0) return; // a ship IS its modules — n>0 in practice

  const d = Math.max(1, Math.round(diam));
  const band = Math.max(HULL_MIN_BAND, Math.round(d * HULL_BAND_FRAC));
  const usable = d - 2 * HULL_PAD_X;
  const left = Math.round(cx - usable / 2);
  const top = Math.round(cy - band / 2);
  // Integer slot boundaries left→right, so adjacent rects butt with no gap/overlap.
  const bound = (j: number): number => left + Math.round((j * usable) / n);

  for (let i = 0; i < n; i++) {
    // Canvas slot: component i counts from the REAR. dir +1 puts the rear at the left (slot i);
    // dir −1 mirrors (rear at the right, slot n−1−i).
    const j = dir > 0 ? i : n - 1 - i;
    const xa = bound(j);
    const w = Math.max(1, bound(j + 1) - xa);
    const kind = COMPONENT_BY_TYPE.get(components[i]!)?.kind;
    g.fillStyle = (kind && KIND_COLOR[kind]) || KIND_COLOR.chassis;
    g.fillRect(xa, top, w, band);
    onModule?.(components[i]!, xa + w / 2, Math.min(w, band) / 2);
  }

  // Faction frame + inter-module dividers — crisp 1-px runs over the fills.
  g.fillStyle = factionColor(factionId);
  g.fillRect(left, top, usable, 1);            // top
  g.fillRect(left, top + band - 1, usable, 1); // bottom
  g.fillRect(left, top, 1, band);              // left
  g.fillRect(left + usable - 1, top, 1, band); // right
  for (let j = 1; j < n; j++) g.fillRect(bound(j), top, 1, band); // dividers
}
