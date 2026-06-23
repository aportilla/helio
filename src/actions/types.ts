// Action vocabulary — the contract the system action menu, the dispatcher, and (later)
// the encounter reducer all satisfy. A pure declaration leaf, the deliberate twin of
// src/ships/types.ts and src/factions/types.ts: it imports nothing app-side, nothing
// from the DOM or catalog, nothing from the (not-yet-built) encounter package. The menu
// (./menu) and registry (./registry) read their shapes from here; consumers must never
// make src/actions/ depend on them (it stays a true leaf).
//
// This is the GENERAL interaction grammar of the system view — select an actor, drill
// category → command → target, execute. Combat is one consumer; non-combat verbs are
// peers. See plans/4x-system-action-menu.md.

// FROZEN serialized contract. These exact strings are the wire format if action logs are
// ever saved (the encounter replay seam), so they earn the freeze from day one. Adding a
// member is safe; renaming/removing a shipped member breaks a saved log — three guards
// defend it (registry FROZEN_ACTION_IDS + its CI test, the DEV module-load assert, and
// this literal union forcing every Record over it to update). Mirrors FacilityType /
// ShipClassType / FactionType discipline.
//
// The v1 content is combat-first (the unblocked frontier): a placeholder ATTACK, a
// NAVIGATION flee, and the always-present Pass. M3 adds the first non-combat WORLD verbs as
// additive 'immediate' members — `mine` (a belt / mineral world), `establish` (claim an
// unowned body), `bombard` (strike an enemy-held body); each routes to an app-side effect
// handler that is a no-op stub today (bones: the routing, not the mechanics).
export type ActionType = 'attack' | 'flee' | 'pass' | 'mine' | 'establish' | 'bombard';

// The top-level menu split. Data, not hardcoded: the menu derives its category rows from
// the categories an actor's commands span (./menu). For a ship that reads ATTACK /
// SUPPORT / NAVIGATION; a body or a colony ship spans a different subset.
export type ActionCategory = 'attack' | 'support' | 'navigation';

// What a command's target step admits (drives ./menu's 'target' level). 'self'/'all' are
// auto-resolved (no player pick — the candidate set is forced); 'single'/'ally'/'multi'
// are picked. Effect content (what hitting the target does) is deferred — the bones only
// need to know HOW MANY and WHICH KIND of target a command points at.
export type ActionTargeting = 'single' | 'all' | 'ally' | 'self' | 'multi';

// Who a command may point at — the PREDICATE axis, orthogonal to ActionTargeting's
// CARDINALITY. Targets are open-endedly dynamic (unowned planets, your own worlds, only an
// opponent's gas giants…), so there is no fixed kind enum; a command carries a predicate
// over rich, neutral candidate descriptors instead. The controller mints the descriptors
// (only it knows real sides + real bodies); this leaf only ever READS them and never
// enumerates a tag value, so it stays pure.

// A candidate's side relative to the acting player, derived by the controller from a
// ship's factionId / a body's ownership overlay.
export type TargetAllegiance = 'self' | 'ally' | 'enemy' | 'neutral';

// A neutral, opaque-but-rich descriptor of one targetable entity, minted per candidate by
// the controller. `kind` is coarse; `allegiance` is derived; `tags` is an OPEN string set
// the controller fills from body-traits + facilities + ownership ('gas-giant', 'colony',
// 'unowned', 'mineable', 'belt', …). The registry/menu never hardcode a tag string — only
// the criteria a consumer authors do.
export interface TargetCandidate {
  readonly id: string;
  readonly kind: 'ship' | 'body';
  readonly allegiance: TargetAllegiance;
  readonly tags: readonly string[];
}

// A pure predicate selecting which candidates a command admits. It SELECTS, it does not
// resolve — it reads the descriptor (+ the acting Actor), never app state, so it stays
// leaf-pure and effect-free. "Only opponent gas giants" is
// `(c) => c.allegiance === 'enemy' && c.tags.includes('gas-giant')`. (`item`s will share
// this shape when they land — one predicate type serves both.)
export type TargetCriteria = (candidate: TargetCandidate, actor: Actor) => boolean;

