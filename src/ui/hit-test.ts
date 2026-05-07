// Three-way pointer hit-test result. HUD orchestrators expose hitTest()
// so scenes can decide whether a pointer event should reach world picking.
//
// - 'interactive' — over a clickable element. Cursor → pointer; consume
//                   the event; lower layers see "no pointer."
// - 'opaque'      — over a non-clickable but visually solid surface
//                   (panel/card bg, disabled button). Block scene picks
//                   below; default cursor; absorb the click so a drag
//                   doesn't start under the surface.
// - 'transparent' — pointer falls through to whatever's below (world).
//
// Phase 2 (planned): this becomes InputLayer.hitTest in a stacked input
// router. The seam exists now so adding modals/tooltips/context menus
// later doesn't require unwinding scene-level hit logic.
export type HitResult = 'interactive' | 'opaque' | 'transparent';
