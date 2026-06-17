// Small shared helpers for the sidebar's painters (Sidebar + the two
// SidebarContexts). Each paints into one canvas and hit-tests by recomputing
// absolute-coord rects, so they all need the same rect type + point-in-rect
// test; the two economy contexts also format the same milli-unit balances.
// Kept here so the painters can't drift on either.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// milli-units → a compact unit string for the value column: ≤1 decimal, a
// trailing ".0" trimmed (12500 → "12.5", 6000 → "6", -1000 → "-1").
export function fmtMilli(milli: number): string {
  const s = (Math.round(milli / 100) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
