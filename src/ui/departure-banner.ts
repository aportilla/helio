// DepartureBanner — the floating HUD overlay pinned near the bottom-center of the galaxy
// CONTENT rect while a warp destination is being picked. Unlike the encounter bar it holds
// NO layout: it's a depthTest-off plate that floats ON TOP of the rendered stars and never
// reflows the scene. A solid GOLD plate (the navigation channel — it matches the on-map gold
// route line) with dark-ink text + dark gold-lettered pills. Two states:
//   - no destination locked → "Select a destination" + CANCEL.
//   - a destination locked  → "<dist> light years, <eta> turns" + CONFIRM + CANCEL.
//
// StarmapScene owns one, shows it when the pick arms, feeds it the live lock via setLock, and
// routes CONFIRM / CANCEL back through the callbacks (their keyboard + second-click twins live
// in the scene's input handlers). Own scene + ortho pass (1 unit = 1 buffer px), rendered by
// the scene between the HUD and the sidebar. Buffer-coord hit-tests mirror the Sidebar's own
// (Y-up buffer → Y-down canvas) so paint + hit stay in lockstep.

import { OrthographicCamera, Scene } from 'three';
import { drawPixelText, getFont, measurePixelText } from '../data/pixel-font';
import { BasePanel } from './base-panel';
import { type HitResult } from './hit-test';
import { PILL_PAD_X, PILL_PAD_Y, type PillPalette, paintPillButton, paintSurface } from './painter';
import { colors, fonts, sizes } from './theme';
import { inRect, type Rect } from './sidebar/shared';

// Dark pill on the gold plate: a dark-ink block with gold text, borderless at rest, gaining a bright
// gold frame + text on hover. Reads as an inset button against the solid-gold banner.
const NAV_PILL: PillPalette = {
  bg: colors.navInk,
  border: colors.navInk,            // borderless at rest (matches the fill)
  borderHover: colors.navGoldBright,
  text: colors.navGold,
  textHover: colors.navGoldBright,
};

// The metrics the banner shows once a destination is locked. The scene precomputes these from
// the picked cluster (world light-years + ETA in turns); the banner only displays them.
export interface DepartureLock {
  readonly distanceLy: number;
  readonly etaTurns: number;
}

// Gap between the message and the first pill, and between adjacent pills.
const GAP = 8;
// Float height above the content rect's bottom edge (buffer px) — a "little banner along the
// bottom", clear of the very edge.
const BOTTOM_INSET = 22;

type Control = 'confirm' | 'cancel' | null;

export class DepartureBanner extends BasePanel {
  // Own ortho pass (1 unit = 1 buffer px), rendered by StarmapScene.
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private contentW = 0;
  private shown = false;
  private lock: DepartureLock | null = null;
  private hovered: Control = null;

  // Layout cached in measure(), read by paintInto() + the hit methods (canvas coords, Y-down).
  private message = '';
  private messageX = 0;
  private messageY = 0;
  private confirmRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private cancelRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  // Fired from the pills; StarmapScene wires these to its confirm / cancel. CONFIRM is only
  // present (and only fires) when a destination is locked — mirroring the two visual states.
  onConfirm: () => void = () => {};
  onCancel: () => void = () => {};

  constructor(renderOrder = 100) {
    super(renderOrder);
    this.addTo(this.scene);
  }

  // Full-buffer ortho + cache the content width used to center the plate. Called by the scene's
  // resize() with the buffer dims + the content rect width (buffer px, left of the sidebar).
  resize(bufferW: number, bufferH: number, contentW: number): void {
    this.contentW = contentW;
    this.camera.right = bufferW;
    this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    if (this.shown) this.refresh();
  }

  // Raise the banner in its prompt state (no destination locked yet).
  show(): void {
    this.shown = true;
    this.lock = null;
    this.hovered = null;
    this.refresh();
  }

  // Update the locked destination (null → back to the prompt). Repaints in place.
  setLock(lock: DepartureLock | null): void {
    if (!this.shown) return;
    this.lock = lock;
    this.refresh();
  }

  hide(): void {
    this.shown = false;
    this.hovered = null;
    this.setVisible(false);
  }

