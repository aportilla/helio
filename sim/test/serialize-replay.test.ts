import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scene, stepN, P1 } from './helpers.ts';
import type { SceneSpec } from './helpers.ts';
import { serialize, deserialize, configHash } from '../src/serialize.ts';
import { EconomyEngine } from '../src/engine.ts';
import { defaultBalance } from '../src/constants.ts';

const SPEC: SceneSpec = {
  xs: [0, 30, 60, 90, 120],
  planets: [
    { star: 0, stock: [5000, 0, 0, 0], production: [80, 0, 0, 0] },
    { star: 1, stock: [200, 300, 0, 0], consumption: [50, 0, 0, 0] },
    { star: 2, stock: [0, 6000, 0, 0], production: [0, 60, 0, 0], consumption: [40, 0, 0, 0] },
    { star: 3, stock: [0, 0, 0, 0], consumption: [30, 40, 0, 0] },
    { star: 4, stock: [100, 100, 0, 0], consumption: [20, 25, 0, 0] },
  ],
  cfg: { jumpRadius: 50, maxLegTurns: 5, horizonH: 8, setpointTurns: 3, keepBufferTurns: 3 },
  seed: 7,
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

function fnv(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const x of bytes) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return h >>> 0;
}

test('serialize → deserialize → serialize is byte-identical (round-trip)', () => {
  const { engine, skeleton } = scene(SPEC);
  stepN(engine, 37); // mid-flight transfers present
  assert.ok(engine.world.ring.inFlightTotal > 0);
  const b1 = serialize(engine.world);
  const reloaded = deserialize(skeleton, b1);
  const b2 = serialize(reloaded);
  assert.ok(bytesEqual(b1, b2), 'a reload re-serializes to the same bytes');
});

test('save/load continuation: a reloaded world steps identically to the original', () => {
  const a = scene(SPEC);
  stepN(a.engine, 25);
  const saved = serialize(a.engine.world);
  const b = new EconomyEngine(deserialize(a.skeleton, saved), { checkInvariants: true });

  for (let i = 0; i < 40; i++) {
    a.engine.step();
    b.step();
    assert.ok(bytesEqual(serialize(a.engine.world), serialize(b.world)), `divergence at continuation turn ${i}`);
  }
});

test('replay-from-seed determinism: two independent runs produce identical bytes', () => {
  const a = scene(SPEC);
  const b = scene(SPEC);
  stepN(a.engine, 60);
  stepN(b.engine, 60);
  const ba = serialize(a.engine.world);
  const bb = serialize(b.engine.world);
  assert.ok(bytesEqual(ba, bb), 'same seed + same inputs → same state');
  assert.equal(fnv(ba), fnv(bb), 'golden hash matches across runs');
});

test('serialized bytes preserve in-flight transfers and their monotonic ids', () => {
  const { engine, skeleton } = scene(SPEC);
  stepN(engine, 20);
  const liveBefore = engine.world.ring.liveCount;
  const nextIdBefore = engine.world.ring.nextTransferId;
  const reloaded = deserialize(skeleton, serialize(engine.world));
  assert.equal(reloaded.ring.liveCount, liveBefore, 'in-flight count preserved');
  assert.equal(reloaded.ring.nextTransferId, nextIdBefore, 'id counter preserved (no recycle)');
  assert.equal(reloaded.ledger.total(), reloaded.ring.inFlightTotal, 'ledger rebuilt to match the ring');
});

test('loading against a different config is rejected (configHash guard)', () => {
  const { engine } = scene(SPEC);
  stepN(engine, 5);
  const saved = serialize(engine.world);
  const wrongSkeleton = {
    geometry: scene(SPEC).skeleton.geometry,
    resources: scene(SPEC).skeleton.resources,
    // A STATIC tuning change (setpointTurns) must be rejected; runtime tech tiers
    // like jumpRadius are serialized state, not part of the configHash identity.
    cfg: defaultBalance({ ...SPEC.cfg, setpointTurns: 99 }),
  };
  assert.notEqual(configHash(wrongSkeleton), configHash(scene(SPEC).skeleton));
  assert.throws(() => deserialize(wrongSkeleton, saved), /configHash mismatch/);
});

test('a kill survives a save/load (tombstone persisted)', () => {
  const { engine, skeleton } = scene(SPEC);
  stepN(engine, 10);
  engine.killPlanet(P1);
  const reloaded = deserialize(skeleton, serialize(engine.world));
  assert.equal(reloaded.tombstone[1], 1, 'dead colony stays dead after reload');
});
