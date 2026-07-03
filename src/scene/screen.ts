// The lifecycle contract every top-level view (galaxy, system, test — and the
// screens to come: research tree, fleet, diplomacy, …) implements, so
// AppController holds and swaps them uniformly instead of knowing each concrete
// type. start()/stop() are pause/resume (cheap, state-preserving — used for the
// galaxy↔overlay round-trip); dispose() is teardown. afterTurnAdvance(arrivals?)
// is optional: only screens that surface turn-driven state (the economy read-outs)
// implement it, so the turn loop can call it without a type test. It carries the
// ships that completed a warp this turn (stepShipTransits' ArrivalEvent stream) so
// the live system view can play their warp-in FX; a screen that ignores them omits
// the arg.

import type { ArrivalEvent } from '../game-state';
//
// AppController keeps the galaxy scene as a persistent ROOT with a stack of
// lazily-built OVERLAYS (system / test, and a modal-over-system to come) layered
// on top (overlay-stack.ts); `current` abstracts "whichever screen is live". Only
// depth-1 is reachable today — the depth-N spine exists for a modal that sits over
// the system view (the encounter modal) without disturbing the round-trip.
export interface Screen {
  start(): void;
  stop(): void;
  dispose(): void;
  afterTurnAdvance?(arrivals?: readonly ArrivalEvent[]): void;
  // When true on the live screen, the outer galaxy turn is suspended: nextTurn()
  // short-circuits so neither a programmatic call nor a turn phase can step the
  // economy/turn scalar while it's up. The seam the encounter mode sets to run its
  // own round loop within a single galaxy turn (combat plan §8.2): SystemScene's freezesTurn
  // getter returns its inEncounter flag, so the system screen raises it only while combat runs;
  // the galaxy/test screens leave it unset and the turn advances normally. The sidebar's Next
  // Turn pill is gated separately (setNextTurnEnabled).
  readonly freezesTurn?: boolean;
}