// How the live system-view dispatcher resolves a CONFIRMED action:
//   - 'immediate' — mutate the world now (the facility-placement model), then reconcile.
//   - 'encounter' — build an EncounterSpec and enter the encounter modality.
// Inside an encounter the reducer is the confirm sink and `kind` is NOT consulted (every
// action folds through applyCommand uniformly). So `kind` is purely the live-view fork.
export type ActionKind = 'immediate' | 'encounter';

// One action's static design — enough to BUILD AND RUN THE MENU, deliberately EFFECT-FREE
// (no damage/resolve/cost). What confirm() ultimately does is reached through the execute
// dispatch (the immediate effect or the encounter reducer) and is deferred content. Each
// of those lands with the consumer that reads it, so this stays a leaf with no edge into
// combat or the economy. Mirrors the thinness of v1 ShipClassDef / FactionDef.
export interface ActionDef {
  readonly type: ActionType;          // === its registry key; a DEV assert pins def.type === key
  readonly label: string;            // 'Attack' — single source for menu rows
  readonly color: string;            // literal sRGB hex menu-row accent, rendered verbatim (ColorManagement is OFF)
  readonly category: ActionCategory; // drives the top-level menu split
  readonly targeting: ActionTargeting; // drives the target step
  readonly kind: ActionKind;         // the live-view dispatch fork (above)
  // isAvailable gates a command greyed/unselectable without the bones knowing WHY (energy
  // cost, cooldown — the seam later mechanics gate on). Default true. The `world` arg
  // (encounter state / system view) is added when that state exists; the bones pass none.
  readonly isAvailable?: (actor: Actor) => boolean;
  // The optional timing-mechanic seam (a timed hit). Shipped IGNORED in the bones; a
  // later experiment reads it to open a reticle. Its presence must not reshape the menu.
  readonly wantsTiming?: boolean;
  // Optional target predicate — ABSENT ⇒ permissive (every minted candidate admitted).
  // The menu filters the controller's candidate list by this (filterCandidates in ./menu);
  // cardinality (`targeting`) then shapes how many of the survivors commit. Effect-free: it
  // selects WHICH targets a command admits, never what hitting them does. Bones defs leave
  // it absent; the creative predicates arrive with the verbs that need them.
  readonly targets?: TargetCriteria;
}

// A reference an Actor holds into the registry. Carries only the id; the menu resolves the
// def (category/targeting/availability) from the registry, so a ref can never drift from
// its def. An interface (not a bare ActionType) so a ref can later carry per-actor overlay
// data (a posted cooldown, a charge count) without touching every call site.
export interface ActionRef {
  readonly id: ActionType;
}

// The minimal thing that can open a menu — anything the player selects and commands.
// Deliberately body-agnostic: a fleet SHIP, a PLANET / MOON / BELT carrying player
// facilities, and an in-encounter Combatant (src/encounter/, later) all conform — each
// offers whatever commands its loadout grants (a ship's weapons; a body's orbital-railgun
// or a colony ship's establish-colony). That conformance is the seam that lets the SAME
// menu drive the system view and combat rounds, for ships and bodies alike.
// `stats` is a deliberately opaque, extensible bag (hull/energy/shields/… are content
// decisions, not skeleton); the bones display whatever keys are present. Scene-side
// anchoring identity (a fleet slot, a body disc) is NOT here — that is the consumer's
// concern, kept out of this rules leaf.
export interface Actor {
  readonly id: string;
  readonly commands: readonly ActionRef[];
  readonly stats?: Readonly<Record<string, number>>;
}

// One faction's actors in a system — the unit both the ship adapter (ships-to-actors) and
// the body projector (bodies-to-actors) group into, so the menu opens on a ship and a body
// through one shape. `controlled` marks the local player's side ("my side" = factionId ===
// CONTROLLED_FACTION_ID) without baking a player flag into the data.
export interface ActorSide {
  readonly factionId: string;
  readonly controlled: boolean;
  readonly actors: readonly Actor[];
}

// What the menu emits on confirm — the uniform hand-off to the execute dispatch (live-view
// immediate/encounter) or the encounter reducer. Effect-free: it names WHO acts, WHICH
// action, and the chosen target ids. Resolving it is the consumer's job.
export interface ActionIntent {
  readonly actorId: string;
  readonly actionId: ActionType;
  readonly targetIds: readonly string[];
}
