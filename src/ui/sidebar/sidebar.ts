// Sidebar — the persistent right-edge chrome shared by both views. Owned by
// AppController (constructed once, survives the galaxy↔system switch); the active
// scene renders it as a final overlay pass, resizes it, and routes pointer + wheel
// events into it before its own HUD.
//
// Three bands, top to bottom: a fixed turn-control HEADER, a scrolling BODY (the
// swappable SidebarContext, clipped into a ScrollView so a tall column scrolls
// within the one texture), and a fixed FOOTER of the context's declared nav actions
// (collapses to nothing when a context offers none).
//
// It's a single canvas (like the HUD panels): header text, body, and footer are all
// painted into one texture, and the interactive sub-rects are hit-tested by recomputing
// their geometry — no nested child widgets. The body's hits are mapped back into the
// context's own (pre-scroll) content space by the ScrollView. Width is the fixed
// reserved strip (sizes.sidebarW); height is the full buffer, set on every resize.

import { OrthographicCamera, Scene } from 'three';
import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { BasePanel } from '../base-panel';
import { type HitResult } from '../hit-test';
import { PILL_PAD_X, PILL_PAD_Y, paintHamburger, paintPillButton, paintSurface } from '../painter';
import { ScrollView, type ScrollViewport } from '../scroll-view';
import { colors, fonts, sizes } from '../theme';
import { type FooterAction, type SidebarContext } from './context';
import { inRect, type Rect } from './shared';

// What an interactive point on the header resolves to. The body's own controls are
// handled by the active SidebarContext; the footer's by the cached footerRects.
type Control = 'next' | 'settings';

export class Sidebar extends BasePanel {
  // Own ortho pass (1 unit = 1 buffer px), rendered by whichever scene is active.
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferH = 0;
  private turn = 1;
  private hovered: Control | null = null;
  // Whether the Next Turn pill is live. When false it paints greyed/inert and
  // ignores clicks + hover — the galaxy-freeze lever an overlay pulls while it
  // suspends the outer turn (the encounter modal, combat plan §8.2). The screen's
  // own freezesTurn marker guards the turn loop in parallel (app-controller).
  private nextTurnOn = true;

  // The swappable contextual region below the header. Set by the active scene
  // (via AppController) and fed its data through its own setters; null = empty.
  private context: SidebarContext | null = null;

  // The scrolling body. Clips + translates the context's paint, and maps pointer
  // hits back into the context's content space. Palette injected (borderDim bar).
  private readonly scrollView = new ScrollView(colors.borderDim);

  // Cached layout (canvas coords, top-down), computed in measure() and read by
  // paintInto() + the hit methods so all three stay in lockstep.
  private nextRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private settingsRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  // The scroll viewport handed to the ScrollView (the band between header + footer).
  private bodyViewport: ScrollViewport = { x: 0, y: 0, w: 0, h: 0 };
  // The footer's pill rects (with their actions), rebuilt each measure() from the
  // context's current footerActions(). Empty ⇒ the footer band is absent.
  private footerRects: Array<{ action: FooterAction; rect: Rect }> = [];
  private hoveredFooterId: string | null = null;
  // The footer band's top edge (canvas Y), computed in measure(); the divider + the
  // body viewport's bottom both read it so paint + hit stay in lockstep.
  private footerTop = 0;
  // The context's content-identity token at the last paint. When it changes, the scroll
  // offset resets to the top (a new selection opens at the top; a same-content re-render
  // keeps its scroll). null forces a reset on the next paint (set on every setContext).
  private lastContentKey: string | null = null;

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

  // Enable/disable the Next Turn pill. Disabling greys it and makes it inert to
  // clicks + hover; an overlay that suspends the galaxy turn calls this on enter
  // and re-enables on exit (combat plan §8.2). Clearing hover avoids a stuck
  // highlight if the pill is disabled mid-hover.
  setNextTurnEnabled(enabled: boolean): void {
    if (this.nextTurnOn === enabled) return;
    this.nextTurnOn = enabled;
    if (!enabled && this.hovered === 'next') this.hovered = null;
    this.rebuild();
  }

