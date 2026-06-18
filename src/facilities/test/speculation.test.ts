// Pins the speculative next-turn clone (speculation.ts) — the foundation of the
// predictive viz. The load-bearing claims: a clone+step reproduces the real next
// turn bit-for-bit (so predicted lanes/cover are what Next Turn will actually
// produce), and the clone is fully independent (a throwaway read can never mutate
// the live world or its save). Runs under `node --test` type-stripping against
// the standalone sim, exactly like project.test.ts — the catalog never loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EconomyEngine,
  makeGeometry,
  makeWorld,
  defaultResourceTable,
  defaultBalance,
  serialize,
  type PlanetSpec,
  type WorldSkeleton,
} from '../../../sim/src/index.ts';
import { cloneWorldForSpeculation } from '../speculation.ts';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A minimal two-star economy: a FOOD producer one jump from a FOOD consumer, so
// every step mints a transfer and the speculative ring is non-empty.
function scene(): { engine: EconomyEngine; skeleton: WorldSkeleton } {
  const geometry = makeGeometry([[0, 0, 0], [30, 0, 0]]);
  const resources = defaultResourceTable();
  const cfg = defaultBalance({ jumpRadius: 50 });
  const planets: PlanetSpec[] = [
    { star: 0, stock: [5000, 0, 0, 0], production: [80, 0, 0, 0] },
    { star: 1, stock: [0, 0, 0, 0], consumption: [50, 0, 0, 0] },
  ];
  const world = makeWorld({ geometry, resources, cfg, seed: 7, planets });
  const engine = new EconomyEngine(world, { checkInvariants: true });
  return { engine, skeleton: { geometry, resources, cfg } };
}

test('speculative clone reproduces the real next turn, bit-for-bit', () => {
  const { engine, skeleton } = scene();
  for (let i = 0; i < 5; i++) engine.step(); // accumulate in-flight cargo
  const before = serialize(engine.world);

  const spec = cloneWorldForSpeculation(engine.world, skeleton);
  assert.ok(spec, 'clone + speculative step succeeded');

  // The speculative step ran on a throwaway copy — the real world is untouched.
  assert.ok(bytesEqual(serialize(engine.world), before), 'real world unchanged by speculation');

  // Stepping the real world reproduces exactly what the clone already predicted.
  engine.step();
  assert.ok(bytesEqual(serialize(spec!.world), serialize(engine.world)),
    'speculative world == real next turn');
});

test('speculative clone is one turn ahead and fully independent', () => {
  const { engine, skeleton } = scene();
  for (let i = 0; i < 3; i++) engine.step();
  const liveTurn = engine.world.turn;

  const spec = cloneWorldForSpeculation(engine.world, skeleton);
  assert.ok(spec);
  assert.equal(spec!.world.turn, liveTurn + 1, 'clone stepped exactly one turn past the live world');

  // Further stepping the clone must never advance the live world.
  spec!.step();
  assert.equal(engine.world.turn, liveTurn, 'live world turn untouched by clone stepping');
});

test('speculative clone predicts the first turn of a freshly built world', () => {
  // The "new provider emits ships immediately" case at game start / before the
  // session's first real step: a turn-0 world still yields a stepped prediction.
  const { engine, skeleton } = scene();
  assert.equal(engine.world.turn, 0);
  const spec = cloneWorldForSpeculation(engine.world, skeleton);
  assert.ok(spec, 'cold-start world clones + steps');
  assert.equal(spec!.world.turn, 1, 'prediction is the turn-0 dispatch');
});
