// initiative invariants — the fleet → icon BASE heuristic (§3.8.2): floor(livingShips × ratio),
// clamped up to MIN_INITIATIVE, counting living SHIPS only. The component tempo tier (tactical-command)
// is NOT here — it rides the effect substrate (see effects/test/fold.test.ts foldPhaseStart). Pure;
// synthetic combatants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseSideInitiative, zeroInitiative } from '../initiative.ts';
import { INITIATIVE_PER_SHIP_MILLI, MIN_INITIATIVE } from '../tuning.ts';
import type { Combatant } from '../state.ts';
import type { FactionType } from '../../factions/types.ts';

const c = (combatId: number, factionId: FactionType, hull = 100): Combatant => ({
  kind: 'ship', id: `c${combatId}`, combatId, factionId, components: ['small-engine', 'small-laser'], commands: [], pools: [{ key: 'hull', current: hull, max: hull }],
});
const fleet = (n: number, factionId: FactionType = 'player'): Combatant[] => Array.from({ length: n }, (_, i) => c(i, factionId));

test('the ratio is the only fractional step and is floored', () => {
  assert.equal(INITIATIVE_PER_SHIP_MILLI, 500, 'sanity: ≈½ in milli (the tuning these expectations assume)');
});

test('baseSideInitiative floors ships × ratio, clamped up to MIN_INITIATIVE', () => {
  assert.equal(baseSideInitiative(fleet(1)), MIN_INITIATIVE, 'floor(½ × 1) = 0 → the lone-ship floor');
  assert.equal(baseSideInitiative(fleet(2)), 1, 'floor(½ × 2) = 1');
  assert.equal(baseSideInitiative(fleet(3)), 1, 'floor(½ × 3) = 1 — the tempo throttle');
  assert.equal(baseSideInitiative(fleet(4)), 2, 'floor(½ × 4) = 2');
  assert.equal(baseSideInitiative(fleet(12)), 6, 'a big fleet does not get an icon per ship');
});

test('baseSideInitiative counts living ships only (attrition lowers tempo)', () => {
  const cs = [c(0, 'player', 0), c(1, 'player', 0), c(2, 'player'), c(3, 'player'), c(4, 'player'), c(5, 'player')];
  assert.equal(baseSideInitiative(cs), 2, '4 living of 6 → floor(½ × 4) = 2');
});

test('zeroInitiative is a full per-faction record at 0', () => {
  const z = zeroInitiative();
  assert.equal(z.player, 0);
  assert.equal(z.rival, 0);
});
