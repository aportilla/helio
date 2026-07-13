// turn-order — the Press-Turn turn cursor (§3.8). `nextActor` walks the ACTIVE side's living ships
// (round-robin by combatId WITHIN the side) while that side still holds initiative icons; when the
// side's pool is spent or it has no living ship left, it yields (undefined) and the reducer hands the
// phase to the next side (`nextLivingSide` + `firstLivingOfSide`). A side freely activates any of its
// ships (I8): there is no per-combatant speed/`readyTick` gate — icons (not one-action-per-ship) are the
// limiter. Pure — reads only EncounterState + the down predicate.

import type { FactionType } from '../factions/types.ts';
import type { EncounterState } from './state.ts';
import { ENERGY_STAT, isDown } from './state.ts';

// The next living SAME-SIDE combatant to offer this phase, or undefined when the active side's phase
// is over. Over = the side's icon pool is spent (≤0), or no living same-side combatant remains. The
// walk is round-robin by combatId within the side; `step` runs 1..n so the LAST candidate checked is
// the active itself — a lone living same-side ship is re-offered (a ship may act again while icons
// remain, I9), while a second living same-side ship is found first (the round-robin offer order).
export function nextActor(state: EncounterState): number | undefined {
  if (state.initiative[state.phaseSide] <= 0) return undefined; // pool spent → phase over
  const n = state.combatants.length;
  const side = state.phaseSide;
  for (let step = 1; step <= n; step++) {
    const id = (state.activeId + step) % n;
    const candidate = state.combatants[id];
    if (candidate && candidate.factionId === side && !isDown(candidate)) return id;
  }
  return undefined; // no living same-side combatant → phase over (eliminated / stranded)
}

// The living SAME-SIDE combatant `delta` steps from the active one in combatId order (wrapping) — the
// player's free in-phase actor cycle (◄ ►, §3.8). `delta` is the DIRECTION (+1 next, −1 prev); the walk
// runs the full ring so a lone living same-side ship returns ITSELF (a no-op re-anchor). Reads phaseSide,
// so it only ever offers YOUR side during your phase. Unlike `nextActor` it is NOT gated on icons and does
// not advance the turn — a cursor query for the UI's actor switch (selectActor), never a turn-order step.
export function neighborActor(state: EncounterState, delta: number): number | undefined {
  const n = state.combatants.length;
  if (n === 0) return undefined;
  const side = state.phaseSide;
  const dir = delta < 0 ? -1 : 1;
  for (let step = 1; step <= n; step++) {
    const id = (((state.activeId + dir * step) % n) + n) % n;
    const c = state.combatants[id];
    if (c && c.factionId === side && !isDown(c)) return id;
  }
  return undefined;
}

// The sides in first-seen combatId order — the deterministic phase rotation. Ships are numbered
// side-by-side at spec build (ships-to-combatants), so this is the side order the round walks.
export function sideOrderOf(combatants: EncounterState['combatants']): readonly FactionType[] {
  const order: FactionType[] = [];
  const seen = new Set<FactionType>();
  for (const c of combatants) {
    if (!seen.has(c.factionId)) {
      seen.add(c.factionId);
      order.push(c.factionId);
    }
  }
  return order;
}

// The next side AFTER `phaseSide` (cyclically, EXCLUDING phaseSide) that still fields a living
// combatant, or undefined when no OTHER side can act (side-elimination — the encounter is terminal).
// The reducer reads this at a phase boundary to choose whose phase begins next.
export function nextLivingSide(state: EncounterState): FactionType | undefined {
  const order = sideOrderOf(state.combatants);
  const i = order.indexOf(state.phaseSide);
  if (i < 0) return undefined;
  for (let step = 1; step < order.length; step++) {
    const side = order[(i + step) % order.length];
    if (side !== undefined && state.combatants.some((c) => c.factionId === side && !isDown(c))) return side;
  }
  return undefined;
}

// The lowest-combatId living combatant of a side, or undefined — the combatant a side's phase OPENS
// on. The roster is dense in combatId order, so the first match is the lowest combatId.
export function firstLivingOfSide(
  combatants: EncounterState['combatants'],
  factionId: FactionType,
): number | undefined {
  for (const c of combatants) {
    if (c.factionId === factionId && !isDown(c)) return c.combatId;
  }
  return undefined;
}

// The lowest-combatId living same-side ship that can AFFORD at least one COMBAT command — the combatant a
// phase should OPEN on, so the cursor lands somewhere the player can actually act (or the AI can move),
// never on a drained ship while a charged same-side ship waits (§3.8). Affordability mirrors the menu's
// energy gate (D6: cost ≤ energy; a ship with no energy model is permissively affordable). A command whose
// target lives in GALAXY space (targetSpace 'system' — e.g. WARP DRIVE) is EXCLUDED: it can never have a
// target in an encounter (the combat resolver mints no 'system' candidate, so the menu greys it), and it
// costs 0 energy, so counting it would falsely make every ship — even a fully drained one — "actable".
// Returns undefined when NO same-side ship can afford a combat action (a fully spent side — the phase
// becomes a forfeit / End Turn); the caller falls back to firstLivingOfSide so a phase always opens on
// someone. The rest of the target half of "has an available action" stays in the menu/controller (only it
// mints targets); for the homogeneous enemy-target loadout the two coincide, since a living enemy always
// exists off-terminal.
export function firstActableOfSide(
  combatants: EncounterState['combatants'],
  factionId: FactionType,
): number | undefined {
  for (const c of combatants) {
    if (c.factionId !== factionId || isDown(c)) continue;
    const energy = c.stats?.[ENERGY_STAT] ?? Infinity;
    if (c.commands.some((cmd) => cmd.grant.targetSpace !== 'system' && cmd.totalCost <= energy)) return c.combatId;
  }
  return undefined;
}
