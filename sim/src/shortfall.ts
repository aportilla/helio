// Shortfall reasons (§5) — the single-cause code naming which term bound a
// reachable-but-unserved demand, each paired with a buildable fix. v1 ships the
// four single-cause codes; ranked multi-causal explanation + extra codes
// (MissingCoInput, BudgetDegraded) are deferred (banner). With transport
// uncapped, every shortfall reduces to reach or production — no LaneAtCapacity.

export const ShortfallReason = {
  /** No legal route to any source with surplus → research jump range / build a
   *  hub to bridge the gap. */
  Unreachable: 0,
  /** A reachable source's per-turn outflow cap (CFL) bound it → raise local
   *  stock / depot buffer / add a second source. */
  SourceCflLimited: 1,
  /** No reachable source had any surplus → build production upstream. */
  SourceExhausted: 2,
  /** A reachable source existed but lost the auction to higher-priority sinks →
   *  raise priority / add production. */
  OutbidByPriority: 3,
} as const;
export type ShortfallReason = (typeof ShortfallReason)[keyof typeof ShortfallReason];

export const SHORTFALL_FIX: Readonly<Record<ShortfallReason, string>> = {
  [ShortfallReason.Unreachable]: 'Research jump range or build a hub to bridge the gap',
  [ShortfallReason.SourceCflLimited]: 'Raise local stock, add a depot buffer, or a second source',
  [ShortfallReason.SourceExhausted]: 'Build production upstream',
  [ShortfallReason.OutbidByPriority]: 'Raise this demand\'s priority or add production',
};

export function shortfallName(r: ShortfallReason): string {
  switch (r) {
    case ShortfallReason.Unreachable: return 'Unreachable';
    case ShortfallReason.SourceCflLimited: return 'SourceCflLimited';
    case ShortfallReason.SourceExhausted: return 'SourceExhausted';
    case ShortfallReason.OutbidByPriority: return 'OutbidByPriority';
  }
}
