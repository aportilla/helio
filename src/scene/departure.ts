// The DTO AppController hands to the armed StarmapScene for a warp DEPARTURE pick — the only thing that
// survives the system→galaxy view swap (the disposed SystemScene minted it; the ActionIntent it confirms
// is the durable truth). It carries everything the departure mode needs to draw the pick and mint the
// confirm intent, so the mode reads no game state of its own.

export interface DepartureDestination {
  // The reachable cluster + its stable system handle (the slug the confirm intent's `sys:` target carries).
  readonly clusterIdx: number;
  readonly systemId: string;
  // Precomputed by the ship-aware SystemScene so the mode only displays: milli-ly distance + ETA in turns.
  readonly distanceMilli: number;
  readonly etaTurns: number;
}

export interface DepartureRequest {
  readonly shipId: string;
  readonly shipName: string;
  // The composed warp command id (`<componentId>:warp`) — what the confirm intent's actionId carries, so
  // it routes through the same EFFECT_HANDLERS map every immediate verb uses.
  readonly actionId: string;
  readonly originClusterIdx: number;
  // The drive's warp range (milli-ly) — the range ring's radius (÷ MILLI_PER_LY → world light-years).
  readonly rangeMilliLy: number;
  // Every reachable destination, distance-ordered (nearest first), origin excluded.
  readonly reachable: readonly DepartureDestination[];
}
