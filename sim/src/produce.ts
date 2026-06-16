// P3 — produce + consume (§8). A deliberately simple flux model for v1: each
// living planet adds its per-turn production (clamped to storage room — the
// output-room clamp that throttles a glutted provider, §6) and removes its
// per-turn consumption (clamped to available stock — a starving colony consumes
// only what it has). Multi-input fixed-ratio recipes are a later contributor
// rule (§6.0); the conservation equality (§3.6) holds for either.
//
// The EMA tracks *attempted* consumption (the colony's appetite), not realized
// (stock-limited) consumption — otherwise a famine would shrink the setpoint and
// the colony would order less and never recover (a livelock the matcher's
// starvation escalation also guards, §5).

import { clampInt } from './math.ts';
import { emaStep } from './constants.ts';
import type { World } from './world.ts';

export const ThrottleReason = { None: 0, OutputFull: 1 } as const;
export type ThrottleReason = (typeof ThrottleReason)[keyof typeof ThrottleReason];

export interface ProduceResult {
  readonly produced: number;
  readonly consumed: number;
  /** Per-(planet, resource) throttle state this turn for the read surface (§6). */
  readonly throttle: Int8Array;
}

export function produceConsume(world: World): ProduceResult {
  const R = world.R;
  let produced = 0;
  let consumed = 0;
  const throttle = new Int8Array(world.planetCount * R);

  for (let p = 0; p < world.planetCount; p++) {
    if (world.tombstone[p]) continue;
    for (let r = 0; r < R; r++) {
      const i = p * R + r;

      // Production, clamped to storage room (output-room clamp → glut throttle).
      const prod = world.production[i]!;
      if (prod > 0) {
        const room = Math.max(0, world.storageCeiling[i]! - world.stock[i]!);
        const actual = clampInt(prod, 0, room);
        world.stock[i] = world.stock[i]! + actual;
        produced += actual;
        if (actual < prod) throttle[i] = ThrottleReason.OutputFull;
      }

      // Consumption, clamped to available stock.
      const want = world.consumption[i]!;
      if (want > 0) {
        const realized = Math.min(want, world.stock[i]!);
        world.stock[i] = world.stock[i]! - realized;
        consumed += realized;
      }

      // EMA of attempted consumption (constant in v1, but trend-ready).
      world.emaConsume[i] = emaStep(world.emaConsume[i]!, want, world.cfg);
    }
  }

  return { produced, consumed, throttle };
}
