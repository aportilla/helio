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

// One button in the sidebar's fixed footer band. The context declares WHAT buttons
// its current state offers (and what they do); the Sidebar owns HOW they're drawn
// (uniform slots) and hit-tested. A disabled button paints greyed and absorbs its
// hit without firing — chrome, never a fall-through to the scene.
export interface FooterAction {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly onClick: () => void;
}

export interface SidebarContext {
  // Paint the content into `region` (canvas coords, top-down). Cache layout for
  // the hit methods below. Returns the content height (region.y-relative) so the
  // host's ScrollView can clamp the scroll offset and size its scrollbar.
  paint(g: CanvasRenderingContext2D, region: Region): number;
  // True if a canvas-space point is over one of this context's controls.
  isInteractive(cx: number, cy: number): boolean;
  // Dispatch a click at a canvas-space point — fires the context's own callbacks.
  // No-op when the point isn't over a control.
  handleClick(cx: number, cy: number): void;
  // Update hover state for a canvas-space point; returns true when it changed, so
  // the Sidebar knows to repaint. Pass an off-panel point to clear hover.
  setHover(cx: number, cy: number): boolean;
  // The footer buttons for the current state (may be empty). Rebuilt each call from
  // fresh state; the Sidebar reads it when it paints and hit-tests the footer band.
  footerActions(): FooterAction[];
  // A stable token identifying WHAT the body is currently showing (which selection /
  // menu state). The Sidebar resets the scroll offset to the top whenever this changes
  // between paints, so a fresh selection opens at the top — but a plain re-render of the
  // same content (a post-turn number refresh, a hover) keeps the scroll position. Must
  // differ across contexts (namespace it) so a context swap always reads as a change.
  contentKey(): string;
}