  // Rebuild the texture, then re-center it in the content rect (its width shifts between the
  // prompt and locked states — the CONFIRM pill widens the plate — so it must re-place).
  private refresh(): void {
    this.rebuild();
    if (this.visible) {
      const left = Math.round(this.contentW / 2 - this.width / 2);
      this.placeAt(left, BOTTOM_INSET);
    }
  }

  protected measure(): { w: number; h: number } {
    if (!this.shown || this.contentW <= 0) return { w: 0, h: 0 };
    const bodyH = getFont(fonts.body).lineHeight;
    const pillH = bodyH + PILL_PAD_Y * 2; // matches paintPillButton's height

    this.message = this.lock
      ? `${this.lock.distanceLy.toFixed(1)} light years, ${this.lock.etaTurns} turn${this.lock.etaTurns === 1 ? '' : 's'}`
      : 'Select a destination';
    const messageW = measurePixelText(this.message, fonts.body);
    const confirmW = this.lock ? measurePixelText('Confirm', fonts.body) + PILL_PAD_X * 2 : 0;
    const cancelW = measurePixelText('Cancel', fonts.body) + PILL_PAD_X * 2;

    // Message vertically centered against the taller pill row.
    this.messageX = sizes.padX;
    this.messageY = sizes.padY + Math.floor((pillH - bodyH) / 2);

    // Pills flow right of the message. CONFIRM only exists when a destination is locked.
    let bx = sizes.padX + messageW + GAP;
    if (this.lock) {
      this.confirmRect = { x: bx, y: sizes.padY, w: confirmW, h: pillH };
      bx += confirmW + GAP;
    } else {
      this.confirmRect = { x: 0, y: 0, w: 0, h: 0 };
    }
    this.cancelRect = { x: bx, y: sizes.padY, w: cancelW, h: pillH };

    return { w: bx + cancelW + sizes.padX, h: sizes.padY * 2 + pillH };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    // Solid GOLD plate (the navigation channel) with a darker-gold frame + dark-ink text — an opaque
    // block that reads cleanly over the star field and matches the on-map gold route line.
    paintSurface(g, 0, 0, w, h, { bg: colors.navGold, border: colors.navGoldDim });
    drawPixelText(g, this.message, this.messageX, this.messageY, colors.navInk, fonts.body);
    if (this.lock) {
      paintPillButton(g, this.confirmRect.x, this.confirmRect.y, 'Confirm', { hover: this.hovered === 'confirm', palette: NAV_PILL });
    }
    paintPillButton(g, this.cancelRect.x, this.cancelRect.y, 'Cancel', { hover: this.hovered === 'cancel', palette: NAV_PILL });
  }

  // Buffer coords → the plate's local canvas coords (Y-up buffer → Y-down canvas), same mapping
  // the Sidebar uses. Returns null when the point isn't over the (shown) plate.
  private toLocal(bufX: number, bufY: number): { x: number; y: number } | null {
    if (!this.shown || !this.visibleBounds.contains(bufX, bufY)) return null;
    return { x: bufX - this.visibleBounds.x, y: (this.visibleBounds.y + this.height) - bufY };
  }

  // A click on the plate: fire the pill under it, else absorb (the plate floats over the stars,
  // so a click on it must never fall through to star picking). False when off the plate.
  handleClick(bufX: number, bufY: number): boolean {
    const p = this.toLocal(bufX, bufY);
    if (!p) return false;
    if (this.lock && inRect(p.x, p.y, this.confirmRect)) this.onConfirm();
    else if (inRect(p.x, p.y, this.cancelRect)) this.onCancel();
    return true;
  }

  hitTest(bufX: number, bufY: number): HitResult {
    const p = this.toLocal(bufX, bufY);
    if (!p) return 'transparent';
    if ((this.lock && inRect(p.x, p.y, this.confirmRect)) || inRect(p.x, p.y, this.cancelRect)) return 'interactive';
    return 'opaque';
  }

  // Update pill hover; repaint only on change. Returns whether the point is over a pill (drives
  // the cursor swap, like the other HUDs).
  handlePointerMove(bufX: number, bufY: number): boolean {
    const p = this.toLocal(bufX, bufY);
    const next: Control = p && this.lock && inRect(p.x, p.y, this.confirmRect) ? 'confirm'
      : p && inRect(p.x, p.y, this.cancelRect) ? 'cancel' : null;
    if (next !== this.hovered) { this.hovered = next; this.refresh(); }
    return next !== null;
  }
}
