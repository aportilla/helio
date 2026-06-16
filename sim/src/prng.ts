// xoshiro128** — the one seeded integer PRNG threaded through the sim state (§10).
//
// Net-new for the repo: the procgen PRNG (scripts/lib/prng.mjs, mulberry32) is
// float-returning and only needs single-build determinism. The economy sim
// needs bit-stable save/replay, so it carries an integer generator whose entire
// state is four uint32 words that serialize verbatim. All ops go through
// Math.imul / `>>> 0` so they stay in 32-bit lanes regardless of platform.

const U32 = 0x100000000;

function rotl(x: number, k: number): number {
  return (((x << k) | (x >>> (32 - k))) >>> 0);
}

/** SplitMix32 — seed expander. Fills the four xoshiro words from one u32 seed,
 *  guaranteeing a non-zero state (all-zero is the one forbidden xoshiro state). */
function splitmix32(seed: number): number[] {
  let z = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    z = (z + 0x9e3779b9) >>> 0;
    let r = z;
    r = Math.imul(r ^ (r >>> 16), 0x21f0aaad) >>> 0;
    r = Math.imul(r ^ (r >>> 15), 0x735a2d97) >>> 0;
    r = (r ^ (r >>> 15)) >>> 0;
    out.push(r);
  }
  if ((out[0]! | out[1]! | out[2]! | out[3]!) === 0) out[0] = 1; // forbid all-zero
  return out;
}

export class Prng {
  // Four 32-bit words — the entire serialized state.
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(state: readonly [number, number, number, number]) {
    this.s0 = state[0] >>> 0;
    this.s1 = state[1] >>> 0;
    this.s2 = state[2] >>> 0;
    this.s3 = state[3] >>> 0;
  }

  static fromSeed(seed: number): Prng {
    const s = splitmix32(seed);
    return new Prng([s[0]!, s[1]!, s[2]!, s[3]!]);
  }

  /** Next 32-bit unsigned integer. */
  next(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0);
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    this.s0 >>>= 0; this.s1 >>>= 0; this.s2 >>>= 0; this.s3 >>>= 0;
    return result;
  }

  /** Uniform integer in [0, bound) for bound in [1, 2^32], rejection-sampled
   *  to remove modulo bias (deterministic — the rejected draws are part of the
   *  stream, so two runs reject identically). */
  below(bound: number): number {
    if (!Number.isInteger(bound) || bound < 1) throw new Error(`below: bad bound ${bound}`);
    if (bound === 1) return 0;
    // Largest multiple of `bound` that fits in 2^32, used as the reject ceiling.
    const limit = U32 - (U32 % bound);
    let x = this.next();
    while (x >= limit) x = this.next();
    return x % bound;
  }

  /** Uniform integer in [lo, hi] inclusive. */
  range(lo: number, hi: number): number {
    return lo + this.below(hi - lo + 1);
  }

  /** Snapshot the four words for serialization. */
  getState(): [number, number, number, number] {
    return [this.s0 >>> 0, this.s1 >>> 0, this.s2 >>> 0, this.s3 >>> 0];
  }

  /** Restore the four words from a deserialized snapshot (object identity kept). */
  setState(state: readonly [number, number, number, number]): void {
    this.s0 = state[0] >>> 0;
    this.s1 = state[1] >>> 0;
    this.s2 = state[2] >>> 0;
    this.s3 = state[3] >>> 0;
  }
}
