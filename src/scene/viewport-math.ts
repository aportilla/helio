// Pure pixel-snap arithmetic for ViewportSizer — extracted so the load-bearing
// multiple-of-N floor (the thing that makes the `image-rendering: pixelated`
// nearest-neighbor upscale divide cleanly) is node-testable without a renderer
// or `window`. See viewport-sizer.ts for the artifact this prevents.

// Round a CSS dimension's physical-pixel count (cssPx × dpr) DOWN to a multiple
// of N, so the browser's nearest-neighbor upscale is exactly N:1 with no mangled
// remainder column. Result is always a multiple of n (and ≥ 0 for valid inputs).
export function snapPhysToMultiple(cssPx: number, dpr: number, n: number): number {
  return Math.floor((cssPx * dpr) / n) * n;
}

// The 3D content width: the full buffer minus the reserved right-edge sidebar
// strip, floored at 1 so a degenerate viewport never yields a zero-width rect.
export function contentBufferWidth(bufferW: number, reservedBuffer: number): number {
  return Math.max(1, bufferW - reservedBuffer);
}
