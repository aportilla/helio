// The lifecycle contract every top-level view (galaxy, system, test — and the
// screens to come: research tree, fleet, diplomacy, …) implements, so
// AppController holds and swaps them uniformly instead of knowing each concrete
// type. start()/stop() are pause/resume (cheap, state-preserving — used for the
// galaxy↔overlay round-trip); dispose() is teardown. afterTurnAdvance() is
// optional: only screens that surface turn-driven state (the economy read-outs)
// implement it, so the turn loop can call it without a type test.
//
// Today AppController keeps the galaxy scene as a persistent ROOT and at most one
// lazily-built OVERLAY (system or test) on top of it; the single overlay slot is
// the seam a future screen stack / modal layer grows from (`current` already
// abstracts "whichever screen is live").
export interface Screen {
  start(): void;
  stop(): void;
  dispose(): void;
  afterTurnAdvance?(): void;
}
