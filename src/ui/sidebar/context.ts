// SidebarContext — the swappable contextual region below the turn header. The
// Sidebar paints the header itself and delegates this region to the active
// context (system view: the selected body's facilities; galaxy view: the civ
// summary + selected system). The active context is set by the live scene via
// Sidebar.setContext().
//
// A context caches its hit-rects in ABSOLUTE canvas coords during paint() (the
// region's origin is the panel's top-left, Y-down) and reads them back in the hit
// methods, so paint and hit stay in lockstep — the same one-canvas pattern the
// rest of the HUD uses, one level down from the Sidebar.

export interface Region {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SidebarContext {
  // Paint the content into `region` (canvas coords, top-down). Cache layout for
  // the hit methods below.
  paint(g: CanvasRenderingContext2D, region: Region): void;
  // True if a canvas-space point is over one of this context's controls.
  isInteractive(cx: number, cy: number): boolean;
  // Dispatch a click at a canvas-space point — fires the context's own callbacks.
  // No-op when the point isn't over a control.
  handleClick(cx: number, cy: number): void;
  // Update hover state for a canvas-space point; returns true when it changed, so
  // the Sidebar knows to repaint. Pass an off-panel point to clear hover.
  setHover(cx: number, cy: number): boolean;
}
