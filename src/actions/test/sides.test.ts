// actorSides invariants — the shared faction split both adapters (ships-to-actors + bodies-to-actors)
// end on. Pins the rule: deterministic first-seen faction order, the controlled-side flag, and
// grouping (NOT filtering — the caller filters first). Runs under `node --test`: pure, no DOM/sim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorSides } from '../sides.ts';
import { CONTROLLED_FACTION_ID } from '../../factions/registry.ts';
import type { Actor } from '../types.ts';

const actor = (id: string): Actor => ({ id, commands: [] });

test('groups actors by faction, preserving first-seen faction order', () => {
  const sides = actorSides([
    { factionId: 'a', actor: actor('a1') },
    { factionId: 'b', actor: actor('b1') },
    { factionId: 'a', actor: actor('a2') },
  ]);
  assert.deepEqual(sides.map((s) => s.factionId), ['a', 'b']);
  assert.deepEqual(sides[0]!.actors.map((x) => x.id), ['a1', 'a2']);
  assert.deepEqual(sides[1]!.actors.map((x) => x.id), ['b1']);
});

test('marks exactly the controlled side (factionId === CONTROLLED_FACTION_ID)', () => {
  const sides = actorSides([
    { factionId: CONTROLLED_FACTION_ID, actor: actor('me') },
    { factionId: 'enemy', actor: actor('them') },
  ]);
  assert.equal(sides.find((s) => s.factionId === CONTROLLED_FACTION_ID)?.controlled, true);
  assert.equal(sides.find((s) => s.factionId === 'enemy')?.controlled, false);
});

test('no entries → no sides (it groups, it does not invent)', () => {
  assert.deepEqual(actorSides([]), []);
});
