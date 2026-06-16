// Tuning surface — every knob the sim reads, as plain data (the procgen-priors
// discipline applied to the economy). One versioned BalanceConfig; its hash
// rides in the save (§7) so a replay can detect it was tuned against a different
// config. All values are integers or integer fractions — no float reaches the
// load-bearing path (§10).

/** 1 unit = MILLI_PER_UNIT milli. Quantities are integer milli; display divides
 *  back out (§3.3, open-Q resolved to 1000 — tooltip-legible, exact either way). */
export const MILLI_PER_UNIT = 1000;

export const SCHEMA_VERSION = 1;

export interface BalanceConfig {
  // — Lookahead & buffers (anti-bullwhip, §7) —
  /** Horizon H: only inbound landing within H turns offsets demand (§3.5). */
  readonly horizonH: number;
  /** setpoint = setpointTurns · emaConsume — the refill target (§6, rule 6). */
  readonly setpointTurns: number;
  /** keepBuffer = keepBufferTurns · emaConsume — reserve held back before export. */
  readonly keepBufferTurns: number;
  /** Hysteresis deadband, in turns of consumption, below the setpoint (§7). */
  readonly deadbandTurns: number;
  /** Integer EMA weight on the newest sample: ema' = (ema·(den−num)+x·num)/den. */
  readonly emaNum: number;
  readonly emaDen: number;

  // — Source smoothing (§3.4) —
  /** Per-source outflow cap: a source ships ≤ floor(stock·cflNum/cflDen) of a
   *  resource per turn (anti-overshoot). cflNum=cflDen ⇒ effectively off. */
  readonly cflNum: number;
  readonly cflDen: number;

  // — Allocation (§5) —
  /** Fan-in breadth: a demand considers its K cheapest candidate sources/turn. */
  readonly fanInK: number;
  /** Turns underserved before a demand's criticality is bumped (anti-livelock). */
  readonly starveEscalationTurns: number;
  /** Score added per starvation escalation step. */
  readonly starveBoost: number;

  // — Topology (§3, §6) —
  // jumpRadius and travelSpeedTier are RUNTIME tech tiers (mutated by
  // EconomyEngine.applyTech): they are serialized as state and excluded from the
  // configHash. maxLegTurns is STATIC structural tuning (it sizes the ring) and
  // is part of the configHash identity.
  /** Max distance of a single jump (a leg). Reach beyond is multi-leg. Runtime tech. */
  readonly jumpRadius: number;
  /** Turns a leg at exactly jumpRadius costs (a leg at distance 0 costs 1). Static. */
  readonly maxLegTurns: number;
  /** Speed tech: turns subtracted from every leg (floored at 1) (§6, rule 7). Runtime tech. */
  readonly travelSpeedTier: number;

  // — Ring sizing (§9) —
  /** Slots in the transfer pool — sized for the famine worst case, not steady
   *  state. Dispatch throws if exceeded (the active-flow cap's v1 hard stop). */
  readonly transferPoolCapacity: number;
}

export function defaultBalance(overrides: Partial<BalanceConfig> = {}): BalanceConfig {
  return {
    horizonH: 6,
    setpointTurns: 3,
    keepBufferTurns: 3,
    deadbandTurns: 1,
    emaNum: 1,
    emaDen: 4,
    cflNum: 1,
    cflDen: 1,
    fanInK: 4,
    starveEscalationTurns: 4,
    starveBoost: 50,
    jumpRadius: 100,
    maxLegTurns: 8,
    travelSpeedTier: 0,
    transferPoolCapacity: 4096,
    ...overrides,
  };
}

/** Integer EMA step: ema' = floor((ema·(den−num) + x·num) / den). */
export function emaStep(ema: number, x: number, cfg: BalanceConfig): number {
  return Math.floor((ema * (cfg.emaDen - cfg.emaNum) + x * cfg.emaNum) / cfg.emaDen);
}
