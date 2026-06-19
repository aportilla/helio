// P4 — quantify supply/demand (§8). The single authority: it computes, per
// living (planet, resource), the netDemand / exportable / signed cover the
// matcher allocates against and the read surface reports — from the SAME math,
// so the read can never contradict allocation (§4.2).
//
// The two anti-bullwhip layers live here: the ETA ledger (subtract only inbound
// landing within horizon H, §3.5) and the hysteresis deadband (a two-threshold
// state machine so demand doesn't flicker at the boundary, §7). A planet either
// orders (refilling toward its setpoint) or exports (releasing above its keep
// buffer) — never both for the same resource in the same turn.

import { TransportTier } from './resources.ts';
import type { World } from './world.ts';
import { asPlanet, asResource } from './ids.ts';

export interface Quantified {
  readonly netDemand: Int32Array; // uncovered demand this turn (0 in surplus)
  readonly exportable: Int32Array; // offered supply/turn — faucet capacity + resting surplus (0 in deficit)
  readonly cover: Int32Array; // signed: + surplus / − deficit
}

export function quantify(world: World): Quantified {
  const R = world.R;
  const cfg = world.cfg;
  const n = world.planetCount * R;
  const netDemand = new Int32Array(n);
  const exportable = new Int32Array(n);
  const cover = new Int32Array(n);

  for (let p = 0; p < world.planetCount; p++) {
    if (world.tombstone[p]) continue;
    for (let r = 0; r < R; r++) {
      const i = p * R + r;
      const tier = world.resources.metas[r]!.tier;

      // Intangibles never move; LocalOnly is consumed in place. Neither emits a
      // transport-able demand/surplus, but we still leave cover at its neutral 0.
      if (tier !== TransportTier.Transportable) continue;

      const emaC = world.emaConsume[i]!;
      const stock = world.stock[i]!;
      const prodPerTurn = world.production[i]!;
      const setpoint = cfg.setpointTurns * emaC;
      const keepBuffer = cfg.keepBufferTurns * emaC;
      const deadband = cfg.deadbandTurns * emaC;

      const inboundH = world.ledger.inboundWithinH(asPlanet(p), asResource(r), world.turn, cfg.horizonH);
      // Project stock to the horizon: current + inbound landing within H + the
      // net flux over H (production steady, consumption via EMA appetite).
      const projStock = stock + inboundH + (prodPerTurn - emaC) * cfg.horizonH;

      // Two-threshold hysteresis: begin ordering once the projection falls below
      // (setpoint − deadband); stop once it recovers to the setpoint.
      let ordering = world.ordering[i] === 1;
      if (!ordering && projStock < setpoint - deadband) ordering = true;
      else if (ordering && projStock >= setpoint) ordering = false;
      world.ordering[i] = ordering ? 1 : 0;

      if (ordering) {
        const nd = Math.max(0, setpoint - projStock);
        netDemand[i] = nd;
        cover[i] = -nd;
      } else {
        // Demand-pull supply: offer the faucet's per-turn NET capacity (gross
        // production less the same-body appetite already reserved by P3 self-feed)
        // PLUS any resting stock above the keep buffer. A pure faucet rests at
        // stock≈0 and offers `netProd`; the resting term only drains stock CARRIED
        // across a facility edit (the `stock` accumulator survives reproject), so
        // under steady pull it is ~0. Net (not gross) withholds the same-body
        // ration; using the static `consumption` rate — exact and integer in v1,
        // where consumption is constant — mirrors the consumer side's net-import
        // projection without coupling the export offer to EMA ramp transients.
        const netProd = Math.max(0, prodPerTurn - world.consumption[i]!);
        const ex = netProd + Math.max(0, stock - keepBuffer);
        exportable[i] = ex;
        cover[i] = ex;
      }
    }
  }

  return { netDemand, exportable, cover };
}
