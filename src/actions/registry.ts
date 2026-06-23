// ACTION_DEFS — the single source of truth for every action. Adding an action is one
// object here plus one literal in the ActionType union: its wire-id, menu label, accent
// color, category, targeting, and dispatch kind all flow from that one edit. Mirrors
// src/ships/registry.ts and src/factions/registry.ts exactly, deliberately, so the
// frozen-key discipline reads identically across the registries.
//
// v1 content is COMBAT-FIRST (the unblocked frontier, per plans/4x-system-action-menu.md):
// a placeholder ATTACK that enters an encounter, a NAVIGATION flee, and the always-present
// Pass. Non-combat verbs (establish-colony, move) are additive 'immediate' members.

import type { ActionDef, ActionType } from './types.ts';
import {
  ATTACK_ACTION_COLOR,
  BOMBARD_ACTION_COLOR,
  ESTABLISH_ACTION_COLOR,
  FLEE_ACTION_COLOR,
  MINE_ACTION_COLOR,
  PASS_ACTION_COLOR,
} from './tuning.ts';

// The registry, keyed by ActionType. `satisfies Record<ActionType, ...>` is the compile
// layer of the frozen-key guard: adding a literal to the union without a def here fails to
// compile, and a key that isn't an ActionType is rejected. The key IS the wire id; the DEV
// assert below pins each def's `type` to its key.
const DEFS = {
  // ATTACK — the offensive command. In the live system view its 'encounter' kind makes a
  // confirm against an opponent ENTER the encounter modality (no separate Engage trigger);
  // inside the encounter it is the basic attack the reducer resolves. Effect-free here.
  attack: {
    type: 'attack',
    label: 'Attack',
    color: ATTACK_ACTION_COLOR,
    category: 'attack',
    targeting: 'single',
    kind: 'encounter',
    // Enemy-only: the controller mints ALL system entities as candidates (ships AND bodies),
    // so this predicate is what keeps Attack pointed at opposing-faction targets — and, for
    // free, lets it bracket an enemy-held BODY, not just enemy ships.
    targets: (c) => c.allegiance === 'enemy',
  },
  // FLEE — disengage. A NAVIGATION command whose real resolution is the encounter reducer.
  // A live-view ship DOES list it (DEFAULT_SHIP_COMMANDS), so a Navigation → Flee drill
  // reaches the dispatcher as an 'immediate' intent — but no EFFECT_HANDLERS entry claims it,
  // so today it no-ops there (a DEV 'no handler' log) until the encounter consumes it.
  // Self-targeted.
  flee: {
    type: 'flee',
    label: 'Flee',
    color: FLEE_ACTION_COLOR,
    category: 'navigation',
    targeting: 'self',
    kind: 'immediate',
  },
  // PASS — decline to act. The menu injects this as an always-present top-level verb
  // (sourced from PASS_ACTION below, NOT from an actor's command list), so the
  // action-exhaustion terminal is always reachable by choice even for an actor with no
  // available commands. Registered here so the pass intent carries a real frozen, labelled,
  // serializable id and the dispatch stays uniform. Self-targeted, no drill.
  pass: {
    type: 'pass',
    label: 'Pass',
    color: PASS_ACTION_COLOR,
    category: 'navigation',
    targeting: 'self',
    kind: 'immediate',
  },
  // The first non-combat WORLD verbs (M3) — additive 'immediate' members that route to an
  // app-side effect handler (no-op stubs today). Each is a SUPPORT/ATTACK command on a
  // facility-bearing body (the body projector grants them; see ../actions/bodies-to-actors).
  // `targets` is left ABSENT (permissive) for the bones — the criteria a verb really wants
  // (mine ⇒ a mineable body, establish ⇒ an unowned body, bombard ⇒ an enemy-held body)
  // lands with the mechanics, not the skeleton.
  //
  // MINE — work the body's own deposits. SUPPORT/industry. SELF-targeted for the bones: the
  // bracket lands on the acting body itself, so the menu is exercisable without deciding the
  // cross-entity targeting semantics (does a mine reach another belt?) — that arrives with
  // the mechanics. The body projector grants this to a mining-base body.
  mine: {
    type: 'mine',
    label: 'Mine',
    color: MINE_ACTION_COLOR,
    category: 'support',
    targeting: 'self',
    kind: 'immediate',
  },
  // ESTABLISH — settle / develop the body. SUPPORT/civic. SELF-targeted for the bones (same
  // rationale as Mine); the body projector grants this to a colony body.
  establish: {
    type: 'establish',
    label: 'Establish',
    color: ESTABLISH_ACTION_COLOR,
    category: 'support',
    targeting: 'self',
    kind: 'immediate',
  },
  // BOMBARD — strike an enemy-held target body. An ATTACK-category WORLD verb; its 'immediate'
  // kind keeps it on the effect-handler path (no encounter). Enemy-only, like Attack. No actor
  // lists it yet (it rides an attacker's loadout with the mechanics) — the def + predicate are
  // ready ahead of that.
  bombard: {
    type: 'bombard',
    label: 'Bombard',
    color: BOMBARD_ACTION_COLOR,
    category: 'attack',
    targeting: 'single',
    kind: 'immediate',
    targets: (c) => c.allegiance === 'enemy',
  },
} satisfies Record<ActionType, ActionDef>;

