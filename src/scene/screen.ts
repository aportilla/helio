// The lifecycle contract every top-level view (galaxy, system, test — and the
// screens to come: research tree, fleet, diplomacy, …) implements, so
// AppController holds and swaps them uniformly instead of knowing each concrete
// type. start()/stop() are pause/resume (cheap, state-preserving — used for the
// galaxy↔overlay round-trip); dispose() is teardown. afterTurnAdvance() is
// optional: only screens that surface turn-driven state (the economy read-outs)
// implement it, so the turn loop can call it without a type test.
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
  afterTurnAdvance?(): void;
  // When true on the live screen, the outer galaxy turn is suspended: nextTurn()
  // short-circuits so neither a programmatic call nor a turn phase can step the
  // economy/turn scalar while it's up. The seam the encounter modal sets to run
  // its own round loop within a single galaxy turn (combat plan §8.2); the
  // galaxy/system/test screens leave it unset, so the turn advances normally
  // there. The sidebar's Next Turn pill is gated separately (setNextTurnEnabled).
  readonly freezesTurn?: boolean;
}
