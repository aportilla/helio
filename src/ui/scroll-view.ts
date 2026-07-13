// ScrollView — a reusable vertical scroll region for a single-canvas panel.
//
// NOT a Widget: it interposes clip + an integer translate on the host's own 2D
// context so a taller-than-viewport body scrolls within ONE texture. That keeps
// the pixel-crisp, no-nested-child-widgets idiom the sidebar and HUDs are built
// on — the host still owns its canvas, repaint lifecycle, and hit routing; the
// ScrollView owns only the scroll geometry: the offset, its clamp, wheel-delta
// application, the 1-px scrollbar, and the point-mapping a hit-test needs to turn
// an on-screen coord back into the body's own (pre-translate) content coord.
//
// The body paints as if it lived at the viewport's top-left and reports its total
// content height (the value paintBody threads back from its callback). Because the
// body caches its hit-rects in the coords it draws in — which are the pre-translate
// content coords — a hit only needs the offset added back (see mapInto).
//
// It is deliberately palette-free (the scrollbar color is injected) so it stays a
// generic geometry helper with no theme coupling — the host owns the look.

export interface ScrollViewport {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// Width of the always-present right gutter the scrollbar lives in. Reserved whether
// or not the body overflows, so the appearance/disappearance of the bar never
// reflows the content (the body is handed a region already narrowed by this).
const GUTTER = 3;
// The bar itself, drawn 1-px inset inside the gutter.
const BAR_W = 2;
// Floor on the thumb height so a very long body still leaves a grabbable/visible mark.
const MIN_THUMB = 8;

export class ScrollView {
  // Pixels scrolled down from the top; 0 = top. Always kept within [0, maxScroll].
  private offset = 0;
  // Last-painted content height + the viewport it was measured against. Set by
  // applyMetrics (from paintBody, or directly in tests) and read by the clamp,
  // the scrollbar, and the hit mapping.
  private contentH = 0;
  private vp: ScrollViewport = { x: 0, y: 0, w: 0, h: 0 };

  // The scrollbar fill; injected so the primitive carries no palette. The host
  // passes its theme token (e.g. colors.borderDim).
  private readonly barColor: string;
  constructor(barColor: string) {
    this.barColor = barColor;
  }

  // The furthest the body can scroll — 0 when it fits (no scrolling, no bar).
  private maxScroll(): number {
    return Math.max(0, this.contentH - this.vp.h);
  }

  // Record the viewport + freshly-measured content height and re-clamp the offset.
  // Pure state update (no canvas) so the geometry is unit-testable without a context.
  applyMetrics(vp: ScrollViewport, contentHeight: number): void {
    this.vp = vp;
    this.contentH = contentHeight;
    this.offset = Math.max(0, Math.min(this.offset, this.maxScroll()));
  }

  get scrollOffset(): number {
    return this.offset;
  }

  // The offset SNAPPED to a whole pixel. The float offset accumulates smoothly (so
  // sub-pixel trackpad deltas aren't lost), but everything that touches the render
  // transform or hit geometry must use this integer value — a fractional canvas
  // translate would bilinearly resample the glyph blits and break the pixel-crisp
  // aesthetic ([[feedback_pixel_aesthetic]]).
  private renderOffset(): number {
    return Math.round(this.offset);
  }

  // Reset to the top. Called when the body's content identity changes (a new context
  // or a new selection) so each fresh body opens scrolled to the top, not wherever
  // the previous one was left (the ScrollView is shared across every sidebar body).
  resetOffset(): void {
    this.offset = 0;
  }

  // Apply a wheel/step delta (px, positive = scroll down). Returns whether the
  // offset actually moved, so the host can skip a repaint when already at an edge.
  // Keeps the float value (small trackpad deltas accumulate); rendering snaps it.
  scrollBy(deltaY: number): boolean {
    const next = Math.max(0, Math.min(this.offset + deltaY, this.maxScroll()));
    if (next === this.offset) return false;
    this.offset = next;
    return true;
  }

  // The content region a body should lay out into: the viewport minus the scrollbar
  // gutter. Origin at the viewport top-left (canvas coords); the body starts here and
  // grows downward, and paintBody's clip+translate is what makes it scroll.
  bodyRegion(): ScrollViewport {
    return { x: this.vp.x, y: this.vp.y, w: this.vp.w - GUTTER, h: this.vp.h };
  }

  // Clip to the viewport, translate by -offset, run `body` (which paints into the
  // gutter-narrowed region and returns its content height), then record metrics and
  // draw the scrollbar. Clamps the offset against the PRIOR height before painting so
  // it never translates past the end; a content-height change self-corrects on the
  // next frame (a one-frame stale offset is invisible).
  paintBody(
    g: CanvasRenderingContext2D,
    vp: ScrollViewport,
    body: (g: CanvasRenderingContext2D, region: ScrollViewport) => number,
  ): void {
    // Pre-clamp with the last-known height so the translate below stays in-range.
    this.vp = vp;
    this.offset = Math.max(0, Math.min(this.offset, this.maxScroll()));

    g.save();
    g.beginPath();
    g.rect(vp.x, vp.y, vp.w, vp.h);
    g.clip();
    g.translate(0, -this.renderOffset());
    const contentHeight = body(g, this.bodyRegion());
    g.restore();

    this.applyMetrics(vp, contentHeight);
    this.paintScrollbar(g);
  }

  // Turn an on-screen canvas point into a body content-space point, or null when the
  // point is outside the viewport (so the host can fall through to other chrome). The
  // body caches its hit-rects in content coords (region.y + localY, pre-translate), so
  // adding the offset back to the on-screen Y lands in that same space.
  mapInto(cx: number, cy: number): { x: number; y: number } | null {
    if (!this.contains(cx, cy)) return null;
    // Add back the SAME snapped offset the render used, so the mapped point lands in
    // the exact content coord the body cached its hit-rect at.
    return { x: cx, y: cy + this.renderOffset() };
  }

  // Whether an on-screen point is inside the scroll viewport — used for wheel capture
  // (only scroll when the cursor is actually over the body).
  contains(cx: number, cy: number): boolean {
    const v = this.vp;
    return cx >= v.x && cx < v.x + v.w && cy >= v.y && cy < v.y + v.h;
  }

  // Thumb rect (canvas coords) or null when the body fits (no bar). Pure geometry,
  // exposed for testing the mapping between offset and thumb travel.
  thumbGeom(): { y: number; h: number } | null {
    const max = this.maxScroll();
    if (max <= 0 || this.contentH <= 0) return null;
    const trackH = this.vp.h;
    const h = Math.max(MIN_THUMB, Math.round(trackH * (this.vp.h / this.contentH)));
    const travel = trackH - h;
    const y = this.vp.y + Math.round(travel * (this.offset / max));
    return { y, h };
  }

  private paintScrollbar(g: CanvasRenderingContext2D): void {
    const thumb = this.thumbGeom();
    if (!thumb) return;
    const x = this.vp.x + this.vp.w - BAR_W;
    g.fillStyle = this.barColor;
    g.fillRect(x, thumb.y, BAR_W, thumb.h);
  }
}
