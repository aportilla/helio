// Base for any HUD widget that re-paints a single rectangular surface
// when its state changes. Folds the rebuild lifecycle (measure → allocate
// canvas → paint → adopt as texture) into one method so subclasses only
// implement two abstract steps:
//
//   measure(): { w, h }                       // first pass — compute size
//   paintInto(g, w, h): void                  // second pass — draw
//
// The two-pass split exists because Canvas2D doesn't support resize-
// without-clear: we have to know the final canvas dimensions before
// allocating. measure() reads the same internal state that paintInto
// will use; the two stay consistent because they read from the same
// private fields.

import { Widget } from './widget';

export abstract class BasePanel extends Widget {
  // Compute the (w, h) for the next paint based on current internal
  // state. Called from rebuild() before allocating the canvas.
  protected abstract measure(): { w: number; h: number };

  // Paint into the freshly-allocated 2D context. The context starts
  // blank; subclass typically opens with paintSurface(g, 0, 0, w, h).
  protected abstract paintInto(g: CanvasRenderingContext2D, w: number, h: number): void;

  // Run the full lifecycle. Public so an orchestrator can request a
  // re-paint after external state changes (e.g. a settings toggle
  // flipped from outside the panel).
  rebuild(): void {
    const { w, h } = this.measure();
    if (w <= 0 || h <= 0) {
      this.setVisible(false);
      return;
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    this.paintInto(c.getContext('2d')!, w, h);
    this.setTexture(c, w, h);
  }
}
