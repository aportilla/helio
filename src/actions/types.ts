// Action vocabulary — the contract the system action menu, the dispatcher, and the
// encounter reducer all satisfy. A pure declaration leaf, the deliberate twin of
// src/ships/types.ts and src/factions/types.ts: it imports nothing app-side, nothing
// from the DOM or catalog, nothing from the encounter package. The menu
// (./menu) and registry (./registry) read their shapes from here; consumers must never
// make src/actions/ depend on them (it stays a true leaf).
//
// This is the GENERAL interaction grammar of the system view — select an actor, drill
// category → command → target, execute. Combat is one consumer; non-combat verbs are
// peers. See ./README.md.

// The action VOCABULARY is OPEN, not a closed union. An actor's commands are DERIVED from the
// modular providers it carries — a ship's components, a body's facilities — each of which
// DECLARES the actions it grants (ActionGrant below); the menu collects and merges those grants
// (./derive). There is no central ActionType enum to thread a new capability through: adding a
// "plasma lance" is one ActionGrant on the module that grants it, nothing else.
//
// A command's serializable wire id is composed as `"<providerId>:<grant.key>"` (./derive). Its
// PROVIDER half is genuinely frozen — FacilityType is guarded by FROZEN_FACILITY_IDS + a CI test
// (load-bearing TODAY: facility types persist in helio.game saves), and ShipComponentDef.id is
// next. The grant KEY half rests on discipline for now (no FROZEN_GRANT_KEYS guard yet), and no
// ActionIntent is serialized anywhere today — so the wire-id freeze is FORWARD-LOOKING: it begins
// to bite only when a replay / encounter log persists an actionId. The `body:` target namespace
// keeps its own guard (./entity-id).

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

// One action a PROVIDER grants — the full static design, owned by the component / facility that
// grants it (there is no central registry of these). Deliberately EFFECT-FREE: enough to BUILD
// AND RUN THE MENU (label / category / targeting / kind / predicate), never what the action DOES
// (the immediate effect or the encounter reducer is the consumer's content). Mirrors the
// thinness of v1 ShipClassDef / FactionDef.
export interface ActionGrant {
  // Stable WITHIN the provider, naming the capability not its discharge ('railgun' / 'repair',
  // never a loaded verb like 'fire'). The serializable command id is `"<providerId>:<key>"`
  // (./derive) — the provider id is the durable thing, the key disambiguates a multi-grant module.
  readonly key: string;
  readonly label: string;            // 'Railgun' — single source for menu rows
  readonly color: string;            // literal sRGB hex menu-row accent, rendered verbatim (ColorManagement is OFF)
  readonly category: ActionCategory; // drives the top-level menu split
  readonly targeting: ActionTargeting; // drives the target step
  readonly kind: ActionKind;         // the live-view dispatch fork (above)
  // Energy cost per STACKED unit (integer); derive-and-merge sums it to a command's totalCost
  // (D3: a weapon's cost == its own battery). ABSENT ⇒ 0 for the bones, which carry no energy
  // model yet — the Phase-2 energy model makes this load-bearing (and adds the per-weapon
  // scaling-curve seam over the linear `count × costPerUnit`).
  readonly costPerUnit?: number;
  // The optional timing-mechanic seam (a timed hit). Shipped IGNORED in the bones; a later
  // experiment reads it to open a reticle. Its presence must not reshape the menu.
  readonly wantsTiming?: boolean;
  // Optional target predicate — ABSENT ⇒ permissive (every minted candidate admitted). The menu
  // filters the controller's candidate list by this (filterCandidates in ./menu); cardinality
  // (`targeting`) then shapes how many of the survivors commit. Effect-free: it selects WHICH
  // targets a command admits, never what hitting them does.
  readonly targets?: TargetCriteria;
}

// A RESOLVED, merged command an Actor carries — the derive-and-merge output (./derive) the menu
// reads inline, with NO central lookup. Identical providers stack into one scaled command:
// `count` is how many merged (D2: Missile x3 ⇒ 3); `totalCost` is `count × grant.costPerUnit`
// (D7: linear for v1). `id` is the stable `"<providerId>:<grant.key>"` wire id — what an
// ActionIntent carries and a saved log would persist.
export interface ActionCommand {
  readonly id: string;
  readonly grant: ActionGrant;
  readonly count: number;
  readonly totalCost: number;
}

// The minimal thing that can open a menu — anything the player selects and commands.
// Deliberately body-agnostic: a fleet SHIP, a PLANET / MOON / BELT carrying player
// facilities, and an in-encounter Combatant (src/encounter/) all conform — each
// offers whatever commands its loadout grants (a ship's weapons; a body's orbital-railgun
// or sensor sweep). That conformance is the seam that lets the SAME menu drive the system
// view and combat rounds, for ships and bodies alike.
// `stats` is a deliberately opaque, extensible bag (hull/energy/shields/… are content
// decisions, not skeleton); the bones display whatever keys are present. Scene-side
// anchoring identity (a fleet slot, a body disc) is NOT here — that is the consumer's
// concern, kept out of this rules leaf.
export interface Actor {
  readonly id: string;
  readonly commands: readonly ActionCommand[];
  // The menu reads `stats.energy` to gate availability — a command is drillable iff
  // `energy >= command.totalCost` (D6). ABSENT energy ⇒ permissive (the bones carry no energy
  // model yet, so every command is available, as before). The rest of the bag (hull / shields /
  // …) stays opaque content the bones merely display.
  readonly stats?: Readonly<Record<string, number>>;
  // The category PALETTE this actor always shows — the menu renders exactly these top-level
  // rows (in CATEGORY_ORDER), greying any with no available command, so the menu's SHAPE is
  // stable per actor TYPE rather than per loadout (a body always offers Attack + Support even
  // before it has a weapon facility). ABSENT ⇒ the menu derives the rows from the categories
  // the actor's commands span (the original behavior). A display concern only — it never adds
  // commands or changes what can be drilled.
  readonly categories?: readonly ActionCategory[];
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
// immediate/encounter) or the encounter reducer. Effect-free: it names WHO acts, WHICH action,
// and the chosen target ids. `actionId` is the composed `"<providerId>:<grant.key>"`; the
// live-view dispatcher resolves the action's `kind` from the actor's own command (no central
// lookup), and an app-side effect handler keys on its grant key (grantKeyOf, ./derive).
export interface ActionIntent {
  readonly actorId: string;
  readonly actionId: string;
  readonly targetIds: readonly string[];
}