export const ACTION_DEFS: readonly ActionDef[] = Object.values(DEFS);

export const ACTION_BY_ID: ReadonlyMap<ActionType, ActionDef> = new Map(
  Object.entries(DEFS) as Array<[ActionType, ActionDef]>,
);

// The validation set, derived from the registry so it can never drift from the union (a
// saved action log / an adapter validates parsed ids against this). Typed as a string-set
// because it validates arbitrary parsed JSON.
export const ACTION_TYPES: ReadonlySet<string> = new Set(Object.keys(DEFS));

// The always-present decline verb the menu injects at the top level (./menu). A constant
// so the one site that offers Pass has a single source rather than an inline string.
export const PASS_ACTION: ActionType = 'pass';

// Single source of an action's menu label.
export function actionLabel(type: ActionType): string {
  return ACTION_BY_ID.get(type)?.label ?? type;
}

// Single source of an action's accent COLOR — the menu row (and a later pill). A literal
// sRGB hex; with ColorManagement OFF it renders verbatim through both the canvas painter
// and the scene shaders. White fallback only guards a future retired tombstone (color is
// required on a live def).
export function actionColor(type: ActionType): string {
  return ACTION_BY_ID.get(type)?.color ?? '#ffffff';
}

// The save/log contract: every action id that has ever shipped. HISTORICAL wire strings,
// deliberately NOT typed as the live ActionType union — so renaming a shipped action can't
// quietly re-green the guard under compiler pressure. The CI test (test/registry.test.ts)
// asserts each entry is still a live type (ACTION_TYPES.has), so removing OR renaming a
// shipped id fails, protecting any saved action log from a compiler-invisible "cleanup".
export const FROZEN_ACTION_IDS: readonly string[] = ['attack', 'flee', 'pass', 'mine', 'establish', 'bombard'];

// DEV-only module-load invariant: each def's `type` equals its registry key, and every
// frozen id is still a live type. Mirrors the ships + factions + facilities + catalog
// drift checks — loud in dev, stripped in prod, irrelevant under node tests (which assert
// the same facts explicitly). import.meta.env is undefined outside Vite, hence the
// optional chain.
if (import.meta.env?.DEV) {
  for (const [key, def] of Object.entries(DEFS)) {
    if (def.type !== key) {
      throw new Error(`[actions] def keyed '${key}' declares type '${def.type}'`);
    }
  }
  for (const id of FROZEN_ACTION_IDS) {
    if (!ACTION_TYPES.has(id)) {
      throw new Error(`[actions] frozen id '${id}' is no longer a live type — a saved action log would break`);
    }
  }
}
