// Sidebar — the persistent right-edge chrome shared by both views. Owned by
// AppController (constructed once, survives the galaxy↔system switch); the active
// scene renders it as a final overlay pass, resizes it, and routes pointer events
// into it before its own HUD. One full-height BasePanel surface: a turn-control
// header at the top and a swappable contextual region below it.
//
// It's a single canvas (like the HUD panels): the header text, the Next Turn pill,
// and the contextual region are all painted into one texture, and the interactive
// sub-rects are hit-tested by recomputing their geometry — no nested child widgets.
// The width is the fixed reserved strip (sizes.sidebarW); the height is the full
// buffer, set on every resize.

import { OrthographicCamera, Scene } from 'three';
import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { BasePanel } from '../base-panel';
import { type HitResult } from '../hit-test';
import { PILL_PAD_X, PILL_PAD_Y, paintHamburger, paintPillButton, paintSurface } from '../painter';
import { colors, fonts, sizes } from '../theme';
import { type SidebarContext } from './context';

interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// What an interactive point on the header resolves to. The contextual region's
// own controls are handled by the active SidebarContext, not here.
type Control = 'next' | 'settings';

export class Sidebar extends BasePanel {
  // Own ortho pass (1 unit = 1 buffer px), rendered by whichever scene is active.
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferH = 0;
  private turn = 1;
  private hovered: Control | null = null;

  // The swappable contextual region below the header. Set by the active scene
  // (via AppController) and fed its data through its own setters; null = empty.
  private context: SidebarContext | null = null;

  // Cached header layout (canvas coords, top-down), computed in measure() and read
  // by paintInto() + hitTest() so the three stay in lockstep.
  private nextRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private settingsRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  // Fired when Next Turn is clicked. AppController wires it to advanceTurn() +
  // setTurn() so the single turn scalar lives in the game-state save.
  onNextTurn: () => void = () => {};
  // Fired when the settings glyph is clicked. The active scene wires it (galaxy
  // opens its settings panel; the system view is a no-op for now).
  onSettings: () => void = () => {};

  constructor(renderOrder = 100) {
    super(renderOrder);
    this.addTo(this.scene);
  }

  setTurn(turn: number): void {
    if (this.turn === turn) return;
    this.turn = turn;
    this.rebuild();
  }

  // Swap the contextual region (system / galaxy). Rebuild so the new content paints.
  setContext(ctx: SidebarContext | null): void {
    this.context = ctx;
    this.rebuild();
  }

  // The active context's data changed (selection, facilities) — repaint.
  refreshContent(): void {
    this.rebuild();
  }

  // Full-buffer ortho + (re)place at the right edge. Called by the active scene's
  // resize() with the buffer dims from its ViewportSizer.
  resize(bufferW: number, bufferH: number): void {
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.rebuild();
    if (this.visible) this.placeAt(bufferW - sizes.sidebarW, 0);
  }

  // True when the click landed anywhere on the sidebar — always absorbed so it
  // can't fall through to scene picking; fires onNextTurn over the button.
  handleClick(bufX: number, bufY: number): boolean {
    if (!this.visible || !this.visibleBounds.contains(bufX, bufY)) return false;
    const cx = this.toCanvasX(bufX), cy = this.toCanvasY(bufY);
    if (inRect(cx, cy, this.nextRect)) this.onNextTurn();
    else if (inRect(cx, cy, this.settingsRect)) this.onSettings();
    else this.context?.handleClick(cx, cy);
    return true; // absorb every click within the strip
  }

  hitTest(bufX: number, bufY: number): HitResult {
    if (!this.visible || !this.visibleBounds.contains(bufX, bufY)) return 'transparent';
    const cx = this.toCanvasX(bufX), cy = this.toCanvasY(bufY);
    if (inRect(cx, cy, this.nextRect) || inRect(cx, cy, this.settingsRect)
      || this.context?.isInteractive(cx, cy)) return 'interactive';
    return 'opaque';
  }

  // Update hover affordance; repaint only on change. Returns whether the point is
  // over an interactive control (drives the cursor swap, like the other HUDs).
  handlePointerMove(bufX: number, bufY: number): boolean {
    const inside = this.visible && this.visibleBounds.contains(bufX, bufY);
    const cx = inside ? this.toCanvasX(bufX) : -1;
    const cy = inside ? this.toCanvasY(bufY) : -1;
    const overNext = inside && inRect(cx, cy, this.nextRect);
    const overSettings = inside && inRect(cx, cy, this.settingsRect);
    const headerHover: Control | null = overNext ? 'next' : overSettings ? 'settings' : null;
    let changed = false;
    if (headerHover !== this.hovered) { this.hovered = headerHover; changed = true; }
    if (this.context?.setHover(cx, cy)) changed = true;
    if (changed) this.rebuild();
    return overNext || overSettings || (inside && this.context?.isInteractive(cx, cy) === true);
  }

  // Buffer coords are Y-up, origin bottom-left; the canvas is Y-down with origin
  // at the panel's top-left. The panel is placed by its bottom edge at y=0.
  private toCanvasX(bufX: number): number { return bufX - this.visibleBounds.x; }
  private toCanvasY(bufY: number): number { return (this.visibleBounds.y + this.height) - bufY; }

  protected measure(): { w: number; h: number } {
    if (this.bufferH <= 0) return { w: 0, h: 0 };
    const bodyH = getFont(fonts.body).lineHeight;
    const titleH = getFont(fonts.title).lineHeight;
    const pillH = bodyH + PILL_PAD_Y * 2;
    const pillW = measurePixelText('Next Turn') + PILL_PAD_X * 2;
    const y = sizes.padY + bodyH + titleH + sizes.cardActionGap;
    this.nextRect = { x: sizes.padX, y, w: pillW, h: pillH };
    // Settings glyph sits in the header's top-right corner.
    this.settingsRect = { x: sizes.sidebarW - sizes.padX - sizes.iconBox, y: sizes.padY, w: sizes.iconBox, h: sizes.iconBox };
    return { w: sizes.sidebarW, h: this.bufferH };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    paintSurface(g, 0, 0, w, h, { border: colors.borderDim });
    const bodyH = getFont(fonts.body).lineHeight;
    // Turn header: "TURN" caption (dim) over the number (yellow, title font).
    drawPixelText(g, 'TURN', sizes.padX, sizes.padY, colors.textKey, fonts.body);
    drawPixelText(g, String(this.turn), sizes.padX, sizes.padY + bodyH, colors.starName, fonts.title);
    paintPillButton(g, this.nextRect.x, this.nextRect.y, 'Next Turn', { hover: this.hovered === 'next' });
    // Settings glyph (top-right of the header).
    const sHover = this.hovered === 'settings';
    paintSurface(g, this.settingsRect.x, this.settingsRect.y, sizes.iconBox, sizes.iconBox,
      { border: sHover ? colors.borderAccent : colors.borderDim });
    paintHamburger(g, this.settingsRect.x, this.settingsRect.y, sizes.iconBox, sHover ? colors.glyphHover : colors.glyphOff);
    // Divider below the header; the contextual region (selection info / facilities)
    // will live below it once wired.
    const divY = this.nextRect.y + this.nextRect.h + sizes.padY;
    g.fillStyle = colors.borderDim;
    g.fillRect(sizes.padX, divY, w - sizes.padX * 2, 1);

    // Contextual region below the divider (selection info / facilities).
    if (this.context) {
      const top = divY + 1 + sizes.padY;
      this.context.paint(g, { x: sizes.padX, y: top, w: w - sizes.padX * 2, h: h - top - sizes.padY });
    }
  }
}
