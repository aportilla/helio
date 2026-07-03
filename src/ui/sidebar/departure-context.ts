// DepartureContext — the sidebar's contextual region while a warp DESTINATION is being picked (the
// departure mode on the galaxy view). Replaces the galaxy context for the duration of the pick:
//   - WARP DRIVE header + the departing ship's name.
//   - origin system, drive range, and — once a destination is locked — the destination + distance + ETA.
//   - CONFIRM (greyed until a destination is locked) + CANCEL pills.
//
// StarmapScene owns one while the mode is armed, feeds it the static info via setInfo and the live lock
// via setLock, and routes CONFIRM / CANCEL back through the callbacks. Mirrors GalaxyContext's pill idiom.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { paintPillButton } from '../painter';
import { colors, fonts, sizes } from '../theme';
import type { Region, SidebarContext } from './context';
import { inRect, type Rect } from './shared';

export interface DepartureLock {
  readonly destName: string;
  readonly distanceLy: number;
  readonly etaTurns: number;
}

type Control = 'confirm' | 'cancel' | null;

const PILL_GAP = 4;
const ROW_GAP = 2;

export class DepartureContext implements SidebarContext {
  private shipName = '';
  private originName = '';
  private rangeLy = 0;
  private lock: DepartureLock | null = null;
  private hovered: Control = null;
  private confirmRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private cancelRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  // Fired from the pills; StarmapScene wires these to its confirm / cancel. CONFIRM only fires when a
  // destination is locked (handleClick gates it), mirroring the greyed pill.
  onConfirm: () => void = () => {};
  onCancel: () => void = () => {};

  // The static header — the departing ship, its origin, and the drive's reach (world light-years).
  setInfo(shipName: string, originName: string, rangeLy: number): void {
    this.shipName = shipName;
    this.originName = originName;
    this.rangeLy = rangeLy;
  }

  // The locked destination (null while browsing) — its name, distance, and ETA in turns.
  setLock(lock: DepartureLock | null): void {
    this.lock = lock;
  }

  paint(g: CanvasRenderingContext2D, region: Region): void {
    this.confirmRect = { x: 0, y: 0, w: 0, h: 0 };
    this.cancelRect = { x: 0, y: 0, w: 0, h: 0 };
    const x0 = region.x;
    const bodyH = getFont(fonts.body).lineHeight;
    let y = region.y;

    drawPixelText(g, 'WARP DRIVE', x0, y, colors.starName, fonts.cardName);
    y += getFont(fonts.cardName).lineHeight + sizes.cardNameGap;

    const kv = (key: string, val: string): void => {
      drawPixelText(g, key, x0, y, colors.textKey, fonts.body);
      const vw = measurePixelText(val);
      drawPixelText(g, val, x0 + region.w - vw, y, colors.textBody, fonts.body);
      y += bodyH + ROW_GAP;
    };
    kv('ship', this.shipName);
    kv('origin', this.originName);
    kv('range', `${this.rangeLy.toFixed(1)} ly`);

    y += sizes.cardActionGap;
    if (this.lock) {
      drawPixelText(g, 'DESTINATION', x0, y, colors.textKey, fonts.body);
      y += bodyH + sizes.cardNameGap;
      drawPixelText(g, this.lock.destName, x0, y, colors.starName, fonts.body);
      y += bodyH + ROW_GAP;
      kv('distance', `${this.lock.distanceLy.toFixed(1)} ly`);
      kv('arrival', `${this.lock.etaTurns} turn${this.lock.etaTurns === 1 ? '' : 's'}`);
    } else {
      drawPixelText(g, 'Select a destination', x0, y, colors.textKey, fonts.body);
      y += bodyH + ROW_GAP;
    }

    y += sizes.cardActionGap;
    const confirm = paintPillButton(g, x0, y, 'Confirm', { hover: this.hovered === 'confirm', disabled: this.lock === null });
    this.confirmRect = { x: x0, y, w: confirm.w, h: confirm.h };
    y += confirm.h + PILL_GAP;
    const cancel = paintPillButton(g, x0, y, 'Cancel', { hover: this.hovered === 'cancel' });
    this.cancelRect = { x: x0, y, w: cancel.w, h: cancel.h };
  }

  isInteractive(cx: number, cy: number): boolean {
    return inRect(cx, cy, this.confirmRect) || inRect(cx, cy, this.cancelRect);
  }

  handleClick(cx: number, cy: number): void {
    if (inRect(cx, cy, this.confirmRect)) {
      if (this.lock !== null) this.onConfirm(); // greyed CONFIRM is inert until a destination is locked
    } else if (inRect(cx, cy, this.cancelRect)) {
      this.onCancel();
    }
  }

  setHover(cx: number, cy: number): boolean {
    const next: Control = inRect(cx, cy, this.confirmRect) ? 'confirm'
      : inRect(cx, cy, this.cancelRect) ? 'cancel' : null;
    if (next === this.hovered) return false;
    this.hovered = next;
    return true;
  }
}