  // Swap the contextual region (system / galaxy). A context swap is always new content,
  // so force a scroll reset (null key never matches the incoming context's key). Rebuild
  // so the new content paints.
  setContext(ctx: SidebarContext | null): void {
    this.context = ctx;
    this.lastContentKey = null;
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
  // can't fall through to scene picking. Fires the turn / settings / footer control,
  // or routes a body hit through the ScrollView into the active context.
  handleClick(bufX: number, bufY: number): boolean {
    if (!this.visible || !this.visibleBounds.contains(bufX, bufY)) return false;
    const cx = this.toCanvasX(bufX), cy = this.toCanvasY(bufY);
    // A disabled pill still absorbs its rect (chrome, not scene) but fires nothing.
    if (inRect(cx, cy, this.nextRect)) { if (this.nextTurnOn) this.onNextTurn(); return true; }
    if (inRect(cx, cy, this.settingsRect)) { this.onSettings(); return true; }
    const f = this.footerRects.find((fr) => inRect(cx, cy, fr.rect));
    if (f) { if (f.action.enabled) f.action.onClick(); return true; }
    const mapped = this.scrollView.mapInto(cx, cy);
    if (mapped) this.context?.handleClick(mapped.x, mapped.y);
    return true; // absorb every click within the strip
  }

  hitTest(bufX: number, bufY: number): HitResult {
    if (!this.visible || !this.visibleBounds.contains(bufX, bufY)) return 'transparent';
    const cx = this.toCanvasX(bufX), cy = this.toCanvasY(bufY);
    // A disabled pill is opaque chrome, not an interactive target (no pointer cursor).
    if (this.nextTurnOn && inRect(cx, cy, this.nextRect)) return 'interactive';
    if (inRect(cx, cy, this.settingsRect)) return 'interactive';
    const f = this.footerRects.find((fr) => inRect(cx, cy, fr.rect));
    if (f) return f.action.enabled ? 'interactive' : 'opaque';
    const mapped = this.scrollView.mapInto(cx, cy);
    if (mapped && this.context?.isInteractive(mapped.x, mapped.y)) return 'interactive';
    return 'opaque';
  }

  // Scroll the body when the wheel turns over the viewport. Returns whether the event
  // was consumed: any wheel over the sidebar strip is absorbed (the map must never
  // zoom under the panel), and one over the body additionally scrolls it. deltaMode
  // (0 = pixel, 1 = line, 2 = page) is normalized to pixels so line-mode wheels (Firefox
  // / some mice, ~3 units/notch) scroll a sensible amount rather than a few pixels.
  handleWheel(bufX: number, bufY: number, deltaY: number, deltaMode = 0): boolean {
    if (!this.visible || !this.visibleBounds.contains(bufX, bufY)) return false;
    const cx = this.toCanvasX(bufX), cy = this.toCanvasY(bufY);
    const bodyH = getFont(fonts.body).lineHeight;
    const px = deltaMode === 1 ? deltaY * bodyH
      : deltaMode === 2 ? deltaY * this.bodyViewport.h
      : deltaY;
    if (this.scrollView.contains(cx, cy) && this.scrollView.scrollBy(px)) this.rebuild();
    return true;
  }

  // Update hover affordance; repaint only on change. Returns whether the point is
  // over an interactive control (drives the cursor swap, like the other HUDs).
  handlePointerMove(bufX: number, bufY: number): boolean {
    const inside = this.visible && this.visibleBounds.contains(bufX, bufY);
    const cx = inside ? this.toCanvasX(bufX) : -1;
    const cy = inside ? this.toCanvasY(bufY) : -1;
    const overNext = inside && this.nextTurnOn && inRect(cx, cy, this.nextRect);
    const overSettings = inside && inRect(cx, cy, this.settingsRect);
    const headerHover: Control | null = overNext ? 'next' : overSettings ? 'settings' : null;
    let changed = false;
    if (headerHover !== this.hovered) { this.hovered = headerHover; changed = true; }

    const fHit = inside ? this.footerRects.find((fr) => fr.action.enabled && inRect(cx, cy, fr.rect)) : undefined;
    const footerId = fHit ? fHit.action.id : null;
    if (footerId !== this.hoveredFooterId) { this.hoveredFooterId = footerId; changed = true; }

    // Body hover — map into content space, or clear when off the body.
    const mapped = inside ? this.scrollView.mapInto(cx, cy) : null;
    const bodyChanged = mapped
      ? this.context?.setHover(mapped.x, mapped.y)
      : this.context?.setHover(-1, -1);
    if (bodyChanged) changed = true;

    if (changed) this.rebuild();
    const overBodyInteractive = mapped !== null && this.context?.isInteractive(mapped.x, mapped.y) === true;
    return overNext || overSettings || footerId !== null || overBodyInteractive;
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
    const divY = this.nextRect.y + this.nextRect.h + sizes.padY;

    // Footer band (fixed, non-scrolling) — one row of the context's nav pills, flowed
    // left-to-right at their measured widths. Collapses to zero height when empty.
    const actions = this.context?.footerActions() ?? [];
    this.footerRects = [];
    const footerBandH = actions.length > 0 ? 1 + sizes.padY + pillH + sizes.padY : 0; // divider + padded pill row
    // Reserve a padY bottom gap even with no footer, so the body never paints flush
    // over the panel's 1-px bottom border (max: the footer band already includes its
    // own bottom padY, and it exceeds padY, so this only bites the no-footer case).
    this.footerTop = this.bufferH - Math.max(footerBandH, sizes.padY);
    if (actions.length > 0) {
      const rowY = this.footerTop + 1 + sizes.padY;
      let fx = sizes.padX;
      for (const a of actions) {
        const w = measurePixelText(a.label) + PILL_PAD_X * 2;
        this.footerRects.push({ action: a, rect: { x: fx, y: rowY, w, h: pillH } });
        fx += w + sizes.cardActionInterButtonGap;
      }
    }

    // Scroll viewport: from below the header divider to the footer top.
    const bodyTop = divY + 1 + sizes.padY;
    this.bodyViewport = {
      x: sizes.padX,
      y: bodyTop,
      w: sizes.sidebarW - sizes.padX * 2,
      h: Math.max(0, this.footerTop - bodyTop),
    };
    return { w: sizes.sidebarW, h: this.bufferH };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    paintSurface(g, 0, 0, w, h, { border: colors.borderDim });
    const bodyH = getFont(fonts.body).lineHeight;
    // Turn header: "TURN" caption (dim) over the number (yellow, title font).
    drawPixelText(g, 'TURN', sizes.padX, sizes.padY, colors.textKey, fonts.body);
    drawPixelText(g, String(this.turn), sizes.padX, sizes.padY + bodyH, colors.starName, fonts.title);
    paintPillButton(g, this.nextRect.x, this.nextRect.y, 'Next Turn',
      { hover: this.hovered === 'next', disabled: !this.nextTurnOn });
    // Settings glyph (top-right of the header).
    const sHover = this.hovered === 'settings';
    paintSurface(g, this.settingsRect.x, this.settingsRect.y, sizes.iconBox, sizes.iconBox,
      { border: sHover ? colors.borderAccent : colors.borderDim });
    paintHamburger(g, this.settingsRect.x, this.settingsRect.y, sizes.iconBox, sHover ? colors.glyphHover : colors.glyphOff);
    // Divider below the header.
    const divY = this.nextRect.y + this.nextRect.h + sizes.padY;
    g.fillStyle = colors.borderDim;
    g.fillRect(sizes.padX, divY, w - sizes.padX * 2, 1);

    // Scrolling body — the ScrollView clips to the viewport + translates by the offset.
    // Reset the scroll to the top when the shown content changed identity since the last
    // paint (a new selection / context), but not on a same-content re-render.
    if (this.context) {
      const ctx = this.context;
      const key = ctx.contentKey();
      if (key !== this.lastContentKey) { this.scrollView.resetOffset(); this.lastContentKey = key; }
      this.scrollView.paintBody(g, this.bodyViewport, (bg, region) => ctx.paint(bg, region));
    }

    // Footer band: a top divider + the nav pills.
    if (this.footerRects.length > 0) {
      g.fillStyle = colors.borderDim;
      g.fillRect(sizes.padX, this.footerTop, w - sizes.padX * 2, 1);
      for (const f of this.footerRects) {
        paintPillButton(g, f.rect.x, f.rect.y, f.action.label,
          { hover: this.hoveredFooterId === f.action.id, disabled: !f.action.enabled });
      }
    }
  }
}
