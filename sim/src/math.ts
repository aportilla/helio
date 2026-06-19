// Integer-only math for the load-bearing sim path (§10).
//
// Everything here is deterministic and float-free in its *result* — the one
// place a float could sneak in is an initial guess, and `isqrt` is written to
// avoid even that, so the same input yields the same bytes on every machine the
// game ever runs on. These are the only arithmetic primitives the sim uses for
// distance, travel time, and fair-share splits.

/** Floor of the square root of a non-negative integer, with no float anywhere.
 *  Domain: 0 ≤ n ≤ Number.MAX_SAFE_INTEGER. The sim's coordinate range keeps
 *  squared distances far below 2^48, so every product below is exact. */
export function isqrt(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new Error(`isqrt: ${n} is not a non-negative integer`);
  if (n < 2) return n;
  // Bracket the root by a power of two (doubling), then binary-search.
  let hi = 1;
  while (hi * hi <= n) hi *= 2;
  let lo = hi >>> 1; // (hi/2)^2 <= n < hi^2, so the root is in [lo, hi)
  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (mid * mid <= n) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Ceiling division of two positive integers (a ≥ 0, b > 0). */
export function ceilDiv(a: number, b: number): number {
  if (b <= 0) throw new Error(`ceilDiv: divisor ${b} must be positive`);
  return Math.floor((a + b - 1) / b);
}

/** Clamp an integer to [lo, hi]. */
export function clampInt(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
