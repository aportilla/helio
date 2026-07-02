// Shared initiative-pip geometry — a right-leaning parallelogram slash. Used by the encounter bar
// (a static row of them) and the ActivePip widget (a single one, animated). Kept in its own leaf so both
// draw a pixel-identical slash and the animated pip seams perfectly into the row at rest.

// A pip is PIP_W wide with its top row shoved right by PIP_SHEAR; SHEAR_SLOPE is a clean 1-in-2 rise so
// the slanted sides stair-step crisply under the no-AA pixel idiom.
export const SHEAR_SLOPE = 0.5;
export const PIP_W = 6;
export const PIP_H = 17; // odd so (PIP_H - 1) is even and the 1-in-2 shear divides exactly
export const PIP_SHEAR = Math.round((PIP_H - 1) * SHEAR_SLOPE); // top row's rightward offset

// Paint one pip: bottom-left corner at (x, yTop + PIP_H), filled row by row so the slanted sides stay crisp.
export function paintPip(g: CanvasRenderingContext2D, x: number, yTop: number, color: string): void {
  g.fillStyle = color;
  for (let r = 0; r < PIP_H; r++) {
    const off = Math.round((PIP_H - 1 - r) * SHEAR_SLOPE);
    g.fillRect(x + off, yTop + r, PIP_W, 1);
  }
}
